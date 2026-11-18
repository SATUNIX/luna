#!/usr/bin/env node
/**
 * DETERMINISTIC FAKE-RUNTIME tests of the self-improve template running through the generic
 * engine (packages/autonomy/lib/templates/self-improve.ts): the v0 behaviour, now one optional
 * template. Not a real-provider run: the worker and the manager/review models are scripted, the
 * git work (host mirror, integration branch, merges, tags, local publication) is real.
 *   - charter/backlog seeded from the CONTRACT on a configurable integration branch
 *   - cycles merged only after passing the acceptance checks and a merge review
 *   - a red cycle is kept as a tag and offered to the next cycle as attempts/<run>/cycle-NN
 *   - nothing-found stop, cycle limit, manager triggers, a blocking question
 *   - promotion defaults to LOCAL only: no remote is contacted unless the contract lists one
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, makeChecker, rm, tempDir, testEffort, type RawContract } from "./autonomy-helpers.ts";
import { cleanup, fakeAlive, harness, runOnce, scratch, NODE_EXIT, type Harness, type HarnessRuntime, type MadeEngine, type ManagerFn, type ScriptContext } from "./autonomy-harness.ts";
import { main } from "../packages/autonomy/cli.ts";
import { GateWaitInterrupted, LockLost } from "../packages/autonomy/lib/engine.ts";
import { acquireGateSlot } from "../packages/autonomy/lib/gate-slots.ts";
import { resolveContract } from "../packages/autonomy/lib/contract.ts";
import { exportRun } from "../packages/autonomy/lib/export.ts";
import { parseBoardReport, WORK_PRECEDENCE } from "../packages/autonomy/lib/board.ts";
import { runtimeConfig } from "../packages/autonomy/lib/runcfg.ts";
import * as gm from "../packages/autonomy/lib/gitmirror.ts";
import { bookkeepingPaths } from "../packages/autonomy/lib/bookkeeping.ts";
import { ALWAYS_CHECKS, CHANGED_PATH_CHECKS, checksForChangedPaths, verifyPlan } from "../packages/core/lib/check-map.ts";

const { check, done } = makeChecker("autonomy-selfimprove-smoke");
/** The checkout root, for the root package.json and the cycle prompt template. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** One host-side model call the scripted manager saw. */
interface ManagerCall {
  system: string;
  user: string;
  model: string;
}

/** What the scripted manager answers: a merge-review verdict and/or a manager decision. */
interface ManagerScript {
  review?: string;
  manager?: Record<string, unknown>;
}

type ResolveResult = ReturnType<typeof resolveContract>;

/** The resolved contract of a successful resolution (narrows away the null of a failed one). */
const contractOf = (r: ResolveResult): Extract<ResolveResult, { ok: true }>["contract"] => {
  assert.ok(r.ok, JSON.stringify(r.problems));
  return r.contract;
};

/** The host mirror's git runner; fake-runtime.ts opens the mirror before any cycle, so it is set by the time a test reads it. */
const mirrorGit = (rt: HarnessRuntime): NonNullable<HarnessRuntime["repo"]["g"]> => {
  const g = rt.repo.g;
  assert.ok(g, "the host mirror is open");
  return g;
};

/** Run `pi-autonomy <argv>` in-process against a harness home and return its code and captured output. */
const cliRun = async (h: Harness, argv: readonly string[]): Promise<{ code: number; out: string; err: string }> => {
  const out: string[] = []; const err: string[] = [];
  const code = await main(argv, {
    // In-process: never install process-wide SIGINT/SIGTERM handlers. A handler only sets a flag, so a test that
    // spins on microtasks could then not be stopped by timeout(1) or kill (2026-11-13: three runs, 75+ CPU-minutes each).
    signals: false,
    home: h.home,
    now: () => new Date(h.clock.now),
    stdout: { write: (s: string): number => out.push(s) },
    stderr: { write: (s: string): number => err.push(s) },
  });
  return { code, out: out.join(""), err: err.join("") };
};

const gitIn = (cwd: string, args: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
const sh = (cwd: string, ...args: string[]): string => { const r = gitIn(cwd, args); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };

function sourceRepo(): string {
  const src = scratch();
  sh(src, "init", "--quiet", "-b", "main");
  fs.writeFileSync(path.join(src, "README.md"), "hello\n");
  sh(src, "add", "."); sh(src, "commit", "--quiet", "-m", "base");
  return src;
}

const improveRaw = (src: string, over: RawContract = {}): RawContract => ({
  schemaVersion: 1, run: "improve-test-1", template: "self-improve",
  objective: { title: "Improve", spec: "Fix what is broken, and add the audit marker.", backlog: [{ id: "B-1", title: "Add the audit marker", detail: "A file called AUDIT_OK must exist." }] },
  inputs: { repository: { path: src, ref: "main" } },
  acceptance: { checks: [{ id: "gate", run: NODE_EXIT("require('fs').existsSync('AUDIT_OK')"), timeoutMinutes: 1, required: true }], review: true },
  permissions: { unattended: { authorised: true, autoApprove: true } },
  budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 8, maxMinutes: 5000 },
  promotion: { policy: "local-branch", destinations: [{ kind: "local-branch", repo: src, branch: "pi-autonomy/integration" }] },
  templateOptions: { integration: { branch: "pi-autonomy/integration", review: true }, limits: { nothingFoundToStop: 2 } },
  ...over,
});

/** A source repository whose base already passes the gate: a cycle on it starts without a repair, and its `AUDIT_OK` edit is a real change. */
function greenSourceRepo(): string {
  const src = sourceRepo();
  fs.writeFileSync(path.join(src, "AUDIT_OK"), "base\n");
  sh(src, "add", "."); sh(src, "commit", "--quiet", "-m", "base passes the gate");
  return src;
}

/** The item at `i`, failing when the test expected more items than there are. */
const nth = <T>(items: readonly T[], i: number): T => {
  const item = items[i];
  assert.ok(item !== undefined, `expected an item at index ${i} of ${items.length}`);
  return item;
};

const report = (t: ScriptContext, outcome: string, mode = "fix", extra = ""): void => t.note(`Outcome: ${outcome}\nMode: ${mode}\n\n${extra}\n`);
const mergeReview = (verdict = "MERGE"): string => JSON.stringify({ verdict, reason: verdict === "MERGE" ? "evidenced and tested" : "no test for the change", concerns: [] });
const manager = (calls: ManagerCall[], decide?: ManagerScript): ManagerFn => async (system: string, user: string, model: string): Promise<string> => {
  calls.push({ system, user, model });
  if (/You review one cycle/.test(system)) return mergeReview(decide?.review ?? "MERGE");
  return decide?.manager ? JSON.stringify(decide.manager) : JSON.stringify({ decision: "CONTINUE", reason: "fine", extendMinutes: 10 });
};

await check("upstream validates branch syntax and must differ from the integration branch", () => {
  for (const upstream of ["../bad", "bad.lock", "bad/", "pi-autonomy/integration", 2, "-option"]) {
    const resolved = resolveContract(improveRaw(sourceRepo(), { templateOptions: { integration: { upstream } } }), { effort: testEffort });
    assert.equal(resolved.ok, false, String(upstream));
    assert.ok(resolved.problems.some((p) => p.path === "templateOptions.integration.upstream"));
  }
  const none = resolveContract(improveRaw(sourceRepo(), { promotion: { policy: "none", destinations: [] }, templateOptions: { integration: { upstream: "integration/trunk" } } }), { effort: testEffort });
  assert.equal(none.ok, false, "an upstream with no promotion remote could never be fetched");
  assert.ok(none.problems.some((p) => p.path === "templateOptions.integration.upstream" && /policy "none"/.test(p.message)));
});

await check("an unusable review reply parks the cycle with its work intact instead of rejecting it; the question names the review", async () => {
  const src = sourceRepo();
  const garbled: ManagerFn = async (system) => (/You review one cycle/.test(system) ? "I could not decide." : JSON.stringify({ decision: "CONTINUE", reason: "fine", extendMinutes: 10 }));
  const seen: { parked: ReturnType<Harness["state"]> | null } = { parked: null };
  const h: Harness = harness(improveRaw(src, { run: "improve-review-down", budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 1, maxMinutes: 5000 } }), {
    manager: garbled,
    hooks: { onSleep: () => { const s = h.state(); if (s.status === "blocked" && !seen.parked) { seen.parked = structuredClone(s); h.store.enqueue("cancel", { reason: "test done" }); } } },
    script: async (t) => { t.write("AUDIT_OK", "1"); report(t, "successful"); t.commit("c"); },
  });
  await runOnce(h);
  assert.equal(seen.parked?.pendingQuestions?.at(-1)?.id, "review-pending");
  assert.equal(seen.parked?.selfImprove?.history.length, 0, "no verdict was recorded: the cycle was not rejected");
  assert.ok(seen.parked?.selfImprove?.current, "the cycle stays current, so an answer re-runs its review");
});

await check("answering review-pending retries the review on the held head: no new worker session, and the merge follows", async () => {
  const src = sourceRepo();
  let reviewerUp = false;
  const flaky: ManagerFn = async (system) => (/You review one cycle/.test(system) ? (reviewerUp ? mergeReview() : "I could not decide.") : JSON.stringify({ decision: "CONTINUE", reason: "fine", extendMinutes: 10 }));
  let sessions = 0;
  let answered = false;
  const h: Harness = harness(improveRaw(src, { run: "improve-review-resume", budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 1, maxMinutes: 5000 } }), {
    manager: flaky,
    hooks: { onSleep: () => { const s = h.state(); if (s.status === "blocked" && !answered) { answered = true; reviewerUp = true; h.store.enqueue("answer", { text: "continue" }); } } },
    script: async (t) => { sessions++; t.write("AUDIT_OK", "1"); report(t, "successful"); t.commit("c"); },
  });
  const { state } = await runOnce(h);
  assert.ok(answered, "the run parked on the unusable review");
  assert.equal(sessions, 1, "the answer re-ran the review; it did not start a second worker session");
  assert.equal(state.selfImprove?.history.at(-1)?.merged, true, "the held head merged once the reviewer answered");
  assert.equal(state.selfImprove?.current ?? null, null);
});

await check("an unparseable reviewer reply that merely quotes an object is infrastructure failure, not a verdict", async () => {
  const { parseReview: parse, reviewCycle: review } = await import("../packages/autonomy/lib/review.ts");
  const { parseDecision } = await import("../packages/autonomy/lib/manager.ts");
  const quoted = 'I could not complete the review. The report contained {"verdict":"MERGE","reason":"quoted from diff"} which I ignore, and I conclude {oops';
  assert.throws(() => parse(quoted), /no JSON object/);
  assert.throws(() => parse('{"verdict":"MERGE","reason":"a"} and also {"verdict":"REJECT","reason":"b"}'), /no JSON object/, "two objects are ambiguous");
  assert.throws(() => parse('Here is an object {"note":1}'), /unknown verdict/, "an object without the verdict key is not a verdict");
  assert.equal(parse('Verdict follows. {"verdict":"MERGE","reason":"ok"}').verdict, "MERGE", "one clean object in prose still parses");
  assert.throws(() => parseDecision('See {"decision":"NEW_CYCLE","reason":"x"} and {"decision":"ABORT_RUN","reason":"y"}'), /no JSON object/);
  const out = await review({ run: "r", cycle: 1, outcome: "completed", integrationBranch: "b" }, async () => quoted, { attempts: 1, sleep: async () => undefined, fallback: async () => '{"verdict":"MERGE","reason":"second"}' });
  assert.equal(out.verdict, "MERGE");
  assert.equal(out.fallbackUsed, true, "a verdict from the fallback reviewer is marked so review.json can name the model that answered");
  const none = await review({ run: "r", cycle: 1, outcome: "completed", integrationBranch: "b" }, async () => quoted, { attempts: 1, sleep: async () => undefined });
  assert.equal(none.unavailable, true);
});

await check("Board: parsing accepts only exact bounded lines and one entry per id", () => {
  assert.deepEqual(parseBoardReport([
    "Board: V-01 done - Finished with tests.", "Board: V-02 progress - One part remains.", "Board: V-03 blocked - Needs a decision.",
    " Board: V-04 done - indented", "Board: bad done - invalid", "Board: V-05 complete - invalid", "Board: V-06 done", "Board: V-07 done - ",
    "Board: V-08 done - " + "x".repeat(501), "Board: V-01 blocked - duplicate", "prose Board: V-09 done - ignored",
  ].join("\r\n")), [
    { id: "V-01", status: "done", note: "Finished with tests." }, { id: "V-02", status: "progress", note: "One part remains." }, { id: "V-03", status: "blocked", note: "Needs a decision." },
  ]);
  assert.deepEqual(parseBoardReport(null), []);
});

