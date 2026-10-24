#!/usr/bin/env node
/**
 * Offline checks for the run lifecycle (packages/autonomy/lib/lifecycle.ts), the single-owner
 * run lock (runlock.ts) and the persistent store (store.ts): the transition table (every legal
 * and every illegal pair), the evidence guard on `succeeded`, distinct outcomes, resume semantics
 * per state, the trusted task board, stale/duplicate/wedged locks, and the control inbox.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assert, implementRaw, makeChecker, rm, tempDir, testEffort } from "./autonomy-helpers.ts";
import { resolveContract } from "../packages/autonomy/lib/contract.ts";
import { STATES, TERMINAL, TRANSITIONS, IllegalTransition, applyResultsToBoard as applyBoard, boardFromContract, canTransition, evidenceProblem, isTerminal, newState, resumeAction as resume, transition, type BlockerRecord, type EvaluationSummary, type RunBlocker, type RunState, type RunStatus as Status, type TaskItem as BoardTask, type TransitionInfo } from "../packages/autonomy/lib/lifecycle.ts";
import { assessLock, createRunLock as createLock, type RunLockOptions } from "../packages/autonomy/lib/runlock.ts";
import { RunStore, listRuns } from "../packages/autonomy/lib/store.ts";
import { runPaths } from "../packages/autonomy/lib/paths.ts";
import { nullable, number, object, parseJsonAs, string } from "../packages/core/lib/guard.ts";


const { check, done } = makeChecker("autonomy-lifecycle-smoke");
const resolved = resolveContract(implementRaw(), { effort: testEffort });
assert.ok(resolved.ok, "the base contract resolves");
const contract = resolved.contract;
const fresh = (): RunState => newState({ contract, contractDigest: "c".repeat(64), boundaryDigest: "b".repeat(64), authorisation: { boundaryDigest: "b".repeat(64), by: "test", at: "2026-09-30T00:00:00.000Z", via: "contract" }, effort: contract.effort, now: "2026-09-30T00:00:00.000Z" });
const withStatus = (status: Status, extra: Partial<RunState> = {}): RunState => ({ ...fresh(), status, ...extra });
/** A recorded acceptance evaluation whose required checks all passed, or not. */
const latest = (allRequiredPass: boolean): EvaluationSummary => ({ sha: "a".repeat(40), step: 1, at: "2026-09-30T00:00:00.000Z", allRequiredPass, results: [] });
const evidence: Partial<RunState> = { acceptance: { latest: latest(true), review: { required: true, status: "approved" }, history: [] } };
const question: BlockerRecord = { kind: "question", id: "q1", method: "input", question: "Which database?" };
/** A recorded blocker with the given kind (and question). */
const blockerOf = (b: Pick<BlockerRecord, "kind"> & Partial<BlockerRecord>): RunBlocker => ({ id: "b1", method: "input", question: "", since: "2026-09-30T00:00:00.000Z", ...b });

// The independent copy of the table: the one in lifecycle.ts must equal it.
const LEGAL: Record<Status, Status[]> = {
  setup: ["ready", "failed", "cancelled"],
  ready: ["running", "paused", "failed", "cancelled"],
  running: ["paused", "blocked", "recovering", "succeeded", "failed", "cancelled", "budget_exhausted"],
  paused: ["running", "failed", "cancelled"],
  blocked: ["running", "paused", "failed", "cancelled"],
  recovering: ["running", "blocked", "paused", "failed", "cancelled", "budget_exhausted"],
  budget_exhausted: ["paused"],
  succeeded: [], failed: [], cancelled: [],
};

const REASONS: Record<string, string | undefined> = { blocked: "question", failed: "boundary_violation", budget_exhausted: "total_usd", cancelled: "operator", succeeded: "acceptance_passed" };
/** Everything a transition to `to` needs to be legal. */
const infoFor = (from: string, to: string): TransitionInfo => ({
  reason: REASONS[to] ?? "test",
  by: from === "budget_exhausted" ? "reconfigure" : "test",
  ...(to === "blocked" ? { blocker: question } : {}),
});

