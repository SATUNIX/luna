# Proposal — retry a timed-out harness check, then park instead of failing the run

Raised in cycle 04 of `luna-fleet-01` because the fix cannot merge unattended. Cycle 03 of this run
(`origin/attempts/luna-fleet-01/cycle-03`, commit `2e10298c`) implemented it and was refused before
review: it changes `packages/autonomy/lib/engine.ts`, `rpc.ts` and `runtime.ts`, which
`packages/autonomy/lib/risk.ts` classifies R3 (run wiring / gate and attempt policy). The
owner/steward route applies. Nothing in this cycle's diff is behavioural; this file is the handoff.

## Finding

Run `luna-ops-01` went terminal `failed` with reason `worker_unavailable` and detail "the kit
harness check timed out after 30000ms" at 2026-11-20T09:55:50Z, right after a normal cycle ended.
That is a multi-week run dying on one slow host reply, not on a broken kit. The event log recorded
it as a `failure` event and `postmortem.json` was written, so the run unit could not resume it.

Evidence: the cycle-03 steward receipt for this run (the ops failure and its timestamp), and the
code path below. Reproduce with the test in "Test" — at the base commit it fails (the run ends
`failed` after the first timed-out check); with the patch it passes.

## Root cause (at base `eb527a54d912`)

1. `packages/autonomy/lib/rpc.ts:382-386` — `HarnessCheck.expire()` records a start-up timeout as
   an ordinary failure: `state = "failed"` and a `reason` string. The class keeps no distinction
   between "the reply never arrived" (transient, host was slow) and "the reply lacked a core
   command" (misconfiguration, must fail closed). `HARNESS_CHECK_TIMEOUT_MS` is 30 s
   (`rpc.ts:317`) and the session is abandoned when it expires (`runtime.ts:516`).
2. `packages/autonomy/lib/runtime.ts:194` — `workerProblem()` returns `this.harness.failure`, so
   the engine sees only a string and cannot tell the two cases apart.
3. `packages/autonomy/lib/engine.ts:653` (loop pre-check, before `runStep`/`taskStep`) and
   `engine.ts:902` (inside `taskStep`, after `waitTurn` returns `unusable`) both treat any worker
   problem as fatal: `await this.stopWorker(...)` then
   `this.go("failed", { reason: "worker_unavailable", detail: problem })`.
