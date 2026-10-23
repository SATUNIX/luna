#!/usr/bin/env node
/**
 * The effort ledger's "workflow" launch kind (docs/effort.md, "Script workflows"): a run's pinned
 * scope and token, the per-run concurrency, per-run total and per-session limits (16 / 1000 / 2000),
 * "concurrency means wait, every other denial throws", independence from the tier budget and the
 * session ceiling, and survival across the per-turn ledger rotation.
 *
 * Deterministic and offline: the effort extension runs against a fake pi API with a temporary HOME
 * and agent dir.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fakePi, isolateKitEnv, loadModule, rmWorkspace, setEnv } from "../packages/core/eval/harness.ts";
import type * as EffortModule from "../packages/extensions/src/effort/index.ts";
import type * as LedgerModule from "../packages/extensions/src/effort/ledger.ts";

type FakePi = ReturnType<typeof fakePi>;
type EffortView = Omit<typeof EffortModule, "default"> & { default: (api: FakePi["api"]) => void };
type Registry = EffortModule.EffortRegistry;
type Granted = Extract<EffortModule.Reservation, { ok: true }>;

const restoreEnv = isolateKitEnv();
const mod: EffortView = await loadModule("extensions/effort/index.ts");
const ledgerMod: typeof LedgerModule = await loadModule("extensions/effort/ledger.ts");

function world(env: Record<string, string> = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wf-ledger-home-"));
  const agent = path.join(home, "agent");
  fs.mkdirSync(agent);
  const restores = [setEnv("HOME", home), setEnv("PI_CODING_AGENT_DIR", agent), ...Object.entries(env).map(([k, v]) => setEnv(k, v))];
  return { agent, cleanup: () => { restores.reverse().forEach((r) => r()); rmWorkspace(home); } };
}

async function boot(sessionId = "wfsess") {
  const pi = fakePi();
  mod.default(pi.api);
  const ctx = { hasUI: false, cwd: process.cwd(), ui: { notify: () => 0, select: async () => undefined, setStatus() {} }, sessionManager: { getSessionId: () => sessionId } };
  await pi.handlers.get("session_start")({ reason: "startup" }, ctx);
  const registry = (): Registry => (globalThis as Record<symbol, unknown>)[mod.REGISTRY_KEY] as Registry;
  const turn = async (): Promise<unknown> => pi.handlers.get("before_agent_start")({ systemPrompt: "BASE" }, ctx);
  await turn();
  return { registry, turn };
}

function opened(scope: EffortModule.RunScope): Extract<EffortModule.RunScope, { ok: true }> {
  if (!scope.ok) throw new Error(`run scope refused: ${scope.code}: ${scope.reason}`);
  return scope;
}

function granted(r: EffortModule.Reservation): Granted {
  if (!r.ok) throw new Error(`reservation refused: ${r.code}: ${r.reason}`);
  return r;
}

/** Reserve and settle `n` agents of a run, one at a time; returns how many were granted. */
function spend(reg: Registry, runId: string, runToken: string, n: number): number {
  let ok = 0;
  for (let i = 0; i < n; i++) {
    const r = reg.reserve({ kind: "workflow", role: "worker", runId, runToken });
    if (!r.ok) break;
    r.settle("done");
    ok++;
  }
  return ok;
}

async function rejection(promise: Promise<unknown>): Promise<EffortModule.WorkflowLedgerError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof mod.WorkflowLedgerError, `expected a WorkflowLedgerError, got ${String(error)}`);
    return error;
  }
  throw new Error("the promise resolved; a rejection was expected");
}

