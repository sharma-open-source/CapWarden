/**
 * Fail-safe handling for CapWarden's own per-access logic (NFR-4).
 *
 * A bug in attribution, suppression, or policy evaluation must never crash the
 * host application — the CI gate, not the production runtime, is the primary
 * enforcement point (R3). Each interceptor wraps its work in a try/catch:
 *
 *   - A CapWardenViolationError is the *intended* block signal (enforce mode).
 *     The interceptor handles it itself — env withholds the value, net/fs/proc
 *     rethrow to abort the operation — so it never reaches `reportInternalError`.
 *   - Any *other* thrown value is a CapWarden internal error, passed here:
 *     'fail-open' (default) logs it once and returns, so the host operation
 *     proceeds as if CapWarden were absent; 'fail-closed' rethrows.
 */

export type InternalErrorMode = 'fail-open' | 'fail-closed';

let _warned = false;

/** Reset the once-only warning latch. Test-only. */
export function _resetInternalErrorWarning(): void {
  _warned = false;
}

/**
 * Handle a CapWarden-internal error. In 'fail-closed' mode it is rethrown; in
 * the default 'fail-open' mode it is logged once and swallowed (the caller then
 * lets the host operation proceed).
 */
export function reportInternalError(err: unknown, mode: InternalErrorMode): void {
  if (mode === 'fail-closed') {
    throw err;
  }
  if (!_warned) {
    _warned = true;
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error(
      `[CapWarden] internal error — failing open so the host app is unaffected ` +
        `(NFR-4). Further internal errors are suppressed.\n  ${detail}`
    );
  }
}