4. `docs/autonomy.md:1400-1406` documents that behaviour ("no reply within 30 seconds fails the run
   with `worker_unavailable`"), so the documentation has to move with the fix.

## Fix (the exact patch from `2e10298c`)

`HarnessCheck` records `timedOut` and exposes `failureIsTimeout`; `Runtime` gains an optional
`workerProblemKind(): "timeout" | "missing" | null` (implemented by `DockerRuntime` and
`FakeRuntime`); `Engine.retryHarnessTimeout()` retries a timeout once with a fresh session, keeps a
consecutive count in `RunState.harnessTimeouts`, resets the count when a session verifies, and parks
as `paused` with reason `harness_check_timeout` when the timeout persists. Missing core commands
still fail closed with `worker_unavailable`. The `taskStep` path retries the same step
(`s.step = n - 1`) instead of spending it.

Safety for the R3 paths: no file named `recover`/`resume`/`restart`/`retry` is touched; the run
lock, budget gates, gate policy, permissions and credentials are unchanged; the harness fail-closed
rule is preserved for the misconfiguration case; the park reuses the existing `paused` status and
history mechanism, so the host run unit resumes the run exactly as it does for a paused run today.

```diff
diff --git a/docs/autonomy.md b/docs/autonomy.md
--- a/docs/autonomy.md
+++ b/docs/autonomy.md
@@ -1400,11 +1400,14 @@ a finite run (`implement`, `deploy`) writes the `run.*` and `failure` events. An
 
 At the start of every worker session the supervisor asks pi for its registered commands to check
 the kit harness loaded (`HARNESS_CORE` and `HARNESS_OPTIONAL` in `packages/autonomy/lib/rpc.ts`). A
-missing core command (the goal, hand-off, verification and firewall commands), a malformed reply or
-no reply within 30 seconds fails the run with `worker_unavailable`. A missing optional command
-(orchestration or tracing) does not: the session goes on without it and the supervisor writes a
-`harness.degraded` event. `tests/autonomy-smoke.ts` and `tests/autonomy-events-smoke.ts` pin both
-outcomes.
+missing core command (the goal, hand-off, verification and firewall commands) or a malformed reply
+fails the run with `worker_unavailable`; a slow host is different. A check with no reply within 30
+seconds is retried once with a fresh session, and a timeout that persists parks the run in `paused`
+with reason `harness_check_timeout`, so the host's run unit resumes it instead of a multi-week run
+failing on one slow check. A missing optional command (orchestration or tracing) does not: the
+session goes on without it and the supervisor writes a `harness.degraded` event.
+`tests/autonomy-smoke.ts` and `tests/autonomy-events-smoke.ts` pin both outcomes and the timeout
+retry/park.
diff --git a/packages/autonomy/lib/engine.ts b/packages/autonomy/lib/engine.ts
--- a/packages/autonomy/lib/engine.ts
+++ b/packages/autonomy/lib/engine.ts
@@ -39,6 +39,8 @@ import { stdoutIsFile, writeJsonAtomic } from "./fsutil.ts";
 
 export const IDLE_MINUTES = 20; // a worker session that emits nothing for this long is treated as stalled
 export const MAX_ACTIVITY_LINES = 60;
+/** A timed-out start-up harness check is retried this many times before the run parks; missing commands still fail closed. */
+export const HARNESS_TIMEOUT_RETRIES = 1;
 const TERMINAL: readonly RunStatus[] = ["succeeded", "failed", "cancelled"];
 
 export { BoundaryError, GateWaitInterrupted, LockLost };
@@ -122,6 +124,8 @@ export interface Runtime extends AcceptanceRuntime {
   setBudgetCap?(usd: number): void;
   /** Why the worker cannot be used (e.g. the kit harness did not load), or null. */
   workerProblem?(): string | null;
+  /** Whether the current worker problem is the start-up harness check timing out (transient) or a missing command (misconfiguration). */
+  workerProblemKind?(): "timeout" | "missing" | null;
   /** The optional harness commands the current worker session lacks, reported once per session (empty otherwise). */
   workerDegraded?(): readonly string[];
 }
@@ -251,7 +255,7 @@ export interface WorkerSession {
 }
 
 /** Why the next fresh session starts; its briefing says so. */
-type StartReason = "first" | "supervisor_restart" | "resumed" | "answer" | "continue" | "crash" | "session_ended" | "hard_restart" | "generation";
+type StartReason = "first" | "supervisor_restart" | "resumed" | "answer" | "continue" | "crash" | "session_ended" | "hard_restart" | "generation" | "harness_timeout";
 
 /** Which of a generation's boxes ran out. */
 type GenerationBox = GenerationRecord["box"];
@@ -421,6 +425,29 @@ export class Engine {
     this.emit({ type: "harness.degraded", run: this.store.run, missing: [...missing] });
   }
 
+  /**
+   * A start-up harness check that timed out is a slow host, not a broken kit: the check is retried
+   * with a fresh session, and only a timeout that persists parks the run (paused, so the host's run
+   * unit resumes it) instead of failing a multi-week run. Missing commands still fail closed.
+   * Returns true when the caller should start a fresh session; false once the run is terminal/parked.
+   */
+  retryHarnessTimeout(problem: string): boolean {
+    if (this.rt.workerProblemKind?.() !== "timeout") {
+      this.go("failed", { reason: "worker_unavailable", detail: problem });
+      return false;
+    }
+    const timeouts = (this.state.harnessTimeouts ?? 0) + 1;
+    this.save((s) => { s.harnessTimeouts = timeouts; });
+    if (timeouts <= HARNESS_TIMEOUT_RETRIES) {
+      this.log(`harness check timed out (${problem}); retrying with a fresh worker session (retry ${String(timeouts)} of ${String(HARNESS_TIMEOUT_RETRIES)})`);
+      this.startReason = "harness_timeout";
+      return true;
+    }
+    this.log(`harness check timed out ${String(timeouts)} times; parking the run for the host run unit to resume`);
+    this.go("paused", { reason: "harness_check_timeout", detail: `${problem}; parked after ${String(timeouts)} timed-out harness checks` });
+    return false;
+  }
+
   writeHeartbeat(): void {
     writeJsonAtomic(path.join(this.store.p.root, "heartbeat.json"), { at: new Date(this.rt.now()).toISOString(), phase: this.state.phase ?? this.status, cycle: this.state.selfImprove?.current?.n ?? this.state.step, status: this.status });
   }
@@ -650,7 +677,10 @@ export class Engine {
       }
       this.reportDegraded();
       const problem = this.rt.workerProblem?.();
-      if (problem) { await this.stopWorker("worker unusable"); this.go("failed", { reason: "worker_unavailable", detail: problem }); return; }
+      if (problem) {
+        await this.stopWorker("worker unusable");
+        if (!this.retryHarnessTimeout(problem)) return;
+      } else if (this.state.harnessTimeouts) this.save((s) => { s.harnessTimeouts = 0; });
       if (this.template.runStep) await this.template.runStep(this.ctx());
       else await this.taskStep();
       this.save();
@@ -897,9 +927,22 @@ export class Engine {
     const res = await this.waitTurn(session, stepStartUsd);
     s.usage.steps = n;
     await this.refreshUsage();
+    if (res.end !== "unusable" && this.state.harnessTimeouts) this.save((st) => { st.harnessTimeouts = 0; });
     if (res.end === "interrupted") { this.save(); return; }
     if (res.end === "limit") { await this.stopWorker(`limit ${res.limit}`); this.save(); return; } // the loop ends the run with the limit's outcome
-    if (res.end === "unusable") { await this.stopWorker("worker unusable"); this.go("failed", { reason: "worker_unavailable", detail: res.problem }); return; }
+    if (res.end === "unusable") {
+      await this.stopWorker("worker unusable");
+      if (this.rt.workerProblemKind?.() === "timeout") {
+        if (!this.retryHarnessTimeout(res.problem)) return;
+        // The check timed out before the step did any work: retry the same step with a fresh session instead of spending it.
+        s.step = n - 1;
+        this.save();
+        await this.taskStep();
+        return;
+      }
+      this.go("failed", { reason: "worker_unavailable", detail: res.problem });
+      return;
+    }
     if (res.end === "blocked") { await this.enterBlocked(res.blocker); return; }
     if (res.end === "generation") { await this.endGeneration(session, n, res.box, stepStartUsd); return; }
     let crashed = false;
@@ -1238,7 +1281,7 @@ export class Engine {
     const steers = (state.steers ?? []).slice(-5).map((x) => x.message);
     const gs = state.generations;
     const g = this.generationSettings();
-    const reasons: Record<string, string> = { generation: `its generation's time box ran out; you are generation ${gs?.current ?? "?"} of ${g?.maxGenerations ?? "?"}, a fresh worker continuing from the previous generation's notebook`, hard_restart: "it was restarted by the supervisor's recovery", crash: "it crashed", supervisor_restart: "the supervisor was restarted", resumed: "the run was paused and resumed", answer: "the run was blocked on a question and has now been answered", session_ended: "it ended", continue: "it ended" };
+    const reasons: Record<string, string> = { generation: `its generation's time box ran out; you are generation ${gs?.current ?? "?"} of ${g?.maxGenerations ?? "?"}, a fresh worker continuing from the previous generation's notebook`, hard_restart: "it was restarted by the supervisor's recovery", crash: "it crashed", supervisor_restart: "the supervisor was restarted", resumed: "the run was paused and resumed", answer: "the run was blocked on a question and has now been answered", session_ended: "it ended", continue: "it ended", harness_timeout: "its start-up harness check timed out; this fresh session retries it" };
     const unaccepted = state.unaccepted ?? null;
     const text = buildBriefing({ contract, state, why: reasons[why] ?? why, head, unaccepted, log: repo.logOneline(start ?? null, head), changed: start ? repo.changedPaths(start, head) : [], activity: this.lastActivity, answer, steers, notebook: g ? this.latestNotebook() : null });
     if (answer || unaccepted) this.save((s) => { if (answer) s.pendingAnswer = null; s.unaccepted = null; });
diff --git a/packages/autonomy/lib/lifecycle.ts b/packages/autonomy/lib/lifecycle.ts
--- a/packages/autonomy/lib/lifecycle.ts
+++ b/packages/autonomy/lib/lifecycle.ts
@@ -288,6 +288,8 @@ export interface RunState {
   unaccepted?: { ref: string; sha: string; why: string; stat: string; at: string } | null;
   /** The last fatal error the supervisor recorded before it stopped (the run stays resumable). */
   lastError?: string;
+  /** Consecutive start-up harness checks that timed out; reset once a session verifies, so one slow check is retried, not fatal (engine.ts). */
+  harnessTimeouts?: number;
   selfImprove?: SelfImproveState;
   /** Generations (Memento mode), when the contract enables them and the Memento allowance permits more than one (engine.ts). */
   generations?: GenerationState;
diff --git a/packages/autonomy/lib/rpc.ts b/packages/autonomy/lib/rpc.ts
--- a/packages/autonomy/lib/rpc.ts
+++ b/packages/autonomy/lib/rpc.ts
@@ -338,6 +338,7 @@ export class HarnessCheck {
   private reason: string | null = null;
   private missingOptional: readonly string[] = [];
   private degradedReported = false;
+  private timedOut = false;
 
   constructor(required: readonly string[] = HARNESS_CORE, optional: readonly string[] = HARNESS_OPTIONAL) {
     this.required = required;
@@ -350,6 +351,7 @@ export class HarnessCheck {
     this.reason = null;
     this.missingOptional = [];
     this.degradedReported = false;
+    this.timedOut = false;
   }
 
   /** Settle the check on a get_commands reply: true when every required command is present (optional ones may be missing: see `degraded`). Once settled (including by `expire()`), a later reply must not overwrite the verdict. */
@@ -382,6 +384,7 @@ export class HarnessCheck {
   expire(): void {
     if (this.state !== "pending") return;
     this.state = "failed";
+    this.timedOut = true;
     this.reason = `the kit harness check timed out after ${String(HARNESS_CHECK_TIMEOUT_MS)}ms`;
   }
 
@@ -390,4 +393,7 @@ export class HarnessCheck {
 
   /** Why the session is unusable, or null while pending or once verified. */
   get failure(): string | null { return this.reason; }
+
+  /** True when the failure is the start-up check timing out rather than a reply that lacked commands. */
+  get failureIsTimeout(): boolean { return this.timedOut; }
 }
diff --git a/packages/autonomy/lib/runtime.ts b/packages/autonomy/lib/runtime.ts
--- a/packages/autonomy/lib/runtime.ts
+++ b/packages/autonomy/lib/runtime.ts
@@ -192,6 +192,7 @@ export class DockerRuntime implements Runtime {
   sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
   log(line: string): void { console.log(`${new Date().toISOString()} ${line}`); }
   workerProblem(): string | null { return this.harness.failure; }
+  workerProblemKind(): "timeout" | "missing" | null { return this.harness.failure === null ? null : this.harness.failureIsTimeout ? "timeout" : "missing"; }
   workerDegraded(): readonly string[] { return this.harness.takeDegraded(); }
 
   /** The inference key; preflight() reads it before anything needs it. */
diff --git a/packages/autonomy/tests/fake-runtime.ts b/packages/autonomy/tests/fake-runtime.ts
--- a/packages/autonomy/tests/fake-runtime.ts
+++ b/packages/autonomy/tests/fake-runtime.ts
@@ -237,13 +237,20 @@ export class FakeRuntime implements Runtime {
   /** Each session's harness verdict, settled at start on `harnessReply` (the real check; the default reply has every command). */
   readonly harness = new HarnessCheck();
   harnessReply: unknown = { type: "response", id: "harness-check", data: { commands: HARNESS_COMMANDS.map((name) => ({ name })) } };
+  /** 1-based worker sessions whose start-up check expires before a reply, to simulate a slow host. */
+  harnessTimeoutSessions = new Set<number>();
+  private harnessSessions = 0;
   workerProblem(): string | null { return this.workerProblemText ?? this.harness.failure; }
+  workerProblemKind(): "timeout" | "missing" | null { return this.harness.failure === null ? null : this.harness.failureIsTimeout ? "timeout" : "missing"; }
   workerDegraded(): readonly string[] { return this.harness.takeDegraded(); }
 
   // --- the worker ---------------------------------------------------------------------------------
   startWorker({ step, attempt, effort, onEvent, resetWorkspace }: StartWorkerOptions): FakeAgent {
     const name = `${this.cfg.namePrefix}-agent-${String(step).padStart(2, "0")}-${attempt}`;
     this.harness.reset();
+    this.harnessSessions++;
+    if (this.harnessTimeoutSessions.has(this.harnessSessions)) this.harness.expire();
+    else this.harness.settle(this.harnessReply);
     this.harness.settle(this.harnessReply);
     let resolveExit: (result: { code: number } | undefined) => void = () => {};
     const exited = new Promise<{ code: number } | undefined>((r) => { resolveExit = r; });
diff --git a/tests/autonomy-events-smoke.ts b/tests/autonomy-events-smoke.ts
--- a/tests/autonomy-events-smoke.ts
+++ b/tests/autonomy-events-smoke.ts
@@ -333,6 +333,36 @@ await check("a worker without an optional harness command degrades the run; one
   }
 });
 
+await check("a start-up harness check that times out is retried, then parks the run instead of failing it", async () => {
+  // One slow host check: a fresh session retries and the run still succeeds.
+  const retried = harness(simpleRaw({ run: "harness-timeout-retry-1" }), { script: solve });
+  const rt = retried.runtime(solve);
+  rt.harnessTimeoutSessions = new Set([1]);
+  const done1 = await runOnce(retried, { rt });
+  assert.equal(done1.state.status, "succeeded", "the retried session finished the work");
+  assert.equal(rt.calls.workers.length, 2, "the timed-out session was replaced by a fresh one");
+  assert.equal(done1.state.harnessTimeouts, 0, "a verified session clears the consecutive count");
+  assert.deepEqual(readEvents(retried.home, { types: ["failure"] }).events, []);
+
+  // A timeout that persists parks the run (paused, for the host's run unit to resume), not fails it.
+  let parkedAt: string | null = null;
+  const parked = harness(simpleRaw({ run: "harness-timeout-parked-1" }), {
+    script: solve,
+    hooks: { onSleep: () => {
+      const s = parked.state();
+      if (s.status === "paused" && parkedAt === null) { parkedAt = s.history.at(-1)?.reason ?? null; parked.store.enqueue("cancel", { reason: "test" }); }
+    } },
+  });
+  const rt2 = parked.runtime(solve);
+  rt2.harnessTimeoutSessions = new Set([1, 2]);
+  const done2 = await runOnce(parked, { rt: rt2 });
+  assert.equal(done2.state.status, "cancelled", "the test ends the parked run");
+  assert.equal(parkedAt, "harness_check_timeout", "the run parked on the mechanical harness timeout reason");
+  assert.ok(done2.state.history.some((h) => h.to === "paused" && h.reason === "harness_check_timeout"), "the history records the park");
+  assert.ok(!done2.state.history.some((h) => h.to === "failed"), "a slow check never fails the run");
+  assert.deepEqual(readEvents(parked.home, { types: ["failure"] }).events, []);
+});
+
 cleanup();
 for (const d of dirs) rm(d);
 done();
```

One tidy-up for whoever lands it: the hunk in `packages/autonomy/tests/fake-runtime.ts` leaves the
pre-existing `this.harness.settle(this.harnessReply);` line in place after the new `if`/`else`, so
`settle` is called twice on the non-timeout path. It is a no-op (`settle` returns early once
settled) and the tests pass either way, but the second call should be deleted when the patch is
applied by hand.

## Test

`tests/autonomy-events-smoke.ts`, new check "a start-up harness check that times out is retried, then
parks the run instead of failing it" (in the patch above). It covers both outcomes: one timed-out
session is retried and the run still succeeds with `harnessTimeouts` cleared and no `failure` event;
a timeout that persists parks the run `paused` with reason `harness_check_timeout` and never
records `failed`. At the base commit the first assertion fails because the run is terminal `failed`
(`worker_unavailable`) after the first timed-out check.

## Verification already done against this cycle's base

In a scratch worktree at `eb527a54d912` with `git cherry-pick -x 2e10298c` (applies cleanly, no
conflict):

- `node tests/autonomy-events-smoke.ts` — 11/11, including the new check.
- `node tests/autonomy-smoke.ts` — 41/41; `node tests/autonomy-lifecycle-smoke.ts` — 30/30.
- `node packages/core/check-all.ts --for-changed=docs/autonomy.md,packages/autonomy/lib/engine.ts,packages/autonomy/lib/lifecycle.ts,packages/autonomy/lib/rpc.ts,packages/autonomy/lib/runtime.ts,packages/autonomy/tests/fake-runtime.ts,tests/autonomy-events-smoke.ts` — pass, as reported by cycle 03; typecheck and lint were green there too.

## What the owner needs to decide

Nothing policy-shaped: no permission, budget, credential, gate-policy or release setting changes.
The only judgement is whether one retry before parking is the right tolerance; it is
`HARNESS_TIMEOUT_RETRIES` in `engine.ts` if a different number is preferred, and the parked reason
(`harness_check_timeout`) is what a resume path and the `/autonomy` status view would show.
