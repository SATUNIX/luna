#!/usr/bin/env node
/**
 * Generations ("Memento mode") in the run engine (packages/autonomy/lib/engine.ts), on the
 * DETERMINISTIC FAKE RUNTIME (packages/autonomy/tests/fake-runtime.ts): no container, no model.
 * What they prove:
 *   - a generation rotates at its box: the worker is asked for its notebook, stopped, the notebook
 *     is copied out of the workspace (and removed there), appended with the supervisor's own
 *     measurements, and handed to a fresh worker inside the untrusted fence
 *   - the last generation has no box
 *   - generations without progress spend the recovery ladder and end the run recovery_exhausted
 *   - the budget is never exceeded: the run's own limits end a run with generations
 *   - resetOnNoProgress starts the next generation from the accepted head
 *   - a pause during the grace period rotates on unpause without starting a worker for the spent
 *     generation, and the per-step budget ends the grace period early
 *   - a worker that crashes after its box ran out rotates without its step being judged twice
 *   - the supervisor never follows a link, opens a FIFO or reads an oversized file for a notebook
 *   - `pi-autonomy status` shows generation n/N, the last rotation reason and the latest notebook
 *     (redacted); a run without generations shows none of it
 *   - terminal controls in a worker's notebook reach neither state.json nor the status output
 *   - the Memento allowance caps the contract's generations: a worker model that is not opted in
 *     (<agent dir>/pi-kit/autonomy.json) runs one generation, and an opted-in one runs at most its
 *     tier's memento.maxGenerations; the decision and its reason are in state.json, the log and status
 *
 * Every other check runs at E5 (allowance 4) with the default worker model opted in, in the
 * long-horizon profile, inside a temp HOME and PI_CODING_AGENT_DIR.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { assert, makeChecker, testEffort } from "./autonomy-helpers.ts";
import * as H from "./autonomy-harness.ts";
import type { ScriptContext } from "./autonomy-harness.ts";
import { WORKER_NOTEBOOK, readNotebook, takeWorkerNotebook } from "../packages/autonomy/lib/notebook.ts";
import { main } from "../packages/autonomy/cli.ts";
import { isRecord, parseJson } from "../packages/core/lib/guard.ts";
import { DEFAULT_MODEL } from "../packages/autonomy/lib/contract.ts";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "autonomy-generations-home-"));
process.env.HOME = sandbox;
process.env.PI_CODING_AGENT_DIR = path.join(sandbox, "agent");

/** The Memento opt-in for the harness's worker model (openrouter/<DEFAULT_MODEL>), or none; and the installed profile. */
const OPT_IN = path.join(sandbox, "agent", "pi-kit", "autonomy.json");
function optIn(models: Record<string, unknown> | null, profile = "long-horizon"): void {
  fs.mkdirSync(path.dirname(OPT_IN), { recursive: true });
  fs.writeFileSync(path.join(sandbox, "agent", ".pi-kit.json"), JSON.stringify({ profile }));
  if (models) fs.writeFileSync(OPT_IN, JSON.stringify({ schemaVersion: 1, memento: { models } }));
  else fs.rmSync(OPT_IN, { force: true });
}
const WORKER_KEY = `openrouter/${DEFAULT_MODEL}`;
optIn({ [WORKER_KEY]: { enabled: true } });

const { check, done } = makeChecker("autonomy-generations-smoke");
const { harness, runOnce, simpleRaw, solve, fakeAlive, cleanup } = H;

const BOX = /time box has run out/;
/** A secret-shaped value built at run time, so this file holds no literal one. */
const FAKE_KEY = ["sk", "or", "v1", "0123456789abcdef0123456789abcdef"].join("-");

/** The notebook a diligent worker writes when its box runs out. */
function writeNotebook(t: ScriptContext, extra: Record<string, unknown> = {}): void {
  t.write(WORKER_NOTEBOOK, JSON.stringify({ schema: 1, state: `generation ${t.attempt} wrote work.txt`, tried: ["wrote work.txt"], failures: [`the key ${FAKE_KEY} did not help`], do_not_retry: ["deleting answer.txt"], next: ["write 42 to answer.txt"], self_reported: ["the unit check passes"], measured: { checks: [{ id: "unit", pass: true }] }, ...extra }));
}