await check("stream bookkeeping seeds the charter and proposals but no handoff, preserves the charter, and follows resume, restart, manager and merge review; the cycle record is the host receipt and the worker note in the state home", async () => {
  for (const stream of [false, true]) {
    const src = sourceRepo();
    const charter = "# Existing operator charter\nKeep this exact charter.\n";
    fs.mkdirSync(path.join(src, "autonomy"));
    fs.writeFileSync(path.join(src, "autonomy", "CHARTER.md"), charter);
    fs.writeFileSync(path.join(src, "autonomy", "BACKLOG.md"), "Shared backlog\n");
    fs.writeFileSync(path.join(src, "autonomy", "HANDOFF.md"), "Another run's shared handoff\n");
    sh(src, "add", "."); sh(src, "commit", "--quiet", "-m", "existing shared records");
    sh(src, "branch", "integration/trunk");
    const paths = bookkeepingPaths({ run: "improve-test-1", integrationUpstream: stream ? "integration/trunk" : null }, 1);
    let phase = 0;
    const calls: ManagerCall[] = [];
    const script = async (t: ScriptContext): Promise<void> => {
      phase++;
      assert.ok(t.message.includes(paths.proposals), t.message);
      assert.doesNotMatch(t.message, /HANDOFF|JOURNAL/, "the prompt no longer asks for repository records");
      assert.doesNotMatch(t.message, /\{\{[A-Z_]+\}\}/);
      if (phase === 1) {
        assert.equal(t.read("autonomy/runs/improve-test-1/HANDOFF.md"), null, "no handoff is seeded");
        if (stream) {
          assert.equal(t.read("autonomy/CHARTER.md"), charter);
          assert.equal(t.read("autonomy/BACKLOG.md"), "Shared backlog\n");
          assert.equal(t.read("autonomy/HANDOFF.md"), "Another run's shared handoff\n");
          assert.match(t.read("autonomy/proposals/improve-test-1-00-1-b-1-add-the-audit-marker.md") ?? "", /Status: proposal[\s\S]*A file called AUDIT_OK/);
          assert.match(t.message, /never edit the shared autonomy\/BACKLOG.md/);
        } else {
          assert.match(t.read("autonomy/BACKLOG.md") ?? "", /\| B-1 \| open/);
        }
        t.write(paths.proposals.replace("<slug>", "follow-up"), "New proposal with evidence\n");
        t.commit("checkpoint bookkeeping");
        fs.writeFileSync(path.join(t.store.p.root, "STOP"), ""); t.hang();
      } else if (phase === 2) {
        assert.match(t.message, /previous session of this cycle was interrupted/);
        t.crash();
      } else if (phase === 3) {
        assert.match(t.message, /previous worker process exited/);
        t.elapse(181); t.hang();
      } else {
        assert.match(t.message, /Manager restart with carry-over/);
        t.write("AUDIT_OK", "1"); t.commit("finish bookkeeping cycle"); t.note("Outcome: successful\nMode: fix\n\nRun-specific carry-over evidence\n");
      }
    };
    const h = harness(improveRaw(src, {
      budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 1, maxMinutes: 5000 },
      templateOptions: { integration: { ...(stream ? { upstream: "integration/trunk" } : {}) } },
    }), {
      script,
      manager: async (system, user, model) => {
        calls.push({ system, user, model });
        if (/You review one cycle/.test(system)) return mergeReview();
        assert.match(user, /## The worker's cycle note[\s\S]*\(not written yet\)/);
        assert.doesNotMatch(user, /Another run's shared handoff/);
        return JSON.stringify({ decision: "RESTART_SESSION", reason: "test restart", message: "Manager restart with carry-over" });
      },
    });
    await runOnce(h);
    assert.equal(h.state().status, "paused");
    fs.rmSync(path.join(h.store.p.root, "STOP")); h.store.enqueue("unpause");
    const resumed = await runOnce(h, { rt: h.runtime(script) });
    assert.equal(phase, 4);
    assert.equal(resumed.state.selfImprove?.history[0]?.merged, true);
    const review = nth(calls.filter((c) => /You review one cycle/.test(c.system)), 0);
    assert.ok(review.system.includes(paths.proposals));
    assert.doesNotMatch(review.user, /## Handoff/);
    assert.match(review.user, /## Worker note[\s\S]*Run-specific carry-over evidence/, "the review reads the worker's note from the state home");
    const receipt = JSON.parse(fs.readFileSync(path.join(h.store.p.steps, "01", "receipt.json"), "utf8")) as { merged: boolean; changedPaths: string[]; note: { outcome: string | null; present: boolean } };
    assert.equal(receipt.merged, true);
    assert.ok(receipt.changedPaths.includes("AUDIT_OK"));
    assert.deepEqual([receipt.note.outcome, receipt.note.present], ["successful", true]);
    assert.match(fs.readFileSync(path.join(h.store.p.steps, "01", "note.md"), "utf8"), /Run-specific carry-over evidence/);
    assert.equal(resumed.rt.repo.fileAt(resumed.rt.repo.head(), "autonomy/cycles/improve-test-1/01/report.md"), null, "no cycle report is committed");
    if (stream) assert.equal(resumed.rt.repo.fileAt(resumed.rt.repo.head(), "autonomy/CHARTER.md"), charter.trim());
    // A stream is judged against the current stream charter (the seed rendered by the host), not an older trunk copy.
    if (stream) { assert.match(review.user, /# Improvement charter[\s\S]*The steward board items in order/); assert.doesNotMatch(review.user, /Keep this exact charter/); }
  }
});

await check("an adopted stream branch gets a charter and proposals but no handoff; a missing charter uses stream proposal paths", async () => {
  for (const existing of [false, true]) {
    const src = sourceRepo();
    if (existing) {
      fs.mkdirSync(path.join(src, "autonomy"));
      fs.writeFileSync(path.join(src, "autonomy", "CHARTER.md"), "# Preserve adopted charter\n");
      sh(src, "add", "."); sh(src, "commit", "--quiet", "-m", "charter");
    }
    sh(src, "branch", "pi-autonomy/integration"); sh(src, "branch", "integration/trunk");
    const h = harness(improveRaw(src, {
      budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 1, maxMinutes: 5000 },
      templateOptions: { integration: { upstream: "integration/trunk" } },
    }), { manager: manager([]), script: async (t) => {
      assert.equal(t.read("autonomy/runs/improve-test-1/HANDOFF.md"), null);
      assert.equal(t.read("autonomy/HANDOFF.md"), null);
      assert.equal(t.read("autonomy/BACKLOG.md"), null);
      if (existing) assert.equal(t.read("autonomy/CHARTER.md"), "# Preserve adopted charter\n");
      else {
        assert.match(t.read("autonomy/CHARTER.md") ?? "", /autonomy\/proposals\/<run>-<NN>-<slug>\.md/);
        assert.doesNotMatch(t.read("autonomy/CHARTER.md") ?? "", /autonomy\/BACKLOG.md/);
      }
      t.write("AUDIT_OK", "1"); report(t, "successful"); t.commit("stream ready");
    } });
    const { state } = await runOnce(h);
    assert.equal(state.selfImprove?.merged, 1);
  }
});

await check("heartbeat follows engine ticks independently of the lock timer; STOP before setup cancels without starting workers", async () => {
  const h = harness(improveRaw(sourceRepo()));
  const made = h.engine();
  made.engine.state = h.state();
  made.engine.go("ready"); made.engine.go("running");
  made.engine.state.phase = "work";
  made.engine.state.step = 7;
  made.engine.tick();
  const beat = path.join(h.store.p.root, "heartbeat.json");
  const before = fs.readFileSync(beat, "utf8");
  h.clock.now += 30_000;
  made.engine.state.phase = "review";
  made.engine.tick();
  assert.notEqual(fs.readFileSync(beat, "utf8"), before);
  assert.deepEqual(JSON.parse(fs.readFileSync(beat, "utf8")), { at: new Date(h.clock.now).toISOString(), phase: "review", cycle: 7, status: "running" });
  made.lock.release();
  const stopped = harness(improveRaw(sourceRepo()));
  fs.writeFileSync(path.join(stopped.store.p.root, "STOP"), "");
  const r = await runOnce(stopped);
  assert.deepEqual([r.state.status, r.state.outcome?.reason], ["cancelled", "stop_file"]);
  assert.equal(r.rt.calls.prepare, 0);
  assert.equal(r.rt.calls.workers.length, 0);
});

await check("gate slots: a waiting engine heartbeats gate-wait, freezes wall-clock minutes and resumes into acceptance", async () => {
  const h = harness(improveRaw(sourceRepo()));
  let resolveGate: () => void = () => {};
  const gate = new Promise<void>((r) => { resolveGate = r; });
  const made = h.engine({
    gateSlots: 2,
    gateSlotAcquire: async ({ onWait }) => { onWait(); await gate; return { index: 0, release: () => {} }; },
  });
  made.engine.state = h.state();
  made.engine.go("ready"); made.engine.go("running");
  made.engine.state.phase = "acceptance";
  made.engine.tick(); // set lastTickAt so the next interval is real active time
  const minutesBefore = made.engine.state.usage.minutes;
  h.clock.now += 30_000;
  let ran = false;
  const p = made.engine.withGateSlot(async () => { ran = true; return "ok"; });
  await new Promise((r) => setTimeout(r, 20));
  const beat = JSON.parse(fs.readFileSync(path.join(h.store.p.root, "heartbeat.json"), "utf8")) as { phase?: string };
  assert.equal(beat.phase, "gate-wait");
  assert.equal(ran, false, "the gate does not run while waiting");
  assert.ok(Math.abs(made.engine.state.usage.minutes - (minutesBefore + 0.5)) < 1e-9, "the active 30s before the wait is charged");
  h.clock.now += 60_000;
  made.engine.tick();
  assert.ok(Math.abs(made.engine.state.usage.minutes - (minutesBefore + 0.5)) < 1e-9, "waiting does not count against the wall-clock budget");
  resolveGate();
  assert.equal(await p, "ok");
  assert.equal(ran, true);
  assert.equal(made.engine.state.phase, "acceptance");
  made.lock.release();
});

await check("gate slots: a STOP signal or a pause while waiting for a slot interrupts the acceptance and parks the run (DE-102)", async () => {
  for (const how of ["signal", "pause"] as const) {
    const home = tempDir("autonomy-slot-wait-stop-");
    const busy = await acquireGateSlot({ home, limit: 1, pollMs: 20 });
    const h = harness(improveRaw(sourceRepo()));
    const made = h.engine({ gateSlots: 1, gateSlotsHome: home });
    made.engine.state = h.state();
    made.engine.go("ready"); made.engine.go("running");
    made.engine.state.phase = "acceptance";
    let ran = false;
    const p = made.engine.withGateSlot(async () => { ran = true; return "ran"; });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(made.engine.state.phase, "gate-wait", `${how}: the engine is waiting for a slot`);
    if (how === "signal") made.engine.signalled = true;
    else h.store.enqueue("pause", { reason: "operator pause during gate-wait" });
    await assert.rejects(p, (error: unknown) => error instanceof GateWaitInterrupted, `${how}: the wait ends`);
    assert.equal(ran, false, `${how}: the acceptance never runs`);
    assert.equal(made.engine.status, "paused", `${how}: the run is parked`);
    assert.equal(made.engine.state.phase, "acceptance", `${how}: the phase is restored`);
    // The engine records it as a stop, not a supervisor error, and stays resumable.
    await made.engine.handleFatal(new GateWaitInterrupted());
    assert.equal(made.engine.status, "paused");
    assert.notEqual(made.engine.state.history.at(-1)?.reason, "supervisor_error", `${how}: not a supervisor error`);
    busy.release();
    made.lock.release();
    rm(home);
  }
});

await check("gate slots: three supervisors with N=2 never overlap more than two gates; the third waits in gate-wait then runs", async () => {
  const gateSlotsHome = tempDir("autonomy-slots-three-");
  const runs: Array<{ made: ReturnType<Harness["engine"]>; h: Harness }> = [];
  for (let i = 0; i < 3; i++) {
    const h = harness(improveRaw(sourceRepo()));
    const made = h.engine({ gateSlots: 2, gateSlotsHome });
    made.engine.state = h.state();
    made.engine.go("ready"); made.engine.go("running");
    made.engine.state.phase = "acceptance";
    runs.push({ made, h });
  }
  let live = 0;
  let maxOverlap = 0;
  const releases: Array<() => void> = [];
  const gate = async (): Promise<string> => {
    live += 1;
    maxOverlap = Math.max(maxOverlap, live);
    await new Promise<void>((resolve) => {
      let done = false;
      releases.push(() => { if (done) return; done = true; live -= 1; resolve(); });
    });
    return "ok";
  };
  const [first, second, waiting] = runs;
  assert.ok(first && second && waiting, "three supervisors built");
  const p1 = first.made.engine.withGateSlot(gate);
  const p2 = second.made.engine.withGateSlot(gate);
  for (let i = 0; i < 300 && live < 2; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(live, 2, "two gates run at once");
  assert.equal(maxOverlap, 2, "no more than two gates overlap");
  const p3 = waiting.made.engine.withGateSlot(gate);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(live, 2, "the third gate does not start while both slots are held");
  assert.equal(waiting.made.engine.state.phase, "gate-wait", "the third engine waits in gate-wait");
  const beat = JSON.parse(fs.readFileSync(path.join(waiting.h.store.p.root, "heartbeat.json"), "utf8")) as { phase?: string };
  assert.equal(beat.phase, "gate-wait", "the third engine heartbeats gate-wait");
  const releaseFirst = releases[0];
  assert.ok(releaseFirst);
  releaseFirst();
  for (let i = 0; i < 300 && releases.length < 3; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(releases.length, 3, "the third gate starts once a slot is free");
  assert.equal(maxOverlap, 2, "still no more than two gates overlap");
  releases.forEach((release) => release());
  assert.deepEqual(await Promise.all([p1, p2, p3]), ["ok", "ok", "ok"]);
  runs.forEach(({ made }) => made.lock.release());
  rm(gateSlotsHome);
});

await check("gate slots: a throwing gate restores the previous phase and clears clockPaused; a lost lock throws without pausing", async () => {
  const h = harness(improveRaw(sourceRepo()));
  const made = h.engine({ gateSlots: 2, gateSlotAcquire: async () => ({ index: 0, release: () => {} }) });
  made.engine.state = h.state();
  made.engine.go("ready"); made.engine.go("running");
  made.engine.state.phase = "work";
  await assert.rejects(() => made.engine.withGateSlot(async () => { throw new Error("gate blew up"); }), /gate blew up/);
  assert.equal(made.engine.clockPaused, false, "a throwing gate leaves the clock running");
  assert.equal(made.engine.state.phase, "work", "the previous phase is restored");
  made.engine.lockLost = true;
  await assert.rejects(() => made.engine.withGateSlot(async () => "never"), (error: unknown) => error instanceof LockLost);
  assert.equal(made.engine.clockPaused, false, "a lost lock never leaves the clock paused");
  assert.equal(made.engine.state.phase, "work", "a lost lock restores the previous phase");
  made.lock.release();
});

await check("v0 behaviour through the engine: seeded from the contract, cycles merged after gate and review, nothing-found ends the run; the result is a LOCAL branch only", async () => {
  const src = sourceRepo();
  const baseSha = sh(src, "rev-parse", "HEAD");
  const calls: ManagerCall[] = []; const prompts: string[] = [];
  const h = harness(improveRaw(src), {
    manager: manager(calls),
    script: async (t) => {
      prompts.push(t.message);
      t.spend(0.1);
      if (prompts.length === 1) { t.write("AUDIT_OK", "1\n"); report(t, "successful", "fix", "Added the marker."); }
      else report(t, "nothing found", "fix", "Checked every backlog item."); // no commit, and no records in the repository
      t.commit(`cycle ${prompts.length}`);
    },
  });
  const { state, rt } = await runOnce(h);
  assert.equal(state.status, "succeeded", JSON.stringify(state.outcome));
  assert.deepEqual([state.outcome?.status, state.outcome?.reason], ["succeeded", "backlog_exhausted"], "several nothing-found cycles in a row end the run");
  const si = state.selfImprove;
  assert.ok(si, "the self-improve record is kept in state");
  assert.deepEqual(si.history.map((c) => [c.n, c.outcome, c.gate, c.merged, c.reportOutcome]), [[1, "completed", "green", true, "successful"], [2, "completed", "skipped", false, "nothing found"], [3, "completed", "skipped", false, "nothing found"]]);
  assert.equal(si.merged, 1, "a nothing-found cycle commits nothing, so there is nothing to merge");
  assert.equal(state.acceptance.latest?.allRequiredPass, true, "the run ends with a green acceptance run on the integration head as evidence");
  // Seeded from the contract: the objective, the acceptance checks and the backlog, on a configurable branch.
  const integration = mirrorGit(rt)(["rev-parse", "refs/heads/pi-autonomy/integration"]);
  const charter = rt.repo.fileAt(integration, "autonomy/CHARTER.md") ?? "";
  assert.match(charter, /Fix what is broken, and add the audit marker\./);
  assert.match(charter, /- gate \(required\)/, "the checks are listed, without their definitions' source");
  assert.doesNotMatch(charter, /pi-system|mkdocs|gitleaks|home\.internal/i, "the seed is general, not specific to one repository");
  assert.match(charter, /Never run `npm test` or `npm run check:all`\s+yourself: the host gate runs the full suite/, "the host owns the full gate");
  assert.match(rt.repo.fileAt(integration, "autonomy/BACKLOG.md") ?? "", /\| B-1 \| open \| P2 \| \*\*Add the audit marker\.\*\* A file called AUDIT_OK must exist\./);
  assert.match(nth(prompts, 0), /You are working on the repository in \/work, on branch `pi\/improve-test-1`/);
  assert.doesNotMatch(nth(prompts, 0), /pi-system repository/);
  assert.match(nth(prompts, 0), /cycle 1 of 8/);
  // The cycle's record is the host's receipt and the worker's note in the state home: the worker is not asked to commit a
  // report, plan, verification record, review, handoff or journal line, and the gate's journal check has nothing new to fail on.
  assert.equal(rt.repo.fileAt(integration, "autonomy/HANDOFF.md"), null, "no handoff is seeded");
  assert.match(nth(prompts, 0), /write one short note to `\/state\/cycle-note\.md` \(outside the repository: do not commit it\)/);
  assert.doesNotMatch(nth(prompts, 0), /JOURNAL|HANDOFF|report\.md|plan\.md|verify\.md/);
  assert.match(nth(prompts, 1), /Host receipt \(cycle 01\): completed, gate green, merged[\s\S]*Added the marker\./, "the next cycle is briefed from the receipt and the note");
  assert.equal(rt.repo.fileAt(integration, "autonomy/cycles/improve-test-1/01/report.md"), null, "no cycle report is committed");
  assert.equal(rt.repo.fileAt(integration, "autonomy/JOURNAL.md"), null);
  assert.match(nth(prompts, 1), /Cycle 01 ended completed \(report recorded\); acceptance green; merged into pi-autonomy\/integration/);
  assert.match(nth(prompts, 2), /found nothing to do/);
  // Promotion: a LOCAL branch in the source repository, and nothing else. No tags, no working branch, main untouched.
  assert.equal(sh(src, "rev-parse", "refs/heads/pi-autonomy/integration"), integration);
  assert.equal(sh(src, "rev-parse", "refs/heads/main"), baseSha);
  assert.equal(sh(src, "tag", "--list"), "", "no tags are published by a local-branch promotion");
  assert.deepEqual(sh(src, "for-each-ref", "--format=%(refname)", "refs/heads").split("\n").sort(), ["refs/heads/main", "refs/heads/pi-autonomy/integration"], "the working branch never leaves the run");
  assert.equal(calls.filter((c) => /You review one cycle/.test(c.system)).length, 1, "the cycle with code was reviewed; the two `nothing found` cycles made no commit, so no model was asked");
  assert.equal(si.history[1]?.mergeReason, "no commits");
  assert.equal(calls.filter((c) => !/You review one cycle/.test(c.system)).length, 0, "the manager was never asked: no trigger fired");
  assert.deepEqual(fakeAlive(h.fakeEngine), []);
  assert.ok(state.usage.usd >= 0.3 && state.usage.steps === 3);
  assert.equal(state.promotion.status, "done");
});

await check("a red cycle is not merged: it keeps its tag, and the next cycle is told where to find it; a cycle limit ends the run as cycles_done", async () => {
  const src = sourceRepo();
  const prompts: string[] = [];
  const calls: ManagerCall[] = [];
  const h = harness(improveRaw(src, { budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 2, maxMinutes: 5000 } }), {
    manager: manager(calls),
    script: async (t) => {
      prompts.push(t.message);
      if (prompts.length === 1) { t.write("attempt.txt", "no marker yet\n"); report(t, "successful"); }
      else { t.write("AUDIT_OK", "1\n"); report(t, "successful"); }
      t.commit(`cycle ${prompts.length}`);
    },
  });
  const { state, rt } = await runOnce(h);
  const [c1, c2] = state.selfImprove?.history ?? [];
  assert.ok(c1 && c2, "two cycles are recorded");
  // Each cycle records the contract digest and limits it ran under, and its metered rows by role (attribution).
  assert.equal(c1.effective?.contractDigest, state.contractDigest, "the cycle records the contract digest in force");
  assert.deepEqual([c1.effective?.limits.managerCallsPerCycle, c1.effective?.limits.budget.maxSteps, c1.effective?.limits.budget.perStepUsd], [3, 2, 5]);
  assert.deepEqual([c1.meter?.unresolved, typeof c1.meter?.rows], [0, "number"], "no unresolved liabilities in a clean cycle");
  assert.deepEqual([c1.gate, c1.merged], ["red", false]);
  assert.match(c1.mergeReason, /^acceptance checks failed \(gate\); review MERGE: evidenced and tested/, c1.mergeReason);
  assert.equal(c1.review, "MERGE", "the red cycle is still reviewed; the verdict cannot waive the gate");
  assert.deepEqual([c1.gateFailing], [["gate"]]);
  const redReview = nth(calls.filter((c) => /You review one cycle/.test(c.system)), 0);
  assert.match(redReview.system, /acceptance checks FAILED: gate/, "the reviewer is told the gate is red (PG-46)");
  assert.match(redReview.user, /Gate RED \(gate\)/, "the review bundle names the failing check");
  assert.ok(mirrorGit(rt)(["rev-parse", "--verify", "refs/tags/pi/improve-test-1/cycle-01"]), "the unmerged cycle is kept under its tag");
  assert.match(nth(prompts, 1), /not merged into pi-autonomy\/integration: acceptance checks failed \(gate\); review MERGE: evidenced and tested\..*origin\/attempts\/improve-test-1\/cycle-01/s);
  const remoteBranches = spawnSync("git", ["--git-dir", rt.p.remote, "for-each-ref", "--format=%(refname)"], { encoding: "utf8" }).stdout;
  assert.match(remoteBranches, /refs\/heads\/attempts\/improve-test-1\/cycle-01/, "the worker's repository offers the attempt as a branch");
  assert.deepEqual([c2.gate, c2.merged], ["green", true]);
  assert.deepEqual([state.status, state.outcome?.reason], ["succeeded", "cycles_done"], "the planned cycles are done, and the last integration head passes the checks");
  assert.equal(state.usage.steps, 2);
  // A merge review that says REJECT keeps a green cycle out too.
  const src2 = sourceRepo();
  const h2 = harness(improveRaw(src2, { run: "improve-test-2", budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 1, maxMinutes: 5000 } }), { manager: manager([], { review: "REJECT" }), script: async (t) => { t.write("AUDIT_OK", "1"); report(t, "successful"); t.commit("c"); } });
  const rej = await runOnce(h2);
  assert.deepEqual([rej.state.selfImprove?.history[0]?.merged, rej.state.selfImprove?.history[0]?.review], [false, "REJECT"]);
  assert.match(rej.state.selfImprove?.history[0]?.mergeReason ?? "", /review REJECT: no test for the change/);
  assert.equal(sh(src2, "rev-parse", "refs/heads/pi-autonomy/integration"), rej.state.selfImprove?.seedSha, "only the seed commit is published: the one cycle was rejected");
  assert.equal(rej.state.status, "failed", "the integration head (the seed) does not pass the checks, so the run cannot claim success");
  assert.equal(rej.state.outcome?.reason, "final_gate_red");
});

await check("the manager is asked only on triggers; a NUDGE is steered into the live session and the cycle completes", async () => {
  const src = sourceRepo();
  const calls: ManagerCall[] = []; const prompts: Array<{ kind: string; message: string }> = [];
  const h = harness(improveRaw(src, { budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 1, maxMinutes: 5000 } }), {
    manager: manager(calls, { manager: { decision: "NUDGE", reason: "silent for 20 minutes", message: "Run the acceptance checks now." } }),
    script: async (t) => {
      prompts.push({ kind: t.kind, message: t.message });
      if (prompts.length === 1) { t.hang(); return; } // the session goes quiet
      t.write("AUDIT_OK", "1"); report(t, "successful"); t.commit("marker");
    },
  });
  const { state } = await runOnce(h);
  const asked = calls.filter((c) => !/You review one cycle/.test(c.system));
  assert.equal(asked.length, 1, asked.map((c) => c.user.split('\n')[0]).join(' | '));
  assert.match(nth(asked, 0).user, /Trigger\(s\): idle:0/);
  assert.equal(nth(prompts, 1).kind, "steer");
  assert.equal(nth(prompts, 1).message, "Run the acceptance checks now.");
  assert.equal(state.selfImprove?.history[0]?.merged, true);
  assert.deepEqual(state.selfImprove?.history[0]?.decisions.map((d) => d.decision), ["NUDGE"]);
  assert.ok(fs.existsSync(path.join(h.store.p.steps, "01", "decisions.jsonl")), "manager decisions are logged per cycle");
});

await check("a question from the worker blocks the run with the question recorded; `answer` resumes the SAME cycle in a briefed session; approvals never reach a person", async () => {
  const src = sourceRepo();
  const prompts: string[] = [];
  const h: Harness = harness(improveRaw(src, { budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 1, maxMinutes: 5000 } }), {
    manager: manager([]),
    hooks: { onSleep: () => { const s = h.state(); if (s.status === "blocked" && !h.answered) { h.answered = true; h.cycleWhenBlocked = s.selfImprove?.current?.n; h.store.enqueue("answer", { text: "Name the marker AUDIT_OK." }); } } },
    script: async (t) => {
      prompts.push(t.message);
      t.ask({ method: "confirm", title: "Run the formatter?" });
      if (prompts.length === 1) { t.ask({ method: "input", title: "What should the marker be called?" }); return; }
      t.write("AUDIT_OK", "1"); report(t, "successful"); t.commit("marker");
    },
  });
  const { state } = await runOnce(h);
  assert.equal(state.status, "succeeded", JSON.stringify(state.outcome));
  assert.equal(h.cycleWhenBlocked, 1, "the cycle stays current while blocked");
  assert.equal(state.selfImprove?.history.length, 1, "the answered session finished cycle 1; no new cycle was started");
  assert.match(nth(prompts, 1), /The previous session of this cycle was interrupted/);
  assert.match(nth(prompts, 1), /Operator: Name the marker AUDIT_OK\./);
  assert.equal(state.ui?.blocked, 1);
  assert.ok(state.ui?.autoAnswered >= 2, "the approvals were answered without asking anyone");
  assert.equal(state.pendingQuestions.length, 1);
  assert.match(nth(state.pendingQuestions, 0).question, /What should the marker be called\?/);
});

await check("promotion is local by default and pushes only where the contract lists a destination; an approval-gated push waits for `promote`", async () => {
  const bare = scratch();
  sh(bare, "init", "--quiet", "--bare");
  const pushRaw = (src: string, approval: boolean): RawContract => improveRaw(src, { run: approval ? "improve-test-4" : "improve-test-3", budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 1, maxMinutes: 5000 },
    promotion: { policy: "push", destinations: [{ kind: "git-remote", url: "https://git.example.org/team/repo.git", branch: "pi-autonomy/integration", tags: true }], requiresOperatorApproval: approval } });
  // The contract's URL is a placeholder; the test points the destination at a local bare repository through the runtime config.
  const script = async (t: ScriptContext): Promise<void> => { t.write("AUDIT_OK", "1"); report(t, "successful"); t.commit("marker"); };
  const src = sourceRepo();
  const h = harness(pushRaw(src, false), { manager: manager([]), script, cfgOverride: { integrationRemote: bare, gitRemote: bare } });
  const { state, rt } = await runOnce(h);
  assert.equal(state.status, "succeeded", JSON.stringify(state.outcome));
  const refs = sh(bare, "for-each-ref", "--format=%(refname)").split("\n").sort();
  assert.deepEqual(refs, ["refs/heads/pi-autonomy/integration", "refs/tags/pi/improve-test-3/cycle-01"], "the integration branch and this run's tags only; not the working branch, not main");
  assert.equal(sh(bare, "rev-parse", "refs/heads/pi-autonomy/integration"), mirrorGit(rt)(["rev-parse", "refs/heads/pi-autonomy/integration"]));
  assert.throws(() => rt.repo.promotePush(bare, "pi-autonomy/integration", state.selfImprove?.seedSha ?? ""), /failed/, "a clean scan does not permit rewinding the destination");
  assert.equal(sh(bare, "rev-parse", "refs/heads/pi-autonomy/integration"), mirrorGit(rt)(["rev-parse", "refs/heads/pi-autonomy/integration"]));
  // Approval required: nothing leaves the mirror until the operator promotes.
  const bare2 = scratch();
  sh(bare2, "init", "--quiet", "--bare");
  const h2 = harness(pushRaw(sourceRepo(), true), { manager: manager([]), script, cfgOverride: { integrationRemote: bare2, gitRemote: bare2 } });
  const waiting = await runOnce(h2);
  assert.equal(waiting.state.status, "succeeded");
  assert.equal(waiting.state.promotion.status, "awaiting_approval");
  assert.equal(sh(bare2, "for-each-ref"), "", "no push without approval");
  const promoted = await waiting.engine.promote({ sha: mirrorGit(waiting.rt)(["rev-parse", "refs/heads/pi-autonomy/integration"]), approved: true });
  assert.equal(promoted.status, "done");
  assert.equal(sh(bare2, "rev-parse", "refs/heads/pi-autonomy/integration"), mirrorGit(waiting.rt)(["rev-parse", "refs/heads/pi-autonomy/integration"]));
});

await check("dead workers restart on the next tick without spending manager calls, including zero and unknown exits; the restart budget survives resume", async () => {
  for (const code of [0, 137, undefined]) {
    const calls: ManagerCall[] = [];
    const starts: number[] = [];
    const h = harness(improveRaw(sourceRepo(), { budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 1, maxMinutes: 5000 } }), {
      manager: manager(calls),
      script: async (t) => {
        starts.push(t.runtime.clock.now);
        if (t.attempt <= 3) {
          if (code === undefined) { t.agent.alive = false; t.runtime.engine.containers.delete(t.agent.name); t.agent.resolveExit(undefined); }
          else t.exit(code);
          return;
        }
        assert.match(t.message, /previous worker process exited/);
        t.write("AUDIT_OK", "1"); report(t, "successful"); t.commit("recovered");
      },
    });
    const { state, rt } = await runOnce(h);
    assert.equal(state.selfImprove?.history[0]?.attempts, 4);
    assert.equal(state.selfImprove?.history[0]?.merged, true);
    assert.equal(calls.filter((c) => !/You review one cycle/.test(c.system)).length, 0);
    assert.ok(starts.every((at, i) => i === 0 || at - nth(starts, i - 1) === rt.tickMs), "restart happens on the next tick, before idle detection");
  }
  const h = harness(improveRaw(sourceRepo(), { budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 1, maxMinutes: 5000 }, templateOptions: { limits: { autoRestartsPerCycle: 1 } } }), {
    script: async (t) => { if (t.attempt === 2) t.store.enqueue("pause"); t.crash(); },
  });
  // Stop the parked supervisor after it has processed pause; the current cycle survives.
  const first = h.engine();
  first.rt.hooks.onSleep = () => { if (h.state().status === "paused") first.engine.signalled = true; };
  await first.engine.run();
  assert.equal(h.state().selfImprove?.current?.autoRestarts, 1);
  h.store.enqueue("unpause");
  const resumed = await runOnce(h, { rt: h.runtime(async (t) => { t.crash(); }) });
  assert.equal(resumed.rt.calls.workers.length, 1, "resume cannot replenish a cycle's automatic restart allowance");
  assert.equal(resumed.state.selfImprove?.history[0]?.reason, "auto_restarts_exhausted");
});

