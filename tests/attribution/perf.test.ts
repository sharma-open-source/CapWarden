/**
 * NFR-1: guard the attribution hot path against gross regressions.
 *
 * `attributeFromStack()` runs on every intercepted access. We assert a generous
 * per-call ceiling — chosen to catch an order-of-magnitude regression (e.g. an
 * accidental O(n^2) frame scan or a per-call allocation storm) without flaking
 * on slow/loaded CI machines. The real numbers live in `bench/attribution.mjs`.
 */

import { describe, it, expect } from 'vitest';
import { attributeFromStack } from '../../src/attribution/stack';

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

describe('attributeFromStack performance (NFR-1)', () => {
  it('stays well under a generous per-call ceiling at a deep stack', () => {
    // Establish a moderately deep call stack, then measure at the bottom.
    const deep = (n: number): number => (n <= 0 ? sample() : deep(n - 1));
    const sample = (): number => {
      const ITER = 20_000;
      for (let i = 0; i < 5_000; i++) attributeFromStack(); // warm up
      const runs: number[] = [];
      for (let r = 0; r < 5; r++) {
        const start = process.hrtime.bigint();
        for (let i = 0; i < ITER; i++) attributeFromStack();
        runs.push(Number(process.hrtime.bigint() - start) / ITER);
      }
      return median(runs);
    };

    const nsPerOp = deep(40);
    // 100µs/op is ~1-2 orders of magnitude above observed (~1-5µs); this only
    // trips on a real algorithmic regression, never on machine jitter.
    expect(nsPerOp).toBeLessThan(100_000);
  });
});
