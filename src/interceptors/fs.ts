/**
 * fs interceptor.
 *
 * Wraps the Node.js `fs` module read and write entry points to attribute and
 * optionally block filesystem access (FR-8, FR-9).
 *
 * Covered entry points (sync + async callback + fs.promises):
 *   Reads:  readFile, readFileSync, createReadStream, open (r/r+/rs), openSync
 *   Writes: writeFile, writeFileSync, appendFile, appendFileSync,
 *           createWriteStream, open (w/wx/a/ax/...), openSync
 *
 * Path extraction: first argument for all wrapped functions.
 * Write-vs-read: determined by flags/function name.
 *
 * Important: patch via require() not import * — TypeScript's __importStar
 * creates a wrapper, so only require() gives us the shared mutable object.
 */

import type * as fsType from 'fs';
import { fileURLToPath } from 'url';
import type { AccessEvent } from '../types.js';
import { attributeCurrentCall } from '../attribution/stack.js';
import { CapWardenViolationError } from '../errors.js';
import { reportInternalError } from './guard.js';
import type { Interceptor, InterceptorOptions } from './types.js';

/* eslint-disable @typescript-eslint/no-require-imports */
const fsModule = require('fs') as typeof fsType;
/* eslint-enable @typescript-eslint/no-require-imports */

type FsMode = 'read' | 'write';

/** Determine read/write from an `open` flags argument. */
function flagsMode(flags: unknown): FsMode {
  const f = String(flags ?? 'r');
  // Write flags: w, wx, w+, a, ax, a+ and variants
  return /^[wWaA]/.test(f) ? 'write' : 'read';
}

/** Normalise a path argument (Buffer, URL, or string) to string. */
function normalisePath(p: unknown): string {
  if (typeof p === 'string') return p;
  if (p instanceof URL) {
    // .pathname keeps percent-encoding (`untitled%20folder`) — decode to the
    // real filesystem path so recorded events match string-path accesses.
    try {
      return fileURLToPath(p);
    } catch {
      return p.pathname; // non-file: URL — fs will reject it; record as-is
    }
  }
  if (Buffer.isBuffer(p)) return p.toString();
  return String(p);
}

type OriginalFs = {
  readFile: typeof fsType.readFile;
  readFileSync: typeof fsType.readFileSync;
  writeFile: typeof fsType.writeFile;
  writeFileSync: typeof fsType.writeFileSync;
  appendFile: typeof fsType.appendFile;
  appendFileSync: typeof fsType.appendFileSync;
  createReadStream: typeof fsType.createReadStream;
  createWriteStream: typeof fsType.createWriteStream;
  open: typeof fsType.open;
  openSync: typeof fsType.openSync;
  promises_readFile: typeof fsType.promises.readFile;
  promises_writeFile: typeof fsType.promises.writeFile;
  promises_appendFile: typeof fsType.promises.appendFile;
  promises_open: typeof fsType.promises.open;
};

/**
 * Additional entry points beyond read/write, covered in sync + callback +
 * `promises` form (GAP §1.3 — a package could delete or rename arbitrary files
 * while staying inside its frozen baseline).
 *
 * [name, pathArgIndex, mode].  For two-path operations the index points at the
 * mutated / created target: copyFile/symlink/link create arg 1; rename mutates
 * arg 0.
 */
const EXTRA_OPS: ReadonlyArray<readonly [string, number, FsMode]> = [
  ['unlink', 0, 'write'],
  ['rm', 0, 'write'],
  ['rmdir', 0, 'write'],
  ['rename', 0, 'write'],
  ['copyFile', 1, 'write'],
  ['mkdir', 0, 'write'],
  ['chmod', 0, 'write'],
  ['chown', 0, 'write'],
  ['symlink', 1, 'write'],
  ['link', 1, 'write'],
  ['truncate', 0, 'write'],
  ['readdir', 0, 'read'],
  ['opendir', 0, 'read'],
];

