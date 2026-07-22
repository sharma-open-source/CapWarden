/**
 * NFR-1: micro-benchmark for the attribution hot path.
 *
 * `attributeFromStack()` runs on *every* intercepted capability access, so its
 * cost is CapWarden's per-access tax. This measures ns/op at several call-stack
 * depths (deeper stacks = more frames to walk) so regressions are visible.
 *
 * Run: `npm run build && npm run bench`
 */

import { attributeFromStack } from '../dist/attribution/stack.js';

function timeAtDepth(depth, iterations) {
  // Build a call stack `depth` frames deep, then measure at the bottom.
  const recurse = (n) => (n <= 0 ? measure(iterations) : recurse(n - 1));
  return recurse(depth);
}

function measure(iterations) {
  // Warm up JIT.
  for (let i = 0; i < 10_000; i++) attributeFromStack();
  const start = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) attributeFromStack();
  const end = process.hrtime.bigint();
  return Number(end - start) / iterations; // ns/op
}

const ITER = 200_000;
console.log('attributeFromStack() — ns/op by call-stack depth\n');
for (const depth of [1, 8, 32, 128]) {
  const nsPerOp = timeAtDepth(depth, ITER);
  console.log(`  depth ${String(depth).padStart(4)} : ${nsPerOp.toFixed(0).padStart(7)} ns/op`);
}
console.log('\n(Informational — CI budget is asserted in tests/attribution/perf.test.ts.)');
