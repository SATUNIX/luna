// Shared harness for the DETERMINISTIC FAKE-RUNTIME tests of the run engine (autonomy-run-smoke.ts,
// autonomy-selfimprove-smoke.ts, autonomy-cli-smoke.ts). Builds a real run directory, a FakeRuntime
// (packages/autonomy/tests/fake-runtime.ts) and an Engine around one contract. Not a real-provider run.
import fs from "node:fs";
import path from "node:path";
import { assert, implementRaw, rm, tempDir, testEffort, type RawContract } from "./autonomy-helpers.ts";
import { resolveContract } from "../packages/autonomy/lib/contract.ts";
import { boundaryDigest } from "../packages/autonomy/lib/boundary.ts";
import { createRun } from "../packages/autonomy/lib/rundir.ts";
import { runtimeConfig } from "../packages/autonomy/lib/runcfg.ts";
import { Engine } from "../packages/autonomy/lib/engine.ts";
import { TEMPLATES } from "../packages/autonomy/lib/templates/index.ts";
import { createRunLock } from "../packages/autonomy/lib/runlock.ts";
import { exportRun } from "../packages/autonomy/lib/export.ts";
import { FakeEngine, FakeRuntime } from "../packages/autonomy/tests/fake-runtime.ts";
import type { RunStore } from "../packages/autonomy/lib/store.ts";

// --- types ---------------------------------------------------------------------------------------
// The run's contract and state are the autonomy package's own types (contract.ts, lifecycle.ts),
// re-exported under the names the tests use.
import type { BacklogItem, RunContract } from "../packages/autonomy/lib/contract.ts";
import type { HistoryEntry as RunHistoryEntry, Reconfiguration, RunBlocker, RunOutcome, RunState } from "../packages/autonomy/lib/lifecycle.ts";
export type { BacklogItem, Reconfiguration, RunBlocker, RunContract, RunHistoryEntry, RunOutcome, RunState };

// The fake runtime's own types (packages/autonomy/tests/fake-runtime.ts), under the names the tests use.
import type { BoundaryReport } from "../packages/autonomy/lib/engine.ts";
import type { FakeManager as ManagerFn, FakeReview as ReviewFn, FakeRuntimeCalls, FakeScript as Script, FakeScriptContext as ScriptContext } from "../packages/autonomy/tests/fake-runtime.ts";
export type { BoundaryReport, FakeRuntimeCalls, ManagerFn, ReviewFn, Script, ScriptContext };
export type HarnessRuntime = FakeRuntime;

/** The virtual clock shared by the fake runtime, the run lock and the store. */
export interface Clock {
  now: number;
}

export interface HarnessOptions {
  script?: Script;
  review?: ReviewFn;
  boundary?: BoundaryReport;
  tickMs?: number;
  hooks?: { onSleep?: (rt: HarnessRuntime, sleeps: number) => unknown };
  cfgOverride?: Record<string, unknown>;
  manager?: ManagerFn;
  clock?: Clock;
  fakeEngine?: FakeEngine;
  contractOpts?: { baseDir?: string; checkFs?: boolean };
}

export type RunLock = ReturnType<typeof createRunLock>;
export type RuntimeCfg = ReturnType<typeof runtimeConfig> & Record<string, unknown>;

export interface EngineOptions {
  rt?: HarnessRuntime;
  pid?: number;
  lock?: RunLock;
}

/** An engine built around the harness's run, with the runtime and lock it uses. */
export interface MadeEngine {
  engine: Engine;
  rt: HarnessRuntime;
  lock: RunLock;
  acquired: ReturnType<RunLock["acquire"]>;
}

export interface Harness {
  home: string;
  store: RunStore;
  contract: RunContract;
  cfg: RuntimeCfg;
  clock: Clock;
  fakeEngine: FakeEngine;
  digest: string;
  runtime(s?: Script): HarnessRuntime;
  lock(pid: number, alive?: (pid: number) => boolean, heartbeatMs?: number): RunLock;
  engine(opts?: EngineOptions): MadeEngine;
  state(): RunState;
  /** Scratch fields a test attaches to its harness (e.g. what a hook observed). */
  [scratch: string]: unknown;
}

export interface RunOnceOptions extends EngineOptions {
  run?: { takeover?: boolean };
}

export interface RunOnceResult extends MadeEngine {
  state: RunState;
}

const roots: string[] = [];
export const cleanup = (): void => { for (const d of roots) rm(d); };
export const scratch = (): string => { const d = tempDir("autonomy-run-"); roots.push(d); return d; };

export const NODE_EXIT = (expr: string): string[] => ["node", "-e", `process.exit((${expr}) ? 0 : 1)`];
export const ANSWER = "require('fs').readFileSync('answer.txt','utf8')";

