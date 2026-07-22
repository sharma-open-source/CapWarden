/**
 * net interceptor.
 *
 * Wraps the following Node.js entry points to attribute and optionally block
 * outbound network connections (FR-8, FR-9):
 *
 *   http.request / http.get
 *   https.request / https.get
 *   net.connect / net.createConnection
 *   tls.connect
 *   http2.connect
 *   dgram.createSocket → socket.send        (UDP / DNS exfil)
 *   dns.lookup / dns.resolve (+ dns.promises) (name resolution)
 *   global fetch                             (default modern network path)
 *
 * Extracts host:port at call time (before any async I/O).
 * In enforce mode, onAccess throws and the connection is aborted with an
 * ECONNREFUSED-equivalent error on the returned socket/request (or a rejected
 * promise for fetch / dns.promises).
 *
 * Important: we patch via require() not import * to get the actual mutable
 * CJS module object that all consumers share.  TypeScript's __importStar
 * creates a wrapper object, so mutating the import binding would not affect
 * code that require()'s the module directly.
 */

import type * as httpType from 'http';
import type * as httpsType from 'https';
import type * as netType from 'net';
import type * as tlsType from 'tls';
import type * as dgramType from 'dgram';
import type * as dnsType from 'dns';
import type * as http2Type from 'http2';
import type { AccessEvent } from '../types.js';
import { attributeCurrentCall } from '../attribution/stack.js';
import { CapWardenViolationError } from '../errors.js';
import { reportInternalError } from './guard.js';
import type { Interceptor, InterceptorOptions } from './types.js';

/* eslint-disable @typescript-eslint/no-require-imports */
const httpModule = require('http') as typeof httpType;
const httpsModule = require('https') as typeof httpsType;
const netModule = require('net') as typeof netType;
const tlsModule = require('tls') as typeof tlsType;
const dgramModule = require('dgram') as typeof dgramType;
const dnsModule = require('dns') as typeof dnsType;
const http2Module = require('http2') as typeof http2Type;
/* eslint-enable @typescript-eslint/no-require-imports */

type HttpRequestFn = typeof httpType.request;
type NetConnectFn = typeof netType.connect;

interface Originals {
  httpRequest: HttpRequestFn;
  httpGet: typeof httpType.get;
  httpsRequest: typeof httpsType.request;
  httpsGet: typeof httpsType.get;
  netConnect: NetConnectFn;
  netCreateConnection: typeof netType.createConnection;
  netSocketConnect: typeof netType.Socket.prototype.connect;
  tlsConnect: typeof tlsType.connect;
  dgramCreateSocket: typeof dgramType.createSocket;
  dnsLookup: typeof dnsType.lookup;
  dnsResolve: typeof dnsType.resolve;
  dnsPromisesLookup: typeof dnsType.promises.lookup;
  dnsPromisesResolve: typeof dnsType.promises.resolve;
  http2Connect: typeof http2Type.connect;
  fetch: typeof globalThis.fetch | undefined;
}

/** Extract host and port from http/https request options or a URL string. */
function extractHostPort(
  input: string | URL | httpType.RequestOptions,
  defaultPort: number
): { host: string; port: number } {
  if (typeof input === 'string') {
    try {
      const u = new URL(input);
      return {
        host: u.hostname || 'unknown',
        port: u.port ? parseInt(u.port, 10) : defaultPort,
      };
    } catch {
      return { host: input, port: defaultPort };
    }
  }
  if (input instanceof URL) {
    return {
      host: input.hostname || 'unknown',
      port: input.port ? parseInt(input.port, 10) : defaultPort,
    };
  }
  // RequestOptions
  return {
    host: (input.hostname ?? input.host ?? 'unknown').replace(/:\d+$/, ''),
    port: input.port ? Number(input.port) : defaultPort,
  };
}

/** Extract host and port from net.connect / net.createConnection / tls.connect. */
function extractNetHostPort(
  args: Parameters<NetConnectFn>
): { host: string; port: number } {
  const first = args[0];
  if (typeof first === 'number') {
    // connect(port, host?, ...)
    const host = (typeof args[1] === 'string' ? args[1] : 'localhost') as string;
    return { host, port: first };
  }
  if (typeof first === 'object' && first !== null && !Array.isArray(first)) {
    const opts = first as { port?: number; host?: string; path?: string };
    if (opts.path) return { host: 'unix:' + opts.path, port: 0 };
    return { host: opts.host ?? 'localhost', port: opts.port ?? 0 };
  }
  return { host: 'unknown', port: 0 };
}