await check("the ten states, and the table in the code equals the reviewed table", () => {
  assert.deepEqual(STATES, ["setup", "ready", "running", "paused", "blocked", "recovering", "succeeded", "failed", "cancelled", "budget_exhausted"]);
  assert.deepEqual(TRANSITIONS, LEGAL);
  assert.deepEqual([...TERMINAL].sort(), ["cancelled", "failed", "succeeded"]);
  assert.equal(isTerminal("budget_exhausted"), false, "an exhausted budget can be lifted, by `reconfigure` only");
});

await check("every legal transition succeeds and every illegal one throws (table-driven over all 100 pairs)", () => {
  let legal = 0; let illegal = 0;
  for (const from of STATES) {
    for (const to of STATES) {
      const state = withStatus(from, evidence);
      if (LEGAL[from].includes(to)) {
        const next = transition(state, to, infoFor(from, to));
        assert.equal(next.status, to, `${from} -> ${to}`);
        assert.equal(next.history.at(-1)?.from, from);
        assert.equal(next.history.at(-1)?.to, to);
        assert.equal(canTransition(from, to), true);
        legal++;
      } else {
        assert.throws(() => transition(state, to, infoFor(from, to)), (e: unknown) => e instanceof IllegalTransition && e.from === from && e.to === to, `${from} -> ${to} must be illegal`);
        assert.equal(canTransition(from, to), false);
        illegal++;
      }
    }
  }
  assert.equal(legal, 28);
  assert.equal(illegal, 72);
  assert.throws(() => transition(fresh(), "exploded", { reason: "x" }), IllegalTransition);
});

await check("guards: success needs trusted evidence and the required review; failures, budgets and blocks carry a reason; nothing leaves a terminal state", () => {
  const running = withStatus("running");
  assert.throws(() => transition(running, "succeeded", { reason: "acceptance_passed" }), /no acceptance evaluation/);
  assert.throws(() => transition({ ...running, acceptance: { latest: latest(false), review: { required: false, status: "skipped" }, history: [] } }, "succeeded", { reason: "x" }), /failing required checks/);
  assert.throws(() => transition({ ...running, acceptance: { latest: latest(true), review: { required: true, status: "pending" }, history: [] } }, "succeeded", { reason: "x" }), /review is required/);
  assert.throws(() => transition({ ...running, acceptance: { latest: latest(true), review: { required: true, status: "rejected" }, history: [] } }, "succeeded", { reason: "x" }), /review/);
  assert.equal(transition({ ...running, acceptance: { latest: latest(true), review: { required: false, status: "skipped" }, history: [] } }, "succeeded", { reason: "acceptance_passed" }).status, "succeeded");
  assert.equal(evidenceProblem({ ...running, ...evidence }), null);
  assert.throws(() => transition(running, "failed", {}), /reason is required/);
  assert.throws(() => transition(running, "failed", { reason: "because" }), /reason must be one of/, "failure reasons come from a closed list");
  assert.throws(() => transition(running, "budget_exhausted", { reason: "out of ideas" }), /total_usd, max_steps, max_minutes/);
  assert.throws(() => transition(running, "cancelled", {}), /reason is required/);
  assert.throws(() => transition(running, "blocked", { reason: "question" }), /blocker record is required/);
  for (const terminal of ["succeeded", "failed", "cancelled"] as const) for (const to of STATES) assert.throws(() => transition(withStatus(terminal, evidence), to, infoFor(terminal, to)), /terminal|illegal/);
  const exhausted = transition(running, "budget_exhausted", { reason: "max_steps" });
  assert.throws(() => transition(exhausted, "paused", { reason: "x", by: "operator" }), /reconfigure/);
  const lifted = transition(exhausted, "paused", { reason: "raised", by: "reconfigure" });
  assert.equal(lifted.status, "paused");
  assert.equal(lifted.outcome, null, "the exhaustion outcome is cleared when lifted, and stays in the history");
  assert.ok(lifted.history.some((h) => h.to === "budget_exhausted" && h.reason === "max_steps"));
});

