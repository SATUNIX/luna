#!/usr/bin/env node
/**
 * Load-robust performance assertion for smoke tests.
 *
 * An absolute wall-clock budget goes red when the host is busy even though the code under test
 * is correct. These redactors are linear, so the useful property is how the time grows with the
 * input, not the absolute milliseconds. `assertSubQuadratic` warms up, measures the best of N
 * runs at 1x and 4x input, and fails only when the 4x run exceeds `max(1x, 2 ms) * maxRatio`.
 * The 2 ms floor keeps a very fast 1x measurement from turning timer noise into a false failure.
 * The clock is injectable for deterministic regression tests; it defaults to CPU time
 * (`cpuMs`, the main thread's user + system time). Wall clock counts the time the process is
 * descheduled, so under the gate's parallel `check-all --jobs` a correct linear redactor reads
 * as super-linear when a sibling check saturates the machine; CPU time measures the work the
 * code did, so the same ratio guard stays meaningful and does not fail on host load.
 */
import assert from "node:assert/strict";
import { cpuMs } from "./timing.ts";

export function assertSubQuadratic(
  label: string,
  fn: (text: string) => void,
  small: string,
  large: string,
  opts?: { maxRatio?: number; runs?: number; clock?: () => number },
): void {
  const maxRatio = opts?.maxRatio ?? 10;
  const runs = opts?.runs ?? 3;
  const clock = opts?.clock ?? cpuMs;
  const bestOf = (text: string): number => {
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < runs; i++) {
      const started = clock();
      fn(text);
      const ms = clock() - started;
      if (ms < best) best = ms;
    }
    return best;
  };
  // Warm up both sizes so JIT compilation and first-touch allocation are not measured.
  fn(small);
  fn(large);
  const smallMs = bestOf(small);
  const largeMs = bestOf(large);
  const bound = Math.max(smallMs, 2) * maxRatio;
  assert.ok(
    largeMs <= bound,
    `${label}: quadratic growth suspected — ${small.length} chars took ${smallMs.toFixed(2)} ms, ` +
      `${large.length} chars (4x) took ${largeMs.toFixed(2)} ms, ratio bound ${maxRatio}x ` +
      `(with a 2 ms floor): limit ${bound.toFixed(2)} ms`,
  );
}
