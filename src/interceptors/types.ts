/**
 * Shared interface for all interceptors.
 *
 * Each interceptor wraps a Node.js built-in, emits AccessEvents, and can
 * optionally block accesses in enforce mode.
 */

import type { AccessLog, AccessEvent } from '../types.js';
import type { InternalErrorMode } from './guard.js';

export interface InterceptorOptions {
  /** The shared log to push AccessEvents into. */
  log: AccessLog;
  /**
   * Called when an access is intercepted.  In enforce mode callers use this
   * to check policy and throw/return-undefined if denied.
   */
  onAccess?: (event: AccessEvent) => void;
  /**
   * How to handle a bug inside CapWarden's own logic (NFR-4).
   * Defaults to 'fail-open' — log once and let the host operation proceed.
   */
  onInternalError?: InternalErrorMode;
}

export interface Interceptor {
  /** Activate the interceptor (patch the built-in). */
  install(): void;
  /** Restore the original built-in. */
  uninstall(): void;
}
