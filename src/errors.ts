/**
 * Shared CapWarden error types.
 *
 * Kept in a dependency-free module so both the interceptors and the enforce
 * mode can reference `CapWardenViolationError` without a circular import
 * (enforce imports the interceptors; the interceptors need to recognise this
 * error to distinguish an intended *block* from an internal *bug*, NFR-4).
 */

/**
 * Thrown by the enforce-mode access handler when a package attempts a
 * capability its committed policy does not grant. This is the intended block
 * signal — interceptors let it propagate so the underlying operation is
 * aborted. Any *other* thrown value is a CapWarden internal error and is
 * handled fail-open (see `interceptors/guard.ts`).
 */
export class CapWardenViolationError extends Error {
  constructor(
    public readonly packageName: string,
    public readonly capability: string
  ) {
    super(`CapWarden: ${packageName} attempted unpermitted capability: ${capability}`);
    this.name = 'CapWardenViolationError';
  }
}