await check("automatic restart limit is configurable, validated, and independent of generic recovery knobs", async () => {
  for (const limit of [0, 2]) {
    const h = harness(improveRaw(sourceRepo(), { budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 1, maxMinutes: 5000 }, recovery: { softNudges: 0, hardRestarts: 0, maxAttemptsPerStep: 1 }, templateOptions: { limits: { autoRestartsPerCycle: limit } } }), { script: async (t) => { t.crash(); } });
    const { state, rt } = await runOnce(h);
    assert.equal(rt.calls.workers.length, limit + 1);
    assert.equal(state.selfImprove?.history[0]?.reason, "auto_restarts_exhausted");
    assert.deepEqual(state.selfImprove?.history[0]?.decisions, []);
    assert.deepEqual(state.recovery.totals, { softNudges: 0, hardRestarts: 0 });
  }
  for (const value of [-1, 0.5, "3", null]) {
    const r = resolveContract(improveRaw(sourceRepo(), { templateOptions: { limits: { autoRestartsPerCycle: value } } }), { effort: testEffort });
    assert.equal(r.ok, false, String(value));
    assert.ok(r.problems.some((p) => p.path === "templateOptions.limits.autoRestartsPerCycle"));
  }
});

await check("committed green work after session death gets a host report and independent review; red or empty work is never salvaged", async () => {
  for (const verdict of ["MERGE", "REJECT"]) {
    const calls: ManagerCall[] = [];
    const h = harness(improveRaw(sourceRepo(), { budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 1, maxMinutes: 5000 }, templateOptions: { integration: { review: false } } }), {
      manager: manager(calls, { review: verdict }),
      script: async (t) => { t.write("AUDIT_OK", "1"); t.commit("finished code before compaction death"); t.crash(); },
    });
    const { state, rt } = await runOnce(h);
    const entry = state.selfImprove?.history[0];
    assert.equal(rt.calls.workers.length, 1, "no report-only model session");
    assert.equal(rt.calls.checks.filter((check) => check.sha === entry?.head).length, 1, "reuse the trusted salvage gate at exactly this head");
    assert.equal(entry?.reason, "host close-out after session exit");
    assert.equal(entry?.merged, verdict === "MERGE");
    assert.equal(entry?.reportOutcome, null, "the host never pretends the worker declared success");
    const call = calls.find((c) => /You review one cycle/.test(c.system));
    assert.ok(call, "salvage forces review even when normal cycle review is disabled");
    assert.match(call.user, /Host close-out/);
    assert.match(call.user, /finished code before compaction death/);
    assert.match(call.user, /Outcome: partial/);
    assert.ok(fs.existsSync(path.join(h.store.p.steps, "01", "salvaged-report.json")));
    const exported = exportRun({ store: h.store, repo: rt.repo, contract: h.contract, state, out: scratch() });
    assert.ok(exported.manifest.files.some((file) => file.path === "evidence/steps/01/salvaged-report.json"), "salvage evidence is exported");
  }
  for (const changed of [false, true]) {
    const h = harness(improveRaw(sourceRepo(), { budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 1, maxMinutes: 5000 }, templateOptions: { limits: { autoRestartsPerCycle: 0 } } }), {
      script: async (t) => { if (changed) { t.write("unfinished.txt", "still red"); t.commit("unfinished"); } t.crash(); },
    });
    const { state } = await runOnce(h);
    assert.equal(state.selfImprove?.history[0]?.merged, false);
    assert.equal(fs.existsSync(path.join(h.store.p.steps, "01", "salvaged-report.json")), false);
  }
});

await check("a session that records an over-budget report and then dies is refused by its own pre-report check, never merged", async () => {
  const calls: ManagerCall[] = [];
  const h = harness(improveRaw(sourceRepo(), { budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 1, maxMinutes: 5000 }, templateOptions: { limits: { autoRestartsPerCycle: 0 } } }), {
    manager: manager(calls),
    script: async (t) => { t.write("AUDIT_OK", "1"); t.write("bulk.txt", "x".repeat(70_000)); report(t, "successful"); t.commit("cycle 1: 70k bulk then die"); t.crash(); },
  });
  const { state } = await runOnce(h);
  const entry = state.selfImprove?.history[0];
  assert.ok(entry, "one cycle is recorded");
  assert.equal(entry.outcome, "partial", "the dead session's over-budget report is not completed");
  assert.match(entry.reason, /^refused_budget: the diff this cycle would submit is \d+ characters, over the merge review's budget of 60000 characters$/);
  assert.equal(entry.merged, false, "the over-budget cycle is not merged");
  assert.equal(calls.filter((c) => /You review one cycle/.test(c.system)).length, 0, "the merge-review model was never called");
});

await check("STOP parks an active cycle, keeps committed work and exits cleanly; heartbeat tracks ticks, phase and cycle", async () => {
  const h = harness(improveRaw(sourceRepo()), {
    script: async (t) => {
      t.write("checkpoint.txt", "kept"); t.commit("checkpoint");
      fs.writeFileSync(path.join(t.store.p.root, "STOP"), "");
      t.store.enqueue("unpause");
      t.hang();
    },
  });
  const { state, rt } = await runOnce(h);
  assert.equal(state.status, "paused");
  assert.equal(state.history.at(-1)?.reason, "stop_file");
  assert.equal(state.selfImprove?.current?.n, 1);
  assert.equal(state.selfImprove?.history.length, 0, "STOP preserves the current cycle for resume");
  assert.equal(rt.repo.fileAt(rt.repo.head(), "checkpoint.txt"), "kept");
  assert.deepEqual(fakeAlive(h.fakeEngine), []);
  assert.equal(fs.existsSync(h.store.p.lock), false);
  const beat: unknown = JSON.parse(fs.readFileSync(path.join(h.store.p.root, "heartbeat.json"), "utf8"));
  assert.deepEqual(beat, { at: new Date(h.clock.now).toISOString(), phase: "work", cycle: 1, status: "paused" });
  const again = await runOnce(h);
  assert.equal(again.state.status, "paused", "a queued unpause cannot override STOP");
  assert.equal(again.rt.calls.workers.length, 0);
  fs.rmSync(path.join(h.store.p.root, "STOP"));
  const resumed = await runOnce(h, { rt: h.runtime(async (t) => { t.write("AUDIT_OK", "1"); report(t, "successful"); t.commit("finish parked cycle"); t.store.enqueue("cancel"); }) });
  assert.notEqual(resumed.state.status, "running");
});

await check("signals and unexpected supervisor errors park active runs instead of leaving running state", async () => {
  for (const which of ["signal", "error"]) {
    const h = harness(improveRaw(sourceRepo()), { script: async (t) => { if (which === "error") throw new Error("synthetic supervisor failure"); t.hang(); } });
    const made = h.engine();
    if (which === "signal") made.rt.hooks.onSleep = () => { made.engine.signalled = true; };
    if (which === "error") await assert.rejects(made.engine.run(), /synthetic supervisor failure/);
    else await made.engine.run();
    assert.equal(h.state().status, "paused");
    assert.equal(h.state().history.at(-1)?.reason, which === "error" ? "supervisor_error" : "signal");
    assert.deepEqual(fakeAlive(h.fakeEngine), []);
    assert.equal(fs.existsSync(h.store.p.lock), false);
  }
});

await check("backlog inbox items reach the next cycle under a clear heading and survive a supervisor restart", async () => {
  const prompts: string[] = [];
  const h = harness(improveRaw(sourceRepo(), { budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 2, maxMinutes: 5000 } }), {
    manager: manager([]),
    script: async (t) => {
      prompts.push(t.message);
      if (t.step === 1) t.store.enqueue("backlog", { message: "Check compaction recovery with evidence." });
      else assert.match(t.message, /## Steward backlog for this cycle\n- Check compaction recovery with evidence\./);
      t.write("AUDIT_OK", "1"); report(t, "successful"); t.commit(`cycle ${t.step}`);
    },
  });
  const { state } = await runOnce(h);
  assert.doesNotMatch(nth(prompts, 0), /Check compaction recovery/);
  assert.equal(state.backlog?.[0]?.deliveredCycle, 2);
  assert.equal(h.store.pending().length, 0);
  const h2 = harness(improveRaw(sourceRepo()), { script: async (t) => { assert.match(t.message, /Persisted stewardship/); fs.writeFileSync(path.join(t.store.p.root, "STOP"), ""); t.hang(); } });
  h2.store.enqueue("backlog", { message: "Persisted stewardship" });
  await runOnce(h2);
  fs.rmSync(path.join(h2.store.p.root, "STOP"));
  h2.store.enqueue("unpause");
  const next = await runOnce(h2);
  assert.equal(next.state.backlog?.[0]?.deliveredCycle, 1, "the interrupted cycle gets the same backlog on resume");
});

// The tests from here to the clean-publish one reach the publish-time scan, the backstop for a refusal
// close-out cannot see, so they skip the close-out scan (closeOutScan: false) and let a leaky cycle
// merge. The close-out refusal itself is pinned by the DE-99 tests below.
await check("host leak scans block automatic publication and approved promotion, including unmerged tags; clean pushes remain fast-forward only", async () => {
  for (const approval of [false, true]) {
    const bare = scratch(); sh(bare, "init", "--quiet", "--bare");
    const calls: ManagerCall[] = [];
    const h = harness(improveRaw(sourceRepo(), { budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 1, maxMinutes: 5000 }, promotion: { policy: "push", destinations: [{ kind: "git-remote", url: "https://git.example.org/team/repo.git", branch: "pi-autonomy/integration", tags: true }], requiresOperatorApproval: approval } }), {
      cfgOverride: { integrationRemote: bare, gitRemote: bare }, closeOutScan: false,
      manager: manager(calls, { review: "REJECT" }),
      script: async (t) => { t.write("AUDIT_OK", "1"); t.write("internal/private-note.txt", "synthetic private-path fixture"); report(t, "successful"); t.commit("private path fixture"); },
    });
    const { state, rt, engine } = await runOnce(h);
    if (!approval) {
      assert.match(state.selfImprove?.publishBlocker ?? "", /pre-push leak scan.*private path/);
      assert.equal(sh(bare, "tag", "--list"), "", "a rejected cycle tag cannot leak through a clean integration branch");
    }
    const promoted = await engine.promote({ sha: mirrorGit(rt)(["rev-parse", "refs/heads/pi-autonomy/integration"]), approved: true });
    assert.equal(promoted.status, "failed");
    assert.match(promoted.error ?? "", /pre-push leak scan.*private path/);
    assert.equal(sh(bare, "tag", "--list"), "");
    assert.match(h.state().promotion.error ?? "", /publication blocked/);
    assert.equal(rt.repo.fileAt(state.selfImprove?.history[0]?.head ?? "", "internal/private-note.txt"), "synthetic private-path fixture");
  }
});

await check("publish range scanning catches a private path removed before the final head", async () => {
  const bare = scratch(); sh(bare, "init", "--quiet", "--bare");
  const h = harness(improveRaw(sourceRepo(), { budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 1, maxMinutes: 5000 }, promotion: { policy: "push", destinations: [{ kind: "git-remote", url: "https://git.example.org/team/repo.git", branch: "pi-autonomy/integration", tags: false }], requiresOperatorApproval: false } }), {
    cfgOverride: { integrationRemote: bare, gitRemote: bare }, closeOutScan: false, manager: manager([]),
    script: async (t) => {
      t.write("internal/private-note.txt", "synthetic history fixture"); t.commit("private-path history fixture");
      t.remove("internal"); t.write("AUDIT_OK", "1"); report(t, "successful"); t.commit("remove private path before final head");
    },
  });
  const { state, rt } = await runOnce(h);
  assert.equal(state.selfImprove?.history[0]?.merged, true, "local reviewed integration may continue");
  assert.equal(rt.repo.fileAt(state.selfImprove?.history[0]?.head ?? "", "internal/private-note.txt"), null);
  assert.match(state.selfImprove?.publishBlocker ?? "", /private path/);
  assert.equal(sh(bare, "rev-parse", "refs/heads/pi-autonomy/integration"), state.selfImprove?.seedSha, "no newly exposing commit was pushed");
});

