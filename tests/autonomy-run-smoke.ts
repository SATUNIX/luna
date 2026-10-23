#!/usr/bin/env node
/**
 * DETERMINISTIC FAKE-RUNTIME integration tests of the run engine (packages/autonomy/lib/engine.ts).
 * These are NOT real-provider runs: no container is started and no model is called. A scripted
 * fake runtime (packages/autonomy/tests/fake-runtime.ts) plays the worker and the container
 * engine; everything the engine does with git, files, the lock, the lifecycle and the acceptance
 * checks is real (the checks are executed, from the contract's definitions, in a clean clone with
 * the held-out overlay applied). What they prove:
 *   - an ordinary finite task starts, works, FAILS acceptance, is corrected, is interrupted (the
 *     supervisor is killed) and RESUMED after a stale lock, finishes with evidence and EXPORTS
 *   - cancellation, budget exhaustion, maxSteps, maxMinutes, each with its own outcome
 *   - containment refusals: tampered contract, out-of-area writes, widened reconfigure, digest mismatch
 *   - no approval is ever asked inside an authorised zone; a question blocks and `answer` continues
 *   - duplicate start refused, orphaned worker cleaned, recovery escalation bounded and persisted
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { assert, implementRaw, makeChecker, testEffort } from "./autonomy-helpers.ts";
import * as H from "./autonomy-harness.ts";
import { createRun } from "../packages/autonomy/lib/rundir.ts";
import { Engine } from "../packages/autonomy/lib/engine.ts";
import { TEMPLATES } from "../packages/autonomy/lib/templates/index.ts";
import { exportRun } from "../packages/autonomy/lib/export.ts";
import { classifyDialog, operatorDecision } from "../packages/autonomy/lib/rpc.ts";
import { kill } from "../packages/autonomy/tests/fake-runtime.ts";

import type { RawContract } from "./autonomy-helpers.ts";
import type { Harness, HarnessRuntime, RunBlocker, RunHistoryEntry, Script, ScriptContext } from "./autonomy-harness.ts";
import { isRecord, object, parseJsonAs, string, unknownValue } from "../packages/core/lib/guard.ts";

interface Manifest { status: string; missing: string[]; artefacts: { path: string; exported: boolean }[]; files: { sha256: string }[] }
/** Engine as constructed: its constructor `Object.assign`s `rt`, which inference cannot see. */
type EngineWithRt = Engine & { rt: HarnessRuntime };

const { check, done } = makeChecker("autonomy-run-smoke");
const { scratch, cleanup, NODE_EXIT, ANSWER, taskRaw, harness, fakeAlive, simpleRaw, solve, junk, runOnce } = H;
// exportRun's JSDoc says it returns the manifest; it returns { dir, manifest }.
const exportRunTyped = exportRun as (o: Parameters<typeof exportRun>[0]) => { dir: string; manifest: Manifest };

/** A JSON file read back from a run directory; it must hold an object. */
function readJson(file: string): Record<string, unknown> {
  const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.ok(isRecord(value), `${file} holds a JSON object`);
  return value;
}
/** The object at a key path inside a JSON object; each step must be an object. */
function recordAt(value: Record<string, unknown>, ...keys: string[]): Record<string, unknown> {
  let at = value;
  for (const key of keys) {
    const next = at[key];
    assert.ok(isRecord(next), `${keys.join(".")}: ${key} is an object`);
    at = next;
  }
  return at;
}
/** A check-evidence file: the fields these checks read. */
const CheckEvidence = object({ pass: unknownValue(), definitionDigest: string() });

/** A field of a thrown value, if it is an object. */
const errorField = (e: unknown, key: string): unknown => (typeof e === "object" && e !== null ? (e as Record<string, unknown>)[key] : undefined);
type Decision = ReturnType<typeof operatorDecision>;
const replyOf = (d: Decision) => ("reply" in d ? d.reply : undefined);
function blockerOf(d: Decision): RunBlocker {
  assert.ok("blocker" in d, `expected a block, got ${d.action}`);
  return d.blocker as RunBlocker;
}

await check("the auto-operator decides from the contract, never hangs and never invents an answer for a person (table-driven)", () => {
  const on = { authorised: true, autoApprove: true };
  const authorisedOnly = { authorised: true, autoApprove: false };
  const off = { authorised: false, autoApprove: false };
  const dialogs = {
    confirm: { id: "1", method: "confirm", title: "Run rm -rf build/?" },
    allowDeny: { id: "2", method: "select", title: "Firewall", options: ["Allow once", "Allow for this session (exact repeats only)", "Deny", "Deny and tell the agent"] },
    yesNoQuestion: { id: "3", method: "select", title: "Use pagination?", options: ["Yes", "No", "Other (type an answer)"] },
    choices: { id: "4", method: "select", title: "Which database?", options: ["SQLite", "Postgres", "Other (type an answer)"] },
    input: { id: "5", method: "input", title: "What should the service be called?" },
    editor: { id: "6", method: "editor", title: "Edit the plan", prefill: "draft" },
    notify: { id: "7", method: "notify", message: "compaction done" },
    status: { id: "8", method: "setStatus", statusKey: "x", statusText: "y" },
  };
  const expected: Record<string, string[]> = {
    // dialog:            autoApprove on | authorised only | not authorised
    confirm:       ["reply", "block", "block"],
    allowDeny:     ["reply", "block", "block"],
    yesNoQuestion: ["block", "block", "block"],
    choices:       ["block", "block", "block"],
    input:         ["block", "block", "block"],
    editor:        ["block", "block", "block"],
    notify:        ["ignore", "ignore", "ignore"],
    status:        ["ignore", "ignore", "ignore"],
  };
  for (const [name, dialog] of Object.entries(dialogs)) {
    const got = [on, authorisedOnly, off].map((policy) => operatorDecision(dialog, policy).action);
    assert.deepEqual(got, expected[name], name);
  }
  const reply = replyOf(operatorDecision(dialogs.allowDeny, on));
  assert.deepEqual(reply, { type: "extension_ui_response", id: "2", value: "Allow for this session (exact repeats only)" });
  assert.deepEqual(replyOf(operatorDecision(dialogs.confirm, on)), { type: "extension_ui_response", id: "1", confirmed: true });
  const blocked = blockerOf(operatorDecision(dialogs.choices, on));
  assert.deepEqual([blocked.kind, blocked.method, blocked.id, blocked.options], ["question", "select", "4", ["SQLite", "Postgres", "Other (type an answer)"]]);
  assert.match(blocked.question, /Which database\?/);
  assert.equal(classifyDialog(dialogs.yesNoQuestion), "question", "a Yes/No question is a question, not an approval");
  assert.equal(classifyDialog({ method: "confirm" }), "approval");
  assert.equal(classifyDialog(undefined), "notice");
  assert.equal(blockerOf(operatorDecision({ id: "9", method: "input", title: "x".repeat(5000) }, on)).question.length, 1000, "recorded questions are bounded");
});