/** A finite task: worker-visible check `unit`, plus a HELD-OUT check the worker cannot see or influence. */
export function taskRaw(dir: string, over: RawContract = {}): RawContract {
  const heldOut = path.join(dir, "held-out.mjs");
  fs.writeFileSync(heldOut, "import fs from 'node:fs'; process.exit(fs.readFileSync('answer.txt', 'utf8') === '42\\n' ? 0 : 1);\n");
  return implementRaw({
    objective: { title: "Write the answer", spec: "Put the answer to everything in answer.txt (with a trailing newline).", backlog: [{ id: "T1", title: "answer.txt says 42", acceptance: ["unit", "held-out"] }, { id: "T2", title: "Keep the change small" }] },
    acceptance: {
      checks: [{ id: "unit", run: NODE_EXIT(`${ANSWER}.trim() === '42'`), timeoutMinutes: 1, required: true }, { id: "held-out", run: ["node", "tests/held-out.mjs"], timeoutMinutes: 1, required: true }],
      overlay: [{ source: heldOut, target: "tests/held-out.mjs" }], review: true,
    },
    budget: { totalUsd: 10, perStepUsd: 2, maxSteps: 12, maxMinutes: 600 },
    ...over,
  });
}

/** Build a run directory, a fake runtime and an engine factory around one contract. */
export function harness(raw: RawContract, { script, review, boundary, tickMs, hooks, cfgOverride = {}, manager, clock = { now: Date.parse("2026-09-30T00:00:00Z") }, fakeEngine = new FakeEngine(), contractOpts = {} }: HarnessOptions = {}): Harness {
  const home = scratch();
  const resolved = resolveContract(raw, { effort: testEffort, baseDir: home, ...contractOpts });
  assert.equal(resolved.ok, true, JSON.stringify(resolved.problems));
  const resolvedContract = resolved.contract;
  assert.ok(resolvedContract, "a resolved contract is present when resolution succeeded"); // narrows; never fails after the check above
  const digest = boundaryDigest(resolvedContract);
  const store = createRun({ contract: resolvedContract, authorisation: { boundaryDigest: digest, by: "test", at: "2026-09-30T00:00:00.000Z", via: "contract" }, home, now: () => new Date(clock.now), boundaryEffort: testEffort });
  const contract = JSON.parse(fs.readFileSync(store.p.contract, "utf8")) as RunContract;
  const cfg: RuntimeCfg = { ...runtimeConfig(contract, { namePrefix: "pi-autonomy-test-run" }), ...cfgOverride };
  const h: Harness = {
    home, store, contract, cfg, clock, fakeEngine, digest,
    runtime: (s = script) => new FakeRuntime({ store, cfg, contract, script: s, engine: fakeEngine, clock, review, boundary, tickMs, hooks, manager }),
    lock: (pid, alive = () => true, heartbeatMs = 3_600_000) => {
      return createRunLock({ file: store.p.lock, pid, host: "test-host", now: () => clock.now, isAlive: alive, startTimeOf: (p: number) => `start-${p}`, staleMs: 120_000, heartbeatMs });
    },
    engine: ({ rt = h.runtime(), pid = 1001, lock = h.lock(pid) } = {}) => {
      const acquired = lock.acquire();
      if (!acquired.acquired) assert.fail(`the run lock was not acquired: ${acquired.reason}`);
      return { engine: new Engine({ contract, cfg, store, rt, template: TEMPLATES[contract.template], lock, effortApi: testEffort, deps: { exportRun: ({ engine, out }: { engine: Engine; out: string }) => exportRun({ store, repo: rt.repo, contract, state: engine.state, out }) } }), rt, lock, acquired };
    },
    state: (): RunState => { const s = store.readState(); assert.ok(s, "the run has a state.json"); return s; },
  };
  return h;
}


export function fakeAlive(engine: FakeEngine): string[] { return [...engine.containers]; }

// --- helpers for the smaller scenarios -----------------------------------------------------------
export const simpleRaw = (over: RawContract = {}): RawContract => implementRaw({
  objective: { title: "Write the answer", spec: "Put 42 in answer.txt.", backlog: [] },
  acceptance: { checks: [{ id: "unit", run: NODE_EXIT(`${ANSWER}.trim() === '42'`), timeoutMinutes: 1, required: true }], review: false },
  budget: { totalUsd: 10, perStepUsd: 2, maxSteps: 12, maxMinutes: 600 },
  ...over,
});
export const solve = (t: ScriptContext): void => { t.write("answer.txt", "42\n"); t.commit("answer"); };
export const junk = (t: ScriptContext): void => { t.write("junk.txt", String(t.turn)); t.commit(`junk ${t.turn}`); }; // activity that never passes the check
export async function runOnce(h: Harness, opts: RunOnceOptions = {}): Promise<RunOnceResult> {
  const made = h.engine(opts);
  await made.engine.run(opts.run ?? {});
  return { ...made, state: h.state() };
}