/** `pi-autonomy status --run <run>` against a harness's state home: the text, and the --json object. */
async function cliStatus(h: H.Harness): Promise<{ text: string; json: Record<string, unknown> }> {
  const out: string[] = [];
  const deps = { home: h.home, effort: testEffort, stdout: { write: (t: string) => out.push(t) }, stderr: { write: () => true }, isTTY: false, signals: false };
  assert.equal(await main(["status", "--run", h.contract.run], deps), 0);
  const text = out.splice(0).join("");
  assert.equal(await main(["status", "--run", h.contract.run, "--json"], deps), 0);
  const json: unknown = parseJson(out.join(""));
  assert.ok(isRecord(json), "status --json prints an object");
  return { text, json };
}

const generations = (g: Record<string, unknown>) => ({ enabled: true, iterationMinutes: 5, graceMinutes: 2, maxGenerations: 3, ...g });

await check("rotates at the box: notebook requested, worker stopped, notebook copied out with the supervisor's measurements, fresh worker briefed inside the fence", async () => {
  const prompts: Array<{ attempt: number; message: string }> = [];
  const h = harness(simpleRaw({ effort: "exhaustive", generations: generations({}) }), {
    script: async (t) => {
      prompts.push({ attempt: t.attempt, message: t.message });
      if (t.attempt === 1 && BOX.test(t.message)) { writeNotebook(t); t.spend(0.05); return; }
      if (t.attempt === 1) { t.write("work.txt", "partial\n"); t.commit("partial work"); t.spend(0.1); t.hang(); return; }
      solve(t);
    },
  });
  const { state, rt } = await runOnce(h);
  assert.equal(state.status, "succeeded", JSON.stringify(state.outcome));
  assert.equal(rt.calls.workers.length, 2, "one fresh worker for the second generation");
  const gs = state.generations;
  assert.ok(gs, "state.json records the generations");
  assert.equal(gs.current, 2);
  assert.deepEqual(gs.history.map((r) => [r.generation, r.box, r.notebook, r.action, r.reset]), [[1, "minutes", true, "none", false]]);
  const request = prompts.find((p) => BOX.test(p.message));
  assert.ok(request?.attempt === 1, "the first worker was asked for its notebook");
  assert.match(request.message, new RegExp(WORKER_NOTEBOOK.replace(/\./g, "\\.")));
  // The notebook left the workspace and is in the run directory, 0600, with measured from the supervisor.
  assert.equal(fs.existsSync(path.join(h.store.p.work, WORKER_NOTEBOOK)), false, "the worker's copy was removed");
  assert.equal(fs.statSync(h.store.p.notebook).mode & 0o777, 0o600);
  const [entry] = readNotebook(h.store.p.notebook);
  assert.ok(entry, "one generation was appended");
  assert.equal(entry.generation, 1);
  assert.equal(entry.report.measuredDropped, true, "the worker's own measured was discarded");
  assert.ok(entry.measured, "the supervisor measured the generation");
  assert.deepEqual(entry.measured.checks, [{ id: "unit", pass: false }], "measured from the trusted checks, not the worker's claim");
  assert.equal(entry.measured.changedFiles, 1);
  assert.ok(entry.measured.minutes >= 5);
  assert.ok(!JSON.stringify(entry).includes(FAKE_KEY), "the secret-shaped value was redacted");
  // The fresh worker's briefing: verified state first, then the notebook inside the untrusted fence.
  const fresh = prompts.find((p) => p.attempt === 2);
  assert.ok(fresh, "the second worker was prompted");
  assert.match(fresh.message, /generation's time box ran out; you are generation 2 of 3/);
  const verified = fresh.message.indexOf("## Verified state");
  const fence = fresh.message.indexOf('<untrusted source="notebook generation 1">');
  assert.ok(verified >= 0 && fence > verified, "the notebook comes after the verified state");
  const fenced = fresh.message.slice(fence, fresh.message.indexOf("</untrusted>", fence));
  assert.match(fenced, /write 42 to answer\.txt/);
  assert.match(fenced, /\[hypothesis\] the unit check passes/);
  assert.match(fresh.message.slice(verified, fence), /checks passing: none; failing: unit/, "the supervisor's measurements are outside the fence");
  assert.deepEqual(fakeAlive(h.fakeEngine), []);
  // The operator's view: generation n/N, why the last one rotated, the latest notebook, redacted.
  const { text, json } = await cliStatus(h);
  assert.match(text, /generations \(Memento mode\): generation 2\/3; box 5 min/);
  assert.match(text, /last rotation: generation 1 ended at \S+: its time box ran out; recovery none; notebook appended/);
  assert.match(text, /latest notebook \(redacted[^\n]*\n {4}Notebook from generation 1\./);
  assert.match(text, /write 42 to answer\.txt/);
  assert.match(text, /\[REDACTED\]/);
  assert.ok(!text.includes(FAKE_KEY) && !JSON.stringify(json).includes(FAKE_KEY), "the secret-shaped value is not shown");
  const g = json.generations;
  assert.ok(isRecord(g), "status --json carries generations");
  assert.deepEqual([g.current, g.max, g.notebookError], [2, 3, null]);
  assert.ok(isRecord(g.lastRotation) && g.lastRotation.box === "minutes" && g.lastRotation.generation === 1 && g.lastRotation.notebook === true);
  assert.ok(isRecord(g.notebook) && g.notebook.generation === 1 && typeof g.notebook.text === "string" && g.notebook.text.includes('<untrusted source="notebook generation 1">'));
  // A notebook.json that does not parse is reported, not thrown.
  fs.writeFileSync(h.store.p.notebook, "{");
  assert.match((await cliStatus(h)).text, /notebook: unreadable/);
});

await check("terminal controls in a worker's notebook never reach state.json, the log or the status output", async () => {
  // JSON.parse's error quotes its input, so a notebook that is not JSON puts worker bytes into the rotation's problems.
  const CONTROLS = { test: (s: string): boolean => ["\u001b", "\u0007", "\u009b"].some((c) => s.includes(c)) };
  const h = harness(simpleRaw({ effort: "exhaustive", generations: generations({}) }), {
    script: async (t) => {
      if (t.attempt === 1 && BOX.test(t.message)) { t.write(WORKER_NOTEBOOK, "\u001b]52;c;Zm9v\u0007\u001b[2J\u009b2J{"); return; }
      if (t.attempt === 1) { t.write("work.txt", "partial\n"); t.commit("partial work"); t.hang(); return; }
      solve(t);
    },
  });
  const { state } = await runOnce(h);
  assert.equal(state.status, "succeeded", JSON.stringify(state.outcome));
  const problems = state.generations?.history[0]?.problems ?? [];
  assert.ok(problems.length > 0 && problems.some((p) => p.includes("not JSON")), JSON.stringify(problems));
  assert.ok(!CONTROLS.test(fs.readFileSync(h.store.p.state, "utf8")), "state.json holds no terminal controls");
  assert.ok(!CONTROLS.test(fs.readFileSync(h.store.p.log, "utf8")), "the supervisor log holds no terminal controls");
  let { text, json } = await cliStatus(h);
  assert.match(text, /no usable notebook \(notebook is not JSON/);
  assert.ok(!CONTROLS.test(text) && !CONTROLS.test(JSON.stringify(json)), "status text and --json hold no terminal controls");
  // A state.json written by an older supervisor, or edited by hand, is cleaned when it is shown too.
  const raw: unknown = parseJson(fs.readFileSync(h.store.p.state, "utf8"));
  assert.ok(isRecord(raw) && isRecord(raw.generations) && Array.isArray(raw.generations.history) && isRecord(raw.generations.history[0]));
  Object.assign(raw.generations.history[0], { at: "\u001b[2Jnow", box: "minutes\u0007", problems: ["bad \u001b]52;c;Zm9v\u0007\u009b2J\nline"] });
  fs.writeFileSync(h.store.p.state, JSON.stringify(raw));
  ({ text, json } = await cliStatus(h));
  assert.match(text, /generation 1 ended at \[2Jnow: its time box ran out; recovery \w+; no usable notebook \(bad \]52;c;Zm9v2J line\)/);
  assert.ok(!CONTROLS.test(text) && !CONTROLS.test(JSON.stringify(json)), "status text and --json hold no terminal controls");
});

await check("the last generation has no box: the run's own limits and recovery end it", async () => {
  let gen2Turns = 0;
  const h = harness(simpleRaw({ effort: "exhaustive", generations: generations({ maxGenerations: 2 }), recovery: { softNudges: 2, hardRestarts: 1, maxAttemptsPerStep: 20 } }), {
    script: async (t) => {
      if (BOX.test(t.message)) { writeNotebook(t); return; }
      if (t.attempt === 1) { t.write("work.txt", "partial\n"); t.commit("partial"); t.hang(); return; }
      gen2Turns++;
      if (gen2Turns === 1) { t.hang(); return; } // past the 5-minute box: idle at 20 minutes ends this turn, not a rotation
      solve(t);
    },
  });
  const { state } = await runOnce(h);
  assert.equal(state.status, "succeeded");
  assert.equal(state.generations?.current, 2);
  assert.equal(state.generations?.history.length, 1, "generation 2 was never rotated");
  assert.ok(state.usage.minutes >= 25, "the second generation ran past its box length");
});

await check("no-progress generations skip the nudges, spend the hard restarts and end recovery_exhausted", async () => {
  const h = harness(simpleRaw({ effort: "exhaustive", generations: generations({ maxGenerations: 8 }), recovery: { softNudges: 2, hardRestarts: 1, maxAttemptsPerStep: 20 } }), {
    script: async (t) => { if (BOX.test(t.message)) { writeNotebook(t); return; } t.tool("read", { path: "README.md" }); t.hang(); },
  });
  const { state, rt } = await runOnce(h);
  assert.deepEqual([state.status, state.outcome?.reason], ["failed", "recovery_exhausted"]);
  assert.equal(state.recovery.softNudgesUsed, 0, "a rotating session is not nudged");
  assert.deepEqual(state.recovery.totals, { softNudges: 0, hardRestarts: 1 });
  assert.equal(rt.calls.workers.length, 2);
  assert.deepEqual(state.generations?.history.map((r) => r.action), ["restart", "stop"]);
  assert.equal(readNotebook(h.store.p.notebook).length, 2, "each ended generation left its notebook");
});

await check("budget never exceeded: generations divide the run's budget, and its total ends the run", async () => {
  const budget = { totalUsd: 2, perStepUsd: 1, maxSteps: 50, maxMinutes: 600 };
  const h = harness(simpleRaw({ effort: "exhaustive", budget, generations: generations({ iterationMinutes: 60, iterationUsd: 0.5, maxGenerations: 8 }), recovery: { softNudges: 0, hardRestarts: 5, maxAttemptsPerStep: 50 } }), {
    script: async (t) => {
      if (BOX.test(t.message)) { writeNotebook(t); t.spend(0.25); return; }
      t.write(`work-${t.attempt}.txt`, "x\n"); t.commit(`work ${t.attempt}`); t.spend(0.5); t.hang();
    },
  });
  const { state, rt } = await runOnce(h);
  assert.deepEqual([state.status, state.outcome?.reason], ["budget_exhausted", "total_usd"]);
  assert.ok(state.usage.usd <= budget.totalUsd, `spent $${state.usage.usd} of $${budget.totalUsd}`);
  assert.deepEqual(state.limits.budget, budget, "generations never change the run's limits");
  assert.deepEqual(state.generations?.history.map((r) => r.box), ["usd", "usd"], "the dollar box rotated twice before the total ran out");
  assert.equal(rt.calls.workers.length, 3, "no worker was started once the total was reached");
});

await check("resetOnNoProgress starts the next generation from the accepted head; without it the leftovers stay", async () => {
  for (const reset of [true, false]) {
    let seen: string | null | undefined;
    let head = "";
    const h = harness(simpleRaw({ effort: "exhaustive", generations: generations({ resetOnNoProgress: reset }), recovery: { softNudges: 0, hardRestarts: 2, maxAttemptsPerStep: 20 } }), {
      script: async (t) => {
        if (BOX.test(t.message)) { writeNotebook(t); return; }
        if (t.attempt === 1) { t.write(".pi/leftover.txt", "half-done\n"); t.hang(); return; }
        seen = t.read(".pi/leftover.txt");
        head = t.git(["rev-parse", "HEAD"]).stdout.trim();
        solve(t);
      },
    });
    const { state, rt } = await runOnce(h);
    assert.equal(state.status, "succeeded", `reset=${String(reset)}`);
    assert.deepEqual(rt.agents.size, 2);
    assert.deepEqual([...rt.agents.values()].map((a) => a.resetWorkspace), [false, reset], "the next worker starts with a reset workspace");
    assert.deepEqual(state.generations?.history.map((r) => [r.action, r.reset]), [["restart", reset]]);
    assert.equal(seen, reset ? null : "half-done\n", reset ? "the leftovers of a generation without progress are gone" : "without the reset the workspace is kept");
    if (reset) assert.equal(head, state.setup?.base, "the second generation started at the accepted head");
  }
});

await check("a pause during the grace period: on unpause the spent generation rotates with its notebook; no worker is started for it", async () => {
  const prompts: Array<{ attempt: number; message: string }> = [];
  let parked = 0;
  const h = harness(simpleRaw({ effort: "exhaustive", generations: generations({ maxGenerations: 4 }) }), {
    script: async (t) => {
      prompts.push({ attempt: t.attempt, message: t.message });
      if (t.attempt === 1 && BOX.test(t.message)) { writeNotebook(t); h.store.enqueue("pause"); t.hang(); return; }
      if (t.attempt === 1) { t.write("work.txt", "partial\n"); t.commit("partial work"); t.hang(); return; }
      solve(t);
    },
    hooks: { onSleep: () => { if (h.state().status === "paused" && ++parked === 3) h.store.enqueue("unpause"); } },
  });
  const { state, rt } = await runOnce(h);
  assert.equal(state.status, "succeeded", JSON.stringify(state.outcome));
  assert.ok(state.history.some((x: H.RunHistoryEntry) => x.to === "paused"), "the run was paused");
  assert.deepEqual(prompts.map((p) => [p.attempt, BOX.test(p.message)]), [[1, false], [1, true], [2, false]], "the second worker was never asked for a notebook");
  assert.equal(rt.calls.workers.length, 2);
  assert.deepEqual(state.generations?.history.map((r) => [r.generation, r.box, r.notebook, r.action]), [[1, "minutes", true, "none"]]);
  const [entry] = readNotebook(h.store.p.notebook);
  assert.match(JSON.stringify(entry ?? {}), /generation 1 wrote work\.txt/, "generation 1's entry is the first worker's notebook");
  assert.match(prompts[2]?.message ?? "", /you are generation 2 of 4/);
});

await check("the per-step budget applies during the grace period: the turn is aborted and the grace period ends early", async () => {
  const budget = { totalUsd: 10, perStepUsd: 1, maxSteps: 50, maxMinutes: 600 };
  const h = harness(simpleRaw({ effort: "exhaustive", budget, generations: generations({ iterationMinutes: 5, graceMinutes: 4 }) }), {
    script: async (t) => {
      if (t.attempt === 1 && BOX.test(t.message)) { t.spend(2); t.hang(); return; }
      if (t.attempt === 1) { t.write("work.txt", "partial\n"); t.commit("partial work"); t.spend(0.1); t.hang(); return; }
      solve(t);
    },
  });
  const { state } = await runOnce(h);
  assert.equal(state.status, "succeeded", JSON.stringify(state.outcome));
  const [entry] = readNotebook(h.store.p.notebook);
  assert.ok(entry?.measured, "generation 1 was rotated");
  assert.ok(entry.measured.minutes < 5 + 4, `the grace period ended early (${entry.measured.minutes} minutes)`);
});

await check("a worker that crashes after its box ran out: the judged step is not judged again; the generation rotates and a fresh worker starts", async () => {
  const h = harness(simpleRaw({ effort: "exhaustive", generations: generations({}), recovery: { softNudges: 2, hardRestarts: 1, maxAttemptsPerStep: 20 } }), {
    script: async (t) => {
      if (t.attempt === 1) { t.tool("read", { path: "README.md" }); writeNotebook(t); t.elapse(6); t.crash(); return; }
      solve(t);
    },
  });
  const { state, rt } = await runOnce(h);
  assert.equal(state.status, "succeeded", JSON.stringify(state.outcome));
  assert.equal(rt.calls.workers.length, 2, "a fresh worker was started");
  assert.deepEqual(state.recovery.totals, { softNudges: 0, hardRestarts: 1 }, "the crash spent one hard restart, not two");
  assert.deepEqual(state.generations?.history.map((r) => [r.generation, r.box, r.notebook, r.action]), [[1, "minutes", true, "restart"]]);
  assert.match(JSON.stringify(readNotebook(h.store.p.notebook)[0] ?? {}), /generation 1 wrote work\.txt/, "the crashed worker's notebook was taken");
});

await check("Memento opt-in off: a contract asking for 3 generations runs one, with no box, and says why", async () => {
  optIn(null);
  try {
    const prompts: string[] = [];
    const h = harness(simpleRaw({ effort: "exhaustive", generations: generations({}) }), {
      script: async (t) => {
        prompts.push(t.message);
        if (t.turn === 1) { t.write("work.txt", "partial\n"); t.commit("partial work"); t.hang(); return; } // past the 5-minute box: idle ends the turn, not a rotation
        solve(t);
      },
    });
    const { state, rt } = await runOnce(h);
    assert.equal(state.status, "succeeded", JSON.stringify(state.outcome));
    assert.ok(state.usage.minutes >= 5, "the worker ran past the box length");
    assert.equal(rt.calls.workers.length, 1, "one worker: no generation rotated");
    assert.equal(state.generations, undefined, "no generations were started");
    assert.ok(!prompts.some((m) => BOX.test(m)), "no worker was asked for a notebook");
    assert.ok(state.memento, "state.json records the Memento decision");
    assert.deepEqual([state.memento.requested, state.memento.allowance, state.memento.maxGenerations, state.memento.model, state.memento.tier], [3, 0, 1, WORKER_KEY, "exhaustive"]);
    assert.match(state.memento.reason, /is not opted in/);
    assert.match(fs.readFileSync(h.store.p.log, "utf8"), /generations: the contract asks for 3, the Memento allowance is 0 \([^)]*is not opted in\): running as a single generation/);
    const events = fs.readFileSync(path.join(h.store.p.steps, "01", "events.jsonl"), "utf8");
    assert.match(events, /"type":"memento"[^\n]*"maxGenerations":1/, "the step's event log records the decision");
    const { text, json } = await cliStatus(h);
    assert.match(text, /generations \(Memento mode\): a single generation, not 3; the Memento allowance is 0 \([^)]*is not opted in\)/);
    const g = json.generations;
    assert.ok(isRecord(g) && g.max === 1 && isRecord(g.memento) && g.memento.allowance === 0, "status --json carries max 1 and the allowance");
  } finally { optIn({ [WORKER_KEY]: { enabled: true } }); }
});

await check("Memento opt-in on, tier allowance 2 (E4): a contract asking for 4 generations is capped at 2", async () => {
  const prompts: Array<{ attempt: number; message: string }> = [];
  let gen2Turns = 0;
  const h = harness(simpleRaw({ effort: "thorough", generations: generations({ maxGenerations: 4 }) }), {
    script: async (t) => {
      prompts.push({ attempt: t.attempt, message: t.message });
      if (BOX.test(t.message)) { writeNotebook(t); return; }
      if (t.attempt === 1) { t.write("work.txt", "partial\n"); t.commit("partial"); t.hang(); return; }
      gen2Turns++;
      if (gen2Turns === 1) { t.hang(); return; } // the second generation is the last: it has no box
      solve(t);
    },
  });
  const { state, rt } = await runOnce(h);
  assert.equal(state.status, "succeeded", JSON.stringify(state.outcome));
  assert.equal(rt.calls.workers.length, 2);
  assert.equal(state.generations?.current, 2);
  assert.equal(state.generations?.history.length, 1, "generation 2 was never rotated: it is the last of 2");
  assert.ok(state.usage.minutes >= 10, "the second generation ran past its box length");
  assert.ok(state.memento, "state.json records the Memento decision");
  assert.deepEqual([state.memento.requested, state.memento.allowance, state.memento.maxGenerations, state.memento.tier], [4, 2, 2, "thorough"]);
  assert.match(state.memento.reason, /the tier allows 2/);
  assert.match(prompts.find((p) => p.attempt === 2)?.message ?? "", /you are generation 2 of 2/);
  assert.match(fs.readFileSync(h.store.p.log, "utf8"), /generations: the contract asks for 4, the Memento allowance is 2 \([^)]*\): capped at 2/);
  const { text } = await cliStatus(h);
  assert.match(text, /generation 2\/2; box 5 min; capped from 4 by the Memento allowance/);
});