// --- 1. the whole journey ----------------------------------------------------------------------
await check("a finite task: starts, fails acceptance (a tampered check does not help), is corrected, survives a killed supervisor, resumes after the stale lock, finishes with evidence and exports", async () => {
  const dir = scratch();
  let killed = false;
  const turns: { step: number; attempt: number; kind: string; has: (s: string) => boolean }[] = [];
  const script = async (t: ScriptContext) => {
    turns.push({ step: t.step, attempt: t.attempt, kind: t.kind, has: (s: string) => t.message.includes(s) });
    t.tool("write", { path: "answer.txt" });
    t.spend(0.05);
    if (turns.length === 1) {
      // First turn: a wrong answer, and a try at faking the held-out check inside the worker's own repository.
      t.write("answer.txt", "41\n");
      t.write("tests/held-out.mjs", "process.exit(0);\n");
      t.commit("first attempt");
    } else if (turns.length === 2 && !killed) {
      killed = true;
      throw kill(); // the supervisor dies in the middle of the second step
    } else if (turns.filter((x) => x.attempt === t.attempt).length === 1 && t.attempt > 1) {
      t.write("answer.txt", "42"); // right value, no trailing newline: unit passes, the held-out check does not
      t.commit("second attempt");
    } else {
      t.write("answer.txt", "42\n"); // and NOT committed: the supervisor's snapshot must pick it up
    }
  };
  const h = harness(taskRaw(dir), { script });
  const first = h.engine({ pid: 111 });
  await assert.rejects(first.engine.run(), (e) => errorField(e, "simulateKill") === true);
  let s = h.state();
  assert.equal(s.status, "running", "a killed supervisor leaves the run running");
  assert.equal(fs.existsSync(h.store.p.lock), true, "and its lock behind");
  assert.equal(s.step, 2);
  assert.equal(s.acceptance.latest?.allRequiredPass, false);
  assert.deepEqual(s.acceptance.latest?.results.map((r: { id: string; pass: boolean }) => [r.id, r.pass]), [["unit", false], ["held-out", false]], "the tampered held-out file in the worker's repo did not make the check pass");
  assert.equal(fakeAlive(h.fakeEngine).length, 1, "the worker container is orphaned");
  assert.equal(h.store.pending().length, 0);

  // A duplicate start while the owner is still alive is refused.
  const dup = h.lock(222, (pid) => pid === 111);
  assert.equal(dup.acquire().acquired, false);
  // Now the owner is gone: the next supervisor takes over the stale lock, cleans the orphan and continues.
  const rtB = h.runtime(script);
  const second = h.engine({ rt: rtB, pid: 222, lock: h.lock(222, (pid) => pid !== 111) });
  assert.match((second.acquired.acquired ? second.acquired.tookOver?.why : undefined) ?? "", /no longer exists/);
  await second.engine.run({ takeover: true });
  s = h.state();
  assert.equal(s.status, "succeeded", JSON.stringify(s.outcome));
  assert.deepEqual([s.outcome?.status, s.outcome?.reason], ["succeeded", "acceptance_passed"]);
  assert.equal(s.acceptance.latest?.allRequiredPass, true);
  assert.deepEqual(s.acceptance.latest?.results.map((r: { id: string; pass: boolean }) => [r.id, r.pass]), [["unit", true], ["held-out", true]]);
  assert.equal(s.acceptance.review.status, "approved");
  assert.deepEqual(s.tasks.map((t: { id: string; status: string }) => [t.id, t.status]), [["T1", "done"], ["T2", "done"]], "the board comes from trusted results: T1 from its checks, T2 covered by the run's acceptance");
  assert.ok(h.fakeEngine.removed.some((n) => n.endsWith("agent-01-1")), "the orphaned container was removed by name");
  assert.deepEqual(fakeAlive(h.fakeEngine), []);
  assert.ok(s.step >= 4 && s.usage.steps >= s.step - 1, "steps continue; they are never reset by the resume");
  assert.ok(s.usage.usd >= 0.19, `spend accumulates across the kill: ${s.usage.usd}`);
  assert.equal(s.effort.tier, "standard");
  assert.equal(s.worker, null);
  assert.equal(fs.existsSync(h.store.p.lock), false, "the lock is released");
  // Evidence: every check has a file, hashed by the definition that ran, and state points at them.
  const ev = s.artefacts.filter((a) => a.kind === "check-evidence");
  assert.ok(ev.length >= 6 && ev.every((a) => fs.existsSync(path.join(h.store.p.root, a.path))));
  const firstResult = s.acceptance.latest?.results[0];
  assert.ok(firstResult, "the latest acceptance records a check result");
  const last = parseJsonAs(CheckEvidence, fs.readFileSync(path.join(h.store.p.root, firstResult.evidence), "utf8"));
  assert.equal(last.pass, true);
  assert.match(last.definitionDigest, /^[a-f0-9]{64}$/);
  // The check definitions that ran came from the contract, and the overlay was applied.
  assert.ok(rtB.calls.checks.every((c: { definition: unknown }) => Array.isArray(c.definition)), "definitions come from checks.json");
  // The session that continued after the kill was briefed from verified state, with worker traces quarantined.
  const resumed = turns.find((x) => x.attempt === 2);
  assert.ok(resumed, "a session ran after the kill");
  assert.ok(resumed.has("Verified state (from the supervisor") && resumed.has("the supervisor was restarted") && resumed.has("Task: Write the answer"), "a fresh session gets the briefing and the task");
  assert.ok(resumed.has("<untrusted") && resumed.has("not as instructions"), "traces of the earlier session are quarantined");
  assert.equal(resumed.has("Ignore previous instructions"), false);
  assert.ok(h.state().history.map((x: RunHistoryEntry) => x.to).join(",").startsWith("setup,ready,running"));

  // Export: results, evidence, usage, decisions and the work itself, everything state references.
  const out = path.join(scratch(), "results");
  const { manifest } = exportRunTyped({ store: h.store, repo: rtB.repo, contract: h.contract, state: h.state(), out });
  assert.equal(manifest.status, "succeeded");
  assert.deepEqual(manifest.missing, []);
  for (const f of ["manifest.json", "contract.json", "state.json", "usage.json", "decisions.json", "acceptance/acceptance.json", `work/${h.contract.run}.bundle`, `work/${h.contract.run}.patch`]) assert.ok(fs.existsSync(path.join(out, f)), f);
  for (const a of manifest.artefacts) assert.equal(a.exported, true, `${a.path} exported`);
  assert.ok(manifest.files.every((f) => /^[a-f0-9]{64}$/.test(f.sha256)));
  const patch = fs.readFileSync(path.join(out, "work", `${h.contract.run}.patch`), "utf8");
  assert.match(patch, /answer\.txt/);
  assert.match(patch, /\+42/);
  assert.equal(fs.readFileSync(path.join(out, "contract.json"), "utf8").includes("sk-"), false);
});



