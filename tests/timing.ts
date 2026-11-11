/**
 * CPU-time guards for smoke tests — load-tolerant, but still fail a super-linear rule.
 *
 * Several smokes assert that an operation runs inside a bound (for example "redact 200 KB in
 * under 200 ms"). They used wall-clock time (`performance.now` / `Date.now`). Wall time counts
 * every moment the process is descheduled, so on a busy host running other gates the same,
 * correct implementation reads 4–9x slower and fails its own linear-time guard.
 *
 * CPU time (`process.cpuUsage()` user + system) does not count descheduled time: it measures
 * only the work the process actually did. That keeps the guard meaningful while ignoring host
 * load. It does not weaken what the guard proves — a quadratic or catastrophically backtracking
 * rule does unbounded CPU *work*, so its CPU time still explodes and blows the same budget. Only
 * waiting (a lock, a sleep, a slow socket) is elided, and those bounds are wait-time assertions,
 * not the CPU-bound guards converted to this helper.
 *
 * The minimum of a few repeats (best-of-N) discards a one-off GC pause or a scheduling blip so a
 * single unlucky sample cannot fail a correct implementation.
 *
 * `tests/timing-load-check.ts` runs every smoke that uses these guards under full CPU load five
 * times, as the evidence that they are load-tolerant; it is CPU-heavy by design and is not part
 * of the CI gate.
 */
import assert from "node:assert/strict";

/** CPU milliseconds (user + system) this process has consumed so far. */
export function cpuMs(): number {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1000;
}

/**
 * Runs `fn` `attempts` times and returns the smallest CPU time observed, in milliseconds. The
 * minimum discards one-off stalls; `fn` must be pure enough to repeat (the smoke guards call a
 * deterministic redaction/classification routine).
 */
export function bestCpuMs(attempts: number, fn: () => void): number {
  let best = Infinity;
  for (let i = 0; i < attempts; i++) {
    const before = cpuMs();
    fn();
    const delta = cpuMs() - before;
    if (delta < best) best = delta;
  }
  return best;
}

/**
 * Asserts that `fn` completes in less than `budgetMs` of CPU time (best of three runs) and
 * returns the measured best. The failure message keeps the smoke's original label and the
 * original budget; callers must not raise a budget to make a slow host pass.
 */
export function assertCpuWithin(label: string, budgetMs: number, fn: () => void): number {
  const ms = bestCpuMs(3, fn);
  assert.ok(ms < budgetMs, `${label} took ${Math.round(ms)} ms of CPU (budget ${budgetMs} ms)`);
  return ms;
}