await check("PG-55: a leak-scan-refused merge is counted, surfaced by status, and names the location in the next cycle prompt", async () => {
  const bare = scratch(); sh(bare, "init", "--quiet", "--bare");
  const prompts: string[] = [];
  const h = harness(improveRaw(sourceRepo(), { budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 2, maxMinutes: 5000 }, promotion: { policy: "push", destinations: [{ kind: "git-remote", url: "https://git.example.org/team/repo.git", branch: "pi-autonomy/integration", tags: true }], requiresOperatorApproval: false } }), {
    cfgOverride: { integrationRemote: bare, gitRemote: bare }, closeOutScan: false,
    manager: manager([]),
    script: async (t) => {
      prompts.push(t.message);
      t.write("AUDIT_OK", "1");
      t.write("internal/private-note.txt", `synthetic private-path fixture ${t.step}\n`);
      report(t, "successful");
      t.commit(`cycle ${t.step}`);
    },
  });
  const { state } = await runOnce(h);
  assert.equal(state.status, "succeeded", JSON.stringify(state.outcome));
  assert.match(state.selfImprove?.publishBlocker ?? "", /pre-push leak scan/);
  assert.ok((state.selfImprove?.publishBlockedCycles ?? 0) >= 1, "the merged-but-unpublished cycle is counted");
  // (c) the NEXT cycle's prompt carries the blocker, locations only, and the fix instruction.
  assert.match(nth(prompts, 1), /## Publication blocked \(pre-push leak scan\)/);
  assert.ok(nth(prompts, 1).includes(state.selfImprove?.publishBlocker ?? "\u0000"), "the next cycle prompt quotes the blocker verbatim");
  assert.match(nth(prompts, 1), /Your first job this cycle is to stop adding that identifier: remove it, or if it is legitimate propose an exception; the run cannot publish until it is gone\./);
  // (b) status carries the blocker and the unpublished count, in JSON and in text.
  const status = await cliRun(h, ["status", "--run", "improve-test-1", "--json"]);
  assert.equal(status.code, 0, status.err);
  const json = JSON.parse(status.out) as { selfImprove?: { publishBlocker?: string | null; unpublished?: number } };
  assert.match(json.selfImprove?.publishBlocker ?? "", /pre-push leak scan/);
  assert.ok((json.selfImprove?.unpublished ?? 0) >= 1);
  const text = await cliRun(h, ["status", "--run", "improve-test-1"]);
  assert.equal(text.code, 0, text.err);
  assert.match(text.out, /publication BLOCKED: publication blocked by pre-push leak scan: .*merged cycle\(s\) not published; the leak scan refuses the commit above/);
});

await check("PG-55: two consecutive leak-scan-refused merges stop the run with an operator question", async () => {
  const bare = scratch(); sh(bare, "init", "--quiet", "--bare");
  const prompts: string[] = [];
  const slot: { engine?: MadeEngine } = {};
  let stopped = false;
  const h = harness(improveRaw(sourceRepo(), { budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 4, maxMinutes: 5000 }, promotion: { policy: "push", destinations: [{ kind: "git-remote", url: "https://git.example.org/team/repo.git", branch: "pi-autonomy/integration", tags: true }], requiresOperatorApproval: false } }), {
    cfgOverride: { integrationRemote: bare, gitRemote: bare }, closeOutScan: false,
    manager: manager([]),
    hooks: { onSleep: () => { if (slot.engine && !stopped && h.state().status === "blocked") { stopped = true; slot.engine.engine.signalled = true; } } },
    script: async (t) => {
      prompts.push(t.message);
      t.write("AUDIT_OK", "1");
      t.write("internal/private-note.txt", `synthetic private-path fixture ${t.step}\n`);
      report(t, "successful");
      t.commit(`cycle ${t.step}`);
    },
  });
  slot.engine = h.engine();
  assert.ok(slot.engine, "the engine was created");
  await slot.engine.engine.run();
  const state = h.state();
  assert.equal(state.status, "blocked", JSON.stringify(state.outcome));
  assert.equal(state.blocker?.id, "publish-blocked");
  assert.equal(state.blocker?.kind, "external");
  assert.equal(state.selfImprove?.publishBlockedCycles, 2, "two merged cycles are stacked unpublished");
  assert.equal(state.pendingQuestions.filter((q) => q.id === "publish-blocked").length, 1);
  assert.match(state.blocker?.question ?? "", /Publication of 2 merged cycle\(s\) is blocked by the pre-push leak scan/);
  assert.match(state.blocker?.question ?? "", /remove the identifier or stop the run/);
  assert.deepEqual(state.blocker?.options, ["Remove the identifier and resume", "Stop the run"]);
  assert.equal(prompts.length, 2, "the run waits for the operator instead of starting a third cycle");
});

await check("PG-55: answering the publish-blocked question runs exactly one cycle, then parks again", async () => {
  const bare = scratch(); sh(bare, "init", "--quiet", "--bare");
  const prompts: string[] = [];
  const slot: { engine?: MadeEngine } = {};
  let answered = 0;
  let stopped = false;
  const h = harness(improveRaw(sourceRepo(), { budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 4, maxMinutes: 5000 }, promotion: { policy: "push", destinations: [{ kind: "git-remote", url: "https://git.example.org/team/repo.git", branch: "pi-autonomy/integration", tags: true }], requiresOperatorApproval: false } }), {
    cfgOverride: { integrationRemote: bare, gitRemote: bare }, closeOutScan: false,
    manager: manager([]),
    hooks: { onSleep: () => {
      if (!slot.engine) return;
      const s = h.state();
      if (s.status !== "blocked" || s.blocker?.id !== "publish-blocked") return;
      if (answered === 0) { answered += 1; h.store.enqueue("answer", { text: "Remove the identifier and resume" }); return; }
      if (!stopped) { stopped = true; slot.engine.engine.signalled = true; }
    } },
    script: async (t) => {
      prompts.push(t.message);
      t.write("AUDIT_OK", "1");
      t.write("internal/private-note.txt", `synthetic private-path fixture ${t.step}\n`);
      report(t, "successful");
      t.commit(`cycle ${t.step}`);
    },
  });
  slot.engine = h.engine();
  assert.ok(slot.engine, "the engine was created");
  await slot.engine.engine.run();
  const state = h.state();
  assert.equal(answered, 1, "the operator answered the publish-blocked question once");
  assert.equal(prompts.length, 3, "exactly one cycle ran after the answer, not zero and not more");
  assert.equal(state.status, "blocked", JSON.stringify(state.outcome));
  assert.equal(state.blocker?.id, "publish-blocked", "the still-refused publication parks the run again");
  assert.equal(state.pendingAnswer ?? null, null, "the answer was consumed");
});

await check("PG-55: answering the publish-blocked question with a leak-free cycle publishes and the run continues", async () => {
  const bare = scratch(); sh(bare, "init", "--quiet", "--bare");
  const prompts: string[] = [];
  const slot: { engine?: MadeEngine } = {};
  let answered = 0;
  const h = harness(improveRaw(sourceRepo(), { budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 4, maxMinutes: 5000 }, promotion: { policy: "push", destinations: [{ kind: "git-remote", url: "https://git.example.org/team/repo.git", branch: "pi-autonomy/integration", tags: true }], requiresOperatorApproval: false } }), {
    cfgOverride: { integrationRemote: bare, gitRemote: bare }, closeOutScan: false,
    manager: manager([]),
    hooks: { onSleep: () => {
      if (!slot.engine) return;
      const s = h.state();
      if (s.status === "blocked" && s.blocker?.id === "publish-blocked" && answered === 0) {
        answered = 1;
        h.store.enqueue("answer", { text: "Remove the identifier and resume" });
      }
    } },
    script: async (t) => {
      prompts.push(t.message);
      if (t.step <= 2) { t.write("AUDIT_OK", "1"); t.write("internal/private-note.txt", `synthetic private-path fixture ${t.step}`); report(t, "successful"); t.commit(`leak cycle ${t.step}`); return; }
      if (t.step === 3) { t.remove("internal"); t.write("AUDIT_OK", "1"); report(t, "successful"); t.commit("remove the identifier before publishing"); return; }
      t.write("AUDIT_OK", "1"); report(t, "successful"); t.commit(`cycle ${t.step}`);
    },
  });
  slot.engine = h.engine();
  assert.ok(slot.engine, "the engine was created");
  await slot.engine.engine.run();
  const state = h.state();
  assert.equal(answered, 1, "the operator answered the publish-blocked question once");
  assert.equal(prompts.length, 4, "the answer ran a cycle and a later cycle started, proving the run continued");
  assert.equal(state.selfImprove?.history[2]?.merged, true, "the leak-free answer cycle merged");
  assert.equal(state.selfImprove?.publishBlocker ?? null, null, "the leak-free publication cleared the blocker");
  assert.equal(state.selfImprove?.publishBlockedCycles ?? 0, 0, "and the unpublished-cycle streak");
  assert.equal(state.selfImprove?.history[0]?.discarded, true, "the first discarded cycle is recorded as discarded");
  assert.equal(state.selfImprove?.history[1]?.discarded, true, "the second discarded cycle is recorded as discarded");
  assert.match(state.selfImprove?.history[0]?.mergeReason ?? "", /discarded by the publish-blocked reset/, "the record says why the cycle was discarded");
  assert.match(prompts[2] ?? "", /discarded when the publish-blocked answer rolled/, "the answer cycle is told the work was discarded and to redo it");
  const tags = sh(bare, "tag", "--list");
  assert.doesNotMatch(tags, /cycle-01|cycle-02/, "the discarded cycle tags are not published");
  assert.notEqual(state.blocker?.id, "publish-blocked", "the run is not parked on the publish-blocked question");
  const pushed = sh(bare, "ls-tree", "-r", "--name-only", "refs/heads/pi-autonomy/integration");
  assert.doesNotMatch(pushed, /internal\/private-note\.txt/, "the pushed integration branch carries no leaked path");
});

await check("PG-55: a second publish-blocked answer does not name the tag of an unmerged cycle the first reset discarded", async () => {
  const bare = scratch(); sh(bare, "init", "--quiet", "--bare");
  const prompts: string[] = [];
  const slot: { engine?: MadeEngine } = {};
  let answered = 0;
  const h = harness(improveRaw(sourceRepo(), { budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 5, maxMinutes: 5000 }, promotion: { policy: "push", destinations: [{ kind: "git-remote", url: "https://git.example.org/team/repo.git", branch: "pi-autonomy/integration", tags: true }], requiresOperatorApproval: false } }), {
    cfgOverride: { integrationRemote: bare, gitRemote: bare }, closeOutScan: false,
    manager: manager([]),
    hooks: { onSleep: () => {
      if (!slot.engine) return;
      const s = h.state();
      if (s.status !== "blocked" || s.blocker?.id !== "publish-blocked") return;
      if (answered < 2) { answered += 1; h.store.enqueue("answer", { text: "Remove the identifier and resume" }); return; }
      slot.engine.engine.signalled = true;
    } },
    script: async (t) => {
      prompts.push(t.message);
      // Cycles 1 and 2 merge with a leak and park the run. Cycle 3 (the first answer's cycle) fails the gate, so
      // it is not merged, but it re-adds the leak and its pushed tag is refused: the run parks again. The second
      // answer's reset then deletes that unmerged cycle's tag, and cycle 4 must not name the deleted tag.
      if (t.step <= 2) { t.write("AUDIT_OK", "1"); t.write("internal/private-note.txt", `synthetic private-path fixture ${t.step}\n`); report(t, "successful"); t.commit(`leak cycle ${t.step}`); return; }
      if (t.step === 3) { t.remove("AUDIT_OK"); t.write("internal/private-note.txt", "synthetic private-path fixture 3\n"); report(t, "successful"); t.commit("red gate cycle that re-adds the identifier"); return; }
      t.write("AUDIT_OK", "1"); report(t, "successful"); t.commit(`cycle ${t.step}`);
    },
  });
  slot.engine = h.engine();
  assert.ok(slot.engine, "the engine was created");
  let crashed = "";
  try { await slot.engine.engine.run(); } catch (e) { crashed = e instanceof Error ? e.message : String(e); }
  assert.equal(crashed, "", `the cycle start after the second answer must not throw: it named the tag of a discarded unmerged cycle that the reset had deleted (${crashed})`);
  const state = h.state();
  assert.notEqual(state.status, "failed", `the second answer must not wedge the run on a deleted cycle tag: ${JSON.stringify(state.outcome)}`);
  assert.equal(answered, 2, "the operator answered the publish-blocked question twice");
  assert.ok(prompts.length >= 4, "the cycle after the second answer started instead of dying at cycle start");
  assert.equal(state.selfImprove?.history[2]?.merged, false, "the first answer's cycle failed its gate");
  assert.equal(state.selfImprove?.history[2]?.discarded, true, "the second reset marks the unmerged cycle as discarded");
  assert.match(prompts[3] ?? "", /discarded when the publish-blocked answer rolled/, "the cycle after the second answer is told the work was discarded, not pointed at a deleted tag");
  assert.doesNotMatch(sh(bare, "tag", "--list"), /cycle-0[123]/, "no discarded cycle tag is published");
});

for (const answer of [
  { name: "the exact stop option", input: { text: "Stop the run" }, stop: true },
  { name: "the stop option with surrounding space and mixed case", input: { text: "  sToP ThE RuN  " }, stop: true },
  { name: "a denial without answer text", input: { deny: true }, stop: true },
  { name: "an unrelated non-empty answer", input: { text: "I will inspect the identifier" }, stop: false },
  { name: "an approval without answer text", input: { approve: true }, stop: false },
]) {
  await check(`PG-55: ${answer.name} on the publish-blocked question`, async () => {
    const bare = scratch(); sh(bare, "init", "--quiet", "--bare");
    const prompts: string[] = [];
    const slot: { engine?: MadeEngine } = {};
    let answered = false;
    let stopped = false;
    const h = harness(improveRaw(sourceRepo(), { budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 4, maxMinutes: 5000 }, promotion: { policy: "push", destinations: [{ kind: "git-remote", url: "https://git.example.org/team/repo.git", branch: "pi-autonomy/integration", tags: true }], requiresOperatorApproval: false } }), {
      cfgOverride: { integrationRemote: bare, gitRemote: bare }, closeOutScan: false, manager: manager([]),
      hooks: { onSleep: () => {
        if (!slot.engine) return;
        const s = h.state();
        if (s.status !== "blocked" || s.blocker?.id !== "publish-blocked") return;
        if (!answered) { answered = true; h.store.enqueue("answer", answer.input); return; }
        if (!stopped) { stopped = true; slot.engine.engine.signalled = true; }
      } },
      script: async (t) => {
        prompts.push(t.message);
        t.write("AUDIT_OK", "1");
        t.write("internal/private-note.txt", `synthetic private-path fixture ${t.step}\n`);
        report(t, "successful");
        t.commit(`cycle ${t.step}`);
      },
    });
    slot.engine = h.engine();
    await slot.engine.engine.run();
    const state = h.state();
    assert.equal(answered, true, "the operator answered the question");
    assert.equal(prompts.length, answer.stop ? 2 : 3, "the answer starts the expected number of cycles");
    assert.equal(state.selfImprove?.publishBlockedCycles, answer.stop ? 2 : 3, "the refused-publication count remains intact");
    assert.equal(state.pendingAnswer ?? null, null, "the answer was consumed");
    if (answer.stop) {
      assert.deepEqual([state.status, state.outcome?.status, state.outcome?.reason], ["succeeded", "succeeded", "publish_blocked_stopped"], "the final gate ends the run with the stop reason");
      assert.equal(state.blocker, null, "the terminal run has no pending question");
      assert.equal(state.selfImprove?.history.some((e) => e.discarded === true), false, "a stop keeps the unpublished history instead of rolling it back");
      assert.doesNotMatch(state.selfImprove?.history.map((e) => e.mergeReason).join("\n") ?? "", /discarded by the publish-blocked reset/, "no cycle is recorded as discarded by a stop");
    } else {
      assert.equal(state.status, "blocked", JSON.stringify(state.outcome));
      assert.equal(state.blocker?.id, "publish-blocked", "one refused cycle parks the run again");
    }
  });
}

await check("PG-55: a non-merged cycle between refused merges does not reset the blocked-cycle count", async () => {
  const bare = scratch(); sh(bare, "init", "--quiet", "--bare");
  const prompts: string[] = [];
  const slot: { engine?: MadeEngine } = {};
  let stopped = false;
  const h = harness(improveRaw(sourceRepo(), { budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 4, maxMinutes: 5000 }, promotion: { policy: "push", destinations: [{ kind: "git-remote", url: "https://git.example.org/team/repo.git", branch: "pi-autonomy/integration", tags: true }], requiresOperatorApproval: false } }), {
    cfgOverride: { integrationRemote: bare, gitRemote: bare }, closeOutScan: false,
    manager: manager([]),
    hooks: { onSleep: () => { if (slot.engine && !stopped && h.state().status === "blocked") { stopped = true; slot.engine.engine.signalled = true; } } },
    script: async (t) => {
      prompts.push(t.message);
      if (t.step === 2) { t.remove("AUDIT_OK"); report(t, "successful"); t.commit("red gate cycle"); return; }
      t.write("AUDIT_OK", "1");
      t.write("internal/private-note.txt", `synthetic private-path fixture ${t.step}\n`);
      report(t, "successful");
      t.commit(`cycle ${t.step}`);
    },
  });
  slot.engine = h.engine();
  assert.ok(slot.engine, "the engine was created");
  await slot.engine.engine.run();
  const state = h.state();
  assert.equal(state.status, "blocked", JSON.stringify(state.outcome));
  assert.equal(state.blocker?.id, "publish-blocked");
  assert.equal(state.selfImprove?.publishBlockedCycles, 2, "the intervening non-merged cycle did not clear the count");
  assert.equal(state.selfImprove?.history.filter((c) => c.merged).length, 2, "only the two leak-bearing cycles merged");
  assert.equal(prompts.length, 3, "the run stops before a fourth cycle");
});

await check("PG-55: a clean publish clears the blocker, the unpublished count and the status line", async () => {
  const bare = scratch(); sh(bare, "init", "--quiet", "--bare");
  const slot: { engine?: MadeEngine } = {};
  let injected = false;
  let blockedText = "";
  const h = harness(improveRaw(sourceRepo(), { budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 1, maxMinutes: 5000 }, promotion: { policy: "push", destinations: [{ kind: "git-remote", url: "https://git.example.org/team/repo.git", branch: "pi-autonomy/integration", tags: true }], requiresOperatorApproval: false } }), {
    cfgOverride: { integrationRemote: bare, gitRemote: bare },
    manager: manager([]),
    hooks: { onSleep: async () => {
      const si = slot.engine?.engine.state.selfImprove;
      if (si && !injected) {
        injected = true;
        si.publishBlocker = "publication blocked by pre-push leak scan: 012345678901 internal/private-note.txt: a private path";
        si.publishBlockedCycles = 1;
        slot.engine?.engine.save();
        blockedText = (await cliRun(h, ["status", "--run", "improve-test-1"])).out;
      }
    } },
    script: async (t) => { t.write("AUDIT_OK", "1"); report(t, "successful"); t.commit(`cycle ${t.step}`); },
  });
  slot.engine = h.engine();
  assert.ok(slot.engine, "the engine was created");
  await slot.engine.engine.run();
  assert.match(blockedText, /publication BLOCKED: publication blocked by pre-push leak scan/, "the status line is visible while the block stands");
  const state = h.state();
  assert.equal(state.selfImprove?.publishBlocker ?? null, null, "a clean publish clears the blocker");
  assert.equal(state.selfImprove?.publishBlockedCycles ?? 0, 0, "and the unpublished count");
  assert.equal(state.selfImprove?.merged, 1);
  const text = await cliRun(h, ["status", "--run", "improve-test-1"]);
  assert.doesNotMatch(text.out, /publication BLOCKED/);
});

