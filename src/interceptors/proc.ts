/**
 * proc interceptor.
 *
 * Wraps child_process entry points to attribute and optionally block subprocess
 * spawning (FR-8, FR-9):
 *
 *   exec, execFile, execSync, execFileSync
 *   spawn, spawnSync
 *   fork
 *
 * Captures the command/file string at call time (first argument).
 * In enforce mode, onAccess throws and the call throws a CapWarden error.
 *
 * Important: patch via require() not import * — TypeScript's __importStar
 * creates a wrapper, so only require() gives us the shared mutable object.
 */

import type * as childProcessType from 'child_process';
import type { AccessEvent } from '../types.js';
import { attributeCurrentCall } from '../attribution/stack.js';
import { CapWardenViolationError } from '../errors.js';
import { reportInternalError } from './guard.js';
import type { Interceptor, InterceptorOptions } from './types.js';

/* eslint-disable @typescript-eslint/no-require-imports */
const cpModule = require('child_process') as typeof childProcessType;
/* eslint-enable @typescript-eslint/no-require-imports */

type OriginalProc = {
  exec: typeof childProcessType.exec;
  execFile: typeof childProcessType.execFile;
  execSync: typeof childProcessType.execSync;
  execFileSync: typeof childProcessType.execFileSync;
  spawn: typeof childProcessType.spawn;
  spawnSync: typeof childProcessType.spawnSync;
  fork: typeof childProcessType.fork;
};

export function createProcInterceptor(options: InterceptorOptions): Interceptor {
  const { log, onAccess, onInternalError = 'fail-open' } = options;
  let originals: OriginalProc | null = null;

  const intercept = (command: string): boolean => {
    try {
      const packageName = attributeCurrentCall();
      const event: AccessEvent = {
        packageName,
        detail: { kind: 'proc', command },
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
    return true;
  };

  const wrap = <T extends (...args: never[]) => unknown>(original: T): T => {
    return function (this: unknown, ...args: Parameters<T>): ReturnType<T> {
      const command = String(args[0] ?? '');
      intercept(command); // throws if onAccess throws (enforce mode block)
      return original.apply(this, args) as ReturnType<T>;
    } as unknown as T;
  };

  return {
    install() {
      if (originals) return;

      originals = {
        exec: cpModule.exec,
        execFile: cpModule.execFile,
        execSync: cpModule.execSync,
        execFileSync: cpModule.execFileSync,
        spawn: cpModule.spawn,
        spawnSync: cpModule.spawnSync,
        fork: cpModule.fork,
      };

      (cpModule as unknown as Record<string, unknown>).exec = wrap(originals.exec);
      (cpModule as unknown as Record<string, unknown>).execFile = wrap(originals.execFile);
      (cpModule as unknown as Record<string, unknown>).execSync = wrap(originals.execSync);
      (cpModule as unknown as Record<string, unknown>).execFileSync = wrap(originals.execFileSync);
      (cpModule as unknown as Record<string, unknown>).spawn = wrap(originals.spawn);
      (cpModule as unknown as Record<string, unknown>).spawnSync = wrap(originals.spawnSync);
      (cpModule as unknown as Record<string, unknown>).fork = wrap(originals.fork);
    },

    uninstall() {
      if (!originals) return;

      (cpModule as unknown as Record<string, unknown>).exec = originals.exec;
      (cpModule as unknown as Record<string, unknown>).execFile = originals.execFile;
      (cpModule as unknown as Record<string, unknown>).execSync = originals.execSync;
      (cpModule as unknown as Record<string, unknown>).execFileSync = originals.execFileSync;
      (cpModule as unknown as Record<string, unknown>).spawn = originals.spawn;
      (cpModule as unknown as Record<string, unknown>).spawnSync = originals.spawnSync;
      (cpModule as unknown as Record<string, unknown>).fork = originals.fork;

      originals = null;
    },
  };
}