await check("Memento opt-in with the model's own limit: --max 1 runs one generation even at E5", async () => {
  optIn({ [WORKER_KEY]: { enabled: true, maxGenerations: 1 } });
  try {
    const h = harness(simpleRaw({ effort: "exhaustive", generations: generations({}) }), { script: async (t) => { solve(t); } });
    const { state } = await runOnce(h);
    assert.equal(state.status, "succeeded");
    assert.equal(state.generations, undefined);
    assert.deepEqual([state.memento?.allowance, state.memento?.maxGenerations], [1, 1]);
    assert.match(state.memento?.reason ?? "", /its own limit of 1/);
  } finally { optIn({ [WORKER_KEY]: { enabled: true } }); }
});

await check("the Memento decision is made once: changing the opt-in after the run started does not change it", async () => {
  const h = harness(simpleRaw({ effort: "exhaustive", generations: generations({}) }), {
    script: async (t) => {
      if (t.turn === 1) optIn(null); // the operator opts the model out while the run is under way
      if (BOX.test(t.message)) { writeNotebook(t); return; }
      if (t.attempt === 1) { t.write("work.txt", "partial\n"); t.commit("partial"); t.hang(); return; }
      solve(t);
    },
  });
  try {
    const { state } = await runOnce(h);
    assert.equal(state.status, "succeeded", JSON.stringify(state.outcome));
    assert.deepEqual([state.memento?.maxGenerations, state.generations?.current], [3, 2], "the run kept the allowance it started with");
  } finally { optIn({ [WORKER_KEY]: { enabled: true } }); }
});

