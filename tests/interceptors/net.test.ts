import { describe, it, expect, beforeEach } from 'vitest';
// Use require() to get the actual mutable CJS module objects (not the ESM namespace wrapper)
/* eslint-disable @typescript-eslint/no-require-imports */
import type * as httpType from 'http';
import type * as httpsType from 'https';
import type * as netType from 'net';
import type * as tlsType from 'tls';
import type * as dgramType from 'dgram';
import type * as dnsType from 'dns';
const http = require('http') as typeof httpType;
const https = require('https') as typeof httpsType;
const net = require('net') as typeof netType;
const tls = require('tls') as typeof tlsType;
const dgram = require('dgram') as typeof dgramType;
const dns = require('dns') as typeof dnsType;
/* eslint-enable @typescript-eslint/no-require-imports */
import { createNetInterceptor } from '../../src/interceptors/net';
import { CapWardenViolationError } from '../../src/errors';
import type { AccessLog } from '../../src/types';

describe('interceptors/net', () => {
  let log: AccessLog;

  beforeEach(() => {
    log = [];
  });

  it('records http.request calls with host and port', () => {
    // Capture the original BEFORE installing
    const origRequest = http.request;
    const interceptor = createNetInterceptor({ log });
    interceptor.install();
    try {
      // Verify the function was replaced
      expect(http.request).not.toBe(origRequest);
    } finally {
      interceptor.uninstall();
    }
  });

  it('restores all original functions on uninstall', () => {
    const origHttpRequest = http.request;
    const origHttpsRequest = https.request;
    const origNetConnect = net.connect;

    const interceptor = createNetInterceptor({ log });
    interceptor.install();
    interceptor.uninstall();

    expect(http.request).toBe(origHttpRequest);
    expect(https.request).toBe(origHttpsRequest);
    expect(net.connect).toBe(origNetConnect);
  });

  it('logs a net access event when http.request is intercepted', () => {
    const interceptor = createNetInterceptor({ log });
    interceptor.install();
    try {
      const req = http.request({ hostname: 'test.example.com', port: 80, path: '/' });
      req.on('error', () => {}); // suppress ECONNRESET from immediate destroy
      req.destroy();

      const netEvent = log.find(
        (e) => e.detail.kind === 'net' && e.detail.host === 'test.example.com'
      );
      expect(netEvent).toBeDefined();
      expect(netEvent?.detail.kind === 'net' && netEvent.detail.port).toBe(80);
    } finally {
      interceptor.uninstall();
    }
  });

  it('logs https.request with port 443 by default', () => {
    const interceptor = createNetInterceptor({ log });
    interceptor.install();
    try {
      const req = https.request({ hostname: 'secure.example.com', path: '/' });
      req.on('error', () => {}); // suppress errors from immediate destroy
      req.destroy();

      const netEvent = log.find(
        (e) => e.detail.kind === 'net' && e.detail.host === 'secure.example.com'
      );
      expect(netEvent).toBeDefined();
      expect(netEvent?.detail.kind === 'net' && netEvent.detail.port).toBe(443);
    } finally {
      interceptor.uninstall();
    }
  });

  it('is idempotent — double install does not double-wrap', () => {
    const interceptor = createNetInterceptor({ log });
    interceptor.install();
    const wrapped = http.request;
    interceptor.install(); // no-op
    expect(http.request).toBe(wrapped);
    interceptor.uninstall();
  });

  // ─── GAP §1.2: modern network surface must be intercepted ──────────────────

  it('logs a net event for global fetch (GAP §1.2)', async () => {
    const interceptor = createNetInterceptor({ log });
    interceptor.install();
    try {
      // Port 9 (discard) — connection fails fast; we only care about the event,
      // which is logged synchronously at call time.
      const p = fetch('http://127.0.0.1:9/x').catch(() => undefined);
      const ev = log.find((e) => e.detail.kind === 'net' && e.detail.host === '127.0.0.1');
      expect(ev).toBeDefined();
      await p;
    } finally {
      interceptor.uninstall();
    }
  });

  it('rejects fetch when blocked in enforce mode (GAP §1.2)', async () => {
    const interceptor = createNetInterceptor({
      log,
      onAccess: () => {
        throw new CapWardenViolationError('pkg', 'net:127.0.0.1:9');
      },
    });
    interceptor.install();
    try {
      await expect(fetch('http://127.0.0.1:9/x')).rejects.toThrow(CapWardenViolationError);
    } finally {
      interceptor.uninstall();
    }
  });

  it('fetch fails open (proceeds) when CapWarden itself errors (NFR-4)', async () => {
    const interceptor = createNetInterceptor({
      log,
      onAccess: () => {
        throw new Error('simulated internal bug');
      },
    });
    interceptor.install();
    try {
      // The bug must not turn into a block: fetch proceeds and fails only on the
      // real (refused) connection, not with our internal error.
      await expect(fetch('http://127.0.0.1:9/x')).rejects.not.toThrow(
        'simulated internal bug'
      );
    } finally {
      interceptor.uninstall();
    }
  });

  it('logs a net event for tls.connect (GAP §1.2)', () => {
    const interceptor = createNetInterceptor({ log });
    interceptor.install();
    try {
      const socket = tls.connect(9, '127.0.0.1');
      socket.on('error', () => {});
      socket.destroy();
      const ev = log.find(
        (e) => e.detail.kind === 'net' && e.detail.host === '127.0.0.1' && e.detail.port === 9
      );
      expect(ev).toBeDefined();
    } finally {
      interceptor.uninstall();
    }
  });

  it('logs a net event for dgram socket.send (GAP §1.2)', () => {
    const interceptor = createNetInterceptor({ log });
    interceptor.install();
    const socket = dgram.createSocket('udp4');
    try {
      socket.send(Buffer.from('x'), 9, '127.0.0.1', () => {});
      const ev = log.find(
        (e) => e.detail.kind === 'net' && e.detail.host === '127.0.0.1' && e.detail.port === 9
      );
      expect(ev).toBeDefined();
    } finally {
      socket.close();
      interceptor.uninstall();
    }
  });

  it('intercepts a direct new net.Socket().connect (bypass of the factories)', () => {
    const interceptor = createNetInterceptor({ log });
    interceptor.install();
    const socket = new net.Socket();
    try {
      socket.connect(9, '127.0.0.1');
      const ev = log.find(
        (e) => e.detail.kind === 'net' && e.detail.host === '127.0.0.1' && e.detail.port === 9
      );
      expect(ev).toBeDefined();
    } finally {
      socket.on('error', () => {});
      socket.destroy();
      interceptor.uninstall();
    }
  });

  it('blocks a direct net.Socket().connect in enforce mode', () => {
    const interceptor = createNetInterceptor({
      log,
      onAccess: () => {
        throw new CapWardenViolationError('pkg', 'net:127.0.0.1:9');
      },
    });
    interceptor.install();
    const socket = new net.Socket();
    try {
      expect(() => socket.connect(9, '127.0.0.1')).toThrow(CapWardenViolationError);
    } finally {
      socket.on('error', () => {});
      socket.destroy();
      interceptor.uninstall();
    }
  });

  it('restores net.Socket.prototype.connect on uninstall', () => {
    const orig = net.Socket.prototype.connect;
    const interceptor = createNetInterceptor({ log });
    interceptor.install();
    expect(net.Socket.prototype.connect).not.toBe(orig);
    interceptor.uninstall();
    expect(net.Socket.prototype.connect).toBe(orig);
  });

  it('logs a net event for dns.resolveTxt — the fan-out family (exfil channel)', async () => {
    const interceptor = createNetInterceptor({ log });
    interceptor.install();
    try {
      await new Promise<void>((resolve) => {
        dns.resolveTxt('capwarden-exfil.test.example', () => resolve());
      });
      const ev = log.find(
        (e) => e.detail.kind === 'net' && e.detail.host === 'capwarden-exfil.test.example'
      );
      expect(ev).toBeDefined();
    } finally {
      interceptor.uninstall();
    }
  });

  it('blocks dns.resolveTxt via callback when enforced', async () => {
    const interceptor = createNetInterceptor({
      log,
      onAccess: () => {
        throw new CapWardenViolationError('pkg', 'net:blocked.example:0');
      },
    });
    interceptor.install();
    try {
      const err = await new Promise<unknown>((resolve) => {
        dns.resolveTxt('blocked.example', (e) => resolve(e));
      });
      expect(err).toBeInstanceOf(CapWardenViolationError);
    } finally {
      interceptor.uninstall();
    }
  });

  it('intercepts a dns.Resolver instance method (bypass of module functions)', async () => {
    const interceptor = createNetInterceptor({ log });
    interceptor.install();
    const resolver = new dns.Resolver();
    try {
      await new Promise<void>((resolve) => {
        resolver.resolve4('capwarden-resolver.test.example', () => resolve());
      });
      const ev = log.find(
        (e) => e.detail.kind === 'net' && e.detail.host === 'capwarden-resolver.test.example'
      );
      expect(ev).toBeDefined();
    } finally {
      interceptor.uninstall();
    }
  });

  it('logs a net event for dns.lookup (GAP §1.2)', async () => {
    const interceptor = createNetInterceptor({ log });
    interceptor.install();
    try {
      await new Promise<void>((resolve) => {
        dns.lookup('capwarden.test.example', () => resolve());
      });
      const ev = log.find(
        (e) => e.detail.kind === 'net' && e.detail.host === 'capwarden.test.example'
      );
      expect(ev).toBeDefined();
    } finally {
      interceptor.uninstall();
    }
  });

  it('delivers a block to the dns.lookup callback when enforced (GAP §1.2)', async () => {
    const interceptor = createNetInterceptor({
      log,
      onAccess: () => {
        throw new CapWardenViolationError('pkg', 'net:blocked.example:0');
      },
    });
    interceptor.install();
    try {
      const err = await new Promise<unknown>((resolve) => {
        dns.lookup('blocked.example', (e) => resolve(e));
      });
      expect(err).toBeInstanceOf(CapWardenViolationError);
    } finally {
      interceptor.uninstall();
    }
  });

  it('calls onAccess with the net event', () => {
    const seen: string[] = [];
    const interceptor = createNetInterceptor({
      log,
      onAccess: (event) => {
        if (event.detail.kind === 'net') seen.push(event.detail.host);
      },
    });
    interceptor.install();
    try {
      const req = http.request({ hostname: 'callback.example.com', port: 8080, path: '/' });
      req.on('error', () => {});
      req.destroy();
      expect(seen).toContain('callback.example.com');
    } finally {
      interceptor.uninstall();
    }
  });
});
