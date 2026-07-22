/**
 * Shared process-exit wiring for observe / update flush.
 *
 * `process.once('exit')` alone misses Ctrl-C (SIGINT) and SIGTERM, so a test
 * run interrupted with Ctrl-C would produce no report — a likely first-contact
 * experience (GAP §3). We flush on normal exit AND on those signals, then
 * re-raise the signal after removing our handler so the process dies from the
 * signal with the conventional exit status (128 + signum).
 *
 * The caller's `flush` must be idempotent (guard with a `flushed` flag): both
 * an 'exit' handler and a signal handler can fire for the same run.
 */
export function installFlushHooks(flush: () => void): void {
  process.once('exit', flush);

  for (const signal of ['SIGINT', 'SIGTERM'] as NodeJS.Signals[]) {
    const handler = () => {
      flush();
      // Remove our handler to restore Node's default disposition, then
      // re-raise so the process terminates from the signal as expected.
      process.removeListener(signal, handler);
      process.kill(process.pid, signal);
    };
    process.once(signal, handler);
  }
}