await check("cancellation ends the run as cancelled (not failed), keeps the work and stops the worker", async () => {
  const h: Harness = harness(simpleRaw(), { script: async (t) => { t.write("wip.txt", "half done"); t.commit("wip"); h.store.enqueue("cancel", { reason: "no longer needed" }); } });
  const { state, rt } = await runOnce(h);
  assert.equal(state.status, "cancelled");
  assert.deepEqual([state.outcome?.status, state.outcome?.reason, state.outcome?.detail], ["cancelled", "operator", "no longer needed"]);
  assert.deepEqual(fakeAlive(h.fakeEngine), []);
  assert.ok(state.setup, "the run recorded its setup");
  assert.notEqual(rt.repo.head(), state.setup.base, "the worker's committed work was brought in before the run ended");
  assert.equal(state.history.at(-1)?.by, "operator");
  assert.equal(h.store.pending().length, 0, "the command was acknowledged");
  // Cancel also works while paused, and on a run nobody is supervising (by transition from any non-terminal state).
  const h2 = harness(simpleRaw(), { script: async (t) => { t.write("x.txt", "1"); t.commit("x"); h2.store.enqueue("pause"); }, hooks: { onSleep: (_rt, n) => { if (h2.state().status === "paused") h2.store.enqueue("cancel"); if (n > 50) throw new Error("did not cancel"); } } });
  const paused = await runOnce(h2);
  assert.equal(paused.state.status, "cancelled");
  assert.ok(paused.state.history.some((x: RunHistoryEntry) => x.to === "paused"));
});

await check("pause parks the run (containers stay, no active time accrues); steer and unpause continue it in a fresh, briefed session", async () => {
  let parked = 0;
  const seen: { attempt: number; message: string }[] = [];
  const h: Harness = harness(simpleRaw(), {
    script: async (t) => { seen.push({ attempt: t.attempt, message: t.message }); if (seen.length === 1) { t.write("wip.txt", "1"); t.commit("wip"); h.store.enqueue("pause", { reason: "lunch" }); } else solve(t); },
    hooks: { onSleep: () => { if (h.state().status === "paused") { parked++; if (parked === 5) { h.store.enqueue("steer", { message: "prefer small commits" }); h.store.enqueue("unpause"); } } } },
  });
  const t0 = h.clock.now;
  const { state } = await runOnce(h);
  assert.equal(state.status, "succeeded");
  assert.equal(parked, 5);
  const elapsedMinutes = (h.clock.now - t0) / 60_000;
  assert.ok(state.usage.minutes <= elapsedMinutes - 4, `active minutes ${state.usage.minutes} exclude the ${parked} parked minutes of ${elapsedMinutes}`);
  assert.deepEqual(state.history.map((x: RunHistoryEntry) => x.to).filter((x: string) => ["paused", "running"].includes(x)), ["running", "paused", "running", ]);
  assert.ok(seen[1], "a second session was started");
  assert.match(seen[1].message, /the run was paused and resumed/);
  assert.match(seen[1].message, /Operator steering \(authoritative\): prefer small commits/);
  assert.equal(state.steers?.length, 1);
  assert.equal(seen[1].attempt, 2, "a fresh session on the same workspace");
});