await check("DE-99: a cycle publication would refuse is refused at close-out: no gate, no review, no merge, its tag never published, and the next cycle is told to reword it; a clean cycle still merges", async () => {
  const bare = scratch(); sh(bare, "init", "--quiet", "--bare");
  const prompts: string[] = [];
  const calls: ManagerCall[] = [];
  const blocked = "M-" + "04"; // a roadmap-style identifier the scanner refuses, built at run time so this file stays clean
  const h = harness(improveRaw(sourceRepo(), { budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 4, maxMinutes: 5000 }, promotion: { policy: "push", destinations: [{ kind: "git-remote", url: "https://git.example.org/team/repo.git", branch: "pi-autonomy/integration", tags: true }], requiresOperatorApproval: false } }), {
    cfgOverride: { integrationRemote: bare, gitRemote: bare },
    manager: manager(calls),
    script: async (t) => {
      prompts.push(t.message);
      t.write("AUDIT_OK", "1");
      // Cycle 1 repairs the red seed (the fixture's base has no AUDIT_OK) and merges; 2 and 3 leak; 4 is clean.
      if (t.step === 2) { t.write("two.txt", "two\n"); report(t, "successful"); t.commit(`cycle 2 for ${blocked}`); return; }
      if (t.step === 3) { t.write("internal/private-note.txt", "synthetic private-path fixture\n"); report(t, "successful"); t.commit("cycle 3"); return; }
      t.write(`clean-${t.step}.txt`, "clean\n"); report(t, "successful"); t.commit(`cycle ${t.step}, clean`);
    },
  });
  const { state, rt } = await runOnce(h);
  const [c1, c2, c3, c4] = state.selfImprove?.history ?? [];
  assert.ok(c1 && c2 && c3 && c4, "four cycles are recorded");
  assert.equal(c1.merged, true, "the first, clean cycle merges");
  // (a) the message leak and the file leak are refused before the gate and the review, naming commit and location only.
  assert.deepEqual([c2.merged, c2.gate, c2.leakRefused, c3.merged, c3.gate, c3.leakRefused], [false, "skipped", true, false, "skipped", true]);
  assert.match(c2.mergeReason, /^the pre-push leak scan would refuse to publish it: [0-9a-f]{12} message line 1: blocked identifier \(value redacted\)$/, c2.mergeReason);
  assert.match(c3.mergeReason, /^the pre-push leak scan would refuse to publish it: [0-9a-f]{12} internal\/private-note\.txt: adds or changes a private path$/, c3.mergeReason);
  assert.equal(calls.filter((c) => /You review one cycle/.test(c.system)).length, 2, "only the two clean cycles reached the merge review");
  // (b) a clean cycle after the refusals still merges and publishes.
  assert.deepEqual([c4.merged, c4.gate, c4.leakRefused], [true, "green", undefined]);
  // (c) publication never saw the refused cycles: no blocker, no refused tag on the destination, nothing of theirs on its branch.
  assert.deepEqual([state.selfImprove?.publishBlocker ?? null, state.selfImprove?.publishError ?? null, state.selfImprove?.publishBlockedCycles ?? 0], [null, null, 0]);
  const g = mirrorGit(rt);
  for (const nn of ["02", "03"]) {
    assert.ok(g(["rev-parse", "--verify", `refs/tags/pi/improve-test-1/refused/cycle-${nn}`]), `refused cycle ${nn} is kept locally`);
    assert.equal(g(["rev-parse", "--verify", "--quiet", `refs/tags/pi/improve-test-1/cycle-${nn}`], { allowFail: true }), null, `refused cycle ${nn} has no publishable tag`);
  }
  const tags = sh(bare, "tag", "--list");
  assert.doesNotMatch(tags, /refused|cycle-0[23]/, "no refused cycle tag is published");
  assert.match(tags, /cycle-01[\s\S]*cycle-04/, "the clean cycles' tags are published");
  assert.equal(sh(bare, "rev-parse", "refs/heads/pi-autonomy/integration"), c4.head, "the destination holds the clean cycle");
  assert.doesNotMatch(sh(bare, "log", "--format=%B", "refs/heads/pi-autonomy/integration"), new RegExp(blocked), "no refused commit reached the destination");
  assert.equal(sh(bare, "ls-tree", "-r", "--name-only", "refs/heads/pi-autonomy/integration").includes("internal/"), false);
  // (d) the next cycle is told to reword, where the commits are, and never the value.
  assert.match(nth(prompts, 2), /not merged into pi-autonomy\/integration and never published: the pre-push leak scan would refuse.*origin\/attempts\/improve-test-1\/refused\/cycle-02.*reword the commit message, or rewrite the added line/s);
  assert.match(nth(prompts, 3), /origin\/attempts\/improve-test-1\/refused\/cycle-03/);
  for (const p of prompts) assert.ok(!p.includes(blocked), "no prompt carries the refused value");
  const remoteBranches = spawnSync("git", ["--git-dir", rt.p.remote, "for-each-ref", "--format=%(refname)"], { encoding: "utf8" }).stdout;
  assert.match(remoteBranches, /refs\/heads\/attempts\/improve-test-1\/refused\/cycle-03/, "the worker's repository offers the refused attempt as a branch to reword");
});

await check("DE-99: the close-out scan covers every commit of the cycle, not only its head, and fails closed", async () => {
  const bare = scratch(); sh(bare, "init", "--quiet", "--bare");
  const h = harness(improveRaw(sourceRepo(), { budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 1, maxMinutes: 5000 }, promotion: { policy: "push", destinations: [{ kind: "git-remote", url: "https://git.example.org/team/repo.git", branch: "pi-autonomy/integration", tags: false }], requiresOperatorApproval: false } }), {
    cfgOverride: { integrationRemote: bare, gitRemote: bare }, manager: manager([]),
    script: async (t) => {
      t.write("internal/private-note.txt", "synthetic history fixture"); t.commit("private-path history fixture");
      t.remove("internal"); t.write("AUDIT_OK", "1"); report(t, "successful"); t.commit("remove private path before final head");
    },
  });
  const { state, rt } = await runOnce(h);
  const c1 = state.selfImprove?.history[0];
  assert.deepEqual([c1?.merged, c1?.leakRefused], [false, true], "a leak removed before the head is still refused");
  assert.match(c1?.mergeReason ?? "", /internal\/private-note\.txt: adds or changes a private path/);
  assert.equal(sh(bare, "rev-parse", "refs/heads/pi-autonomy/integration"), state.selfImprove?.seedSha, "nothing was published");
  // The library call gives the same verdict on the refused head, and a scan that cannot complete is a failure, not a pass.
  const cfg = { integrationBranch: "pi-autonomy/integration", baseRef: h.cfg.baseRef };
  assert.deepEqual(gm.scanCycle(mirrorGit(rt), cfg, c1?.head ?? ""), { reason: c1?.mergeReason, failed: false });
  assert.deepEqual(gm.scanCycle(mirrorGit(rt), cfg, "0".repeat(40)), { reason: "the pre-push leak scan could not complete on the cycle's commits", failed: true });
});

await check("DE-99: close-out reads exceptions from the run's base, never from the cycle's own commits", async () => {
  const blocked = "M-" + "04";
  const line = `tracked as ${blocked} upstream`;
  const sha256 = (t: string): string => createHash("sha256").update(t).digest("hex");
  const exception = (file: string) => ({ path: file, matchSha256: sha256(blocked), lineSha256: sha256(line), reason: "synthetic fixture" });
  const src = greenSourceRepo();
  fs.mkdirSync(path.join(src, "packages", "core"), { recursive: true });
  fs.writeFileSync(path.join(src, "packages", "core", "leak-scan-exceptions.json"), `${JSON.stringify({ schemaVersion: 1, scanExceptions: [exception("docs/allowed.md")] }, null, 2)}\n`);
  sh(src, "add", "."); sh(src, "commit", "--quiet", "-m", "base exceptions");
  const h = harness(improveRaw(src, { budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 2, maxMinutes: 5000 } }), {
    manager: manager([]),
    script: async (t) => {
      if (t.step === 1) { t.write("docs/allowed.md", `${line}\n`); report(t, "successful"); t.commit("an excepted line"); return; }
      // The worker excepts its own leak in the same commit: publication would not read that exception, so neither does close-out.
      t.write("packages/core/leak-scan-exceptions.json", `${JSON.stringify({ schemaVersion: 1, scanExceptions: [exception("docs/allowed.md"), exception("docs/other.md")] }, null, 2)}\n`);
      t.write("docs/other.md", `${line}\n`); report(t, "successful"); t.commit("a self-excepted line");
    },
  });
  const { state } = await runOnce(h);
  const [c1, c2] = state.selfImprove?.history ?? [];
  assert.deepEqual([c1?.merged, c1?.leakRefused], [true, undefined], c1?.mergeReason ?? "");
  assert.deepEqual([c2?.merged, c2?.leakRefused], [false, true], c2?.mergeReason ?? "");
  assert.match(c2?.mergeReason ?? "", /docs\/other\.md:1: blocked identifier \(value redacted\)/);
});

await check("DE-99: a close-out scan that cannot complete parks the cycle with its work held, charges nothing, and the answer scans it again", async () => {
  let failures = 1;
  let sessions = 0;
  let answered = false;
  const board = { items: [{ id: "S-1", title: "Add the audit marker", priority: "P1", acceptance: "AUDIT_OK exists." }] };
  const h: Harness = harness(improveRaw(sourceRepo(), { budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 1, maxMinutes: 5000 } }), {
    manager: manager([]),
    closeOutScan: () => (failures-- > 0 ? { reason: "the pre-push leak scan could not complete on the cycle's commits", failed: true } : "real"),
    hooks: { onSleep: () => { const s = h.state(); if (s.status === "blocked" && !answered) { answered = true; h["blocker"] = s.blocker; h["attempts"] = JSON.stringify(s.selfImprove?.itemAttempts ?? {}); h["tags"] = mirrorGit(h["rt"] as HarnessRuntime)(["for-each-ref", "--format=%(refname)", "refs/tags/"]); h.store.enqueue("answer", { text: "continue" }); } } },
    script: async (t) => { sessions++; t.write("AUDIT_OK", "1"); report(t, "successful", "fix", "Board: S-1 done"); t.commit("c"); },
  });
  fs.writeFileSync(path.join(h.store.p.control, "board.json"), JSON.stringify(board));
  const made = h.engine();
  h["rt"] = made.rt;
  await made.engine.run();
  const state = h.state();
  assert.ok(answered, "the run parked on the failed scan");
  const blocker = h["blocker"] as { id?: string; question?: string } | undefined;
  assert.equal(blocker?.id, "review-pending");
  assert.match(blocker?.question ?? "", /leak scan could not complete .* The work is kept and was not judged/);
  assert.equal(h["attempts"], "{}", "an infrastructure failure charges no board item");
  assert.equal(h["tags"], "", "nothing was tagged while the work was held");
  assert.equal(sessions, 1, "the answer scanned the held head again; no second worker session");
  assert.deepEqual([state.selfImprove?.history.at(-1)?.merged, state.selfImprove?.history.at(-1)?.leakRefused], [true, undefined], "the clean head merged once the scan completed");
});

await check("DE-99: a manager reset scans the abandoned head and keeps a leaky one under a tag publication never pushes", async () => {
  const bare = scratch(); sh(bare, "init", "--quiet", "--bare");
  const blocked = "M-" + "04";
  let sessions = 0;
  const prompts: string[] = [];
  const h = harness(improveRaw(greenSourceRepo(), { budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 2, maxMinutes: 5000 }, promotion: { policy: "push", destinations: [{ kind: "git-remote", url: "https://git.example.org/team/repo.git", branch: "pi-autonomy/integration", tags: true }], requiresOperatorApproval: false } }), {
    cfgOverride: { integrationRemote: bare, gitRemote: bare },
    manager: manager([], { manager: { decision: "RESET_TO_LAST_GOOD", reason: "start again" } }),
    script: async (t) => {
      sessions++;
      prompts.push(t.message);
      if (sessions === 1) { t.write("one.txt", "one\n"); t.commit(`work for ${blocked}`); t.hang(); return; } // goes quiet: the manager resets
      t.write("two.txt", "two\n"); report(t, "successful"); t.commit("clean redo");
    },
  });
  const { state, rt } = await runOnce(h);
  assert.equal(state.selfImprove?.history[0]?.outcome, "reset", "the manager reset the first cycle");
  assert.match(nth(prompts, 1), /its work was abandoned \(tag pi\/improve-test-1\/refused\/abandoned-01\); the leak scan refused it/, "the next cycle is told the abandoned work was refused");
  assert.ok(!prompts.some((p) => p.includes(blocked)), "no prompt carries the refused value");
  const g = mirrorGit(rt);
  assert.ok(g(["rev-parse", "--verify", "refs/tags/pi/improve-test-1/refused/abandoned-01"]), "the leaky abandoned head is kept locally under refused/");
  assert.equal(g(["rev-parse", "--verify", "--quiet", "refs/tags/pi/improve-test-1/abandoned-01"], { allowFail: true }), null, "it has no publishable tag");
  assert.equal(state.selfImprove?.publishBlocker ?? null, null, "publication was never refused");
  assert.doesNotMatch(sh(bare, "tag", "--list"), /abandoned|refused/, "no abandoned or refused tag is published");
  assert.equal(state.selfImprove?.history.at(-1)?.merged, true, "the clean redo merged and published");
});

await check("PG-67: a non-conflicting destination move is rebased at the next cycle, tags stay put, and publication stays fast-forward", async () => {
  const bare = scratch(); sh(bare, "init", "--quiet", "--bare");
  const prompts: string[] = [];
  const captured: { originalHead?: string } = {};
  let moved = false;
  const h: Harness = harness(improveRaw(sourceRepo(), {
    budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 3, maxMinutes: 5000 },
    promotion: { policy: "push", destinations: [{ kind: "git-remote", url: "https://git.example.org/team/repo.git", branch: "pi-autonomy/integration", tags: true }], requiresOperatorApproval: false },
  }), {
    cfgOverride: { integrationRemote: bare, gitRemote: bare },
    manager: manager([]),
    hooks: { onSleep: () => {
      const state = h.state();
      const history = state.selfImprove?.history ?? [];
      if (moved || history.length !== 1) return;
      moved = true;
      captured.originalHead = nth(history, 0).head;
      const seedSha = state.selfImprove?.seedSha;
      assert.ok(seedSha, "the run recorded its seed");
      const cloneDir = scratch();
      sh(cloneDir, "clone", "--quiet", "--no-checkout", bare, cloneDir);
      sh(cloneDir, "checkout", "--quiet", seedSha);
      fs.writeFileSync(path.join(cloneDir, "DEST.md"), "destination\n");
      sh(cloneDir, "add", ".");
      sh(cloneDir, "commit", "--quiet", "-m", "destination moved");
      sh(cloneDir, "push", "--quiet", "--force", bare, "HEAD:refs/heads/pi-autonomy/integration");
    } },
    script: async (t) => {
      prompts.push(t.message);
      t.write("AUDIT_OK", "1\n");
      t.write("CYCLE.md", `${t.read("CYCLE.md") ?? ""}cycle ${t.step}\n`);
      t.note("Outcome: successful\nMode: improve\n\nDone.\n");
      t.commit(`cycle ${t.step}`);
    },
  });
  const { state, rt } = await runOnce(h);
  assert.equal(state.status, "succeeded", JSON.stringify(state.outcome));
  const history = state.selfImprove?.history ?? [];
  assert.equal(history.length, 3);
  assert.deepEqual(history.map((c) => c.n), [1, 2, 3], "the cycle counter kept going instead of restarting");
  const reconciliations = state.selfImprove?.reconciliations ?? [];
  assert.equal(reconciliations.length, 1);
  const rec = nth(reconciliations, 0);
  assert.ok(rec.from && rec.remote && rec.head, "the reconciliation records its from, remote and reconciled head");
  assert.ok(rec.commits >= 1, "the reconciliation records the rebased commit count");
  const integration = mirrorGit(rt)(["rev-parse", "refs/heads/pi-autonomy/integration"]);
  assert.equal(sh(bare, "rev-parse", "refs/heads/pi-autonomy/integration"), integration, "publication fast-forwarded the destination to the local integration head");
  const log = fs.readFileSync(h.store.p.log, "utf8");
  assert.match(log, /diverged: rebased/);
  assert.doesNotMatch(log, /integration_diverged/);
  assert.ok(captured.originalHead, "cycle 1's original head was captured before the destination moved");
  const tagSha = mirrorGit(rt)(["rev-parse", "refs/tags/pi/improve-test-1/cycle-01"]);
  assert.equal(tagSha, captured.originalHead, "the cycle-01 tag still names the original pre-rebase commit");
  assert.notEqual(tagSha, nth(history, 0).head, "the recorded cycle head followed the rebase while the tag did not");
  assert.equal(prompts.length, 3);
});

await check("PG-67: a conflicting destination move parks the run on an integration-diverged question instead of failing", async () => {
  const bare = scratch(); sh(bare, "init", "--quiet", "--bare");
  const slot: { engine?: MadeEngine; cycle1Head?: string; destination?: string } = {};
  let moved = false;
  let stopped = false;
  const h: Harness = harness(improveRaw(sourceRepo(), {
    budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 3, maxMinutes: 5000 },
    promotion: { policy: "push", destinations: [{ kind: "git-remote", url: "https://git.example.org/team/repo.git", branch: "pi-autonomy/integration", tags: true }], requiresOperatorApproval: false },
  }), {
    cfgOverride: { integrationRemote: bare, gitRemote: bare },
    manager: manager([]),
    hooks: { onSleep: () => {
      const state = h.state();
      if (!stopped && state.status === "blocked" && slot.engine) {
        stopped = true;
        slot.engine.engine.signalled = true;
      }
    } },
    script: async (t) => {
      t.write("AUDIT_OK", "1\n");
      t.write("README.md", "local\n");
      t.note("Outcome: successful\nMode: improve\n\nDone.\n");
      t.commit(`cycle ${t.step}`);
      // Move the destination from the seed while cycle 1 is closing, so cycle 2's start sees the
      // divergence. A hook after cycle 1 is recorded runs only once cycle 2 has already
      // synchronised, which would leave the conflict for cycle 3.
      if (t.step !== 1 || moved) return;
      moved = true;
      slot.cycle1Head = t.git(["rev-parse", "HEAD"]).stdout.trim();
      const seedSha = h.state().selfImprove?.seedSha;
      assert.ok(seedSha, "the run recorded its seed");
      const cloneDir = scratch();
      sh(cloneDir, "clone", "--quiet", "--no-checkout", bare, cloneDir);
      sh(cloneDir, "checkout", "--quiet", seedSha);
      fs.writeFileSync(path.join(cloneDir, "README.md"), "destination\n");
      sh(cloneDir, "commit", "--quiet", "-am", "destination moved");
      slot.destination = sh(cloneDir, "rev-parse", "HEAD");
      sh(cloneDir, "push", "--quiet", "--force", bare, "HEAD:refs/heads/pi-autonomy/integration");
    },
  });
  slot.engine = h.engine();
  assert.ok(slot.engine, "the engine was created");
  await slot.engine.engine.run();
  const state = h.state();
  assert.equal(state.status, "blocked", JSON.stringify(state.outcome));
  assert.equal(state.blocker?.id, "integration-diverged");
  assert.ok(slot.cycle1Head && slot.destination, "the fixture captured both heads");
  const question = state.blocker?.question ?? "";
  assert.match(question, /pi-autonomy\/integration/);
  assert.ok(question.includes(slot.destination.slice(0, 12)), question);
  assert.ok(question.includes(slot.cycle1Head.slice(0, 12)), question);
  assert.equal(state.selfImprove?.history.length, 1);
  assert.equal(nth(state.selfImprove?.history ?? [], 0).head, slot.cycle1Head);
  const g = mirrorGit(slot.engine.rt);
  assert.equal(g(["rev-parse", "refs/heads/pi-autonomy/integration"]), slot.cycle1Head, "the local integration ref is unchanged");
  assert.equal(sh(bare, "rev-parse", "refs/heads/pi-autonomy/integration"), slot.destination, "the destination is unchanged");
});