const tests: Record<string, () => void | Promise<void>> = {
  "a run scope needs its own token: no token, a wrong token or another run's token are refused": async () => {
    const w = world();
    try {
      const { registry } = await boot();
      const a = opened(registry().openRunScope("run-a"));
      const b = opened(registry().openRunScope("run-b"));
      assert.notEqual(a.runToken, b.runToken);
      assert.equal(a.ledger, b.ledger, "one workflow ledger per session");
      assert.ok(!fs.readFileSync(a.ledger, "utf8").includes(a.runToken), "only a hash of the token is stored");
      for (const bad of [{}, { runId: "run-a" }, { runId: "run-a", runToken: "x" + "y" }, { runId: "run-a", runToken: b.runToken }, { runId: "nope", runToken: a.runToken }]) {
        const r = registry().reserve({ kind: "workflow", role: "worker", ...bad });
        assert.equal(r.ok, false);
        assert.equal(r.ok ? "" : r.code, "run-scope", JSON.stringify(bad));
      }
      const g = granted(registry().reserve({ kind: "workflow", role: "worker", runId: "run-a", runToken: a.runToken }));
      assert.equal(g.childTier, "minimal", "workflow agents run at E1");
      assert.deepEqual(g.env, { PI_KIT_EFFORT: "minimal", PI_KIT_EFFORT_CAP: "minimal", PI_KIT_EFFORT_LEDGER: a.ledger });
      g.settle("done");
    } finally { w.cleanup(); }
  },

  "a run id is opened once, must be well-formed, and child processes cannot open runs": async () => {
    const w = world();
    try {
      const { registry } = await boot();
      opened(registry().openRunScope("r1"));
      const again = registry().openRunScope("r1");
      assert.equal(again.ok ? "" : again.code, "run-scope");
      for (const id of ["", "../x", "a b", "x".repeat(65)]) {
        const r = registry().openRunScope(id);
        assert.equal(r.ok ? "" : r.code, "invalid", JSON.stringify(id));
      }
    } finally { w.cleanup(); }
    const c = world();
    try {
      const { registry } = await boot();
      const restore = setEnv("PI_KIT_EFFORT_LEDGER", path.join(c.agent, "parent.json"));
      try {
        const r = registry().openRunScope("child-run");
        assert.equal(r.ok ? "" : r.code, "child");
      } finally { restore(); }
    } finally { c.cleanup(); }
  },

  "16 agents of one run may be live; the 17th is a concurrency denial that reserveWorkflow waits out": async () => {
    const w = world();
    try {
      const { registry } = await boot();
      const run = opened(registry().openRunScope("conc"));
      const live = Array.from({ length: 16 }, () => granted(registry().reserve({ kind: "workflow", role: "worker", runId: "conc", runToken: run.runToken })));
      const over = registry().reserve({ kind: "workflow", role: "worker", runId: "conc", runToken: run.runToken });
      assert.equal(over.ok ? "" : over.code, "concurrency");
      // Another run has its own 16.
      const other = opened(registry().openRunScope("other"));
      granted(registry().reserve({ kind: "workflow", role: "worker", runId: "other", runToken: other.runToken })).settle("done");
      let resolved = false;
      const waiting = registry().reserveWorkflow({ runId: "conc", runToken: run.runToken, role: "worker" }, { pollMs: 10 }).then((g) => { resolved = true; return g; });
      await new Promise((r) => setTimeout(r, 60));
      assert.equal(resolved, false, "still waiting while 16 are live");
      live[0]?.settle("done");
      const g = await waiting;
      assert.equal(g.ok, true, "a freed slot is taken by the waiter");
      // Aborting a wait rejects with code "aborted" and takes no slot.
      const controller = new AbortController();
      const aborted = registry().reserveWorkflow({ runId: "conc", runToken: run.runToken, role: "worker" }, { pollMs: 10, signal: controller.signal });
      setTimeout(() => controller.abort(), 30);
      assert.equal((await rejection(aborted)).code, "aborted");
    } finally { w.cleanup(); }
  },

  "every denial other than concurrency throws: an unknown run, a used-up run (1000) and a used-up session (2000)": async () => {
    const w = world();
    try {
      const { registry } = await boot();
      assert.equal((await rejection(registry().reserveWorkflow({ runId: "missing", runToken: "t", role: "worker" }))).code, "run-scope");
      const one = opened(registry().openRunScope("one"));
      assert.equal(spend(registry(), "one", one.runToken, 1001), 1000, "a run starts at most 1000 agents");
      const runOut = await rejection(registry().reserveWorkflow({ runId: "one", runToken: one.runToken, role: "worker" }));
      assert.equal(runOut.code, "total");
      assert.match(runOut.message, /per-run limit \(1000\)/);
      const two = opened(registry().openRunScope("two"));
      assert.equal(spend(registry(), "two", two.runToken, 1000), 1000);
      const three = opened(registry().openRunScope("three"));
      const sessionOut = await rejection(registry().reserveWorkflow({ runId: "three", runToken: three.runToken, role: "worker" }));
      assert.equal(sessionOut.code, "session-ceiling", "the session's runs start at most 2000 agents together");
      assert.match(sessionOut.message, /session limit \(2000\)/);
    } finally { w.cleanup(); }
  },

  "workflow agents never draw on the tier budget or the 64-child session ceiling": async () => {
    const w = world();
    try {
      const { registry } = await boot();
      const run = opened(registry().openRunScope("big"));
      assert.equal(spend(registry(), "big", run.runToken, 100), 100);
      const s = registry().snapshot();
      assert.equal(s.usage.total, 0, "the request's discretionary count is untouched");
      assert.notEqual(s.ledger, run.ledger, "the turn's ledger is a different file");
      granted(registry().reserve({ kind: "discretionary", role: "worker" })).settle("done");
      const data = ledgerMod.readLedger(run.ledger);
      assert.equal(data?.total, 0);
      assert.equal(data?.workflow?.used, 100);
    } finally { w.cleanup(); }
  },

  "a run scope is pinned: it survives the per-turn ledger rotation and keeps its count": async () => {
    const w = world();
    try {
      const { registry, turn } = await boot();
      const run = opened(registry().openRunScope("pinned"));
      assert.equal(spend(registry(), "pinned", run.runToken, 3), 3);
      const before = registry().snapshot().ledger;
      await turn();
      await turn();
      assert.notEqual(registry().snapshot().ledger, before, "the turn ledger rotated");
      assert.equal(spend(registry(), "pinned", run.runToken, 2), 2, "the run still reserves after rotation");
      assert.equal(ledgerMod.readLedger(run.ledger)?.workflow?.runs.pinned?.used, 5, "the count carried over");
    } finally { w.cleanup(); }
  },

  "a workflow ledger with a malformed workflow section reads as missing, so nothing is granted": async () => {
    const w = world();
    try {
      const { registry } = await boot();
      const run = opened(registry().openRunScope("tamper"));
      const doc: unknown = JSON.parse(fs.readFileSync(run.ledger, "utf8"));
      assert.ok(doc && typeof doc === "object");
      fs.writeFileSync(run.ledger, JSON.stringify({ ...doc, workflow: { concurrent: "lots" } }));
      assert.equal(ledgerMod.readLedger(run.ledger), null);
      const r = registry().reserve({ kind: "workflow", role: "worker", runId: "tamper", runToken: run.runToken });
      assert.equal(r.ok ? "" : r.code, "no-ledger");
      // A plain turn ledger has no workflow section: workflow launches against it are refused.
      const plain = registry().snapshot().ledger;
      assert.ok(plain);
      const direct = ledgerMod.reserve(plain, { kind: "workflow", role: "worker", runId: "tamper", runToken: run.runToken, requesterTier: "standard", requesterLimits: { maxConcurrent: 2, maxTotal: 3, maxScouts: 1 }, requesterLabel: "E3 Standard" });
      assert.equal(direct.ok ? "" : direct.code, "run-scope");
    } finally { w.cleanup(); }
  },

  "a tampered workflow ledger is never recreated: a new run scope is refused and the session count is kept": async () => {
    const w = world();
    try {
      const { registry } = await boot();
      const a = opened(registry().openRunScope("a"));
      const b = opened(registry().openRunScope("b"));
      assert.equal(spend(registry(), "a", a.runToken, 3), 3);
      assert.equal(spend(registry(), "b", b.runToken, 2), 2);
      const original = fs.readFileSync(a.ledger, "utf8");
      const doc: unknown = JSON.parse(original);
      assert.ok(doc && typeof doc === "object" && "workflow" in doc && doc.workflow && typeof doc.workflow === "object");
      const tampered = JSON.stringify({ ...doc, workflow: { ...doc.workflow, runs: { a: { tokenHash: "x", used: -1, openedAt: 0 } } } });
      fs.writeFileSync(a.ledger, tampered);
      assert.equal(ledgerMod.readLedger(a.ledger), null);
      const c = registry().openRunScope("c");
      assert.equal(c.ok ? "" : c.code, "no-ledger", "a new run is refused, not given a fresh ledger");
      assert.equal(fs.readFileSync(a.ledger, "utf8"), tampered, "the tampered file was left as it was");
      const r = registry().reserve({ kind: "workflow", role: "worker", runId: "b", runToken: b.runToken });
      assert.equal(r.ok ? "" : r.code, "no-ledger");
      // Once the file reads again, the session count and the open runs are what they were.
      fs.writeFileSync(a.ledger, original);
      assert.equal(ledgerMod.readLedger(a.ledger)?.workflow?.used, 5);
      assert.ok(opened(registry().openRunScope("d")));
      // A file that parses but has no workflow section is refused the same way.
      const plain: unknown = JSON.parse(original);
      assert.ok(plain && typeof plain === "object");
      fs.writeFileSync(a.ledger, JSON.stringify({ ...plain, workflow: undefined }));
      const e = registry().openRunScope("e");
      assert.equal(e.ok ? "" : e.code, "no-ledger");
    } finally { w.cleanup(); }
  },
};

let failed = 0;
for (const [name, fn] of Object.entries(tests)) {
  try {
    await fn();
    console.log(`  OK: ${name}`);
  } catch (error: unknown) {
    failed++;
    console.error(`  FAIL: ${name}\n    ${String((error instanceof Error && error.stack) || error)}`);
  }
}
restoreEnv();
if (failed) {
  console.error(`\n[workflow-ledger-smoke] ${failed} check(s) failed`);
  process.exit(1);
}
console.log(`\n[workflow-ledger-smoke] all ${Object.keys(tests).length} checks passed`);