await check("limits end the run with their own outcome: total_usd, max_steps, max_minutes, each budget_exhausted, never failed", async () => {
  const cases: [reason: string, over: RawContract, script: Script][] = [
    ["total_usd", { budget: { totalUsd: 1, perStepUsd: 1, maxSteps: 20, maxMinutes: 600 } }, (t) => { t.spend(0.4); junk(t); }],
    ["max_steps", { budget: { totalUsd: 10, perStepUsd: 2, maxSteps: 3, maxMinutes: 600 } }, junk],
    ["max_minutes", { budget: { totalUsd: 10, perStepUsd: 2, maxSteps: 20, maxMinutes: 100 } }, (t) => { t.elapse(70); junk(t); }],
  ];
  for (const [reason, over, script] of cases) {
    const h = harness(simpleRaw(over), { script: async (t) => script(t) });
    const { state, rt } = await runOnce(h);
    assert.equal(state.status, "budget_exhausted", reason);
    assert.deepEqual([state.outcome?.status, state.outcome?.reason], ["budget_exhausted", reason]);
    assert.deepEqual(fakeAlive(h.fakeEngine), [], `${reason}: no worker left running`);
    assert.ok(state.setup, `${reason}: the run recorded its setup`);
    assert.notEqual(rt.repo.head(), state.setup.base, `${reason}: the work is kept`);
    if (reason === "max_steps") assert.equal(state.usage.steps, 3);
    if (reason === "total_usd") assert.ok(state.usage.usd >= 1 && state.usage.usd < 1.5);
    if (reason === "max_minutes") assert.ok(state.usage.minutes >= 100);
  }
  // The step that satisfies acceptance is judged BEFORE the limit is applied.
  const h = harness(simpleRaw({ budget: { totalUsd: 10, perStepUsd: 2, maxSteps: 1, maxMinutes: 600 } }), { script: async (t) => solve(t) });
  assert.equal((await runOnce(h)).state.status, "succeeded", "finishing on the last allowed step is success, not exhaustion");
});

await check("the per-step budget stops a runaway turn; raising limits with `reconfigure` lifts an exhausted run to paused, then it can continue", async () => {
  const h: Harness = harness(simpleRaw({ budget: { totalUsd: 3, perStepUsd: 1, maxSteps: 20, maxMinutes: 600 } }), { script: async (t) => { t.spend(1.6); t.hang(); } });
  const { state, rt } = await runOnce(h);
  assert.ok([...rt.agents.values()].some((a) => a.aborted), "the runaway turn was aborted at the per-step budget");
  assert.equal(state.status, "budget_exhausted");
  assert.equal(state.outcome?.reason, "total_usd");
  // Only `reconfigure` changes budgets, and it is logged in state.
  h.store.enqueue("reconfigure", { changes: { budget: { totalUsd: 30, perStepUsd: 5 } }, reason: "operator topped up" });
  h.store.enqueue("unpause");
  const script2 = async (t: ScriptContext) => solve(t);
  const again = await runOnce(h, { rt: h.runtime(script2), pid: 2, run: { takeover: true } });
  assert.equal(again.state.status, "succeeded");
  assert.deepEqual(again.state.limits.budget, { totalUsd: 30, perStepUsd: 5, maxSteps: 20, maxMinutes: 600 });
  assert.equal(again.state.reconfigurations.length, 1);
  assert.ok(again.state.reconfigurations[0], "the top-up is recorded");
  assert.deepEqual([again.state.reconfigurations[0].before?.budget.totalUsd, again.state.reconfigurations[0].after?.budget.totalUsd], [3, 30]);
  assert.equal(again.state.history.some((x: RunHistoryEntry) => x.from === "budget_exhausted" && x.to === "paused" && x.by === "reconfigure"), true);
  assert.ok(again.state.usage.usd >= 3.2, "spend was not reset by the top-up");
});

await check("containment: a contract changed under a run, a failed boundary probe and a widening reconfigure are all refused", async () => {
  // 1. The contract file edited after the run was created: the run fails as boundary_violation before any worker starts.
  const h = harness(simpleRaw(), { script: async (t) => solve(t) });
  const c = readJson(h.store.p.contract);
  const cEgress = recordAt(c, "permissions", "network").egress;
  assert.ok(Array.isArray(cEgress), "the contract lists its egress");
  cEgress.push({ host: "evil.example.org", ports: [443], plainGet: false });
  fs.chmodSync(h.store.p.contract, 0o644);
  fs.writeFileSync(h.store.p.contract, JSON.stringify(c));
  const { state, rt } = await runOnce(h);
  assert.equal(state.status, "failed");
  assert.deepEqual([state.outcome?.status, state.outcome?.reason], ["failed", "boundary_violation"]);
  assert.match(state.outcome?.detail ?? "", /no longer matches the digest/);
  assert.equal(rt.calls.workers.length, 0, "no worker was started on a tampered contract");
  // 2. Tampering mid-run (a worker cannot write it, but the supervisor checks every tick anyway).
  const h2: Harness = harness(simpleRaw(), { script: async (t) => { junk(t); const c2 = readJson(h2.store.p.contract); recordAt(c2, "permissions").writeAreas = ["**", "../outside/**"]; recordAt(c2, "budget").totalUsd = 9999; fs.chmodSync(h2.store.p.contract, 0o644); fs.writeFileSync(h2.store.p.contract, JSON.stringify(c2)); } });
  const mid = await runOnce(h2);
  assert.equal(mid.state.outcome?.reason, "boundary_violation");
  assert.deepEqual(fakeAlive(h2.fakeEngine), []);
  // 3. A failed probe at start: boundary_violation, terminal, no work done.
  const h3 = harness(simpleRaw(), { script: async (t) => solve(t), boundary: { pass: false, checks: [{ name: "tcp 1.1.1.1:443 fails", ok: false, detail: "connected" }, { name: "no docker socket", ok: true, detail: "" }] } });
  const probe = await runOnce(h3);
  assert.equal(probe.state.status, "failed");
  assert.equal(probe.state.outcome?.reason, "boundary_violation");
  assert.match(probe.state.outcome?.detail ?? "", /tcp 1\.1\.1\.1:443 fails: connected/);
  assert.equal(probe.rt.calls.workers.length, 0);
  // 4. `reconfigure` cannot touch the boundary: network, promotion, credentials, runtime, acceptance definitions.
  const h4: Harness = harness(simpleRaw(), { script: async (t) => { if (t.turn === 1) for (const changes of [{ permissions: { network: { egress: [{ host: "evil.example.org", ports: [443] }] } } }, { promotion: { policy: "push" } }, { runtime: { image: "evil:1" } }, { acceptance: { checks: [] } }, { budget: { totalUsd: -1 } }, { effort: "E9" }]) h4.store.enqueue("reconfigure", { changes }); junk(t); } , });
  const rec = await runOnce(h4, { run: {} });
  const refusals = rec.state.reconfigurations.filter((r) => r.refused);
  assert.equal(refusals.length, 6, JSON.stringify(rec.state.reconfigurations));
  assert.ok(refusals[0], "the first widening is refused");
  assert.match(refusals[0].refused?.[0] ?? "", /part of the authorised boundary/);
  assert.deepEqual(rec.state.limits.budget, h4.contract.budget, "nothing changed");
  assert.deepEqual(rec.state.effort, { tier: "standard", cap: "standard" });
  const storedEgress = recordAt(readJson(h4.store.p.contract), "permissions", "network").egress;
  assert.ok(Array.isArray(storedEgress), "the contract lists its egress");
  assert.equal(storedEgress.length, 0);
});