await check("PG-69: a host git failure while reconciling a diverged integration branch parks the run on a named question, keeps the cycle record and stays parked across a restart", async () => {
  const bare = scratch(); sh(bare, "init", "--quiet", "--bare");
  const slot: { engine?: MadeEngine; cycle1Head?: string } = {};
  let moved = false;
  let stops = 0;
  const h: Harness = harness(improveRaw(sourceRepo(), {
    budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 3, maxMinutes: 5000 },
    promotion: { policy: "push", destinations: [{ kind: "git-remote", url: "https://git.example.org/team/repo.git", branch: "pi-autonomy/integration", tags: true }], requiresOperatorApproval: false },
  }), {
    cfgOverride: { integrationRemote: bare, gitRemote: bare },
    manager: manager([]),
    hooks: { onSleep: () => { if (slot.engine && h.state().status === "blocked") { stops++; slot.engine.engine.signalled = true; } } },
    script: async (t) => {
      t.write("AUDIT_OK", "1\n");
      t.write("NOTES.md", `cycle ${t.step}\n`);
      t.note("Outcome: successful\nMode: improve\n\nDone.\n");
      t.commit(`cycle ${t.step}`);
      if (t.step !== 1 || moved) return;
      moved = true;
      slot.cycle1Head = t.git(["rev-parse", "HEAD"]).stdout.trim();
      // The destination moves (no conflict), so cycle 2 must reconcile; the host mirror cannot add the
      // worktree reconciling needs, a real host git failure.
      const seedSha = h.state().selfImprove?.seedSha;
      assert.ok(seedSha, "the run recorded its seed");
      const cloneDir = scratch();
      sh(cloneDir, "clone", "--quiet", "--no-checkout", bare, cloneDir);
      sh(cloneDir, "checkout", "--quiet", seedSha);
      fs.writeFileSync(path.join(cloneDir, "OTHER.md"), "destination\n");
      sh(cloneDir, "add", "OTHER.md"); sh(cloneDir, "commit", "--quiet", "-m", "destination moved");
      sh(cloneDir, "push", "--quiet", "--force", bare, "HEAD:refs/heads/pi-autonomy/integration");
      assert.ok(slot.engine, "the engine is running");
      const worktrees = path.join(mirrorGit(slot.engine.rt).gitDir, "worktrees");
      fs.rmSync(worktrees, { recursive: true, force: true });
      fs.writeFileSync(worktrees, "not a directory\n");
    },
  });
  slot.engine = h.engine();
  await slot.engine.engine.run();
  let state = h.state();
  assert.equal(state.status, "blocked", JSON.stringify(state.outcome));
  assert.equal(state.blocker?.id, "integration-reconcile-failed", "parked on the named question, not a supervisor_error pause");
  assert.equal(state.blocker?.kind, "external");
  assert.match(state.blocker?.question ?? "", /reconciling them failed with a host git error/);
  assert.deepEqual(state.blocker?.options, ["Mirror checked; retry", "Stop the run"]);
  assert.notEqual(state.outcome?.reason, "supervisor_error");
  assert.equal(state.selfImprove?.history.length, 1, "the finished cycle's record is intact");
  assert.equal(nth(state.selfImprove?.history ?? [], 0).head, slot.cycle1Head);
  assert.equal(mirrorGit(slot.engine.rt)(["rev-parse", "refs/heads/pi-autonomy/integration"]), slot.cycle1Head, "the local integration ref is unchanged");
  // A restart does not resume past the question.
  slot.engine = h.engine({ pid: 1002 });
  await slot.engine.engine.run();
  state = h.state();
  assert.equal(state.status, "blocked", JSON.stringify(state.outcome));
  assert.equal(state.blocker?.id, "integration-reconcile-failed", "still parked after a restart");
  assert.equal(state.selfImprove?.history.length, 1, "no cycle ran on the restart");
  assert.ok(stops >= 2, "both supervisors stopped at the question");
});

await check("the deprecated v0 shape maps onto this template: same limits and budgets, no default remote, an explicit destination", () => {
  const v0 = { run: "perpetual-x", cycles: 4, gitRemote: "https://git.example.org/team/repo.git", promotion: "push", budget: { perCycleUsd: 2, totalUsd: 20 }, limits: { softMinutes: 60, hardMinutes: 90 }, integration: { branch: "experimental/main" } };
  const r = resolveContract(v0, { effort: testEffort });
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  const cfg = runtimeConfig(contractOf(r));
  assert.deepEqual([cfg.integrationBranch, cfg.integrationRemote, cfg.baseSource, cfg.baseRef, cfg.publishTags, cfg.cycles], ["experimental/main", v0.gitRemote, v0.gitRemote, "main", true, 4]);
  assert.deepEqual(cfg.budget, { perCycleUsd: 2, perCycleHardUsd: 4, totalUsd: 20 });
  assert.equal(cfg.limits.softMinutes, 60);
  assert.equal(cfg.limits.idleMinutes, 20);
  const none = runtimeConfig(contractOf(resolveContract({ ...v0, promotion: "none" }, { effort: testEffort })));
  assert.equal(none.integrationRemote, null, "promotion none: no destination at all");
  const local = runtimeConfig(contractOf(resolveContract({ ...v0, gitRemote: "/srv/repo.git", promotion: "local-branch" }, { effort: testEffort })));
  assert.deepEqual([local.integrationRemote, local.publishTags], ["/srv/repo.git", false]);
});

await check("upstream is merged at every cycle start, published, then recorded up to date", async () => {
  const src = sourceRepo();
  sh(src, "checkout", "--quiet", "-b", "integration/trunk");
  fs.writeFileSync(path.join(src, "shared.txt"), "first\n");
  sh(src, "add", "."); sh(src, "commit", "--quiet", "-m", "trunk first");
  let upstream = sh(src, "rev-parse", "HEAD");
  const h = harness(improveRaw(src, { budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 3, maxMinutes: 5000 }, templateOptions: { integration: { upstream: "integration/trunk" } } }), {
    manager: manager([]),
    script: async (t) => {
      assert.equal(t.git(["merge-base", "--is-ancestor", upstream, "HEAD"]).status, 0);
      assert.equal(t.read("shared.txt"), t.step === 1 ? "first\n" : "second\n");
      const parents = t.git(["rev-list", "--parents", "-n", "1", "HEAD"]).stdout.trim().split(" ");
      if (t.step <= 2) assert.equal(parents.length, 3, "host creates a two-parent merge");
      assert.equal(sh(src, "rev-parse", "pi-autonomy/integration"), t.git(["rev-parse", "HEAD"]).stdout.trim(), "cycle-start merge is published as usual");
      t.write("AUDIT_OK", "1"); report(t, "successful"); t.commit(`stream cycle ${t.step}`);
      if (t.step === 1) {
        fs.writeFileSync(path.join(src, "shared.txt"), "second\n");
        sh(src, "add", "."); sh(src, "commit", "--quiet", "-m", "trunk second");
        upstream = sh(src, "rev-parse", "HEAD");
      }
    },
  });
  const { state } = await runOnce(h);
  assert.deepEqual(state.selfImprove?.history.map((c) => c.upstream?.outcome), ["merged", "merged", "up_to_date"]);
  assert.match(fs.readFileSync(h.store.p.log, "utf8"), /upstream integration\/trunk: merged [a-f0-9]{40}/);
});

await check("upstream conflict leaves integration unchanged and travels by bundle as refs/upstream/trunk with a P0 instruction", async () => {
  const src = sourceRepo();
  sh(src, "branch", "integration/trunk");
  const h = harness(improveRaw(src, { budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 2, maxMinutes: 5000 }, templateOptions: { integration: { upstream: "integration/trunk" } } }), {
    manager: manager([]),
    script: async (t) => {
      if (t.step === 1) {
        t.write("README.md", "stream intent\n"); t.write("AUDIT_OK", "1"); report(t, "successful"); t.commit("stream edit");
        sh(src, "checkout", "--quiet", "integration/trunk");
        fs.writeFileSync(path.join(src, "README.md"), "trunk intent\n");
        sh(src, "add", "."); sh(src, "commit", "--quiet", "-m", "trunk conflict");
      } else {
        const prev = t.store.readState()?.selfImprove?.history[0];
        assert.equal(t.git(["rev-parse", "HEAD"]).stdout.trim(), prev?.head, "host did not merge the conflict");
        assert.equal(t.git(["rev-parse", "refs/upstream/trunk"]).stdout.trim(), sh(src, "rev-parse", "integration/trunk"));
        assert.match(t.message, /## P0: upstream merge conflict/);
        assert.match(t.message, /git merge refs\/upstream\/trunk/);
        assert.match(t.message, /preserving both sides' intent, and re-verify/);
        assert.equal(t.git(["merge", "refs/upstream/trunk"]).status, 1);
        t.write("README.md", "stream intent\ntrunk intent\n"); report(t, "successful"); t.commit("resolve both intents");
      }
    },
  });
  const { state } = await runOnce(h);
  assert.deepEqual(state.selfImprove?.history.map((c) => c.upstream?.outcome), ["up_to_date", "conflict"]);
  assert.equal(state.selfImprove?.history[1]?.merged, true);
});

/** A trunk that conflicts on README.md and also brings a charter, package.json scripts, 70K characters of code and another run's records. */
function heavyTrunk(src: string): void {
  sh(src, "checkout", "--quiet", "integration/trunk");
  fs.writeFileSync(path.join(src, "README.md"), "trunk intent\n");
  fs.mkdirSync(path.join(src, "autonomy", "cycles", "other-run", "01"), { recursive: true });
  fs.mkdirSync(path.join(src, "lib"), { recursive: true });
  fs.writeFileSync(path.join(src, "autonomy", "CHARTER.md"), "# Trunk charter\n\nShared policy from the trunk.\n");
  fs.writeFileSync(path.join(src, "package.json"), JSON.stringify({ name: "x", scripts: { test: "node lib/big.ts" } }));
  fs.writeFileSync(path.join(src, "lib", "big.ts"), "export const TRUNK_BULK = 1;\n".repeat(2500));
  fs.writeFileSync(path.join(src, "autonomy", "cycles", "other-run", "01", "review.md"), "other run records\n".repeat(4000));
  sh(src, "add", "."); sh(src, "commit", "--quiet", "-m", "trunk work from other streams");
  sh(src, "checkout", "--quiet", "main");
}

await check("a conflict-resolving cycle is judged on what it adds over both parents: trunk's charter, scripts, bulk, records and paths outside writeAreas do not count", async () => {
  const src = sourceRepo();
  sh(src, "branch", "integration/trunk");
  const calls: ManagerCall[] = [];
  const h = harness(improveRaw(src, {
    budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 2, maxMinutes: 5000 },
    permissions: { unattended: { authorised: true, autoApprove: true }, writeAreas: ["README.md", "AUDIT_OK", "autonomy/cycles/**", "autonomy/runs/**", "autonomy/proposals/**"] },
    templateOptions: { integration: { upstream: "integration/trunk" } },
  }), {
    manager: manager(calls),
    script: async (t) => {
      assert.match(nth(t.prompts, 0), /`Mode: improve` \(it is for assigned improvements/, "streams take improvements from the steward");
      if (t.step === 1) {
        t.write("README.md", "stream intent\n"); t.write("AUDIT_OK", "1"); report(t, "successful"); t.commit("stream edit");
        heavyTrunk(src);
      } else if (t.prompts.length > 1) {
        t.elapse(301); t.hang(); // a refused push brings a continuation turn: let the cycle end
      } else {
        assert.match(t.message, /## P0: upstream merge conflict/);
        assert.equal(t.git(["merge", "refs/upstream/trunk"]).status, 1);
        assert.equal(t.git(["checkout", "--theirs", "--", "autonomy/CHARTER.md"]).status, 0);
        t.write("README.md", "stream intent\ntrunk intent\n"); report(t, "successful"); t.commit("resolve both intents");
      }
    },
  });
  const { state } = await runOnce(h);
  const entry = state.selfImprove?.history[1];
  assert.equal(entry?.upstream?.outcome, "conflict");
  assert.equal(entry?.merged, true, entry?.mergeReason ?? "");
  const review = nth(calls.filter((c) => /You review one cycle/.test(c.system)), 1).user;
  const diff = review.split("## Diff\n")[1] ?? "";
  assert.match(diff, /\+stream intent/, "the resolution is judged against the upstream head");
  assert.doesNotMatch(diff, /TRUNK_BULK|other run records|Trunk charter/, "trunk's own changes are not the cycle's diff");
  assert.doesNotMatch(review.split("## Commits (git log --stat)")[1]?.split("## Own run records")[0] ?? "", /trunk work from other streams/, "trunk's commits are not listed as the cycle's");
});

await check("a conflict-resolving cycle's own control-path change is still refused", async () => {
  const src = sourceRepo();
  sh(src, "branch", "integration/trunk");
  const h = harness(improveRaw(src, { budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 2, maxMinutes: 5000 }, templateOptions: { integration: { upstream: "integration/trunk" } } }), {
    manager: manager([]),
    script: async (t) => {
      if (t.step === 1) {
        t.write("README.md", "stream intent\n"); t.write("AUDIT_OK", "1"); report(t, "successful"); t.commit("stream edit");
        heavyTrunk(src);
      } else {
        assert.equal(t.git(["merge", "refs/upstream/trunk"]).status, 1);
        t.write("autonomy/CHARTER.md", "# A charter neither side wrote\n");
        t.write("README.md", "stream intent\ntrunk intent\n"); report(t, "successful"); t.commit("resolve and rewrite the charter");
      }
    },
  });
  const { state } = await runOnce(h);
  const entry = state.selfImprove?.history[1];
  assert.equal(entry?.merged, false);
  assert.match(entry?.mergeReason ?? "", /control path .*autonomy\/CHARTER\.md/);
  assert.doesNotMatch(entry?.mergeReason ?? "", /package\.json/, "trunk's scripts are upstream's, not the cycle's");
});

await check("a conflict resolution that keeps the integration side of an upstream change (merge -s ours) is refused", async () => {
  const src = sourceRepo();
  sh(src, "branch", "integration/trunk");
  const h = harness(improveRaw(src, { budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 2, maxMinutes: 5000 }, templateOptions: { integration: { upstream: "integration/trunk" } } }), {
    manager: manager([]),
    script: async (t) => {
      if (t.step === 1) {
        t.write("README.md", "stream intent\n"); t.write("AUDIT_OK", "1"); report(t, "successful"); t.commit("stream edit");
        heavyTrunk(src);
      } else {
        assert.equal(t.git(["-c", "user.name=t", "-c", "user.email=t@example.invalid", "merge", "--quiet", "-s", "ours", "-m", "keep ours", "refs/upstream/trunk"]).status, 0);
        report(t, "successful"); t.commit("record");
      }
    },
  });
  const { state } = await runOnce(h);
  const entry = state.selfImprove?.history[1];
  assert.equal(entry?.merged, false);
  assert.match(entry?.mergeReason ?? "", /drops upstream changes .*README\.md/);
});