/**
 * Extract destination host/port from dgram socket.send() arguments.
 * Signatures: send(msg, port, address?, cb?) or send(msg, offset, length, port, address?, cb?).
 * The address is the last string argument; the port is the number preceding it
 * (or the last number if no address is given).
 */
function extractDgramTarget(args: unknown[]): { host: string; port: number } {
  let addrIdx = -1;
  for (let i = args.length - 1; i >= 1; i--) {
    if (typeof args[i] === 'string') {
      addrIdx = i;
      break;
    }
  }
  const host = addrIdx >= 0 ? (args[addrIdx] as string) : 'localhost';

  let port = 0;
  const from = addrIdx >= 0 ? addrIdx - 1 : args.length - 1;
  for (let i = from; i >= 1; i--) {
    if (typeof args[i] === 'number') {
      port = args[i] as number;
      break;
    }
  }
  return { host, port };
}

/** Extract the target host/port from a fetch() input (string | URL | Request). */
function extractFetchTarget(input: unknown): { host: string; port: number } {
  let urlStr: string | undefined;
  if (typeof input === 'string') urlStr = input;
  else if (input instanceof URL) urlStr = input.href;
  else if (input && typeof (input as { url?: unknown }).url === 'string') {
    urlStr = (input as { url: string }).url;
  }
  if (!urlStr) return { host: 'unknown', port: 0 };
  try {
    const u = new URL(urlStr);
    const defaultPort = u.protocol === 'https:' ? 443 : 80;
    return { host: u.hostname || 'unknown', port: u.port ? parseInt(u.port, 10) : defaultPort };
  } catch {
    return { host: urlStr, port: 0 };
  }
}

/**
 * The full `dns` name-resolution surface beyond `lookup`. Every one of these
 * resolves a hostname and is a viable exfiltration channel (a compromised
 * package can smuggle data in the QNAME of a `resolveTxt`), so all must be
 * attributed and enforceable — not just `resolve`. `lookup` is handled
 * separately because its host argument position differs on `lookupService`.
 */
const DNS_RESOLVE_METHODS = [
  'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCaa', 'resolveCname',
  'resolveMx', 'resolveNaptr', 'resolveNs', 'resolvePtr', 'resolveSoa',
  'resolveSrv', 'resolveTxt', 'reverse',
] as const;