await check("the effort tier is a snapshot: workers get it from state; a reconfigure changes it for later sessions only; nothing else does", async () => {
  const tiers: string[] = [];
  const h: Harness = harness(simpleRaw({ effort: "E3", recovery: { softNudges: 0, hardRestarts: 2, maxAttemptsPerStep: 8 } }), {
    script: async (t) => { tiers.push(t.effort.tier); if (tiers.length === 1) { h.store.enqueue("reconfigure", { changes: { effort: "E5" } }); h.store.enqueue("reconfigure", { changes: { effort: { tier: "E5", cap: "E5" } } }); } if (tiers.length === 3) solve(t); },
  });
  const { state, rt } = await runOnce(h);
  assert.equal(state.status, "succeeded");
  assert.deepEqual(rt.calls.workers.map((w: { effort: { tier: string } }) => w.effort.tier), ["standard", "exhaustive", "exhaustive"].slice(0, rt.calls.workers.length));
  assert.equal(state.effort.tier, "exhaustive");
  assert.ok(state.reconfigurations[1], "the second reconfigure is recorded");
  assert.equal(state.reconfigurations[1].before?.effort.tier, "standard");
  assert.equal(recordAt(readJson(h.store.p.contract), "effort").tier, "standard", "the contract still says what was authorised; the change is a logged, explicit reconfigure");
  assert.equal(state.reconfigurations.length, 2);
  const published = recordAt(readJson(path.join(h.store.p.public, "contract.json")), "effort");
  assert.deepEqual([published.tier, published.cap], ["exhaustive", "exhaustive"], "the sanitised contract a worker reads at /run/contract.json follows the run's current effort");
  assert.equal(published.cap, published.tier, "and the boundary part of it is unchanged");
  assert.ok(state.reconfigurations[0], "the bare-tier reconfigure is recorded");
  assert.match(state.reconfigurations[0].refused?.[0] ?? "", /above its cap/, "a bare tier above the run's cap is refused; raising the cap is an explicit part of the change");
});

await check("write areas: changes outside permissions.writeAreas are not accepted; reverting them is; a second consecutive violation ends the run as boundary_violation", async () => {
  const raw = () => simpleRaw({ permissions: { writeAreas: ["answer.txt", "src/**"], unattended: { authorised: true, autoApprove: true } } });
  // Corrected after one violation.
  let turn = 0;
  const h = harness(raw(), { script: async (t) => {
    turn++;
    if (turn === 1) { t.write("answer.txt", "42\n"); t.write("package.json", "{}"); t.commit("answer and a stray file"); }
    else if (turn === 2) { t.remove("package.json"); t.commit("remove the stray file"); }
  } });
  const { state, rt } = await runOnce(h);
  assert.equal(state.status, "succeeded", JSON.stringify(state.outcome));
  assert.equal(state.recovery.violations, 0, "the violation counter resets once a step is clean");
  assert.ok(rt.calls.checks.length >= 2);
  assert.equal(rt.repo.fileAt(rt.repo.head(), "package.json"), null, "the refused file is not in the accepted history's tree");
  assert.ok(h.state().history.length > 0);
  // Not corrected: refused twice in a row.
  const h2 = harness(raw(), { script: async (t) => { t.write("answer.txt", "42\n"); t.write(`elsewhere-${t.turn}.txt`, "x"); t.commit("still outside"); } });
  const bad = await runOnce(h2);
  assert.deepEqual([bad.state.status, bad.state.outcome?.reason], ["failed", "boundary_violation"]);
  assert.match(bad.state.outcome?.detail ?? "", /outside permissions\.writeAreas/);
  assert.equal(bad.rt.repo.head(), bad.state.setup?.base, "nothing outside the areas was ever accepted");
  assert.equal(bad.rt.calls.checks.length, 1, "the refused head was never even judged: only the unchanged base was checked, once (a second look at the same commit is not repeated)");
});