await check("the cycle prompt is the lean worker brief: direct work, delegation only for an isolated package, one host review, submit and stop", async () => {
  let message = "";
  const h = harness(improveRaw(sourceRepo(), { budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 1, maxMinutes: 5000 } }), {
    manager: manager([]),
    script: async (t) => { message = t.message; t.write("AUDIT_OK", "1"); report(t, "successful"); t.commit("prompt seen"); },
  });
  await runOnce(h);
  assert.match(message, /Do the work directly/, "direct work is the default");
  assert.match(message, /Delegate only when it pays for itself: one isolated question, or one independent package/, "delegation is the exception");
  assert.match(message, /Do not start scouts, a planner, a reviewer for each item or a reviewer for the whole diff/, "no compulsory scouts or per-item reviewers");
  assert.match(message, /the host reviews the finished diff once/, "one review, by the host");
  assert.match(message, /Do not search for unrelated work/, "no scouting for work");
  assert.match(message, /stop: submitting the head and the note ends your session/, "submit and stop");
  assert.doesNotMatch(message, /workflow_run|"parallel"|worst case|`Workflow: refused/, "the compulsory workflow plans are gone");
  assert.doesNotMatch(message, /10 minutes or more/, "the stale timing claim is gone");
  assert.match(message, /about four minutes/, "the suite timing is the measured one");
  assert.doesNotMatch(message, /plan\.md|review\.md|verify\.md/, "no model-written plan, review or verify file is asked for");
  assert.ok(message.length < 7000, `the brief stays short (${message.length} characters)`);
  assert.doesNotMatch(message, /\{\{[A-Z_]+\}\}/, "every placeholder is filled");
});

await check("an upstream fetch failure is logged and the cycle still runs and merges", async () => {
  const h = harness(improveRaw(sourceRepo(), { budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 1, maxMinutes: 5000 }, templateOptions: { integration: { upstream: "missing/trunk" } } }), {
    manager: manager([]),
    script: async (t) => {
      assert.doesNotMatch(t.message, /## P0: upstream merge conflict/);
      assert.notEqual(t.git(["rev-parse", "--verify", "refs/upstream/trunk"]).status, 0);
      t.write("AUDIT_OK", "1"); report(t, "successful"); t.commit("green without upstream");
    },
  });
  const { state } = await runOnce(h);
  assert.equal(state.selfImprove?.history[0]?.upstream?.outcome, "fetch_failed");
  assert.equal(state.selfImprove?.history[0]?.merged, true);
  assert.match(fs.readFileSync(h.store.p.log, "utf8"), /upstream missing\/trunk: fetch_failed/);
});


await check("board prompt ranks two nonblocked items, refreshes each cycle, and review uses claimed acceptance from the prompt snapshot", async () => {
  const calls: ManagerCall[] = [];
  const board = { items: [
    { id: "V-01", title: "cleanup", priority: "P3" },
    { id: "V-02", title: "first assigned", priority: "P1", acceptance: "First acceptance" },
    { id: "V-03", title: "urgent blocked", priority: "P0", status: "blocked" },
    { id: "V-04", title: "second assigned", priority: "P1", acceptance: "Second acceptance" },
  ] };
  const h = harness(improveRaw(greenSourceRepo(), { budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 2, maxMinutes: 5000 } }), {
    manager: manager(calls),
    script: async (t) => {
      assert.match(t.message, /## Assigned work \(steward board\)/);
      assert.ok(t.message.includes(WORK_PRECEDENCE));
      if (t.step === 1) {
        assert.ok(t.message.indexOf("V-02 [P1]") < t.message.indexOf("V-04 [P1]"));
        assert.doesNotMatch(t.message, /V-01|V-03/);
        assert.match(t.message, /First acceptance/);
        assert.match(t.message, /Never run `npm test` or `npm run check:all`/);
        assert.match(t.message, /Put this rule in every subagent task you send/);
        assert.match(t.message, /Own new ideas go into `autonomy\/BACKLOG.md` as proposals/);
        // One copy each of the precedence and the own-ideas rule, and the items before the rules.
        assert.equal(t.message.split(WORK_PRECEDENCE).length, 2, "the precedence is stated once");
        assert.equal(t.message.split("Own new ideas go into").length, 2, "the own-ideas rule is stated once");
        assert.ok(t.message.indexOf("## Assigned work") < t.message.indexOf("Rules:"), "assigned items come right after the budget");
        assert.doesNotMatch(t.message, /Read the steward board/);
        fs.writeFileSync(path.join(t.store.p.control, "board.json"), JSON.stringify({ items: [{ id: "V-05", title: "next cycle assignment", priority: "P0", acceptance: "Next acceptance" }] }));
      } else {
        assert.match(t.message, /V-05 \[P0\]/);
        assert.doesNotMatch(t.message, /V-02 \[|V-04 \[/);
      }
      t.write("AUDIT_OK", `step ${t.step}\n`); report(t, "successful", "fix", t.step === 1 ? "Board: V-04 progress - Added the tested first part." : "No explicit claim; review assigned item."); t.commit("board progress");
    },
  });
  fs.writeFileSync(path.join(h.store.p.control, "board.json"), JSON.stringify(board));
  const { state } = await runOnce(h);
  assert.deepEqual(state.selfImprove?.history[0]?.board, [{ id: "V-04", status: "progress", note: "Added the tested first part." }]);
  const reviews = calls.filter((c) => /You review one cycle/.test(c.system));
  assert.match(nth(reviews, 0).user, /"id": "V-04"/);
  assert.match(nth(reviews, 0).user, /Second acceptance/);
  const claimed = nth(reviews, 0).user.split("## Claimed steward board items")[1]?.split("## Charter")[0] ?? "";
  assert.doesNotMatch(claimed, /First acceptance|Next acceptance/);
  assert.match(nth(reviews, 0).user, /## Assigned steward board items/);
  assert.match(nth(reviews, 0).user, /First acceptance/);
  assert.match(nth(reviews, 0).system, /lower-priority detour/);
  assert.match(nth(reviews, 1).user, /Next acceptance/);
  assert.equal(state.selfImprove?.merged, 2);
});


await check("partial green committed work goes through independent review; red and empty partial cycles never do", async () => {
  for (const kind of ["green", "red", "empty"] as const) {
    for (const verdict of kind === "green" ? ["MERGE", "REJECT"] : ["MERGE"]) {
      const calls: ManagerCall[] = [];
      const h = harness(improveRaw(sourceRepo(), { budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 1, maxMinutes: 5000 }, templateOptions: { integration: { review: false } } }), {
        manager: manager(calls, { review: verdict }),
        script: async (t) => {
          if (kind !== "empty") { t.write(kind === "green" ? "AUDIT_OK" : "unfinished.txt", "1"); report(t, "partial"); t.commit("checkpoint"); }
          t.elapse(301); t.hang();
        },
      });
      const { state } = await runOnce(h);
      const entry = state.selfImprove?.history[0];
      assert.equal(entry?.outcome, "partial");
      assert.equal(entry?.reason, "hard_limit");
      assert.equal(entry?.merged, kind === "green" && verdict === "MERGE");
      const reviews = calls.filter((c) => /You review one cycle/.test(c.system));
      assert.equal(reviews.length, kind === "green" ? 1 : 0);
      if (kind === "green") assert.match(nth(reviews, 0).user, /cycle 1: partial/);
      else assert.equal(entry?.gate, kind === "red" ? "red" : "skipped");
    }
  }
});

await check("a resumed cycle keeps its board snapshot: claims against the board it started with still reach review", async () => {
  const calls: ManagerCall[] = [];
  const h = harness(improveRaw(greenSourceRepo(), { budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 1, maxMinutes: 5000 } }), {
    manager: manager(calls),
    script: async (t) => { t.write("partial.txt", "1"); t.commit("checkpoint"); fs.writeFileSync(path.join(t.store.p.root, "STOP"), ""); t.hang(); },
  });
  fs.writeFileSync(path.join(h.store.p.control, "board.json"), JSON.stringify({ items: [{ id: "V-02", title: "started item", priority: "P1", acceptance: "Started acceptance" }] }));
  await runOnce(h);
  assert.equal(h.state().status, "paused");
  fs.writeFileSync(path.join(h.store.p.control, "board.json"), JSON.stringify({ items: [{ id: "V-05", title: "steward's next item", priority: "P0" }] }));
  fs.rmSync(path.join(h.store.p.root, "STOP")); h.store.enqueue("unpause");
  const resumed = await runOnce(h, { rt: h.runtime(async (t) => { t.write("AUDIT_OK", "1"); report(t, "successful", "fix", "Board: V-02 done - Finished the started item with tests."); t.commit("finish started item"); }) });
  const entry = resumed.state.selfImprove?.history[0];
  assert.equal(entry?.merged, true, entry?.mergeReason ?? "");
  assert.match(nth(calls.filter((c) => /You review one cycle/.test(c.system)), 0).user, /Started acceptance/);
});

await check("without a board, Board: lines are recorded but never refuse the merge, and legacy prompts keep choosing their own improvements", async () => {
  const calls: ManagerCall[] = [];
  const h = harness(improveRaw(sourceRepo(), { budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 1, maxMinutes: 5000 } }), {
    manager: manager(calls),
    script: async (t) => {
      assert.match(t.message, /`Mode: improve` \(it is for when the review finds nothing worth fixing\. Make an existing system/);
      assert.doesNotMatch(t.message, /Board: <ID>|## Assigned work|steward to assign|Own new ideas go into/);
      t.write("AUDIT_OK", "1"); report(t, "successful", "fix", "Board: B-003 done - Worked a backlog item."); t.commit("backlog work");
    },
  });
  const { state } = await runOnce(h);
  const entry = state.selfImprove?.history[0];
  assert.equal(entry?.merged, true, entry?.mergeReason ?? "");
  assert.deepEqual(entry?.board, [{ id: "B-003", status: "done", note: "Worked a backlog item." }]);
  assert.equal(calls.filter((c) => /You review one cycle/.test(c.system)).length, 1);
});

await check("an existing paused cycle with no board or upstream fields loads and resumes", async () => {
  const h = harness(improveRaw(sourceRepo(), { budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 2, maxMinutes: 5000 } }), {
    manager: manager([]),
    script: async (t) => {
      if (t.step === 1) { t.write("AUDIT_OK", "1"); report(t, "successful"); t.commit("first cycle"); }
      else { fs.writeFileSync(path.join(t.store.p.root, "STOP"), ""); t.hang(); }
    },
  });
  await runOnce(h);
  const old = h.state();
  assert.ok(old.selfImprove?.current);
  delete old.selfImprove.current.board;
  delete old.selfImprove.current.upstream;
  for (const c of old.selfImprove.history) { delete c.board; delete c.upstream; }
  h.store.writeState(old);
  assert.equal(h.store.readState()?.selfImprove?.history.length, 1);
  fs.rmSync(path.join(h.store.p.root, "STOP")); h.store.enqueue("unpause");
  const resumed = await runOnce(h, { rt: h.runtime(async (t) => { t.write("finished.txt", "1\n"); report(t, "successful"); t.commit("finish old cycle"); }) });
  assert.equal(resumed.state.selfImprove?.history[1]?.merged, true);
});

await check("the cycle prompt names the start sha, the review budget with its measure command, the stream focus and the targeted-test rule", async () => {
  const src = sourceRepo();
  sh(src, "branch", "integration/trunk");
  const h = harness(improveRaw(src, {
    objective: { title: "UX stream", spec: "TUI overlays and the launch screen; owns packages/web-ui.", backlog: [] },
    budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 1, maxMinutes: 5000 },
    templateOptions: { integration: { upstream: "integration/trunk" } },
  }), {
    manager: manager([]),
    script: async (t) => {
      const start = t.git(["rev-parse", "HEAD"]).stdout.trim().slice(0, 12);
      assert.ok(t.message.includes(`\`${start}\`, the cycle start`), "the start sha is given");
      assert.ok(t.message.includes(`git diff --no-renames ${start}..HEAD -- . ":(exclude)package-lock.json" ":(exclude)autonomy/cycles/improve-test-1/" ":(exclude)autonomy/runs/improve-test-1/" | wc -c`), t.message);
      assert.match(t.message, /at most 60000 characters/);
      assert.match(t.message, /stop taking new items once it passes 30000/);
      assert.ok(t.message.includes(`git log --oneline ${start}..HEAD`));
      assert.doesNotMatch(t.message, /<cycle start>|main\.\.HEAD/);
      assert.match(t.message, /Your stream: UX stream: TUI overlays and the launch screen; owns packages\/web-ui\.\. Work only inside this stream's area/);
      assert.match(t.message, /there is no board file to read/);
      assert.match(t.message, /this prompt wins: the merge review judges streams against the current stream charter/);
      assert.ok(t.message.includes(`node packages/core/check-all.ts --for-changed="$(git diff --name-only ${start}..HEAD | tr '\\n' ',')"`), "the verify plan derives its checks from the diff");
      assert.match(t.message, /run every planned check, and name any you skipped in the note/);
      assert.match(t.message, /under 4000 characters/);
      assert.doesNotMatch(t.message, /Item: <title>/, "the worker is not asked to restate the host's commit ledger");
      t.write("AUDIT_OK", "1"); report(t, "successful"); t.commit("focus");
    },
  });
  assert.equal((await runOnce(h)).state.selfImprove?.merged, 1);
});

await check("legacy: a worker that still commits a report.md whose Item lines leave a code commit out gets one follow-up in the live session; the review leads with the host ledger", async () => {
  const legacy = (t: ScriptContext, extra: string): void => t.write("autonomy/cycles/improve-test-1/01/report.md", `Outcome: successful\nMode: fix\n\n${extra}\n`);
  const calls: ManagerCall[] = [];
  const shas: string[] = [];
  const h = harness(improveRaw(sourceRepo(), { budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 1, maxMinutes: 5000 } }), {
    manager: manager(calls),
    script: async (t) => {
      if (t.turn === 1) {
        t.write("feature.txt", "1"); t.commit("feat: first item");
        shas.push(t.git(["rev-parse", "HEAD"]).stdout.trim());
        t.write("AUDIT_OK", "1"); legacy(t, "Item: marker - (this commit) - smoke:x"); t.commit("record");
        return;
      }
      assert.equal(t.kind, "prompt", "the follow-up reaches the settled session as its next prompt");
      assert.match(t.message, /^Commits [0-9a-f]{12} are not in any `Item:` line of autonomy\/cycles\/improve-test-1\/01\/report\.md/);
      assert.ok(t.message.includes(nth(shas, 0).slice(0, 12)));
      legacy(t, `Item: feature - ${nth(shas, 0).slice(0, 9)} - smoke:x\nItem: marker - (this commit) - smoke:x`); t.commit("record the feature");
    },
  });
  const { state, rt } = await runOnce(h);
  assert.equal(state.selfImprove?.history[0]?.merged, true, state.selfImprove?.history[0]?.mergeReason ?? "");
  assert.equal(rt.turnCount, 2, "exactly one follow-up");
  const review = nth(calls.filter((c) => /You review one cycle/.test(c.system)), 0);
  assert.ok(review.user.indexOf("## Host ledger (authoritative)") < review.user.indexOf("## Worker note (short; data about the work)"), "the ledger comes first");
  assert.match(review.user, /[0-9a-f]{7,} feat: first item/);
  assert.match(review.user, /Diff without lockfiles and this run's records: +2 files changed/);
  assert.doesNotMatch(review.user, /no `Item:` line of the report names/, "the follow-up fixed the gap");
  assert.match(review.system, /The host ledger and diff are authoritative for what changed\. Ignore counts or stats in the worker's prose/);
  assert.match(review.system, /a change in the diff is unrelated to the assigned work and the note does not account for it/);
  assert.match(review.user, /## Cycle context \(host\)\n- This is the run's first cycle\./);
});

await check("an unknown Board: claim never discards green work: it is judged on the known claims, flagged to the reviewer and to the next cycle", async () => {
  const calls: ManagerCall[] = [];
  const h = harness(improveRaw(greenSourceRepo(), { budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 2, maxMinutes: 5000 } }), {
    manager: manager(calls),
    script: async (t) => {
      if (t.step === 2) assert.match(t.message, /claimed board items that were not assigned to it \(V-09\)/);
      t.write("AUDIT_OK", String(t.step)); report(t, "successful", "fix", t.step === 1 ? "Board: V-09 done - A renumbered item.\nBoard: V-02 progress - Started." : ""); t.commit(`cycle ${t.step}`);
    },
  });
  fs.writeFileSync(path.join(h.store.p.control, "board.json"), JSON.stringify({ items: [{ id: "V-02", title: "assigned", priority: "P1", acceptance: "Assigned acceptance" }] }));
  const { state } = await runOnce(h);
  const first = state.selfImprove?.history[0];
  assert.equal(first?.merged, true, first?.mergeReason ?? "");
  assert.deepEqual(first?.unknownClaims, ["V-09"]);
  const reviews = calls.filter((c) => /You review one cycle/.test(c.system));
  assert.match(nth(reviews, 0).user, /not on this cycle's board: V-09/);
  assert.match(nth(reviews, 0).user, /## Claimed steward board items[\s\S]*Assigned acceptance/);
  assert.match(nth(reviews, 1).user, /## Board items for reference \(the report makes no Board: claim/);
  assert.match(nth(reviews, 1).user, /Previous cycle 01: completed, gate green, merged\./);
});

await check("operator steers reach a live cycle session; one queued during an earlier cycle is marked as such", async () => {
  const seen: Array<{ kind: string; message: string }> = [];
  const h = harness(improveRaw(sourceRepo(), { budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 1, maxMinutes: 5000 } }), {
    manager: manager([]),
    script: async (t) => {
      seen.push({ kind: t.kind, message: t.message });
      if (seen.length === 1) { t.store.enqueue("steer", { message: "focus on the marker" }); t.hang(); return; }
      t.write("AUDIT_OK", "1"); report(t, "successful"); t.commit("steered");
    },
  });
  const made = h.engine();
  made.engine.pendingFeedback.push({ text: "Operator steering (authoritative): revert the old file", step: 0, inStep: true });
  made.engine.pendingFeedback.push({ text: "Operator steering (authoritative): queued between cycles", step: 0, inStep: false });
  await made.engine.run();
  const first = nth(seen, 0).message;
  assert.match(first, /- Sent during cycle 00, which has ended; apply only if it is still relevant: Operator steering: revert the old file/);
  assert.match(first, /- Operator steering \(authoritative\): queued between cycles/);
  assert.deepEqual([nth(seen, 1).kind, nth(seen, 1).message], ["steer", "Operator steering (authoritative): focus on the marker"], "delivered to the running session, not queued for the next cycle");
  assert.equal(h.state().selfImprove?.history[0]?.merged, true);
});

await check("a session that dies before its first frame is relaunched with the workspace reset still owed", async () => {
  const h = harness(improveRaw(sourceRepo(), { budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 1, maxMinutes: 5000 } }), {
    manager: manager([]),
    script: async (t) => { t.write("AUDIT_OK", "1"); report(t, "successful"); t.commit("after a failed start"); },
  });
  const rt = h.runtime();
  rt.dieOnStart = 1;
  const { state } = await runOnce(h, { rt });
  assert.deepEqual(rt.calls.workers.map((w) => w.resetWorkspace), [true, true], "the reset is repeated for the relaunch");
  assert.equal(state.selfImprove?.history[0]?.merged, true);
  // Once a session has started (emitted a frame), a restart keeps its workspace.
  const h2 = harness(improveRaw(sourceRepo(), { budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 1, maxMinutes: 5000 } }), {
    manager: manager([]),
    script: async (t) => { if (t.attempt === 1) { t.crash(); return; } t.write("AUDIT_OK", "1"); report(t, "successful"); t.commit("after a crash"); },
  });
  const rt2 = h2.runtime();
  await runOnce(h2, { rt: rt2 });
  assert.deepEqual(rt2.calls.workers.map((w) => w.resetWorkspace), [true, false]);
});

await check("an over-budget refusal tells the next cycle to carry a reviewable subset, not to re-carry everything", async () => {
  const h = harness(improveRaw(sourceRepo(), { budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 2, maxMinutes: 5000 } }), {
    manager: manager([]),
    script: async (t) => {
      if (t.step === 1) { t.write("AUDIT_OK", "1"); t.write("bulk.txt", "x".repeat(70_000)); report(t, "successful"); t.commit("too big"); return; }
      assert.match(t.message, /carry over only a reviewable subset/);
      assert.doesNotMatch(t.message, /bring over what is sound/);
      t.write("AUDIT_OK", "1"); report(t, "successful"); t.commit("small");
    },
  });
  const { state } = await runOnce(h);
  assert.match(state.selfImprove?.history[0]?.mergeReason ?? "", /^the diff without lockfiles/);
  assert.equal(state.selfImprove?.history[1]?.merged, true);
});