export function createNetInterceptor(options: InterceptorOptions): Interceptor {
  const { log, onAccess, onInternalError = 'fail-open' } = options;
  let originals: Originals | null = null;
  // Restore closures for the table-driven dns resolve* family + Resolver proto.
  let dnsRestores: Array<() => void> = [];

  const intercept = (host: string, port: number): void => {
    try {
      const packageName = attributeCurrentCall();
      const event: AccessEvent = {
        packageName,
        detail: { kind: 'net', host, port },
        timestamp: Date.now(),
      };
      log.push(event);

      if (onAccess && packageName !== 'app') {
        onAccess(event); // throws CapWardenViolationError on block
      }
    } catch (err) {
      if (err instanceof CapWardenViolationError) throw err; // propagate the block
      reportInternalError(err, onInternalError); // fail-open: let the call proceed
    }
  };

  return {
    install() {
      if (originals) return;

      originals = {
        httpRequest: httpModule.request,
        httpGet: httpModule.get,
        httpsRequest: httpsModule.request,
        httpsGet: httpsModule.get,
        netConnect: netModule.connect,
        netCreateConnection: netModule.createConnection,
        netSocketConnect: netModule.Socket.prototype.connect,
        tlsConnect: tlsModule.connect,
        dgramCreateSocket: dgramModule.createSocket,
        dnsLookup: dnsModule.lookup,
        dnsResolve: dnsModule.resolve,
        dnsPromisesLookup: dnsModule.promises.lookup,
        dnsPromisesResolve: dnsModule.promises.resolve,
        http2Connect: http2Module.connect,
        fetch: globalThis.fetch,
      };

      // http.request
      (httpModule as { request: unknown }).request = function (
        ...args: Parameters<typeof httpType.request>
      ) {
        const { host, port } = extractHostPort(args[0], 80);
        intercept(host, port); // throws on enforce block
        return originals!.httpRequest.apply(httpModule, args);
      };

      // http.get
      (httpModule as { get: unknown }).get = function (
        ...args: Parameters<typeof httpType.get>
      ) {
        const { host, port } = extractHostPort(args[0], 80);
        intercept(host, port);
        return originals!.httpGet.apply(httpModule, args);
      };

      // https.request
      (httpsModule as { request: unknown }).request = function (
        ...args: Parameters<typeof httpsType.request>
      ) {
        const { host, port } = extractHostPort(args[0], 443);
        intercept(host, port);
        return originals!.httpsRequest.apply(httpsModule, args);
      };

      // https.get
      (httpsModule as { get: unknown }).get = function (
        ...args: Parameters<typeof httpsType.get>
      ) {
        const { host, port } = extractHostPort(args[0], 443);
        intercept(host, port);
        return originals!.httpsGet.apply(httpsModule, args);
      };

      // net.connect / net.createConnection (they're the same function)
      const netWrap = function (...args: Parameters<NetConnectFn>) {
        const { host, port } = extractNetHostPort(args);
        intercept(host, port);
        return originals!.netConnect.apply(netModule, args);
      };
      (netModule as { connect: unknown }).connect = netWrap;
      (netModule as { createConnection: unknown }).createConnection = netWrap;

      // net.Socket.prototype.connect — the low-level choke point every socket
      // connection ultimately routes through. Wrapping it closes the direct
      // `new net.Socket().connect(...)` path, which bypasses the module-level
      // factories above. Higher-level wraps (http/tls/net.connect) still fire
      // first and, in enforce mode, throw before their Socket is created — so
      // this does not double-block; in observe the duplicate event dedupes in
      // both the policy and the report.
      (netModule.Socket.prototype as { connect: unknown }).connect = function (
        this: netType.Socket,
        ...args: Parameters<typeof netType.Socket.prototype.connect>
      ) {
        const { host, port } = extractNetHostPort(args as unknown as Parameters<NetConnectFn>);
        intercept(host, port);
        return originals!.netSocketConnect.apply(this, args);
      };

      // tls.connect
      (tlsModule as { connect: unknown }).connect = function (
        ...args: Parameters<typeof tlsType.connect>
      ) {
        const { host, port } = extractNetHostPort(args as unknown as Parameters<NetConnectFn>);
        intercept(host, port);
        return originals!.tlsConnect.apply(tlsModule, args);
      };

      // http2.connect
      (http2Module as { connect: unknown }).connect = function (
        ...args: Parameters<typeof http2Type.connect>
      ) {
        const { host, port } = extractHostPort(
          args[0] as string | URL,
          443
        );
        intercept(host, port);
        return originals!.http2Connect.apply(http2Module, args);
      };

      // dgram.createSocket → wrap the returned socket's send()
      (dgramModule as { createSocket: unknown }).createSocket = function (
        ...args: Parameters<typeof dgramType.createSocket>
      ) {
        const socket = originals!.dgramCreateSocket.apply(dgramModule, args) as dgramType.Socket;
        const originalSend = socket.send.bind(socket);
        (socket as { send: unknown }).send = function (...sendArgs: unknown[]) {
          const { host, port } = extractDgramTarget(sendArgs);
          intercept(host, port); // throws on enforce block
          return (originalSend as (...a: unknown[]) => unknown)(...sendArgs);
        };
        return socket;
      };

      // dns.lookup / dns.resolve (callback form) — deliver a block via callback
      const wrapDnsCallback = <T extends (...a: never[]) => unknown>(original: T): T =>
        function (this: unknown, ...args: unknown[]): unknown {
          const host = typeof args[0] === 'string' ? args[0] : 'unknown';
          try {
            intercept(host, 0);
          } catch (err) {
            const cb = args[args.length - 1];
            if (typeof cb === 'function') {
              queueMicrotask(() => (cb as (e: unknown) => void)(err));
              return undefined;
            }
            throw err;
          }
          return (original as unknown as (...a: unknown[]) => unknown).apply(this, args);
        } as unknown as T;
      (dnsModule as { lookup: unknown }).lookup = wrapDnsCallback(originals.dnsLookup);
      (dnsModule as { resolve: unknown }).resolve = wrapDnsCallback(originals.dnsResolve);

      // dns.promises.lookup / resolve — reject on block
      const wrapDnsPromise = <T extends (...a: never[]) => Promise<unknown>>(original: T): T =>
        function (this: unknown, ...args: unknown[]): Promise<unknown> {
          const host = typeof args[0] === 'string' ? args[0] : 'unknown';
          try {
            intercept(host, 0);
          } catch (err) {
            return Promise.reject(err);
          }
          return (original as unknown as (...a: unknown[]) => Promise<unknown>).apply(this, args);
        } as unknown as T;
      dnsModule.promises.lookup = wrapDnsPromise(originals.dnsPromisesLookup);
      dnsModule.promises.resolve = wrapDnsPromise(originals.dnsPromisesResolve);

      // Fan out over the rest of the resolve* family (callback + promises) and
      // over dns.Resolver instances, which bypass the module-level functions.
      const wrapDnsFamily = (
        holder: Record<string, unknown>,
        name: string,
        kind: 'callback' | 'promise'
      ): void => {
        const orig = holder[name];
        if (typeof orig !== 'function') return;
        holder[name] = kind === 'promise'
          ? wrapDnsPromise(orig as (...a: never[]) => Promise<unknown>)
          : wrapDnsCallback(orig as (...a: never[]) => unknown);
        dnsRestores.push(() => { holder[name] = orig; });
      };

      const dnsCb = dnsModule as unknown as Record<string, unknown>;
      const dnsProm = dnsModule.promises as unknown as Record<string, unknown>;
      const resolverProto = dnsModule.Resolver?.prototype as unknown as Record<string, unknown> | undefined;
      const promisesResolverProto =
        dnsModule.promises.Resolver?.prototype as unknown as Record<string, unknown> | undefined;

      for (const name of DNS_RESOLVE_METHODS) {
        // 'resolve' on the module + promises is already wrapped above; skip to
        // avoid double interception, but still cover it on the Resolver protos.
        if (name !== 'resolve') {
          wrapDnsFamily(dnsCb, name, 'callback');
          wrapDnsFamily(dnsProm, name, 'promise');
        }
        if (resolverProto) wrapDnsFamily(resolverProto, name, 'callback');
        if (promisesResolverProto) wrapDnsFamily(promisesResolverProto, name, 'promise');
      }

      // global fetch — reject on block
      if (originals.fetch) {
        const originalFetch = originals.fetch;
        globalThis.fetch = function (this: unknown, ...args: Parameters<typeof fetch>) {
          const { host, port } = extractFetchTarget(args[0]);
          try {
            intercept(host, port);
          } catch (err) {
            return Promise.reject(err);
          }
          return originalFetch.apply(this, args);
        } as typeof fetch;
      }
    },

    uninstall() {
      if (!originals) return;
      for (const restore of dnsRestores) restore();
      dnsRestores = [];
      (httpModule as { request: unknown }).request = originals.httpRequest;
      (httpModule as { get: unknown }).get = originals.httpGet;
      (httpsModule as { request: unknown }).request = originals.httpsRequest;
      (httpsModule as { get: unknown }).get = originals.httpsGet;
      (netModule as { connect: unknown }).connect = originals.netConnect;
      (netModule as { createConnection: unknown }).createConnection = originals.netCreateConnection;
      (netModule.Socket.prototype as { connect: unknown }).connect = originals.netSocketConnect;
      (tlsModule as { connect: unknown }).connect = originals.tlsConnect;
      (dgramModule as { createSocket: unknown }).createSocket = originals.dgramCreateSocket;
      (dnsModule as { lookup: unknown }).lookup = originals.dnsLookup;
      (dnsModule as { resolve: unknown }).resolve = originals.dnsResolve;
      dnsModule.promises.lookup = originals.dnsPromisesLookup;
      dnsModule.promises.resolve = originals.dnsPromisesResolve;
      (http2Module as { connect: unknown }).connect = originals.http2Connect;
      if (originals.fetch) globalThis.fetch = originals.fetch;
      originals = null;
    },
  };
}