await check("approvals: with auto-approve on, zero approvals are asked across a whole run; questions always block; an answer continues the run", async () => {
  // A run full of approval dialogs and notices: all answered by the auto-operator, none reach a person.
  let n = 0;
  const h: Harness = harness(simpleRaw({ permissions: { unattended: { authorised: true, autoApprove: true } } }), { script: async (t) => {
    n++;
    t.ask({ method: "confirm", title: "Run rm -rf build/?" });
    t.ask({ method: "select", title: "Firewall", options: ["Allow once", "Allow for this session", "Deny"] });
    t.emit({ type: "extension_ui_request", id: `n${n}`, method: "notify", message: "heads up", notifyType: "info" });
    if (n === 2) solve(t); else junk(t);
  } });
  const { state, rt } = await runOnce(h);
  assert.equal(state.status, "succeeded");
  assert.equal(state.ui?.blocked, 0, "approvals asked of a person: zero");
  assert.equal(state.ui?.autoAnswered, 4);
  assert.equal(rt.uiResponses.length, 4, "every dialog got an immediate answer");
  assert.deepEqual(rt.uiResponses.map((r) => ("confirmed" in r ? r.confirmed : "value" in r ? r.value : undefined)), [true, "Allow for this session", true, "Allow for this session"]);
  assert.equal(state.pendingQuestions.length, 0);

  // A question needs a human, whatever the auto-approve setting; the question is recorded and `answer` continues.
  const prompts: string[] = [];
  const h2: Harness & { answered?: boolean; blockedSeen?: RunBlocker | null } = harness(simpleRaw({ permissions: { unattended: { authorised: true, autoApprove: true } } }), {
    script: async (t) => { prompts.push(t.message); if (prompts.length === 1) { t.write("wip.txt", "1"); t.ask({ method: "input", title: "Which answer do you want: 41 or 42?" }); } else solve(t); },
    hooks: { onSleep: () => { const s = h2.state(); if (s.status === "blocked" && !h2.answered) { h2.answered = true; h2.blockedSeen = s.blocker; h2.store.enqueue("answer", { text: "" }); h2.store.enqueue("answer", { text: "Use 42, please." }); } } },
  });
  const q = await runOnce(h2);
  assert.equal(q.state.status, "succeeded", JSON.stringify(q.state.outcome));
  assert.deepEqual([h2.blockedSeen?.kind, h2.blockedSeen?.method], ["question", "input"]);
  assert.match(h2.blockedSeen?.question ?? "", /41 or 42/);
  assert.ok(q.state.pendingQuestions[0], "the question is recorded in state");
  assert.equal(q.state.pendingQuestions[0].question, h2.blockedSeen?.question, "the question is recorded in state");
  assert.ok(prompts[1], "a second prompt carried the answer");
  assert.match(prompts[1], /The operator's answer \(authoritative\)/);
  assert.match(prompts[1], /Which answer do you want/);
  assert.match(prompts[1], /Operator: Use 42, please\./);
  assert.equal(q.state.ui?.blocked, 1);
  assert.deepEqual(q.state.history.map((x: RunHistoryEntry) => x.to).filter((x: string) => ["blocked", "running"].includes(x)), ["running", "blocked", "running"]);
  assert.equal(q.state.history.find((x: RunHistoryEntry) => x.from === "blocked")?.by, "operator");

  // Without auto-approve, even an approval blocks, and the run waits for a decision.
  const h3: Harness & { done?: boolean; kind?: string | undefined } = harness(simpleRaw({ permissions: { unattended: { authorised: true, autoApprove: false } } }), {
    script: async (t) => { if (t.attempt === 1) t.ask({ method: "confirm", title: "Push to origin?" }); else solve(t); },
    hooks: { onSleep: () => { const s = h3.state(); if (s.status === "blocked" && !h3.done) { h3.done = true; h3.kind = s.blocker?.kind; h3.store.enqueue("answer", { deny: true, text: "No pushing." }); } } },
  });
  const a = await runOnce(h3);
  assert.equal(h3.kind, "approval");
  assert.equal(a.state.status, "succeeded");
  assert.equal(a.state.ui?.autoAnswered, 0);
  assert.equal(a.rt.uiResponses.length, 0);
});

await check("duplicate start refused; a wedged or live owner is never taken over; a displaced supervisor stops without touching state", async () => {
  const h = harness(simpleRaw(), { script: async (t) => solve(t) });
  assert.throws(() => createRun({ contract: h.contract, authorisation: { boundaryDigest: h.digest, by: "t", at: "x", via: "contract" }, home: h.home }), /already exists/);
  const owner = h.lock(500);
  assert.equal(owner.acquire().acquired, true);
  const second = h.lock(600, (pid) => pid === 500);
  const r = second.acquire();
  assert.equal(r.acquired, false);
  assert.match(r.reason ?? "", /already being supervised/);
  owner.release();
  // A supervisor whose lock is taken away mid-run stops and leaves the state to the new owner.
  const h2: Harness = harness(simpleRaw(), { script: async (t) => { junk(t); fs.writeFileSync(h2.store.p.lock, `${JSON.stringify({ schemaVersion: 1, pid: 9, host: "other", token: "someone-else", startTime: "x", heartbeatAt: new Date(h2.clock.now).toISOString() })}\n`); } });
  const made = h2.engine({ lock: h2.lock(1001, () => true, 5) }); // a fast heartbeat notices the swap while a check runs
  await assert.rejects(async () => { await made.engine.run(); }, (e) => errorField(e, "code") === "lock_lost");
  const s = h2.state();
  assert.notEqual(s.status, "succeeded");
  assert.notEqual(s.status, "failed", "a displaced supervisor records no outcome");
  assert.equal(readJson(h2.store.p.lock).token, "someone-else", "the new owner's lock is untouched");
});

await check("recovery escalates nudge, nudge, hard restart, then stops as recovery_exhausted; counters are bounded, persisted and survive a kill and resume", async () => {
  const stallScript = (log: { attempt: number; message: string }[]) => async (t: ScriptContext) => { log.push({ attempt: t.attempt, message: t.message }); t.tool("read", { path: "README.md" }); t.spend(0.01); };
  const log: { attempt: number; message: string }[] = [];
  const h = harness(simpleRaw({ recovery: { softNudges: 2, hardRestarts: 1, maxAttemptsPerStep: 20 } }), { script: stallScript(log) });
  const { state, rt } = await runOnce(h);
  assert.deepEqual([state.status, state.outcome?.reason], ["failed", "recovery_exhausted"]);
  assert.equal(state.recovery.softNudgesUsed, 2);
  assert.equal(state.recovery.hardRestartsUsed, 1);
  assert.deepEqual(state.recovery.totals, { softNudges: 2, hardRestarts: 1 });
  assert.equal(log.length, 4, "1 turn + 2 nudged turns + 1 turn after the hard restart, then stop");
  assert.equal(rt.calls.workers.length, 2, "one fresh session after the hard restart");
  assert.ok(log[1] && log[3], "the nudged turn and the turn after the restart ran");
  assert.match(log[1].message, /ended without changing the accepted code/, "the nudge tells the worker what the supervisor verified");
  assert.match(log[3].message, /it was restarted by the supervisor's recovery/);
  assert.match(log[3].message, /Verified state/);
  assert.deepEqual(state.history.map((x: RunHistoryEntry) => x.to).filter((x: string) => ["recovering", "failed"].includes(x)), ["recovering", "failed"]);
  assert.ok(state.usage.usd >= 0.04, "recovery never resets spend");
  assert.ok(state.usage.steps >= 4);
  assert.deepEqual(fakeAlive(h.fakeEngine), []);

  // The same ladder with a kill in the middle: the counters are read back from state.json, not from memory.
  let calls = 0; let killed = false;
  const h2 = harness(simpleRaw({ recovery: { softNudges: 2, hardRestarts: 1, maxAttemptsPerStep: 20 } }), { script: async () => { calls++; if (calls === 2 && !killed) { killed = true; throw kill(); } } });
  const first = h2.engine({ pid: 10 });
  await assert.rejects(first.engine.run(), (e) => errorField(e, "simulateKill") === true);
  const mid = h2.state();
  assert.equal(mid.recovery.softNudgesUsed, 1, "one nudge had been spent when the supervisor died");
  const usdBefore = mid.usage.usd; const stepsBefore = mid.step;
  const second = h2.engine({ rt: h2.runtime(async () => { calls++; }), pid: 11, lock: h2.lock(11, (pid) => pid !== 10) });
  await second.engine.run({ takeover: true });
  const end = h2.state();
  assert.deepEqual([end.status, end.outcome?.reason], ["failed", "recovery_exhausted"]);
  assert.deepEqual(end.recovery.totals, { softNudges: 2, hardRestarts: 1 }, "no counter was reset by the resume; totals are exactly the ladder");
  assert.ok(end.step > stepsBefore && end.usage.usd >= usdBefore);
  assert.ok(end.recovery.softNudgesUsed <= 2 && end.recovery.hardRestartsUsed <= 1, "bounded");

  // A dying worker skips the nudges (there is no session to nudge) and goes to hard restarts, also bounded.
  const h3 = harness(simpleRaw({ recovery: { softNudges: 3, hardRestarts: 2, maxAttemptsPerStep: 20 } }), { script: async (t) => { t.crash(); } });
  const crash = await runOnce(h3);
  assert.deepEqual([crash.state.status, crash.state.outcome?.reason], ["failed", "recovery_exhausted"]);
  assert.deepEqual(crash.state.recovery.totals, { softNudges: 0, hardRestarts: 2 });
  assert.equal(crash.rt.calls.workers.length, 3);

  // Activity without verified progress is not a stall, but attempts per target are capped (and never reset).
  const h4 = harness(simpleRaw({ recovery: { softNudges: 2, hardRestarts: 1, maxAttemptsPerStep: 3 } }), { script: async (t) => junk(t) });
  const capped = await runOnce(h4);
  assert.deepEqual([capped.state.status, capped.state.outcome?.reason], ["failed", "step_attempts_exhausted"]);
  assert.equal(capped.state.recovery.attemptsByTarget.acceptance, 3);
  assert.equal(capped.state.recovery.softNudgesUsed, 0, "a worker that keeps changing the code is busy, not stalled");
});

await check("independent review: required before success; a rejection goes back to the worker; repeated rejections end the run as review_rejected", async () => {
  let reviews = 0;
  const prompts: string[] = [];
  const h = harness(simpleRaw({ acceptance: { checks: [{ id: "unit", run: NODE_EXIT(`${ANSWER}.trim() === '42'`), timeoutMinutes: 1, required: true }], review: true } }), {
    script: async (t) => { prompts.push(t.message); if (prompts.length === 1) solve(t); else { t.write("README.md", "documented\n"); t.commit("document"); } },
    review: (bundle) => { reviews++; assert.match(bundle.spec ?? "", /Put 42/); assert.ok(bundle.results?.every((r) => r.pass)); return reviews === 1 ? { verdict: "REJECT", reason: "No README explains the change.", concerns: ["missing docs"] } : { verdict: "APPROVE", reason: "ok", concerns: [] }; },
  });
  const { state } = await runOnce(h);
  assert.equal(state.status, "succeeded");
  assert.equal(reviews, 2);
  assert.ok(prompts[1], "a second prompt carried the review");
  assert.match(prompts[1], /The independent review did not approve the change: No README explains/);
  assert.equal(state.acceptance.review.status, "approved");
  assert.equal(state.acceptance.review.attempts, 2);
  // Never approved: the checks passing is not enough.
  const h2 = harness(simpleRaw({ acceptance: { checks: [{ id: "unit", run: NODE_EXIT(`${ANSWER}.trim() === '42'`), timeoutMinutes: 1, required: true }], review: true }, recovery: { softNudges: 2, hardRestarts: 1, maxAttemptsPerStep: 2 } }), {
    script: async (t) => { if (t.turn === 1) solve(t); else { t.write(`note-${t.turn}.md`, "x"); t.commit("more"); } }, review: () => ({ verdict: "REJECT", reason: "does not meet the spec", concerns: [] }),
  });
  const bad = await runOnce(h2);
  assert.deepEqual([bad.state.status, bad.state.outcome?.reason], ["failed", "review_rejected"]);
  assert.equal(bad.state.acceptance.latest?.allRequiredPass, true, "the checks passed; the run still did not succeed");
  // A review that cannot be obtained is a rejection (fail closed).
  const h3 = harness(simpleRaw({ acceptance: { checks: [{ id: "unit", run: NODE_EXIT(`${ANSWER}.trim() === '42'`), timeoutMinutes: 1, required: true }], review: true }, recovery: { softNudges: 1, hardRestarts: 0, maxAttemptsPerStep: 1 } }), { script: async (t) => solve(t), review: () => { throw new Error("provider down"); } });
  const down = await runOnce(h3);
  assert.equal(down.state.status, "failed");
  assert.match(down.state.acceptance.review.reason ?? "", /review unavailable \(provider down\)/);
});

await check("deploy in the zone: services are refreshed from the accepted head and health-checked; nothing is promoted without a destination and approval", async () => {
  const svc = { name: "web", image: "nginxinc/nginx-unprivileged:1.27-alpine", port: 8080, workspaceMounts: [{ source: "dist", target: "/usr/share/nginx/html" }], tmpfs: ["/tmp"], health: { path: "/" } };
  const raw = { ...implementRaw({
    objective: { title: "Site", spec: "Build dist/index.html.", backlog: [{ id: "B1", title: "page built", acceptance: ["build"] }, { id: "B2", title: "page served", acceptance: ["web-up"] }] },
    acceptance: { checks: [{ id: "build", run: ["node", "-e", "process.exit(require('fs').existsSync('dist/index.html') ? 0 : 1)"], timeoutMinutes: 1, required: true }, { id: "web-up", type: "service-health", service: "web", path: "/", expectStatus: 200, required: true }], review: false },
    permissions: { network: { serviceImages: [svc.image], services: [svc] }, unattended: { authorised: true, autoApprove: true } },
  }), template: "deploy" };
  let turn = 0;
  const h = harness(raw, { script: async (t) => { turn++; if (turn === 1) { t.write("README.md", "about"); t.commit("start"); } else { t.write("dist/index.html", "<h1>Hello, zone</h1>"); t.commit("build the site"); } } });
  const { state, rt } = await runOnce(h);
  assert.equal(state.status, "succeeded", JSON.stringify(state.outcome));
  assert.ok(rt.calls.deploy.length >= 2, "the staging copy is refreshed before each evaluation");
  assert.deepEqual(state.acceptance.latest?.results.map((r: { id: string; pass: boolean }) => [r.id, r.pass]), [["build", true], ["web-up", true]]);
  assert.ok(state.history.length > 0 && state.step >= 2, "the first step failed both checks (nothing built or served) and the second fixed it");
  assert.equal(fs.readFileSync(path.join(h.store.p.deploy, "web", "0", "index.html"), "utf8"), "<h1>Hello, zone</h1>");
  assert.equal(state.promotion.status, "none", "in-zone deployment is not promotion");
});

await check("promotion: none by default; local-branch fast-forwards a branch in a LOCAL repository only, idempotently; an approval-gated destination waits for the operator", async () => {
  const src = scratch();
  const sh = (cwd: string, ...args: string[]) => { const r = spawnSyncGit(cwd, args); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  sh(src, "init", "--quiet", "-b", "main");
  fs.writeFileSync(path.join(src, "README.md"), "hello\n");
  sh(src, "add", "."); sh(src, "commit", "--quiet", "-m", "base");
  const baseSha = sh(src, "rev-parse", "HEAD");
  const promoRaw = (approval: boolean) => simpleRaw({ inputs: { repository: { path: src, ref: "main" } }, promotion: { policy: "local-branch", destinations: [{ kind: "local-branch", branch: "pi/todo-api-1" }], requiresOperatorApproval: approval } });
  const h = harness(promoRaw(false), { script: async (t) => solve(t) });
  const { state, rt } = await runOnce(h);
  assert.equal(state.status, "succeeded");
  assert.equal(state.promotion.status, "done");
  assert.equal(sh(src, "rev-parse", "refs/heads/pi/todo-api-1"), rt.repo.head(), "the result is a local branch in the operator's repository");
  assert.equal(sh(src, "rev-parse", "refs/heads/main"), baseSha, "main is untouched");
  assert.equal(sh(src, "for-each-ref", "refs/remotes"), "", "no remote is contacted or created");
  assert.equal(Object.keys(state.promotion.done).length, 1);
  // Idempotent: promoting again does nothing new.
  const engine = new Engine({ contract: h.contract, cfg: h.cfg, store: h.store, rt: h.runtime(), template: TEMPLATES.implement, effortApi: testEffort });
  engine.state = h.state();
  const again = await engine.promote({ sha: rt.repo.head(), approved: false });
  assert.equal(again.status, "done");
  assert.equal(Object.keys(h.state().promotion.done).length, 1);
  // Needs approval: waits, and only an explicit approved promote acts.
  const src2 = scratch();
  sh(src2, "init", "--quiet", "-b", "main"); fs.writeFileSync(path.join(src2, "README.md"), "hello\n"); sh(src2, "add", "."); sh(src2, "commit", "--quiet", "-m", "base");
  const h2 = harness(simpleRaw({ inputs: { repository: { path: src2, ref: "main" } }, promotion: { policy: "local-branch", destinations: [{ kind: "local-branch", branch: "pi/x" }], requiresOperatorApproval: true } }), { script: async (t) => solve(t) });
  const waiting = await runOnce(h2);
  assert.equal(waiting.state.status, "succeeded");
  assert.equal(waiting.state.promotion.status, "awaiting_approval");
  assert.equal(spawnSyncGit(src2, ["rev-parse", "--verify", "--quiet", "refs/heads/pi/x"]).status, 1, "nothing was written before approval");
  const e2 = new Engine({ contract: h2.contract, cfg: h2.cfg, store: h2.store, rt: h2.runtime(), template: TEMPLATES.implement, effortApi: testEffort }) as EngineWithRt;
  e2.state = h2.state(); e2.rt.repo.open();
  assert.equal((await e2.promote({ sha: waiting.rt.repo.head(), approved: true })).status, "done");
  assert.equal(sh(src2, "rev-parse", "refs/heads/pi/x"), waiting.rt.repo.head());
});

function spawnSyncGit(cwd: string, args: string[]) { return spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }); }

cleanup();
done();