await check("outcomes stay distinct: succeeded, failed (boundary_violation), cancelled and each budget reason are recorded as such", () => {
  const out = (to: string, reason: string, base = withStatus("running", evidence)) => { const o = transition(base, to, { reason, detail: "d" }).outcome; assert.ok(o, `${to} records an outcome`); return o; };
  assert.deepEqual(Object.keys(out("succeeded", "acceptance_passed")).sort(), ["at", "detail", "reason", "status"]);
  assert.equal(out("failed", "boundary_violation").status, "failed");
  assert.equal(out("failed", "boundary_violation").reason, "boundary_violation");
  assert.equal(out("cancelled", "operator").status, "cancelled");
  for (const reason of ["total_usd", "max_steps", "max_minutes"]) { const o = out("budget_exhausted", reason); assert.deepEqual([o.status, o.reason], ["budget_exhausted", reason]); }
  const blocked = transition(withStatus("running"), "blocked", { reason: "question", blocker: question });
  assert.equal(blocked.outcome, null, "blocked is not an outcome");
  assert.equal(blocked.blocker?.question, "Which database?");
  assert.ok(blocked.blocker?.since);
  assert.equal(transition(blocked, "running", { reason: "answered", by: "operator" }).blocker, null);
});

await check("resume semantics are defined for every state", () => {
  const r = (status: Status, extra?: Partial<RunState>, opts?: { answer?: string; approve?: boolean; deny?: boolean }) => resume(withStatus(status, extra), opts);
  assert.deepEqual(STATES.map((s) => typeof r(s, {}).ok), STATES.map(() => "boolean"));
  assert.equal(r("setup").action, "redo_setup");
  assert.equal(r("ready").action, "start");
  assert.equal(r("running").action, "takeover");
  assert.equal(r("recovering").action, "takeover");
  assert.equal(r("paused").action, "unpause");
  assert.equal(r("blocked", { blocker: blockerOf({ kind: "question", question: "q?" }) }).ok, false, "a question needs an answer");
  assert.match(r("blocked", { blocker: blockerOf({ kind: "question", question: "Which database?" }) }).message, /--answer/);
  assert.equal(r("blocked", { blocker: blockerOf({ kind: "question" }) }, { answer: "Postgres" }).ok, true);
  assert.equal(r("blocked", { blocker: blockerOf({ kind: "question" }) }, { answer: "   " }).ok, false);
  assert.equal(r("blocked", { blocker: blockerOf({ kind: "approval" }) }).ok, false);
  assert.equal(r("blocked", { blocker: blockerOf({ kind: "approval" }) }, { approve: true }).ok, true);
  assert.equal(r("blocked", { blocker: blockerOf({ kind: "approval" }) }, { deny: true }).ok, true);
  assert.equal(r("blocked", { blocker: blockerOf({ kind: "external", question: "waiting for the DBA" }) }, { answer: "done" }).ok, true);
  for (const terminal of ["succeeded", "failed", "cancelled"] as const) assert.equal(r(terminal, { outcome: { status: terminal, reason: "x", at: "2026-09-30T00:00:00.000Z" } }).ok, false, terminal);
  const ex = r("budget_exhausted", { outcome: { status: "budget_exhausted", reason: "total_usd", at: "2026-09-30T00:00:00.000Z" } });
  assert.equal(ex.ok, false);
  assert.match(ex.message, /reconfigure/);
});

await check("the state record: identity, digests, authorisation, trusted board, usage and recovery counters, effort snapshot", () => {
  const s = fresh();
  assert.equal(s.schemaVersion, 1);
  assert.deepEqual([s.run, s.template, s.status], ["todo-api-1", "implement", "setup"]);
  assert.equal(s.contractDigest.length, 64);
  assert.equal(s.authorisation.via, "contract");
  assert.deepEqual(s.usage, { usd: 0, minutes: 0, steps: 0 });
  assert.deepEqual(s.effort, { tier: "standard", cap: "standard" });
  assert.deepEqual(s.limits.budget, contract.budget, "budget is snapshotted; only reconfigure changes it");
  assert.equal(s.recovery.softNudgesUsed, 0);
  assert.deepEqual(s.tasks.map((t: BoardTask) => [t.id, t.status]), [["T1", "todo"], ["T2", "todo"]]);
  assert.deepEqual(s.worker, null);
  assert.ok(s.history[0], "the new state records its first transition");
  assert.equal(s.history[0].to, "setup");
  assert.equal(s.acceptance.review.status, "pending");
  assert.equal(s.promotion.status, "none");
  assert.equal(boardFromContract(contract).length, 2);
});