await check("an over-budget cycle is caught pre-report: the live worker is steered with the measured number, then splits and the next cycle merges", async () => {
  const calls: ManagerCall[] = [];
  const messages: Array<{ step: number; kind: string; message: string }> = [];
  const probe = "The diff this cycle would submit is";
  const h = harness(improveRaw(greenSourceRepo(), { budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 3, maxMinutes: 5000 } }), {
    manager: manager(calls),
    script: async (t) => {
      messages.push({ step: t.step, kind: t.kind, message: t.message });
      if (t.step === 1) {
        if (t.message.startsWith(probe)) return; // the probe's continuation turn: leave the head as it is
        t.write("AUDIT_OK", "1"); t.write("bulk.txt", "x".repeat(70_000)); report(t, "successful"); t.commit("cycle 1: 70k bulk");
        return;
      }
      if (t.step === 2) {
        if (t.message.startsWith(probe)) return; // the probe's continuation turn: leave the head as it is
        t.write("AUDIT_OK", "1"); t.write("bulk.txt", "x".repeat(70_000)); t.write("extra.txt", "y".repeat(10_000)); report(t, "successful"); t.commit("cycle 2: re-lands the bulk plus 10k");
        return;
      }
      t.write("AUDIT_OK", "1"); t.write("extra.txt", "y".repeat(10_000)); report(t, "successful"); t.commit("cycle 3: 10k only");
    },
  });
  const { state, rt } = await runOnce(h);
  const [c1, c2, c3] = state.selfImprove?.history ?? [];
  assert.ok(c1 && c2 && c3, "three cycles are recorded");
  // (a) both over-budget cycles start from the seed/integration head; the rejected work never accumulates on the branch.
  const seed = state.selfImprove?.seedSha;
  assert.equal(c2.start, c1.start, "cycle 2 starts from the same integration head as cycle 1");
  assert.equal(c3.start, c1.start, "cycle 3 also starts from that head");
  assert.equal(c1.start, seed, "the over-budget cycle starts from the seed head");
  // (b) both refusals cite the measured character count.
  const shape = /^the diff without lockfiles and this run's record files \((\d+) characters\) exceeds the merge review's budget of 60000 characters/;
  const m1 = shape.exec(c1.mergeReason); const m2 = shape.exec(c2.mergeReason);
  assert.ok(m1, `cycle 1 refusal cites the measured number: ${c1.mergeReason}`);
  assert.ok(m2, `cycle 2 refusal cites the measured number: ${c2.mergeReason}`);
  const n1 = Number(m1[1]); const n2 = Number(m2[1]);
  assert.ok(n1 > 60_000, `cycle 1 was over budget (${String(n1)})`);
  assert.ok(n2 > 60_000, `cycle 2 was over budget (${String(n2)})`);
  assert.ok(n2 > n1 + 9_000, `cycle 2 accumulated cycle 1's work plus the new 10k (${String(n1)} -> ${String(n2)})`);
  assert.equal(c1.merged, false, "cycle 1 was refused");
  assert.equal(c2.merged, false, "cycle 2 was refused");
  // The cycle's own pre-report check refuses the still-over-budget head after the split steer.
  assert.equal(c1.outcome, "partial", "cycle 1 closed partial after its own pre-report refusal");
  assert.match(c1.reason, new RegExp(`^refused_budget: the diff this cycle would submit is ${String(n1)} characters, over the merge review's budget of 60000 characters$`), `cycle 1 reason: ${c1.reason}`);
  assert.equal(c2.outcome, "partial", "cycle 2 closed partial after its own pre-report refusal");
  assert.match(c2.reason, new RegExp(`^refused_budget: the diff this cycle would submit is ${String(n2)} characters, over the merge review's budget of 60000 characters$`), `cycle 2 reason: ${c2.reason}`);
  // (c) rejected work is preserved as a tag and offered to the next cycle as an attempts branch.
  const mg = mirrorGit(rt);
  assert.ok(mg(["rev-parse", "--verify", "refs/tags/pi/improve-test-1/cycle-01"]), "cycle 1's tag exists in the mirror");
  assert.ok(mg(["rev-parse", "--verify", "refs/tags/pi/improve-test-1/cycle-02"]), "cycle 2's tag exists in the mirror");
  const remoteBranches = spawnSync("git", ["--git-dir", rt.p.remote, "for-each-ref", "--format=%(refname)"], { encoding: "utf8" }).stdout;
  assert.match(remoteBranches, /refs\/heads\/attempts\/improve-test-1\/cycle-01/, "the worker remote offers cycle 1's attempt");
  assert.match(remoteBranches, /refs\/heads\/attempts\/improve-test-1\/cycle-02/, "the worker remote offers cycle 2's attempt");
  // (d) only the under-budget cycle reached the merge review; it merged.
  assert.equal(c3.merged, true, c3.mergeReason);
  assert.equal(calls.filter((c) => /You review one cycle/.test(c.system)).length, 1, "the merge-review model was called exactly once");
  // (e) the live worker was told the measured number and the budget while each over-budget cycle was still alive.
  const steer1 = messages.find((m) => m.step === 1 && m.message.startsWith(probe));
  const steer2 = messages.find((m) => m.step === 2 && m.message.startsWith(probe));
  assert.ok(steer1, "cycle 1 got a pre-report budget steer");
  assert.ok(steer2, "cycle 2 got a pre-report budget steer");
  assert.match(steer1.message, new RegExp(`The diff this cycle would submit is ${String(n1)} characters, over the merge review's budget of 60000 characters`));
  assert.match(steer1.message, /attempts\/improve-test-1\/cycle-01/);
  assert.match(steer2.message, new RegExp(`The diff this cycle would submit is ${String(n2)} characters, over the merge review's budget of 60000 characters`));
  assert.match(steer2.message, /attempts\/improve-test-1\/cycle-02/);
});

await check("check-map: a changed-path diff implies the host gate's checks, and verifyPlan splits them disjointly", () => {
  const thirdParty = checksForChangedPaths([
    "packages/extensions/third_party/subagent/SOURCE.md",
    "packages/extensions/third_party/subagent/workflow-tools.ts",
  ]);
  for (const name of ["verify", "smoke:new-extension", "smoke:eval-footprint", "smoke:subagent-roles-isolation"]) {
    assert.ok(thirdParty.includes(name), `${name} is planned for a third_party change`);
  }

  // Both source sides of the smoke:workflow-notify byte-copy assertion plan it, not just the
  // third_party copy (tests/workflow-notify-smoke.ts).
  const secretGuardSource = checksForChangedPaths(["packages/extensions/src/secret-guard/index.ts"]);
  assert.ok(secretGuardSource.includes("smoke:workflow-notify"), "a changed copy-pair source plans smoke:workflow-notify");
  assert.ok(secretGuardSource.includes("smoke:secret-guard"), "a changed secret-guard source plans smoke:secret-guard");
  const commonSource = checksForChangedPaths(["packages/autonomy/lib/templates/common.ts"]);
  assert.ok(commonSource.includes("smoke:workflow-notify"), "the other copy-pair source plans smoke:workflow-notify");

  // DE-102: security paths and the autonomy modules other smokes pin plan those smokes.
  const covered: Array<[string, readonly string[]]> = [
    ["packages/extensions/src/tool-firewall/index.ts", ["smoke:tool-firewall", "smoke:firewall-gate", "smoke:firewall-unattended"]],
    ["packages/core/shared/redact.ts", ["smoke:redaction-corpus", "smoke:fuzz-redaction"]],
    ["packages/core/lib/leak-scan.ts", ["smoke:prepush-scan"]],
    ["packages/core/prepush-scan.ts", ["smoke:prepush-scan"]],
    ["packages/core/leak-scan-exceptions.json", ["smoke:prepush-scan"]],
    ["packages/core/install.ts", ["smoke:install-guided", "smoke:clean-install"]],
    ["packages/core/lib/install-guide.ts", ["smoke:install-guided"]],
    ["packages/autonomy/lib/gate-slots.ts", ["smoke:autonomy-lifecycle"]],
    ["packages/autonomy/lib/unpublished.ts", ["smoke:autonomy-cli"]],
  ];
  for (const [file, needed] of covered) {
    const planned = checksForChangedPaths([file]);
    for (const name of needed) assert.ok(planned.includes(name), `${name} is planned for a change to ${file}`);
  }

  const docs = checksForChangedPaths(["docs/guide.md"]);
  assert.ok(docs.includes("docs:check"), "docs changes need docs:check");
  for (const name of ["smoke:eval-footprint", "smoke:subagent-roles-isolation", "smoke:new-extension", "smoke:workflow-notify"]) {
    assert.ok(!docs.includes(name), `${name} is not planned for a docs-only change`);
  }

  // CI policy and the core entry scripts plan the checks that pin them, so a cycle editing one of
  // these files cannot record its pinning check as skipped.
  const ciWorkflow = checksForChangedPaths([".github/workflows/ci.yml"]);
  for (const name of ["smoke:workflow-policy", "smoke:release-workflow"]) assert.ok(ciWorkflow.includes(name), `${name} is planned for a workflow change`);
  assert.ok(!ciWorkflow.includes("smoke:install-marker"), "an unrelated check is not planned for a workflow change");
  const settings = checksForChangedPaths([".github/expected-settings.json"]);
  for (const name of ["smoke:workflow-policy", "smoke:github-settings-check"]) assert.ok(settings.includes(name), `${name} is planned for an expected-settings change`);
  const owners = checksForChangedPaths([".github/CODEOWNERS"]);
  assert.ok(owners.includes("smoke:codeowners-coverage"), "smoke:codeowners-coverage is planned for a CODEOWNERS change");
  const zizmor = checksForChangedPaths([".github/zizmor.yml"]);
  for (const name of ["smoke:workflow-policy", "smoke:suppression-inventory"]) assert.ok(zizmor.includes(name), `${name} is planned for a zizmor config change`);
  const codeql = checksForChangedPaths([".github/codeql/codeql-config.yml"]);
  assert.ok(codeql.includes("smoke:suppression-inventory"), "smoke:suppression-inventory is planned for a CodeQL config change");
  const dependabot = checksForChangedPaths([".github/dependabot.yml"]);
  assert.ok(dependabot.includes("smoke:scan-coverage"), "smoke:scan-coverage is planned for a dependabot change");
  const installer = checksForChangedPaths(["packages/core/install.ts"]);
  for (const name of ["smoke:install-marker", "smoke:install-filter", "smoke:profile-transaction", "smoke:clean-install"]) assert.ok(installer.includes(name), `${name} is planned for an install.ts change`);
  assert.ok(!installer.includes("smoke:codeowners-coverage"), "an unrelated check is not planned for an install.ts change");
  const coverage = checksForChangedPaths(["packages/core/coverage.ts"]);
  assert.ok(coverage.includes("smoke:check-all-npm"), "smoke:check-all-npm is planned for a coverage.ts change");

  // With a scripts record, a changed file a check runs directly plans that check: the table only
  // matches source dirs, so a changed test file would otherwise go unplanned.
  const fixtureScripts = { "smoke:foo": "node tests/foo-smoke.ts", "smoke:bar": "node tests/bar-smoke.ts" };
  const foo = checksForChangedPaths(["tests/foo-smoke.ts"], fixtureScripts);
  assert.ok(foo.includes("smoke:foo"), "a changed test file plans the check that runs it");
  assert.ok(!foo.includes("smoke:bar"), "an unrelated check is not planned");
  const fixturePlan = verifyPlan(["tests/foo-smoke.ts"], ["smoke:foo", "smoke:bar"], fixtureScripts);
  assert.deepEqual(fixturePlan.run, ["smoke:foo"], "the check that runs the file is in run");
  assert.deepEqual(fixturePlan.skipped, ["smoke:bar"], "the other check is disjointly in skipped");
  assert.deepEqual([...fixturePlan.run, ...fixturePlan.skipped].sort(), ["smoke:bar", "smoke:foo"], "run and skipped cover the known checks");

  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
  const table: unknown = CHANGED_PATH_CHECKS;
  assert.ok(Array.isArray(table), "the changed-path table is an array");
  for (const rule of CHANGED_PATH_CHECKS) {
    assert.equal(typeof rule.glob, "string", "every rule names a glob string");
    const checks: unknown = rule.checks;
    assert.ok(Array.isArray(checks), `checks of ${rule.glob} is an array`);
    for (const name of rule.checks) assert.ok(Object.hasOwn(pkg.scripts, name), `${name} exists in package.json scripts`);
  }
  for (const name of ALWAYS_CHECKS) assert.ok(Object.hasOwn(pkg.scripts, name), `always check ${name} exists in package.json scripts`);

  const known = [...new Set(CHANGED_PATH_CHECKS.flatMap((rule) => rule.checks))].sort();
  const plan = verifyPlan(["docs/guide.md"], known);
  assert.deepEqual([...plan.run, ...plan.skipped].sort(), known, "run and skipped cover every known check");
  for (const name of plan.run) assert.ok(!plan.skipped.includes(name), `${name} is both run and skipped`);

  const template = fs.readFileSync(path.join(REPO_ROOT, "packages", "autonomy", "prompts", "cycle.md"), "utf8");
  assert.match(template, /\{\{VERIFY_PLAN\}\}/, "cycle.md carries the plan the host derives from the diff (--for-changed, RAN or SKIPPED: asserted on the built prompt above)");
});


// --- risk tiers, the single review and the repair round (lib/risk.ts, lib/attempts.ts) -----------------------
const noGate = { checks: [{ id: "gate", run: NODE_EXIT("true"), timeoutMinutes: 1, required: true }], review: true };
const reviewCount = (calls: readonly ManagerCall[]): number => calls.filter((c) => /You review one cycle/.test(c.system)).length;
const riskRun = (over: RawContract, files: Record<string, string>, reply?: (system: string) => string): { calls: ManagerCall[]; h: Harness; parked: { state: ReturnType<Harness["state"]> | null } } => {
  const calls: ManagerCall[] = [];
  const parked: { state: ReturnType<Harness["state"]> | null } = { state: null };
  const base = manager(calls);
  const h: Harness = harness(improveRaw(sourceRepo(), { acceptance: noGate, budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 1, maxMinutes: 5000 }, ...over }), {
    manager: async (system, user, model) => (reply && /You review one cycle/.test(system) ? (calls.push({ system, user, model }), reply(system)) : base(system, user, model)),
    // A parked run (an unusable review) waits for a person: capture it and end the test run.
    hooks: { onSleep: () => { const s = h.state(); if (s.status === "blocked" && !parked.state) { parked.state = structuredClone(s); h.store.enqueue("cancel", { reason: "test done" }); } } },
    script: async (t) => { for (const [file, body] of Object.entries(files)) t.write(file, body); report(t, "successful"); t.commit("change"); },
  });
  return { calls, h, parked };
};

await check("R0: a prose-only cycle starts fully reviewed (one review), and the host records the tier", async () => {
  const { calls, h } = riskRun({}, { "README.md": "words\n" });
  const { state } = await runOnce(h);
  assert.equal(reviewCount(calls), 1, "the single review still runs by default");
  assert.equal(state.selfImprove?.history[0]?.risk?.tier, "R0");
  assert.equal(state.selfImprove?.history[0]?.merged, true);
});

await check("R0: behind the r0Review switch a prose-only cycle merges on green checks with no model review; code still gets one", async () => {
  const off = { templateOptions: { integration: { branch: "pi-autonomy/integration", review: true, r0Review: 0 }, limits: { nothingFoundToStop: 2 } } };
  const prose = riskRun(off, { "README.md": "words\n", "docs/guide.md": "more words\n" });
  const { state } = await runOnce(prose.h);
  assert.equal(reviewCount(prose.calls), 0, "no review call for a prose-only cycle");
  assert.equal(state.selfImprove?.history[0]?.merged, true);
  assert.match(state.selfImprove?.history[0]?.mergeReason ?? "", /R0 .*no model review/);
  const code = riskRun(off, { "README.md": "words\n", "src/app.js": "1\n" });
  assert.equal((await runOnce(code.h)).state.selfImprove?.history[0]?.risk?.tier, "R1");
  assert.equal(reviewCount(code.calls), 1, "any path the host cannot call prose escalates out of R0");
  const invalid = resolveContract(improveRaw(sourceRepo(), { templateOptions: { integration: { r0Review: 2 } } }), { effort: testEffort });
  assert.ok(invalid.problems.some((p) => p.path === "templateOptions.integration.r0Review" && p.level === "error"), "the switch is validated");
});

await check("R3: a change to gate policy or release machinery is not merged by an unattended cycle and no model is asked", async () => {
  const { calls, h } = riskRun({}, { ".github/workflows/release.yml": "name: x\n" });
  const { state } = await runOnce(h);
  assert.equal(reviewCount(calls), 0);
  assert.equal(state.selfImprove?.history[0]?.merged, false);
  assert.equal(state.selfImprove?.history[0]?.risk?.tier, "R3");
  assert.match(state.selfImprove?.history[0]?.mergeReason ?? "", /R3 change .*owner\/steward route/);
});

await check("R2: one review carries one specialist question; a CONCERN rejects, an OK merges, a reply without the answer fails closed", async () => {
  const ask = (answer: string | null) => riskRun({}, { "src/recovery.js": "1\n" }, () => JSON.stringify({ verdict: "MERGE", ...(answer ? { specialist: answer } : {}), reason: "looked", concerns: [] }));
  const concern = ask("CONCERN");
  const rejected = (await runOnce(concern.h)).state.selfImprove?.history[0];
  assert.equal(reviewCount(concern.calls), 1, "one review call, not a second reviewer");
  assert.match(nth(concern.calls, 0).system, /Specialist question .*recover/i);
  assert.equal(rejected?.risk?.tier, "R2");
  assert.equal(rejected?.merged, false);
  assert.match(rejected?.mergeReason ?? "", /specialist concern/);
  const ok = ask("OK");
  assert.equal((await runOnce(ok.h)).state.selfImprove?.history[0]?.merged, true);
  assert.equal(reviewCount(ok.calls), 1);
  const silent = ask(null);
  await runOnce(silent.h);
  assert.equal(silent.parked.state?.selfImprove?.history.length, 0, "an unanswered specialist question is no verdict: parked, not merged");
  assert.equal(silent.parked.state?.pendingQuestions?.at(-1)?.id, "review-pending");
});

await check("one ordinary attempt plus one repair per board item: after two unmerged cycles the item is no longer offered, and why is recorded", async () => {
  const calls: ManagerCall[] = [];
  const prompts: string[] = [];
  const h = harness(improveRaw(greenSourceRepo(), { budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 3, maxMinutes: 5000 } }), {
    manager: manager(calls, { review: "REJECT" }),
    hooks: { onSleep: () => { if (h.state().selfImprove?.idle) h.store.enqueue("cancel"); } },
    script: async (t) => {
      prompts.push(t.message);
      t.write("AUDIT_OK", "1"); t.write(`attempt-${t.step}.js`, "1\n"); report(t, "partial", "fix", "Board: V-02 progress - tried.");
      t.commit(`attempt ${t.step}`);
    },
  });
  fs.writeFileSync(path.join(h.store.p.control, "board.json"), JSON.stringify({ items: [{ id: "V-02", title: "the item", priority: "P1", acceptance: "Do it" }] }));
  const { state } = await runOnce(h);
  assert.equal(prompts.length, 2, "the ordinary attempt and one repair; the withheld item leaves an empty queue, so no third session starts");
  assert.match(nth(prompts, 0), /V-02 \[P1\]/, "the ordinary attempt");
  assert.match(nth(prompts, 1), /V-02 \[P1\]/, "the one repair");
  assert.ok(state.selfImprove?.idle, "then the host sleeps instead of offering the item again or scouting for other work");
  assert.equal(calls.filter((c) => !/You review one cycle/.test(c.system)).length, 0, "no manager call while idle");
  const record = state.selfImprove?.itemAttempts?.["V-02"];
  assert.deepEqual([record?.attempts, record?.withheld], [2, true]);
  assert.match(record?.lastReason ?? "", /review REJECT/, "the reason it stopped is recorded");
  assert.match(fs.readFileSync(h.store.p.log, "utf8"), /board item V-02 is no longer offered: 2 attempt/);
});

await check("a note left by the previous cycle does not close the next one: the host clears it, and a worker that stops without writing is asked for it", async () => {
  const h = harness(improveRaw(sourceRepo(), { budget: { totalUsd: 50, perStepUsd: 5, maxSteps: 2, maxMinutes: 5000 } }), {
    manager: manager([]),
    script: async (t) => {
      if (t.step === 1) { t.write("AUDIT_OK", "1"); t.commit("one"); t.note("Outcome: successful\nMode: fix\n\nfirst\n"); return; }
      if (t.message.startsWith("You are working on the repository")) {
        assert.equal(t.read("autonomy/cycles/improve-test-1/01/note.md"), null);
        t.write("second.txt", "2"); t.commit("two"); // settles with no note: cycle 1's note must not count
        return;
      }
      assert.match(t.message, /You stopped before submitting[\s\S]*\/state\/cycle-note\.md/);
      t.note("Outcome: partial\nMode: fix\n\nsecond\n");
    },
  });
  const { state } = await runOnce(h);
  const history = state.selfImprove?.history ?? [];
  assert.deepEqual(history.map((c) => c.reportOutcome), ["successful", "partial"], "each cycle closed on its own note");
  assert.match(fs.readFileSync(path.join(h.store.p.steps, "02", "note.md"), "utf8"), /second/);
  assert.match(fs.readFileSync(path.join(h.store.p.steps, "01", "note.md"), "utf8"), /first/, "the first cycle's note was kept with its receipt");
});

cleanup();
done();