export function createFsInterceptor(options: InterceptorOptions): Interceptor {
  const { log, onAccess, onInternalError = 'fail-open' } = options;
  let originals: OriginalFs | null = null;
  // Restore closures for the table-driven EXTRA_OPS patches.
  let extraRestores: Array<() => void> = [];

  const intercept = (path: string, mode: FsMode): void => {
    try {
      const packageName = attributeCurrentCall();
      const event: AccessEvent = {
        packageName,
        detail: { kind: 'fs', path, mode },
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

  const wrap = <T extends (...args: never[]) => unknown>(
    original: T,
    pathArgIndex: number,
    mode: FsMode | ((args: Parameters<T>) => FsMode)
  ): T => {
    return function (this: unknown, ...args: Parameters<T>): ReturnType<T> {
      const path = normalisePath(args[pathArgIndex]);
      const resolvedMode = typeof mode === 'function' ? mode(args) : mode;
      intercept(path, resolvedMode); // throws on enforce block
      return original.apply(this, args) as ReturnType<T>;
    } as unknown as T;
  };

  const wrapAsync = <T extends (...args: never[]) => Promise<unknown>>(
    original: T,
    pathArgIndex: number,
    mode: FsMode | ((args: Parameters<T>) => FsMode)
  ): T => {
    return function (this: unknown, ...args: Parameters<T>): ReturnType<T> {
      const path = normalisePath(args[pathArgIndex]);
      const resolvedMode = typeof mode === 'function' ? mode(args) : mode;
      try {
        intercept(path, resolvedMode); // throws synchronously on enforce block
      } catch (err) {
        return Promise.reject(err) as ReturnType<T>;
      }
      return original.apply(this, args) as ReturnType<T>;
    } as unknown as T;
  };

  return {
    install() {
      if (originals) return;

      originals = {
        readFile: fsModule.readFile,
        readFileSync: fsModule.readFileSync,
        writeFile: fsModule.writeFile,
        writeFileSync: fsModule.writeFileSync,
        appendFile: fsModule.appendFile,
        appendFileSync: fsModule.appendFileSync,
        createReadStream: fsModule.createReadStream,
        createWriteStream: fsModule.createWriteStream,
        open: fsModule.open,
        openSync: fsModule.openSync,
        promises_readFile: fsModule.promises.readFile,
        promises_writeFile: fsModule.promises.writeFile,
        promises_appendFile: fsModule.promises.appendFile,
        promises_open: fsModule.promises.open,
      };

      // Callback-based
      (fsModule as unknown as Record<string, unknown>).readFile = wrap(originals.readFile, 0, 'read');
      (fsModule as unknown as Record<string, unknown>).writeFile = wrap(originals.writeFile, 0, 'write');
      (fsModule as unknown as Record<string, unknown>).appendFile = wrap(originals.appendFile, 0, 'write');
      (fsModule as unknown as Record<string, unknown>).open = wrap(
        originals.open, 0,
        (args) => flagsMode((args as unknown[])[1])
      );

      // Sync
      (fsModule as unknown as Record<string, unknown>).readFileSync = wrap(originals.readFileSync, 0, 'read');
      (fsModule as unknown as Record<string, unknown>).writeFileSync = wrap(originals.writeFileSync, 0, 'write');
      (fsModule as unknown as Record<string, unknown>).appendFileSync = wrap(originals.appendFileSync, 0, 'write');
      (fsModule as unknown as Record<string, unknown>).openSync = wrap(
        originals.openSync, 0,
        (args) => flagsMode((args as unknown[])[1])
      );

      // Stream factories
      (fsModule as unknown as Record<string, unknown>).createReadStream = wrap(originals.createReadStream, 0, 'read');
      (fsModule as unknown as Record<string, unknown>).createWriteStream = wrap(originals.createWriteStream, 0, 'write');

      // fs.promises
      fsModule.promises.readFile = wrapAsync(originals.promises_readFile, 0, 'read');
      fsModule.promises.writeFile = wrapAsync(originals.promises_writeFile, 0, 'write');
      fsModule.promises.appendFile = wrapAsync(originals.promises_appendFile, 0, 'write');
      fsModule.promises.open = wrapAsync(
        originals.promises_open, 0,
        (args) => flagsMode((args as unknown[])[1])
      );

      // Table-driven destructive / directory operations (sync + callback + promises).
      const mod = fsModule as unknown as Record<string, unknown>;
      const pmod = fsModule.promises as unknown as Record<string, unknown>;
      for (const [name, pathIdx, mode] of EXTRA_OPS) {
        const syncName = name + 'Sync';
        if (typeof mod[name] === 'function') {
          const orig = mod[name] as (...a: never[]) => unknown;
          mod[name] = wrap(orig, pathIdx, mode);
          extraRestores.push(() => { mod[name] = orig; });
        }
        if (typeof mod[syncName] === 'function') {
          const orig = mod[syncName] as (...a: never[]) => unknown;
          mod[syncName] = wrap(orig, pathIdx, mode);
          extraRestores.push(() => { mod[syncName] = orig; });
        }
        if (typeof pmod[name] === 'function') {
          const orig = pmod[name] as (...a: never[]) => Promise<unknown>;
          pmod[name] = wrapAsync(orig, pathIdx, mode);
          extraRestores.push(() => { pmod[name] = orig; });
        }
      }
    },

    uninstall() {
      if (!originals) return;

      for (const restore of extraRestores) restore();
      extraRestores = [];

      (fsModule as unknown as Record<string, unknown>).readFile = originals.readFile;
      (fsModule as unknown as Record<string, unknown>).writeFile = originals.writeFile;
      (fsModule as unknown as Record<string, unknown>).appendFile = originals.appendFile;
      (fsModule as unknown as Record<string, unknown>).open = originals.open;
      (fsModule as unknown as Record<string, unknown>).readFileSync = originals.readFileSync;
      (fsModule as unknown as Record<string, unknown>).writeFileSync = originals.writeFileSync;
      (fsModule as unknown as Record<string, unknown>).appendFileSync = originals.appendFileSync;
      (fsModule as unknown as Record<string, unknown>).openSync = originals.openSync;
      (fsModule as unknown as Record<string, unknown>).createReadStream = originals.createReadStream;
      (fsModule as unknown as Record<string, unknown>).createWriteStream = originals.createWriteStream;
      fsModule.promises.readFile = originals.promises_readFile;
      fsModule.promises.writeFile = originals.promises_writeFile;
      fsModule.promises.appendFile = originals.promises_appendFile;
      fsModule.promises.open = originals.promises_open;

      originals = null;
    },
  };
}