await check("the task board changes only from trusted check results; unverifiable items are covered by the run's overall acceptance", () => {
  const tasks: BoardTask[] = boardFromContract(contract); // T1 needs check "unit"; T2 names no check
  const fail = applyBoard(tasks, [{ id: "unit", pass: false }], { step: 1 });
  assert.deepEqual(fail.map((t: BoardTask) => t.status), ["in_progress", "todo"]);
  const pass = applyBoard(fail, [{ id: "unit", pass: true }], { step: 2 });
  assert.deepEqual(pass.map((t: BoardTask) => t.status), ["done", "todo"], "T2 has no check of its own, so a passing check does not complete it");
  const regress = applyBoard(pass, [{ id: "unit", pass: false }], { step: 3 });
  assert.ok(regress[0], "the board keeps T1");
  assert.equal(regress[0].status, "todo", "an item that stops passing is no longer done");
  const finished = applyBoard(pass, [{ id: "unit", pass: true }], { step: 4, complete: true });
  assert.deepEqual(finished.map((t: BoardTask) => t.status), ["done", "done"]);
  assert.ok(finished[1]?.evidence[0], "T2 records why it is done");
  assert.match(finished[1].evidence[0], /covered by the run's acceptance/);
  const [untouched] = applyBoard(tasks, [], { step: 1 });
  assert.ok(untouched, "the board keeps T1");
  assert.equal(untouched.status, "todo", "no evidence, no progress");
});

/** The fields of a lock-file record these checks read back from disk. */
const LockFile = object({ pid: number(), host: string(), startTime: nullable(string()), heartbeatAt: string(), token: string() });

// --- the run lock -----------------------------------------------------------------------------
const tmp = tempDir("autonomy-lock-");
const lockFile = path.join(tmp, "run", "supervisor.lock");
let clock = Date.parse("2026-09-30T00:00:00Z");
const mk = (over: Partial<RunLockOptions> = {}) => createLock({ file: lockFile, host: "hostA", pid: 1000, now: () => clock, isAlive: () => true, startTimeOf: () => "proc:42", staleMs: 60_000, ...over });

await check("lock: one owner; a duplicate start refuses while the owner is alive", () => {
  const a = mk({ pid: 1001 });
  const got = a.acquire();
  assert.equal(got.acquired, true);
  const rec = parseJsonAs(LockFile, fs.readFileSync(lockFile, "utf8"));
  assert.deepEqual([rec.pid, rec.host, rec.startTime], [1001, "hostA", "proc:42"]);
  assert.ok(rec.heartbeatAt && rec.token);
  const b = mk({ pid: 1002 });
  const dup = b.acquire();
  assert.equal(dup.acquired, false);
  assert.match(dup.reason ?? "", /already being supervised/);
  assert.equal(dup.holder?.pid, 1001);
  clock += 10_000;
  assert.equal(a.heartbeat(), true);
  assert.equal(parseJsonAs(LockFile, fs.readFileSync(lockFile, "utf8")).heartbeatAt, new Date(clock).toISOString());
  a.release();
  assert.equal(fs.existsSync(lockFile), false);
  assert.equal(b.acquire().acquired, true, "free after release");
  b.release();
});

await check("lock: a crashed owner (process gone) is stale; the next supervisor takes over and the old owner learns it lost the lock", () => {
  const dead = mk({ pid: 2001 });
  dead.acquire();
  const next = mk({ pid: 2002, isAlive: (pid: number) => pid !== 2001 });
  const got = next.acquire();
  assert.equal(got.acquired, true);
  const tookOver = got.tookOver;
  assert.equal(tookOver?.pid, 2001);
  assert.match(tookOver?.why ?? "", /no longer exists/);
  assert.equal(dead.heartbeat(), false, "the displaced owner sees the lock is no longer its own");
  assert.equal(next.heartbeat(), true);
  dead.release();
  assert.equal(fs.existsSync(lockFile), true, "a displaced owner must not delete the new owner's lock");
  next.release();
});

await check("lock: two supervisors taking over the same stale lock at once: exactly one acquires", () => {
  const dead = mk({ pid: 2101 });
  dead.acquire();
  // `late` has judged the lock stale when `early` runs its whole takeover: a check-then-act
  // takeover would then move early's fresh lock aside and both would hold the run.
  const early = mk({ pid: 2102, isAlive: (pid: number) => pid !== 2101 });
  let interleaved = false;
  const late = mk({ pid: 2103, isAlive: (pid: number) => {
    if (pid === 2101 && !interleaved) { interleaved = true; assert.equal(early.acquire().acquired, true, "the first taker acquires"); }
    return pid !== 2101;
  } });
  const r = late.acquire();
  assert.equal(interleaved, true);
  assert.equal(r.acquired, false, "the second taker is refused");
  assert.match(r.acquired ? "" : r.reason, /already being supervised/);
  assert.equal(early.heartbeat(), true, "the first taker still owns the lock file");
  assert.equal(parseJsonAs(LockFile, fs.readFileSync(lockFile, "utf8")).pid, 2102);
  assert.deepEqual(fs.readdirSync(path.dirname(lockFile)), ["supervisor.lock"], "no takeover claim or moved-aside file is left behind");
  early.release();
  dead.release();
});

await check("lock: a takeover claim held by another taker makes acquire back off; an abandoned claim (older than staleMs) is cleared", () => {
  const dead = mk({ pid: 2201 });
  dead.acquire();
  const deadToken = parseJsonAs(LockFile, fs.readFileSync(lockFile, "utf8")).token;
  const claim = `${lockFile}.takeover-${deadToken}-${fs.statSync(lockFile).ino}`;
  fs.writeFileSync(claim, "someone\n");
  const b = mk({ pid: 2202, isAlive: (pid: number) => pid !== 2201 });
  const r = b.acquire();
  assert.equal(r.acquired, false, "a live claim is never overridden");
  assert.match(r.acquired ? "" : r.reason, /contention/);
  const old = new Date(Date.now() - 120_000);
  fs.utimesSync(claim, old, old);
  const got = b.acquire();
  assert.equal(got.acquired, true, "an abandoned claim does not block the run forever");
  assert.equal(got.acquired && got.tookOver?.pid, 2201);
  assert.deepEqual(fs.readdirSync(path.dirname(lockFile)), ["supervisor.lock"]);
  b.release();
  dead.release();
});

await check("lock: eight processes racing to take over one stale lock: exactly one acquires", async () => {
  const gone = spawnSync(process.execPath, ["-e", ""]).pid;
  assert.ok(gone, "a pid that has exited");
  fs.writeFileSync(lockFile, `${JSON.stringify({ schemaVersion: 1, pid: gone, startTime: null, host: os.hostname(), token: "deadbeef", acquiredAt: new Date().toISOString(), heartbeatAt: new Date().toISOString() })}\n`);
  const at = Date.now() + 1500;
  const src = `import { createRunLock } from ${JSON.stringify(pathToFileURL(path.join(import.meta.dirname, "../packages/autonomy/lib/runlock.ts")).href)};
const lock = createRunLock({ file: ${JSON.stringify(lockFile)} });
while (Date.now() < ${at}) { /* line up the start */ }
process.stdout.write(lock.acquire().acquired ? "won" : "lost");
setTimeout(() => {}, 1500);`;
  const results = await Promise.all(Array.from({ length: 8 }, () => new Promise<string>((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", src], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    child.on("close", () => resolve(out));
  })));
  assert.equal(results.filter((x) => x === "won").length, 1, `exactly one winner: ${results.join(",")}`);
  assert.equal(results.filter((x) => x === "lost").length, 7);
  fs.rmSync(lockFile, { force: true });
  assert.deepEqual(fs.readdirSync(path.dirname(lockFile)), [], "no takeover claim or moved-aside file is left behind");
});

await check("lock: pid reuse is detected from the process start time; other hosts are judged by heartbeat age; a wedged local owner is never taken over", () => {
  const rec = { pid: 3001, host: "hostA", startTime: "proc:42", heartbeatAt: new Date(clock).toISOString() };
  const base = { host: "hostA", now: clock, isAlive: () => true, startTimeOf: () => "proc:42", staleMs: 60_000 };
  assert.equal(assessLock(rec, base).state, "alive");
  assert.match(assessLock(rec, { ...base, startTimeOf: () => "proc:99" }).why, /reused/);
  assert.equal(assessLock(rec, { ...base, startTimeOf: () => "proc:99" }).state, "stale");
  assert.equal(assessLock(rec, { ...base, now: clock + 600_000 }).state, "wedged", "alive but silent: never taken over automatically");
  assert.equal(assessLock({ ...rec, host: "hostB" }, base).state, "alive", "another host with a fresh heartbeat");
  assert.equal(assessLock({ ...rec, host: "hostB" }, { ...base, now: clock + 600_000 }).state, "stale", "another host, no heartbeat");
  assert.equal(assessLock(rec, { ...base, startTimeOf: () => null }).state, "alive", "start time unreadable: trust the fresh heartbeat");
  assert.equal(assessLock(rec, { ...base, startTimeOf: () => null, now: clock + 600_000 }).state, "stale", "start time unreadable and no heartbeat");
  const owner = mk({ pid: 3002 });
  owner.acquire();
  clock += 600_000;
  const b = mk({ pid: 3003 });
  const r = b.acquire();
  assert.equal(r.acquired, false);
  assert.match(r.reason ?? "", /wedged/);
  owner.release();
});

await check("lock: a corrupt lock file is stale once it is old, and 'being written' while young", () => {
  fs.writeFileSync(lockFile, "{not json");
  const a = mk({ pid: 4001, now: () => Date.now() });
  assert.equal(a.acquire().acquired, false, "just written: someone may be mid-write");
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lockFile, old, old);
  assert.equal(a.acquire().acquired, true);
  a.release();
  const real = createLock({ file: lockFile });
  assert.equal(real.acquire().acquired, true, "the real pid/start-time helpers work on this machine");
  const insp = real.inspect();
  assert.equal(insp?.state, "alive");
  const twin = createLock({ file: lockFile });
  assert.equal(twin.acquire().acquired, false, "a second supervisor process on this host is refused");
  real.release();
});

