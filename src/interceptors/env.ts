/**
 * env interceptor.
 *
 * Replaces process.env with a Proxy whose `get` trap:
 *   - attributes the read to the responsible package (FR-11)
 *   - records the key (never the value — NFR-5)
 *   - in enforce mode: calls onAccess which may throw CapWardenViolationError,
 *     causing the get to return undefined (withhold the value)
 *
 * First-party 'app' accesses pass through unmodified (FR-12).
 */

import type { AccessEvent } from '../types.js';
import { attributeCurrentCall, classifyReaderContext } from '../attribution/stack.js';
import { CapWardenViolationError } from '../errors.js';
import { reportInternalError } from './guard.js';
import type { Interceptor, InterceptorOptions } from './types.js';

/**
 * Env keys read by the Node.js runtime itself (TTY/color detection, TLS,
 * cluster/IPC wiring, warnings, coverage…).  A dependency's async context is
 * often active when Node reads these, so attributing them to the package fills
 * baselines with noise no reviewer can adjudicate (GAP §1.4 / R1).  Reads of
 * these keys are never charged to a package — they are recorded as 'app'.
 *
 * NODE_ENV is deliberately excluded: it is an application-level convention that
 * dependencies legitimately read, and it is adjudicable.
 */
const NODE_INTERNAL_ENV_KEYS = new Set<string>([
  'FORCE_COLOR', 'NO_COLOR', 'NODE_DISABLE_COLORS', 'COLORTERM', 'TERM',
  'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_EXTRA_CA_CERTS',
  'NODE_CLUSTER_SCHED_POLICY', 'NODE_UNIQUE_ID',
  'NODE_CHANNEL_FD', 'NODE_CHANNEL_SERIALIZATION_MODE',
  'NODE_DEBUG', 'NODE_DEBUG_NATIVE', 'NODE_PENDING_DEPRECATION',
  'NODE_NO_WARNINGS', 'NODE_REDIRECT_WARNINGS', 'NODE_V8_COVERAGE',
  'NODE_ICU_DATA', 'NODE_OPTIONS', 'NODE_COMPILE_CACHE', 'NODE_PATH',
  'NODE_REPL_HISTORY', 'NODE_REPL_MODE',
]);

export function createEnvInterceptor(options: InterceptorOptions): Interceptor {
  const { log, onAccess, onInternalError = 'fail-open' } = options;
  const originalEnv = process.env;
  let installed = false;

  /**
   * Record a read of `key` and, in enforce mode, decide whether the value may
   * be disclosed. Returns true when the value should be withheld (blocked).
   *
   * Every read path — `get`, `getOwnPropertyDescriptor`, `ownKeys` — funnels
   * through here so none of them can be used to exfiltrate around the others
   * (GAP §1.1: `Object.getOwnPropertyDescriptors(process.env).X.value`).
   *
   * Wrapped in a fail-safe (NFR-4): a CapWardenViolationError withholds the
   * value (a real block); any other error is a CapWarden bug and fails open —
   * the real value is disclosed rather than crashing the host.
   */
  const recordRead = (key: string): boolean => {
    try {
      let packageName = attributeCurrentCall();

      // Suppress attribution for reads Node itself performs while merely running
      // inside a package's async context (GAP §1.4). Cheap denylist first; only
      // pay for a stack inspection when a package is on the hook for a non-listed
      // key, which keeps the ALS fast-path fast (NFR-1).
      if (packageName !== 'app') {
        if (NODE_INTERNAL_ENV_KEYS.has(key) || classifyReaderContext() === 'internal') {
          packageName = 'app';
        }
      }

      const event: AccessEvent = {
        packageName,
        detail: { kind: 'env', key },
        timestamp: Date.now(),
      };

      log.push(event);

      if (onAccess && packageName !== 'app') {
        onAccess(event); // throws CapWardenViolationError on block
      }

      return false;
    } catch (err) {
      if (err instanceof CapWardenViolationError) {
        return true; // withhold the value
      }
      reportInternalError(err, onInternalError); // fail-open: disclose the value
      return false;
    }
  };

  const proxy = new Proxy(originalEnv, {
    get(target, prop: string | symbol) {
      // Only intercept string property reads (actual env var lookups)
      if (typeof prop !== 'string') {
        return (target as unknown as Record<string | symbol, unknown>)[prop];
      }

      const blocked = recordRead(prop);
      if (blocked) return undefined;
      return target[prop];
    },

    getOwnPropertyDescriptor(target, prop: string | symbol) {
      const descriptor = Object.getOwnPropertyDescriptor(target, prop);
      if (typeof prop !== 'string' || descriptor === undefined) {
        return descriptor;
      }

      const blocked = recordRead(prop);
      if (blocked) {
        // Withhold the value but keep the descriptor shape so proxy invariants
        // hold (a configurable target prop must not report a value here).
        return { ...descriptor, value: undefined };
      }
      return descriptor;
    },

    ownKeys(target) {
      // Enumerating the env is itself an access; charge it so a package cannot
      // harvest the whole keyspace without attribution. We do not block key
      // *names* (they are not secret values — NFR-5), only value disclosure,
      // which the get/getOwnPropertyDescriptor traps still gate on read.
      recordRead('*');
      return Reflect.ownKeys(target);
    },

    set(target, prop: string | symbol, value: unknown) {
      // Writing env is itself a capability — mutating NODE_TLS_REJECT_UNAUTHORIZED,
      // NODE_OPTIONS, etc. is at least as attack-relevant as reading. Charge the
      // write to the responsible package; in enforce mode a block withholds the
      // mutation (the assignment does not take effect) rather than the value.
      if (typeof prop === 'string') {
        const blocked = recordRead(prop);
        if (blocked) return true; // silently drop the write; do not mutate
      }
      (target as Record<string | symbol, unknown>)[prop] = value;
      return true;
    },

    deleteProperty(target, prop: string | symbol) {
      if (typeof prop === 'string') {
        const blocked = recordRead(prop);
        if (blocked) return true; // block the delete; leave the value intact
      }
      delete (target as Record<string | symbol, unknown>)[prop];
      return true;
    },

    has(target, prop) {
      return prop in target;
    },
  });

  return {
    install() {
      if (installed) return;
      installed = true;
      process.env = proxy as NodeJS.ProcessEnv;
    },

    uninstall() {
      if (!installed) return;
      installed = false;
      process.env = originalEnv;
    },
  };
}