await check("status of a run without generations shows no generations section", async () => {
  const h = harness(simpleRaw(), { script: async (t) => { solve(t); } });
  const { state } = await runOnce(h);
  assert.equal(state.status, "succeeded");
  const { text, json } = await cliStatus(h);
  assert.equal(json.generations, null);
  assert.ok(!/generations|last rotation|notebook/.test(text), text);
});

await check("taking the notebook out never follows a link, never opens a FIFO and never reads an oversized file", () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "autonomy-generations-work-"));
  const hostSecret = path.join(sandbox, "host-secret.txt");
  fs.writeFileSync(hostSecret, `${FAKE_KEY}\n`);
  const nb = path.join(work, WORKER_NOTEBOOK);
  try {
    assert.deepEqual(takeWorkerNotebook(work).ok, false, "no .pi directory: no notebook");
    fs.mkdirSync(path.dirname(nb));
    fs.symlinkSync(hostSecret, nb);
    const linked = takeWorkerNotebook(work);
    assert.equal(linked.ok, false);
    assert.ok(!linked.ok && /symbolic link/.test(linked.problem) && !linked.problem.includes(FAKE_KEY), "a symlinked notebook is refused unread");
    assert.equal(fs.existsSync(nb), false, "and the link is removed");
    assert.equal(fs.readFileSync(hostSecret, "utf8"), `${FAKE_KEY}\n`, "its target is untouched");
    const fifo = spawnSync("mkfifo", [nb]);
    if (fifo.status === 0) {
      const r = takeWorkerNotebook(work);
      assert.ok(!r.ok && /not a regular file/.test(r.problem), "a FIFO is refused without blocking");
    }
    fs.rmSync(nb, { force: true });
    fs.writeFileSync(nb, "x".repeat(70 * 1024));
    const big = takeWorkerNotebook(work);
    assert.ok(!big.ok && /bytes/.test(big.problem), "an oversized notebook is refused unread");
    fs.writeFileSync(nb, '{"state":"ok"}');
    assert.deepEqual(takeWorkerNotebook(work), { ok: true, text: '{"state":"ok"}' });
    assert.equal(fs.existsSync(nb), false, "a taken notebook is removed from the workspace");
    fs.rmSync(path.dirname(nb), { recursive: true });
    fs.mkdirSync(path.join(work, "elsewhere"));
    fs.writeFileSync(path.join(work, "elsewhere", "generation-notebook.json"), '{"state":"planted"}');
    fs.symlinkSync(path.join(work, "elsewhere"), path.dirname(nb));
    const dirLink = takeWorkerNotebook(work);
    assert.ok(!dirLink.ok && /not a plain directory/.test(dirLink.problem), "a symlinked .pi is refused");
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
});

cleanup();
fs.rmSync(sandbox, { recursive: true, force: true });
done();