await check("lock: heartbeat timer reports a lost lock", async () => {
  const a = createLock({ file: lockFile, heartbeatMs: 20 });
  a.acquire();
  let lost = false;
  a.start(() => { lost = true; });
  fs.rmSync(lockFile);
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(lost, true);
  a.release();
});

// --- the store --------------------------------------------------------------------------------
await check("store: state round-trips atomically; transitions persist; the control inbox is ordered and acknowledged", () => {
  const home = path.join(tmp, "home");
  const store = new RunStore("todo-api-1", { home, now: () => new Date("2026-09-30T01:00:00Z") });
  assert.equal(store.exists(), false);
  fs.mkdirSync(store.p.root, { recursive: true });
  store.writeState(fresh());
  assert.equal(store.exists(), true);
  store.transition("ready", { reason: "setup complete" });
  assert.equal(store.readState()?.status, "ready");
  assert.equal(store.readState()?.updatedAt, "2026-09-30T01:00:00.000Z");
  assert.throws(() => store.transition("succeeded", { reason: "x" }), IllegalTransition);
  assert.equal(store.readState()?.status, "ready", "a refused transition changes nothing");
  fs.writeFileSync(store.p.state, JSON.stringify({ ...store.readState(), schemaVersion: 9 }));
  assert.throws(() => store.readState(), /schemaVersion 9/);
  store.writeState(fresh());
  const a = store.enqueue("pause");
  const b = store.enqueue("steer", { message: "use sqlite" });
  const c = store.enqueue("cancel");
  assert.deepEqual(store.pending().map((m: { kind: string }) => m.kind), ["pause", "steer", "cancel"]);
  assert.deepEqual(store.pending()[1]?.payload, { message: "use sqlite" });
  store.ack(a); store.ack(b);
  assert.deepEqual(store.pending().map((m: { name: string }) => m.name), [c]);
  assert.throws(() => store.enqueue("format-disk"), /unknown control/);
  store.log("hello");
  assert.match(fs.readFileSync(store.p.log, "utf8"), /2026-09-30T01:00:00.000Z hello/);
  assert.equal(listRuns(home)[0]?.run, "todo-api-1");
  assert.deepEqual(Object.keys(runPaths("x", "/h")).sort(), Object.keys(runPaths("y", "/h")).sort());
  assert.ok(runPaths("run-1", "/h").root === path.join("/h", "run-1"));
  assert.equal(os.hostname().length > 0, true);
});

rm(tmp);
done();
