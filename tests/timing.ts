/**
 * CPU-time guards for smoke tests — load-tolerant, but still fail a super-linear rule.
 *
 * Several smokes assert that an operation runs inside a bound (for example "redact 200 KB in
 * under 200 ms"). They used wall-clock time (`performance.now` / `Date.now`). Wall time counts
 * every moment the process is descheduled, so on a busy host running other gates the same,
 * correct implementation reads 4–9x slower and fails its own linear-time guard.
 *
 * CPU time (the calling thread's user + system time) does not count descheduled time: it measures
 * only the work the code actually did. That keeps the guard meaningful while ignoring host
 * load. It does not weaken what the guard proves — a quadratic or catastrophically backtracking
 * rule does unbounded CPU *work*, so its CPU time still explodes and blows the same budget. Only
 * waiting (a lock, a sleep, a slow socket) is elided, and those bounds are wait-time assertions,
 * not the CPU-bound guards converted to this helper.
 *
 * The minimum of a few repeats (best-of-N) discards a one-off GC pause or a scheduling blip so a
 * single unlucky sample cannot fail a correct implementation.
 *
 * The rule for which bounds use this helper: a guard on work the process itself does in-process
 * (regex match/compile, redaction, classification, sizing) is CPU-bound and uses `cpuMs` /
 * `assertCpuWithin`. A bound on waiting — a subprocess, a socket, a `node:vm` or `setTimeout`
 * timeout, a `Date.now()` deadline, a lock — stays wall clock on purpose and is deliberately NOT
 * converted: CPU time does not advance while the process waits, so measuring CPU there would make
 * the hang/cut-off guard a no-op.
 *
 * A noisier measurement may need more repeats than the default three;
 * `workflow-redaction-smoke.ts` uses best-of-nine.
 */
import assert from "node:assert/strict";

/**
 * CPU milliseconds (user + system) the calling thread has consumed so far.
 *
 * `threadCpuUsage` scopes the reading to this thread, excluding the process's other threads (V8's
 * concurrent marking/compilation helpers, libuv workers). Their CPU is charged to process-wide
 * `cpuUsage` and, on a saturated host, lands in every measurement window while the heap is under
 * pressure — which made a linear redaction read as quadratic. The guarded work runs on the main
 * thread, so the thread reading is the honest measure. `threadCpuUsage` is new in Node 22.13 /
 * 23.9; on an older runtime (engines floor is 22.19) fall back to the process-wide reading.
 */
export function cpuMs(): number {
  const u = typeof process.threadCpuUsage === "function" ? process.threadCpuUsage() : process.cpuUsage();
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
