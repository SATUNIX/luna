#!/usr/bin/env node
// Plans as data: `workflow_run {steps:[...]}` compiled through the workflow parser (sub/plan.ts,
// docs/workflows.md).
//   1. The tool: name is optional, steps exists, exactly one of name, steps or resume, and its text
//      is at most 1,150 characters.
//   2. The four brief examples (single, parallel plus synthesis, review plus revise, bounded recovery).
//   3. Malformed plans: each returns {path, problem, fix} under 300 characters and launches nothing.
//   4. Authority: the fields that would widen, tool narrowing, and the worst case refused before a launch.
//   5. The gate's retry target sees the reviewer's FAIL on loop 2; skills reach one step's child only.
//   6. workflow_control stop and the tool signal abort an inline plan's agent.
//   7. Resume comes from plan.json; a changed plan.json is gated; a saved workflow of the same name is ignored.
//   8. A live duplicate (plan, YAML, script) is refused, naming the live run.
//   9. expand: a step answers with more steps; the host validates, charges, prefixes, splices and persists.
//  10. outputs are run-directory paths: prose is refused at compile and a miss names the directory.
//  11. A parallel member that finished is on disk before the run ends, so a resume does not re-run it.
//  12. With the allowance spent the refusal says nothing fits, and names a size only when one fits.
//  13. A gate refusal's fix names a real step id; the tool text says who fills {previous}.
//  14. A plan's resume trust refusal says "plan"; the reference generator documents the tool from its source.
//  15. Executable text survives persistence, and run files a child can replace are read with limits.
//  16. A regex gate runs off the host's loop and reads the tail of an answer; a dead worker is reported.
//  17. Resume, group and expansion edges: passes at the cursor, stale passes, omissions, order, writers.
// Offline: children are fakes (tests/workflow-fakes.ts) behind the real effort and delegation-guard extensions.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import workerThreads from "node:worker_threads";
import { ROOT, fakePi, isolateKitEnv, loadModule, rmWorkspace, setEnv, textOf, tmpWorkspace, type FakePiApi } from "../packages/core/eval/harness.ts";
import { installDelegation } from "../packages/core/eval/delegation.ts";
import type * as AgentsModule from "../packages/extensions/third_party/subagent/agents.ts";
import type * as EngineModule from "../packages/extensions/third_party/subagent/wf-engine.ts";
import type * as PanelModule from "../packages/extensions/third_party/subagent/wf-panel.ts";
import type * as PlanModule from "../packages/extensions/third_party/subagent/plan.ts";
import type * as RunModelModule from "../packages/extensions/third_party/subagent/run-model.ts";
import type * as SandboxModule from "../packages/extensions/third_party/subagent/wf-sandbox.ts";
import type * as WorkflowModule from "../packages/extensions/third_party/subagent/workflow.ts";
import { fakeSpawner, type FakeReply, type FakeSpawn, type Spawned } from "./workflow-fakes.ts";

interface ToolsView {
  registerWorkflowTools(api: FakePiApi, deps?: { spawnChild?: FakeSpawn }): void;
  openScriptWorkflow(ctx: { cwd: string }, name: string): Promise<{ error?: string | undefined }>;
}
interface ScriptToolView {
  registerScriptWorkflowTool(api: FakePiApi, deps?: { sandbox?: SandboxModule.SandboxSession; engine?: Partial<Omit<EngineModule.EngineOptions, "spawnChild">> & { spawnChild?: FakeSpawn } }): void;
}

const restoreKit = isolateKitEnv();
const ws = tmpWorkspace("pi-kit-wf-plan-");
const agentDir = path.join(ws, "home", ".pi", "agent");
const project = path.join(ws, "project");
fs.mkdirSync(project, { recursive: true });
const restores = [
  setEnv("HOME", path.join(ws, "home")),
  setEnv("PI_CODING_AGENT_DIR", agentDir),
  setEnv("PI_KIT_SUBAGENT_RETRIES", "0"),
  setEnv("PI_KIT_SUBAGENT_STATE_DIR", path.join(ws, "state")),
  setEnv("PI_KIT_WORKFLOWS_DIR", path.join(ROOT, "packages", "kit", "workflows")),
  setEnv("PI_KIT_EFFORT_CONFIG", path.join(ws, "no-effort-config.json")),
];
const delegation = await installDelegation({ tier: "standard" });

let checks = 0;
const failures: string[] = [];
const check = async (label: string, body: () => Promise<void> | void): Promise<void> => {
  try {
    await body();
    checks++;
    console.log(`  OK: ${label}`);
  } catch (error) {
    failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    console.log(`  FAIL: ${label}`);
  }
};

type Reply = (s: Spawned) => FakeReply;
let fake = fakeSpawner(() => ({ text: "done" }));
const useFake = (reply: Reply): typeof fake => (fake = fakeSpawner(reply));
// A live pid: the ledger reaps a slot whose process is gone, and a fake's pid is nobody's.
const spawnChild: FakeSpawn = (command, args, options) => Object.assign(fake.spawn(command, args, options), { pid: process.pid });

const tools = await loadModule<ToolsView>("vendor/subagent/workflow-tools.ts");
const pi = fakePi();
tools.registerWorkflowTools(pi.api, { spawnChild });
const tool = pi.tools.get("workflow_run");

// The named regression: on the base this schema requires `name` and has no `steps`, so a plan is refused.
const schema: unknown = JSON.parse(JSON.stringify(tool.parameters));
const required: unknown = Reflect.get(Object(schema), "required");
const props: unknown = Reflect.get(Object(schema), "properties");
const names = typeof props === "object" && props !== null ? Object.keys(props) : [];
assert.ok(names.includes("steps") && !(Array.isArray(required) && required.includes("name")), `workflow_run {steps:[...]} is refused by the schema: required ${JSON.stringify(required)}, properties ${JSON.stringify(names)}`);

const plan = await loadModule<typeof PlanModule>("vendor/subagent/plan.ts");
const workflowMod = await loadModule<typeof WorkflowModule>("vendor/subagent/workflow.ts");
const agentsMod = await loadModule<typeof AgentsModule>("vendor/subagent/agents.ts");
const effortMod = await loadModule<{ default: (api: ReturnType<typeof fakePi>["api"]) => void }>("extensions/effort/index.ts");

const roles = agentsMod.discoverAgents(project, "user").agents;
const ctx = { cwd: project, hasUI: false };
const call = (params: Record<string, unknown>, signal?: AbortSignal) => tool.execute("t", params, signal, undefined, ctx);
const control = (runId: string, action: string) => pi.tools.get("workflow_control").execute("c", { runId, action }, undefined, undefined, ctx);

let boots = 0;
/** A fresh session at a tier, so each case has its own allowance. */
async function session(tier = "standard"): Promise<() => Promise<unknown>> {
  const restoreTier = setEnv("PI_KIT_EFFORT", tier);
  const key = `plan-${String(++boots)}`;
  const effortPi = fakePi();
  effortMod.default(effortPi.api);
  const ectx = { hasUI: false, cwd: project, ui: {}, sessionManager: { getSessionId: () => key } };
  await effortPi.handlers.get("session_start")({ reason: "startup" }, ectx);
  restoreTier();
  const userTurn = async (): Promise<unknown> => effortPi.handlers.get("before_agent_start")({ systemPrompt: "", messageType: "user", prompt: "go" }, ectx);
  await userTurn();
  return userTurn;
}
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
async function until(what: string, test: () => boolean): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (test()) return;
    await wait(10);
  }
  throw new Error(`timed out waiting for: ${what}`);
}
const statusIn = (text: string): string => /· run \S+ · (\w+)/.exec(text)?.[1] ?? `no status in: ${text}`;
const runIdIn = (text: string): string => /· run (\S+) ·/.exec(text)?.[1] ?? "";
const liveRun = (): string => workflowMod.listRuns(project, 50).find((r) => r.status === "running")?.id ?? "";
const argOf = (s: Spawned, flag: string): string | undefined => s.args[s.args.indexOf(flag) + 1];

await check("workflow_run takes name, steps or resume; its text is at most 1,150 characters", async () => {
  const text = `${tool.description}${tool.promptSnippet ?? ""}${JSON.stringify(tool.parameters)}`;
  assert.ok(text.length <= 1150, `${String(text.length)} characters`);
  await session();
  useFake(() => ({ text: "done" }));
  const steps = [{ task: "go" }];
  for (const bad of [{}, { name: "bugfix", steps }, { steps, resume: "x" }, { name: "bugfix", resume: "x" }, { inputs: { a: "b" } }]) {
    const r = await call(bad);
    assert.equal(r.isError, true, JSON.stringify(bad));
    assert.match(textOf(r), /exactly one of name, steps or resume/);
  }
  assert.equal(fake.seen.length, 0);
  assert.match(textOf(await call({ name: "list" })), /bugfix/, "name list still lists");
});

await check("example: a single agent, defaulting to implementer at E1 on the run's ledger", async () => {
  await session();
  useFake(() => ({ text: "fixed" }));
  const r = await call({ steps: [{ task: "fix the typo in README" }] });
  assert.equal(statusIn(textOf(r)), "passed", textOf(r));
  assert.equal(fake.seen.length, 1);
  assert.match(fake.seen[0]?.task ?? "", /fix the typo in README/);
  assert.equal(fake.seen[0]?.env.PI_KIT_EFFORT, "minimal");
  assert.match(fake.seen[0]?.system ?? "", /You are an implementer/);
});

await check("example: parallel investigation, then a synthesis over {previous}", async () => {
  await session();
  useFake((s) => ({ text: s.task.includes("Combine") ? "summary" : `found in ${s.task}` }));
  const r = await call({ steps: [{ id: "look", parallel: [{ id: "web", agent: "scout", task: "web" }, { id: "db", agent: "scout", task: "db" }] }, { id: "sum", agent: "planner", task: "Combine: {previous}" }] });
  assert.equal(statusIn(textOf(r)), "passed", textOf(r));
  assert.equal(fake.seen.length, 3);
  const synth = fake.seen.find((s) => s.task.includes("Combine"));
  assert.match(synth?.task ?? "", /found in web/);
  assert.match(synth?.task ?? "", /found in db/);
});

await check("example: review plus revise; the retry target's task holds the reviewer's FAIL on loop 2", async () => {
  await session();
  let reviews = 0;
  useFake((s) => {
    if (!s.task.includes("Review")) return { text: "built" };
    reviews++;
    return { text: reviews === 1 ? "VERDICT: FAIL the null check is missing" : "VERDICT: PASS" };
  });
  const r = await call({ steps: [{ id: "build", task: "Build it." }, { id: "check", agent: "reviewer", task: "Review: {previous}", gate: { pass: "VERDICT: PASS", retry: "build", max_loops: 2 } }] });
  assert.equal(statusIn(textOf(r)), "passed", textOf(r));
  const builds = fake.seen.filter((s) => s.task.includes("Build it."));
  assert.equal(builds.length, 2);
  assert.doesNotMatch(builds[0]?.task ?? "", /VERDICT/, "nothing to report on the first pass");
  assert.match(builds[1]?.task ?? "", /VERDICT: FAIL the null check is missing/);
});

await check("example: bounded recovery; a failed attempt runs the recovery and the run names the omission", async () => {
  const steps = [{ id: "try", agent: "scout", task: "first attempt", continue_on_error: true }, { id: "recover", agent: "scout", task: "recover: {{steps.try.status}}", when: { step: "try", status: "failed" } }];
  await session();
  useFake((s) => (s.task.includes("first attempt") ? { fail: "no route" } : { text: "recovered" }));
  const r = await call({ steps });
  assert.equal(statusIn(textOf(r)), "partial", textOf(r));
  assert.match(fake.seen[1]?.task ?? "", /recover: failed/);
  await session();
  useFake(() => ({ text: "fine" }));
  const clean = await call({ steps });
  assert.equal(statusIn(textOf(clean)), "passed", textOf(clean));
  assert.equal(fake.seen.length, 1, "no recovery after a passing attempt");
});

const leaf = (extra: Record<string, unknown>): Record<string, unknown> => ({ task: "t", ...extra });
const malformed: Array<[string, unknown, RegExp]> = [
  ["not a list", "do it", /^steps$/],
  ["no steps", [], /^steps$/],
  ["a step that is not a mapping", ["do it"], /^steps\[0\]$/],
  ["a missing task", [{ agent: "scout" }], /^steps\[0\]\.task$/],
  ["a task that is not text", [{ task: 5 }], /^steps\[0\]\.task$/],
  ["an unknown role", [leaf({ agent: "wizard" })], /^steps\[0\]\.agent$/],
  ["an unknown field", [leaf({ retries: 3 })], /^steps\[0\]\.retries$/],
  ["a bad id", [leaf({ id: "Bad Id" })], /^steps\[0\]/],
  ["a repeated id", [leaf({ id: "a" }), leaf({ id: "a" })], /^steps/],
  ["tools as text", [leaf({ tools: "read" })], /^steps\[0\]\.tools$/],
  ["an output outside the run directory", [leaf({ outputs: ["../x"] })], /^steps\[0\]/],
  ["outputs of the wrong type", [leaf({ outputs: [1] })], /^steps\[0\]\.outputs$/],
  ["continue_on_error as text", [leaf({ continue_on_error: "yes" })], /^steps\[0\]\.continue_on_error$/],
  ["when with no status", [leaf({ id: "a" }), leaf({ when: { step: "a" } })], /^steps\[1\]\.when/],
  ["when with an unknown status", [leaf({ id: "a" }), leaf({ when: { step: "a", status: "done" } })], /^steps\[1\]\.when\.status$/],
  ["when naming a later step", [leaf({ when: { step: "b", status: "passed" } }), leaf({ id: "b" })], /^steps\[0\]\.when\.step$/],
  ["when on a parallel group", [leaf({ id: "a" }), { when: { step: "a", status: "passed" }, parallel: [leaf({})] }], /^steps\[1\]\.when$/],
  ["a gate with no pass", [leaf({ gate: { retry: "x" } })], /^steps\[0\]\.gate\.pass$/],
  ["a gate with no retry", [leaf({ gate: { pass: "ok" } })], /^steps\[0\]\.gate\.retry$/],
  ["a gate retrying a later step", [leaf({ gate: { pass: "ok", retry: "b" } }), leaf({ id: "b" })], /^steps\[0\]\.gate\.retry$/],
  ["a gate retrying a parallel member", [{ id: "g", parallel: [leaf({ id: "m" })] }, leaf({ gate: { pass: "ok", retry: "m" } })], /^steps\[1\]\.gate\.retry$/],
  ["a gate on a parallel member", [{ parallel: [leaf({ gate: { pass: "ok", retry: "x" } })] }], /^steps\[0\]\.parallel\[0\]\.gate$/],
  ["max_loops out of range", [leaf({ id: "a", gate: { pass: "ok", retry: "a", max_loops: 99 } })], /^steps\[0\]\.gate\.max_loops$/],
  ["an unsafe gate pattern", [leaf({ id: "a", gate: { pass: "/(a+)+$/", retry: "a" } })], /^steps\[0\]\.gate\.pass$/],
  ["an empty parallel group", [{ parallel: [] }], /^steps\[0\]\.parallel$/],
  ["parallel with a task", [{ task: "t", parallel: [leaf({})] }], /^steps\[0\]\.task$/],
  ["{previous} on the first step", [{ task: "use {previous}" }], /^steps\[0\]\.task$/],
  ["a template expression that does not exist", [{ task: "{{nonsense}}" }], /^steps\[0\]\.task$/],
  ["an input nobody gave", [{ task: "{{inputs.goal}}" }], /^steps\[0\]\.task$/],
  ["a later step's output, required", [{ task: "{{steps.b.output}}" }, leaf({ id: "b" })], /^steps\[0\]\.task$/],
  ["a skill name that is a path", [leaf({ skills: ["../../x"] })], /^steps\[0\]\.skills$/],
  ["a run longer than the execution limit", Array.from({ length: 70 }, () => leaf({})), /^steps$/],
];
const widening: Array<[string, unknown, RegExp]> = [
  ["tools past the role's list", [leaf({ agent: "reviewer", tools: ["read", "write"] })], /^steps\[0\]\.tools$/],
  ["model", [leaf({ model: "big" })], /^steps\[0\]\.model$/],
  ["thinking", [leaf({ thinking: "high" })], /^steps\[0\]\.thinking$/],
  ["extensions", [leaf({ extensions: ["subagent"] })], /^steps\[0\]\.extensions$/],
  ["max_runtime", [leaf({ max_runtime: "2h" })], /^steps\[0\]\.max_runtime$/],
  ["skill", [leaf({ skill: "x" })], /^steps\[0\]\.skill$/],
  ["maxRuntime", [leaf({ maxRuntime: "2h" })], /^steps\[0\]\.maxRuntime$/],
  ["a nested parallel", [{ parallel: [{ parallel: [leaf({})] }] }], /^steps\[0\]\.parallel\[0\]\.parallel$/],
  ["an unknown {{steps.x}}", [{ task: "{{steps.x.output}}" }], /^steps\[0\]\.task$/],
  ["an unknown optional {{steps.x}}", [{ task: "{{steps.x.output?}}" }], /^steps\[0\]\.task$/],
  ["tools: []", [leaf({ tools: [] })], /^steps\[0\]\.tools$/],
  ["tools naming subagent", [leaf({ tools: ["read", "subagent"] })], /^steps\[0\]\.tools$/],
  ["tools naming workflow", [leaf({ tools: ["workflow"] })], /^steps\[0\]\.tools$/],
  ["tools naming workflow_run", [leaf({ tools: ["workflow_run"] })], /^steps\[0\]\.tools$/],
  ["tools naming a spawn tool in capitals", [leaf({ tools: ["SubAgent"] })], /^steps\[0\]\.tools$/],
  ["tools with a pattern", [leaf({ tools: ["*"] })], /^steps\[0\]\.tools$/],
  ["expand that is not true or false", [leaf({ expand: "yes" })], /^steps\[0\]\.expand$/],
];

await check(`${String(malformed.length)} malformed plans each return {path, problem, fix} under 300 characters with 0 launches`, async () => {
  assert.ok(malformed.length >= 20);
  await session();
  useFake(() => ({ text: "must not run" }));
  for (const [label, steps, at] of malformed) {
    const c = plan.compilePlan(steps, roles);
    assert.equal(c.ok, false, label);
    if (c.ok) continue;
    for (const e of c.errors) {
      assert.ok(e.path && e.problem && e.fix, `${label}: ${JSON.stringify(e)}`);
      assert.ok(JSON.stringify(e).length < 300, `${label}: ${String(JSON.stringify(e).length)}`);
    }
    assert.match(c.errors[0]?.path ?? "", at, `${label}: ${JSON.stringify(c.errors)}`);
    const r = await call({ steps });
    assert.equal(r.isError, true, label);
    assert.ok(textOf(r).length <= 300, `${label}: ${textOf(r)}`);
    assert.ok(textOf(r).includes(c.errors[0]?.path ?? ""), label);
    assert.match(textOf(r), /Fix: /, label);
  }
  assert.equal(fake.seen.length, 0);
  assert.equal(workflowMod.listRuns(project, 1000).filter((s) => s.workflow === "plan" && s.steps.t).length, 0);
});

await check("what would widen is refused: tools past the role, model, thinking, extensions, max_runtime, skill, nesting, unknown references, empty and spawn tools", async () => {
  await session();
  useFake(() => ({ text: "must not run" }));
  for (const [label, steps, at] of widening) {
    const c = plan.compilePlan(steps, roles);
    assert.equal(c.ok, false, label);
    if (!c.ok) assert.match(c.errors[0]?.path ?? "", at, `${label}: ${JSON.stringify(c.errors)}`);
    assert.equal((await call({ steps })).isError, true, label);
  }
  assert.equal(fake.seen.length, 0);
});

await check("outputs are paths in the run directory: prose is refused at compile, and a miss names the directory checked", async () => {
  assert.match(plan.PLAN_DESCRIPTION, /outputs/, "the tool says what outputs are");
  assert.match(plan.PLAN_DESCRIPTION, /relative to the run directory/);
  const prose = plan.compilePlan([leaf({ outputs: ["the report"] })], roles);
  assert.equal(prose.ok, false, "prose is not a path");
  if (!prose.ok) {
    assert.match(prose.errors[0]?.path ?? "", /^steps\[0\]\.outputs$/, JSON.stringify(prose.errors));
    assert.ok(prose.errors[0]?.fix, JSON.stringify(prose.errors));
  }
  await session();
  useFake(() => ({ text: "must not run" }));
  assert.equal((await call({ steps: [leaf({ outputs: ["the report"] })] })).isError, true);
  assert.equal(fake.seen.length, 0);
  // A saved workflow accepts what it always did; only the failure message is clearer.
  assert.deepEqual(workflowMod.parseWorkflow("---\nname: saved\nsteps:\n  - { id: one, agent: scout, task: t, outputs: the report }\n---\n", "saved.md", "user").errors, []);
  useFake(() => ({ text: "no file written" }));
  const missing = await call({ steps: [leaf({ outputs: ["report.md"] })] });
  assert.equal(statusIn(textOf(missing)), "failed", textOf(missing));
  const runId = runIdIn(textOf(missing));
  const dir = path.join(workflowMod.runsRoot(project), runId);
  const saved: unknown = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
  const stepState: unknown = Reflect.get(Object(Reflect.get(Object(saved), "steps")), "step-1");
  assert.equal(Reflect.get(Object(stepState), "error"), `declared output(s) not written in ${dir}: report.md`);
  assert.match(textOf(missing), /declared output\(s\) not written/);
});

await check("a gate refusal's fix shows a real step id, and the tool text says who fills {previous}", () => {
  const retry = plan.compilePlan([{ id: "draft", task: "write" }, { task: "review", gate: { pass: "PASS", retry: "nope" } }], roles);
  assert.equal(retry.ok, false);
  if (!retry.ok) {
    assert.match(retry.errors[0]?.path ?? "", /^steps\[1\]\.gate\.retry$/, JSON.stringify(retry.errors));
    assert.match(retry.errors[0]?.fix ?? "", /draft/, `the fix names a step the plan has: ${JSON.stringify(retry.errors)}`);
  }
  const shape = plan.compilePlan([{ id: "draft", task: "write" }, { task: "review", gate: "check" }], roles);
  assert.equal(shape.ok, false);
  if (!shape.ok) assert.match(shape.errors[0]?.fix ?? "", /draft/, `the fix names a step the plan has: ${JSON.stringify(shape.errors)}`);
  const overExpand = plan.compilePlan([{ id: "plan", task: "t", expand: true }, { id: "x", task: "y" }, { task: "r", gate: { pass: "P", retry: "nope" } }], roles);
  assert.equal(overExpand.ok, false);
  if (!overExpand.ok) assert.match(overExpand.errors[0]?.fix ?? "", /"retry": "x"/, `the fix never names a step past an expand: ${JSON.stringify(overExpand.errors)}`);
  assert.match(plan.PLAN_DESCRIPTION, /host adds the review to the retry step/, "a model need not add it to the retry step");
  assert.match(plan.PLAN_DESCRIPTION, /continue_on_error/, "a recovery plan needs it, and nothing else teaches it");
});

await check("tools may narrow a role, and the child gets exactly that list", async () => {
  const c = plan.compilePlan([{ agent: "reviewer", task: "t", tools: ["read", "grep"] }], roles);
  assert.ok(c.ok, JSON.stringify(c));
  assert.equal(c.worstCaseAgents, 1);
  await session();
  useFake(() => ({ text: "ok" }));
  await call({ steps: [{ agent: "reviewer", task: "t", tools: ["read", "grep"] }] });
  assert.equal(argOf(fake.seen[0] as Spawned, "--tools"), "read,grep");
});

await check("the worst case is charged before any launch: over the allowance is refused with no run directory, a second plan too, and a user turn renews it", async () => {
  const userTurn = await session();
  useFake(() => ({ text: "VERDICT: PASS" }));
  const big = Array.from({ length: 9 }, (_, i) => ({ id: `s${String(i)}`, agent: "scout", task: "t" }));
  const dirs = (): string[] => fs.readdirSync(workflowMod.runsRoot(project)).sort();
  const before = dirs();
  const over = await call({ steps: big });
  assert.equal(over.isError, true);
  assert.match(textOf(over), /\/effort/);
  assert.equal(fake.seen.length, 0);
  assert.deepEqual(dirs(), before, "a refused plan leaves no run directory, listed or not");
  // Gated: 2 steps + 2 for each of 2 loops is 6 of 8.
  const gated = [{ id: "a", task: "go" }, { id: "b", agent: "scout", task: "t", gate: { pass: "VERDICT: PASS", retry: "a" } }];
  assert.equal(statusIn(textOf(await call({ steps: gated }))), "passed");
  const second = await call({ steps: [{ agent: "scout", task: "again" }, { agent: "scout", task: "more" }, { agent: "scout", task: "still" }] });
  assert.equal(second.isError, true, "6 of 8 are planned, so 3 more are refused");
  await userTurn();
  assert.equal(statusIn(textOf(await call({ steps: [{ agent: "scout", task: "again" }] }))), "passed");
});

await check("with the allowance spent the refusal says no workflow of any size fits and that it renews; a size is named only when one would fit", async () => {
  const userTurn = await session();
  useFake(() => ({ text: "ok" }));
  const sized = (n: number): unknown[] => Array.from({ length: n }, (_, i) => ({ id: `s${String(i + 1)}`, agent: "scout", task: "t" }));
  // 8 planned agents a request at E3: 6, then 2 exactly fills it.
  const six = await call({ steps: sized(6) });
  assert.equal(statusIn(textOf(six)), "passed", textOf(six));
  const three = await call({ steps: sized(3) });
  assert.equal(three.isError, true);
  assert.match(textOf(three), /up to 2/, `the size that still fits: ${textOf(three)}`);
  assert.doesNotMatch(textOf(three), /no workflow of any size/);
  assert.match(textOf(three), /\/effort/);
  const two = await call({ steps: sized(2) });
  assert.equal(statusIn(textOf(two)), "passed", textOf(two));
  const one = await call({ steps: sized(1) });
  assert.equal(one.isError, true);
  assert.match(textOf(one), /no workflow of any size fits/);
  assert.match(textOf(one), /next user message/, "it says when the allowance comes back");
  assert.doesNotMatch(textOf(one), /smaller workflow|Run less/, `no advice that cannot be followed: ${textOf(one)}`);
  assert.equal(fake.seen.length, 8, "nothing was launched for the refusals");
  await userTurn();
  assert.equal(statusIn(textOf(await call({ steps: sized(1) }))), "passed", "a user turn renews it");
});

await check("skills on one step reach that child only; an unknown skill is refused", async () => {
  await session();
  useFake(() => ({ text: "ok" }));
  const r = await call({ steps: [{ agent: "scout", task: "one", skills: ["workflow-authoring"] }, { agent: "scout", task: "two" }] });
  assert.equal(statusIn(textOf(r)), "passed", textOf(r));
  assert.match(fake.seen[0]?.system ?? "", /<skill name="workflow-authoring"/);
  assert.doesNotMatch(fake.seen[1]?.system ?? "", /<skill name=/);
  const missing = await call({ steps: [{ agent: "scout", task: "one", skills: ["no-such-skill"] }] });
  assert.equal(missing.isError, true);
  assert.match(textOf(missing), /steps\[0\]\.skills/);
  assert.equal(fake.seen.length, 2);
});

/** Start a plan whose agent hangs, and wait until the agent is running. */
async function hanging(steps: unknown[], signal?: AbortSignal) {
  await session();
  useFake((s) => (s.task.includes("hang") ? { delayMs: 60_000 } : { text: "ok" }));
  const done = call({ steps }, signal);
  await until("the agent to start", () => fake.seen.some((s) => s.task.includes("hang")));
  return { done, runId: liveRun() };
}

await check("workflow_control stop aborts an inline plan's running agent; nothing further launches", async () => {
  const { done, runId } = await hanging([{ agent: "scout", task: "hang here" }, { agent: "scout", task: "after" }]);
  assert.ok(runId);
  assert.match(textOf(await control(runId, "stop")), /Stop/i);
  const r = await done;
  assert.equal(statusIn(textOf(r)), "interrupted", textOf(r));
  assert.match(textOf(r), /Resume with workflow_run \{resume:/);
  assert.equal(fake.seen.length, 1);
});

await check("the tool signal aborts an inline plan's running agent", async () => {
  const abort = new AbortController();
  const { done } = await hanging([{ agent: "scout", task: "hang here" }, { agent: "scout", task: "after" }], abort.signal);
  abort.abort();
  const r = await done;
  assert.equal(statusIn(textOf(r)), "interrupted", textOf(r));
  assert.equal(fake.seen.length, 1);
});

await check("a parallel member that settled is on disk before the next one does, so a resume does not re-run it", async () => {
  await session();
  useFake((s) => (s.task === "hang here" ? { delayMs: 60_000 } : { text: "quick", delayMs: 5 }));
  const steps = [{ parallel: [{ id: "a", agent: "scout", task: "quick" }, { id: "b", agent: "scout", tools: ["read"], task: "hang here" }, { id: "c", agent: "scout", task: "also quick" }] }];
  const done = call({ steps });
  await until("the members to start", () => fake.seen.length === 3);
  const runId = liveRun();
  const statePath = path.join(workflowMod.runsRoot(project), runId, "state.json");
  const stepField = (id: string, field: string): unknown => {
    const saved: unknown = JSON.parse(fs.readFileSync(statePath, "utf8"));
    const value: unknown = Reflect.get(Object(Reflect.get(Object(saved), "steps")), id);
    return Reflect.get(Object(value), field);
  };
  await until("both quick members to say passed on disk", () => stepField("a", "status") === "passed" && stepField("c", "status") === "passed");
  for (const id of ["a", "c"]) {
    const runIds: unknown = stepField(id, "runIds");
    assert.ok(Array.isArray(runIds) && runIds.length > 0, `${id} kept its child's run id: ${JSON.stringify(runIds)}`);
  }
  assert.equal(stepField("b", "status"), "running", "the hung member is still running");
  await control(runId, "stop");
  assert.equal(statusIn(textOf(await done)), "interrupted");
  useFake(() => ({ text: "resumed" }));
  const r = await call({ resume: runId });
  assert.equal(statusIn(textOf(r)), "passed", textOf(r));
  assert.deepEqual(fake.seen.map((s) => s.task), ["hang here"], "only the member that had not passed ran again");
});

await check("a plan run resumes from plan.json: passed steps are not rerun, and only what is left is charged", async () => {
  fs.mkdirSync(path.join(agentDir, "workflows"), { recursive: true });
  fs.writeFileSync(path.join(agentDir, "workflows", "plan.md"), "---\nname: plan\ndescription: a saved workflow that shares the name\nsteps:\n  - { id: saved, agent: scout, task: the saved one }\n---\n");
  try {
    const read = ["read", "grep"];
    const { done, runId } = await hanging([{ id: "one", agent: "scout", task: "first" }, { agent: "scout", task: "second" }, { agent: "scout", task: "third" }, { id: "four", agent: "scout", tools: read, task: "hang here" }, { id: "five", agent: "scout", task: "then {previous}" }]);
    await control(runId, "stop");
    await done;
    const file = path.join(workflowMod.runsRoot(project), runId, "plan.json");
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    // The same request: 5 of 8 are planned, so a resume fits only if it is charged the 2 left.
    useFake(() => ({ text: "resumed" }));
    const r = await call({ resume: runId });
    assert.equal(statusIn(textOf(r)), "passed", textOf(r));
    assert.deepEqual(fake.seen.map((s) => s.task.split("\n")[0]), ["hang here", "then resumed"], "from the interrupted step, and not the saved workflow of the same name");
    const again = await call({ resume: runId });
    assert.match(textOf(again), /already passed/);
  } finally {
    fs.rmSync(path.join(agentDir, "workflows", "plan.md"));
  }
});

await check("a resume whose plan.json changed is gated as strictly as a project workflow, and the refusal says plan; a missing or broken one is refused", async () => {
  const { done, runId } = await hanging([{ id: "only", agent: "scout", task: "hang here" }]);
  await control(runId, "stop");
  await done;
  const file = path.join(workflowMod.runsRoot(project), runId, "plan.json");
  const original = fs.readFileSync(file, "utf8");
  useFake(() => ({ text: "must not run" }));
  await session();
  fs.writeFileSync(file, original.replace("hang here", "something else"));
  const changed = await call({ resume: runId });
  assert.equal(changed.isError, true);
  assert.match(textOf(changed), /interactive approval or a digest grant/);
  assert.match(textOf(changed), /plan/, textOf(changed));
  assert.doesNotMatch(textOf(changed), /project workflow/, `an inline plan is not a project workflow: ${textOf(changed)}`);
  fs.writeFileSync(file, "{ not json");
  assert.match(textOf(await call({ resume: runId })), /plan\.json/);
  fs.rmSync(file);
  assert.match(textOf(await call({ resume: runId })), /plan\.json/);
  assert.equal(fake.seen.length, 0);
});

await check("a live duplicate plan is refused, naming the live run; other work runs, and the same plan runs once it ends", async () => {
  const steps = [{ agent: "scout", task: "hang here" }];
  const { done, runId } = await hanging(steps);
  const dup = await call({ steps });
  assert.equal(dup.isError, true);
  assert.ok(textOf(dup).includes(runId), textOf(dup));
  assert.match(textOf(dup), /workflow_control/);
  assert.doesNotMatch(textOf(dup), /workflow_status/, "it cannot see a script run, and this text is shared");
  assert.match(textOf(dup), /workflow_control/);
  assert.equal(fake.seen.length, 1, "no launch for the duplicate");
  const different = await call({ steps: [{ agent: "scout", task: "other work" }] });
  assert.equal(statusIn(textOf(different)), "passed", textOf(different));
  await control(runId, "stop");
  await done;
  await session();
  useFake(() => ({ text: "ok" }));
  assert.equal(statusIn(textOf(await call({ steps }))), "passed");
});

await check("a live duplicate YAML run is refused, naming the live run; other inputs run", async () => {
  await session("thorough");
  useFake((s) => (s.task.includes("first goal") ? { delayMs: 60_000 } : { text: "VERDICT: PASS" }));
  const inputs = { question: "first goal" };
  const done = call({ name: "research", inputs });
  await until("the agent to start", () => fake.seen.length > 0);
  const runId = liveRun();
  const dup = await call({ name: "research", inputs });
  assert.equal(dup.isError, true);
  assert.ok(textOf(dup).includes(runId), textOf(dup));
  const other = await call({ name: "research", inputs: { question: "something else" } });
  assert.equal(statusIn(textOf(other)), "passed", textOf(other));
  await control(runId, "stop");
  await done;
});

await check("a live duplicate script run is refused, naming the live run; other arguments run", async () => {
  await session();
  const sandboxMod = await loadModule<typeof SandboxModule>("vendor/subagent/wf-sandbox.ts");
  const scriptMod = await loadModule<ScriptToolView>("vendor/subagent/wf-tool.ts");
  const support = sandboxMod.detectSupport();
  const scriptPi = fakePi();
  const scripted = fakeSpawner((s) => (s.task.includes("hang") ? { delayMs: 60_000 } : { text: "ok" }));
  scriptMod.registerScriptWorkflowTool(scriptPi.api, { sandbox: new sandboxMod.SandboxSession({ detect: () => support }), engine: { spawnChild: (c, a, o) => Object.assign(scripted.spawn(c, a, o), { pid: process.pid }) } });
  const script = 'export const meta = { name: "dup-demo", description: "demo" };\nreturn await agent(args.say, { agentType: "scout" })';
  const sctx = { cwd: project, hasUI: !support.bwrap, ui: { select: () => Promise.resolve(sandboxMod.REDUCED_YES), notify() {} } };
  const exec = (args: unknown) => scriptPi.tools.get("workflow").execute("s", { script, args }, undefined, undefined, sctx);
  const first = await exec({ say: "hang here" });
  assert.ok(!first.isError, textOf(first));
  const runId = String(Reflect.get(Object(first.details), "runId"));
  await until("the script's agent to start", () => scripted.seen.length > 0);
  const dup = await exec({ say: "hang here" });
  assert.equal(dup.isError, true);
  assert.ok(textOf(dup).includes(runId), textOf(dup));
  const other = await exec({ say: "other" });
  assert.ok(!other.isError, textOf(other));
  await until("the other run to finish", () => scriptPi.steers.length > 0);
  assert.equal(scripted.seen.length, 2, "no launch for the duplicate");
  assert.ok(pi.tools.get("workflow_control"));
  assert.match(textOf(await control(runId, "stop")), /Stop/i);
  await until("the stopped run to end", () => scriptPi.steers.length > 1);
  const after = await exec({ say: "hang here" });
  assert.ok(!after.isError, `once it ends the same script runs: ${textOf(after)}`);
  await until("the run to start", () => scripted.seen.length > 2);
  await control(String(Reflect.get(Object(after.details), "runId")), "stop");
  await until("the last run to end", () => scriptPi.steers.length > 2);
});

await check("the redirect errors name real tools", async () => {
  const script = await tools.openScriptWorkflow(ctx, "bugfix");
  assert.match(script.error ?? "", /run it with workflow_run/);
  assert.ok(pi.tools.get("workflow_run"));
  const yaml = await call({ name: "review-changes" });
  assert.equal(yaml.isError, true);
  assert.match(textOf(yaml), /script workflow; run it with the workflow tool/);
});

// ---------------------------------------------------------------------------------------------
// Host-side recursion: a step with expand answers with more steps, and the host runs them.

const asJson = (value: unknown): string => JSON.stringify(value);
const toolsOf = (s: Spawned): string => argOf(s, "--tools") ?? "";
const lastDir = (runId: string): string => path.join(workflowMod.runsRoot(project), runId);
const leaves = (n: number, more: Record<string, unknown> = {}): unknown[] => Array.from({ length: n }, (_, i) => ({ id: `l${String(i + 1)}`, agent: "scout", task: `leaf ${String(i + 1)}`, ...more }));

await check("expand is a plan field: a plan with expand: true compiles, and the schema no longer refuses it", () => {
  const compiled = plan.compilePlan([{ id: "split", task: "split it", expand: true }], roles);
  assert.ok(compiled.ok, `a plan with expand: true is refused by the schema: ${compiled.ok ? "" : plan.planRefusal(compiled.errors)}`);
  assert.equal(compiled.workflow.steps[0]?.expand, true);
  assert.equal(compiled.worstCaseAgents, 2, "the step and the one resample it may need");
});

await check("expand: {steps:[a,b]} runs a and b by the host at process depth 1 with no spawn tool, and they show in status and summary", async () => {
  await session();
  useFake((s) => {
    if (s.task.includes("split it")) return { text: asJson({ steps: [{ id: "a", agent: "scout", task: "do a" }, { id: "b", agent: "scout", task: "do b after {previous}" }] }) };
    return { text: `result of ${s.task.split("\n")[0] ?? ""}` };
  });
  const r = await call({ steps: [{ id: "split", task: "split it", expand: true }] });
  const text = textOf(r);
  assert.equal(statusIn(text), "passed", text);
  assert.equal(fake.seen.length, 3);
  assert.match(text, /split\.a: passed/);
  assert.match(text, /split\.b: passed/);
  const [, a, b] = fake.seen;
  assert.match(a?.task ?? "", /^do a/);
  assert.match(b?.task ?? "", /result of do a/, "a reference inside the expansion follows the prefix");
  for (const child of [a, b]) {
    assert.equal(child?.env.PI_KIT_SUBAGENT_DEPTH, "1");
    assert.doesNotMatch(toolsOf(child ?? fake.seen[0] as Spawned), /subagent|workflow/);
  }
  const runId = runIdIn(text);
  assert.ok(fs.existsSync(path.join(lastDir(runId), "steps", "split.a.md")));
  const status = textOf(await pi.tools.get("workflow_status").execute("s", { id: runId }, undefined, undefined, ctx));
  assert.match(status, /split\.b: passed/);
});

await check('expand: {"done":"x"} ends with no expansion and passes; later steps read x', async () => {
  await session();
  useFake((s) => (s.task.includes("split it") ? { text: asJson({ done: "x marks it" }) } : { text: "ok" }));
  const r = await call({ steps: [{ id: "split", task: "split it", expand: true }, { id: "after", agent: "scout", task: "then {previous}" }] });
  assert.equal(statusIn(textOf(r)), "passed", textOf(r));
  assert.equal(fake.seen.length, 2);
  assert.match(fake.seen[1]?.task ?? "", /then x marks it/);
});

await check("nested expansion works to expandDepth 3; a fourth is refused with 0 launches and the run is partial", async () => {
  await session("thorough");
  const level = (n: number): unknown => ({ id: `n${String(n)}`, task: `level ${String(n)}`, expand: true });
  useFake((s) => {
    const n = Number(/level (\d)/.exec(s.task)?.[1] ?? "");
    return { text: asJson({ steps: [n === 3 ? { id: "n4", agent: "scout", task: "too deep" } : level(n + 1)] }) };
  });
  const r = await call({ steps: [{ id: "split", task: "level 0", expand: true }] });
  const text = textOf(r);
  assert.equal(statusIn(text), "partial", text);
  assert.equal(fake.seen.length, 4, "the three generations and the planner of the fourth");
  assert.match(text, /split\.n1\.n2\.n3: passed/);
  assert.match(text, /omitted: .*depth/i);
  assert.ok(!fake.seen.some((s) => s.task.includes("too deep")));
});

await check("an expansion whose worst case is over the request allowance is refused before any of it launches", async () => {
  await session();
  const seven = leaves(7);
  useFake((s) => (s.task.includes("split it") ? { text: asJson({ steps: seven }) } : { text: "ok" }));
  const r = await call({ steps: [{ id: "split", task: "split it", expand: true }] });
  assert.equal(statusIn(textOf(r)), "partial", textOf(r));
  assert.equal(fake.seen.length, 1, "2 of 8 are planned, so 7 more launch nothing");
  assert.match(textOf(r), /omitted: .*\/effort/);
  await session();
  useFake((s) => (s.task.includes("split it") ? { text: asJson({ steps: leaves(6) }) } : { text: "ok" }));
  const fits = await call({ steps: [{ id: "split", task: "split it", expand: true }] });
  assert.equal(statusIn(textOf(fits)), "passed", textOf(fits));
  assert.equal(fake.seen.length, 7, "exactly at the allowance");
});

await check("invalid JSON or an invalid plan is resampled once with path, problem and fix; a second miss fails the step", async () => {
  await session();
  let asks = 0;
  useFake((s) => {
    if (!s.task.includes("split it")) return { text: "ok" };
    asks++;
    return { text: asks === 1 ? "I think we should split this" : asJson({ steps: [{ id: "a", agent: "scout", task: "do a" }] }) };
  });
  const r = await call({ steps: [{ id: "split", task: "split it", expand: true }] });
  assert.equal(statusIn(textOf(r)), "passed", textOf(r));
  assert.equal(asks, 2);
  assert.match(fake.seen[1]?.task ?? "", /"path":.*"problem":.*"fix":/);
  await session();
  useFake(() => ({ text: asJson({ steps: [{ id: "BAD ID", nonsense: true, task: "t" }] }) }));
  const missed = await call({ steps: [{ id: "split", task: "split it", expand: true }, { id: "after", agent: "scout", task: "never" }] });
  assert.equal(statusIn(textOf(missed)), "failed", textOf(missed));
  assert.equal(fake.seen.length, 2, "the step and its one resample");
  await session();
  useFake(() => ({ text: "```json\n" + asJson({ done: "fenced" }) + "\n```" }));
  assert.equal(statusIn(textOf(await call({ steps: [{ task: "split it", expand: true }] }))), "passed", "a fenced answer is read");
  assert.equal(fake.seen.length, 1);
});

await check("an expansion cannot widen: model, tools past the parent's, or a role with more than the parent has", async () => {
  const refuses = async (parent: Record<string, unknown>, step: unknown, why: RegExp): Promise<void> => {
    await session();
    useFake(() => ({ text: asJson({ steps: [step] }) }));
    const r = await call({ steps: [{ id: "split", task: "split it", expand: true, ...parent }] });
    assert.equal(statusIn(textOf(r)), "failed", textOf(r));
    assert.equal(fake.seen.length, 2, "the step and its resample; nothing of the expansion");
    assert.match(fake.seen[1]?.task ?? "", why);
  };
  await refuses({}, { task: "t", model: "big" }, /model is refused/);
  await refuses({ tools: ["read", "grep"] }, { agent: "scout", task: "t", tools: ["read", "bash"] }, /bash.*parent/);
  await refuses({ agent: "planner" }, { task: "write it" }, /every tool|parent/);
  await refuses({ agent: "planner" }, { agent: "scout", task: "t" }, /bash.*parent/);
  await refuses({}, { agent: "delegator", task: "t" }, /delegator can start agents/);
  await session();
  useFake((s) => (s.task.includes("split it") ? { text: asJson({ steps: [{ agent: "scout", tools: ["read"], task: "narrow" }] }) } : { text: "ok" }));
  const r = await call({ steps: [{ id: "split", agent: "planner", task: "split it", expand: true }] });
  assert.equal(statusIn(textOf(r)), "passed", `narrow is allowed: ${textOf(r)}`);
  assert.equal(toolsOf(fake.seen[1] ?? fake.seen[0] as Spawned), "read");
});

/** A user role for one case; removed by the returned function. */
function userRole(name: string, fields: string): () => void {
  const dir = path.join(process.env.PI_CODING_AGENT_DIR ?? agentDir, "agents"); // installDelegation moves it
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.md`);
  fs.writeFileSync(file, `---\nname: ${name}\ndescription: a role for one test\n${fields}\n---\nDo the task.\n`);
  return () => fs.rmSync(file);
}

await check("an expansion cannot widen through a role: one with its own model launches nothing, even at the same tools", async () => {
  const remove = userRole("bigrole", "tools: read\nmodel: provider/very-expensive\nthinking: high");
  try {
    await session();
    useFake(() => ({ text: asJson({ steps: [{ agent: "bigrole", task: "costly" }] }) }));
    const r = await call({ steps: [{ id: "split", agent: "scout", task: "split it", expand: true }] });
    assert.equal(statusIn(textOf(r)), "failed", textOf(r));
    assert.equal(fake.seen.length, 2, "the step and its resample; nothing of the expansion");
    assert.match(fake.seen[1]?.task ?? "", /bigrole runs differently from the parent step/);
    for (const seen of fake.seen) {
      assert.doesNotMatch(seen.task, /^costly/);
      assert.equal(argOf(seen, "--model") === "provider/very-expensive", false);
    }
  } finally {
    remove();
  }
});

await check("every setting a role carries past a plan's refusal is held to the parent's, and a parent with every tool is no exception", () => {
  const base = roles.find((r) => r.name === "scout");
  assert.ok(base);
  const role = (name: string, extra: Partial<AgentsModule.AgentConfig>): AgentsModule.AgentConfig => ({ ...base, name, ...extra });
  const list = [role("plain", {}), role("all-tools", { tools: undefined }), role("model", { model: "big" }), role("thinking", { thinking: "high" }), role("extended", { extensions: ["x"] }), role("timed", { maxRuntimeMs: 60_000 }), role("tiered", { effort: "exhaustive" }), role("model-too", { model: "big" })];
  const compiled = plan.compilePlan([{ id: "split", agent: "plain", task: "t", expand: true }, { id: "top", agent: "all-tools", task: "t", expand: true }, { id: "dear", agent: "model", task: "t", expand: true }], list);
  assert.ok(compiled.ok);
  const [plain, top, dear] = compiled.workflow.steps;
  assert.ok(plain && top && dear);
  for (const parent of [plain, top]) {
    for (const agent of ["model", "thinking", "extended", "timed", "tiered"]) {
      const built = plan.compileExpansion([{ agent, task: "t" }], parent, list, []);
      assert.ok(!built.ok, `${agent} under ${parent.agent ?? ""}`);
      assert.match(plan.planRefusal(built.errors), /runs differently from the parent step/);
    }
  }
  assert.ok(!plan.compileExpansion([{ agent: "plain", task: "t" }], dear, list, []).ok, "a role with no model would fall back to the session's, under a cheap parent");
  assert.ok(plan.compileExpansion([{ agent: "model-too", task: "t" }], dear, list, []).ok, "the same model is not wider");
});

await check("a required failure inside an expansion fails the run; nothing after it launches", async () => {
  await session();
  useFake((s) => {
    if (s.task.includes("split it")) return { text: asJson({ steps: [{ id: "a", agent: "scout", task: "break" }, { id: "b", agent: "scout", task: "never b" }] }) };
    return s.task.includes("break") ? { fail: "boom" } : { text: "ok" };
  });
  const r = await call({ steps: [{ id: "split", task: "split it", expand: true }, { id: "after", agent: "scout", task: "never after" }] });
  assert.equal(statusIn(textOf(r)), "failed", textOf(r));
  assert.match(textOf(r), /step split\.a failed/);
  assert.equal(fake.seen.length, 2);
});

const hangingExpansion = (s: Spawned): FakeReply => {
  if (s.task.includes("split it")) return { text: asJson({ steps: [{ id: "a", agent: "scout", tools: ["read"], task: "hang here" }, { id: "b", agent: "scout", task: "then b" }] }) };
  return s.task.includes("hang") ? { delayMs: 60_000 } : { text: "ok" };
};

await check("stop during an expanded step aborts it and nothing further launches", async () => {
  await session();
  useFake(hangingExpansion);
  const done = call({ steps: [{ id: "split", task: "split it", expand: true }] });
  await until("the expanded step to start", () => fake.seen.some((s) => s.task.includes("hang")));
  await control(liveRun(), "stop");
  const r = await done;
  assert.equal(statusIn(textOf(r)), "interrupted", textOf(r));
  assert.equal(fake.seen.length, 2);
});

await check("a killed run resumes from the persisted expansion without asking the planner again; a changed expansion is gated", async () => {
  await session();
  useFake(hangingExpansion);
  const steps = [{ id: "split", task: "split it", expand: true }, { id: "after", agent: "scout", task: "last" }];
  const done = call({ steps });
  await until("the expanded step to start", () => fake.seen.some((s) => s.task.includes("hang")));
  const runId = liveRun();
  await control(runId, "stop");
  await done;
  const file = path.join(lastDir(runId), "plan.json");
  const saved = fs.readFileSync(file, "utf8");
  assert.match(saved, /"expansions"/);
  assert.match(saved, /then b/);
  fs.writeFileSync(file, saved.replace("then b", "something planted"));
  useFake(() => ({ text: "must not run" }));
  const changed = await call({ resume: runId });
  assert.equal(changed.isError, true);
  assert.match(textOf(changed), /interactive approval or a digest grant/);
  assert.equal(fake.seen.length, 0);
  fs.writeFileSync(file, saved);
  useFake(() => ({ text: "resumed" }));
  const r = await call({ resume: runId });
  assert.equal(statusIn(textOf(r)), "passed", textOf(r));
  assert.deepEqual(fake.seen.map((s) => s.task.split("\n")[0]), ["hang here", "then b", "last"], "the planner is not asked again");
  assert.match(textOf(r), /split\.b: passed/);
});

await check("a kill between the planner's answer and the splice replays its saved answer, not the planner", async () => {
  await session();
  useFake(hangingExpansion);
  const done = call({ steps: [{ id: "split", task: "split it", expand: true }] });
  await until("the expanded step to start", () => fake.seen.some((s) => s.task.includes("hang")));
  const runId = liveRun();
  await control(runId, "stop");
  await done;
  // The disk as it stood just before the splice: the answer saved, no expansion, the cursor on the planner.
  const file = path.join(lastDir(runId), "plan.json");
  const before: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  const given: unknown = Reflect.get(Object(before), "steps");
  const text = JSON.stringify({ version: 1, steps: given });
  fs.writeFileSync(file, text);
  const stateFile = path.join(lastDir(runId), "state.json");
  const state = workflowMod.loadState(project, runId);
  assert.ok(state);
  const parent = state.steps.split;
  assert.ok(parent);
  delete parent.expanded;
  parent.expandAnswer = hangingExpansion({ args: [], env: {}, cwd: "", task: "split it", system: "" }).text;
  delete state.steps["split.a"];
  delete state.steps["split.b"];
  fs.writeFileSync(stateFile, JSON.stringify({ ...state, cursor: 0, status: "interrupted" }));
  // The waiting answer is part of what the grant covers.
  const sha = (data: string): string => crypto.createHash("sha256").update(data).digest("hex");
  const restore = setEnv("PI_KIT_TRUSTED_WORKFLOWS", sha(JSON.stringify([sha(text), [{ id: "split", answer: parent.expandAnswer }]])));
  try {
    useFake(() => ({ text: "resumed" }));
    const r = await call({ resume: runId });
    assert.equal(statusIn(textOf(r)), "passed", textOf(r));
    assert.deepEqual(fake.seen.map((s) => s.task.split("\n")[0]), ["hang here", "then b"]);
  } finally {
    restore();
  }
});

/** Stop a run whose first step hangs. */
async function interruptedAt(steps: unknown[]): Promise<string> {
  await session();
  useFake(() => ({ delayMs: 60_000 }));
  const done = call({ steps });
  await until("the step to start", () => fake.seen.length > 0);
  const runId = liveRun();
  await control(runId, "stop");
  await done;
  return runId;
}

/** `/workflow resume <id>` as an operator types it, to the summary it posts. */
async function typedResume(runId: string, reply: Reply): Promise<string> {
  useFake(reply);
  const posted = pi.steers.length;
  const ui = { notify: () => undefined, setStatus: () => undefined, select: (_title: string, choices: string[]) => Promise.resolve(choices[1]) };
  await pi.commands.get("workflow").handler(`resume ${runId}`, { cwd: project, hasUI: true, ui });
  await until("the resumed run to post its summary", () => pi.steers.length > posted);
  return JSON.stringify(pi.steers.at(-1)?.message);
}

await check("a typed resume refuses a new expansion: it ends partial with nothing of it launched", async () => {
  const runId = await interruptedAt([{ id: "split", agent: "planner", task: "split it", expand: true }]);
  const posted = await typedResume(runId, () => ({ text: asJson({ steps: leaves(30, { tools: ["read"] }) }) }));
  assert.match(posted, /· partial/, posted);
  assert.match(posted, /omitted: .*typed resume/, posted);
  assert.equal(fake.seen.length, 1, "the planner alone: an operator never saw these steps");
});

await check("a typed resume cannot launch a role that starts agents: it is resampled, then the step fails", async () => {
  const runId = await interruptedAt([{ id: "split", task: "split it", expand: true }]);
  const posted = await typedResume(runId, () => ({ text: asJson({ steps: [{ agent: "delegator", task: "must not run" }] }) }));
  assert.match(posted, /· failed/, posted);
  assert.equal(fake.seen.length, 2, "the step and its resample");
  assert.match(fake.seen[1]?.task ?? "", /delegator can start agents/);
  for (const seen of fake.seen) {
    assert.doesNotMatch(toolsOf(seen), /subagent/);
    assert.doesNotMatch(seen.task, /must not run/);
  }
});

await check("a typed resume still replays an expansion the run already charged", async () => {
  await session();
  useFake(hangingExpansion);
  const done = call({ steps: [{ id: "split", task: "split it", expand: true }] });
  await until("the expanded step to start", () => fake.seen.some((s) => s.task.includes("hang")));
  const runId = liveRun();
  await control(runId, "stop");
  await done;
  const posted = await typedResume(runId, () => ({ text: "resumed" }));
  assert.match(posted, /· passed/, posted);
  assert.deepEqual(fake.seen.map((s) => s.task.split("\n")[0]), ["hang here", "then b"]);
});

await check("a gate inside an expansion loops on its own prefixed steps", async () => {
  await session();
  let reviews = 0;
  useFake((s) => {
    if (s.task.includes("split it")) return { text: asJson({ steps: [{ id: "build", task: "Build it." }, { id: "check", agent: "reviewer", task: "Review: {previous}", gate: { pass: "VERDICT: PASS", retry: "build", max_loops: 1 } }] }) };
    if (!s.task.includes("Review")) return { text: "built" };
    reviews++;
    return { text: reviews === 1 ? "VERDICT: FAIL no tests" : "VERDICT: PASS" };
  });
  const r = await call({ steps: [{ id: "split", task: "split it", expand: true }] });
  assert.equal(statusIn(textOf(r)), "passed", textOf(r));
  assert.equal(fake.seen.filter((s) => s.task.includes("Build it.")).length, 2);
  assert.match(fake.seen.filter((s) => s.task.includes("Build it."))[1]?.task ?? "", /VERDICT: FAIL no tests/);
});

await check("MAX_EXECUTIONS still bounds everything: an expansion that could pass it is refused, with no launch of its own", async () => {
  await session("exhaustive");
  useFake((s) => {
    if (s.task.includes("split it")) return { text: asJson({ steps: [...leaves(49), { id: "more", agent: "implementer", task: "split more", expand: true }] }) };
    if (s.task.includes("split more")) return { text: asJson({ steps: leaves(20) }) };
    return { text: "ok" };
  });
  const r = await call({ steps: [{ id: "split", task: "split it", expand: true }] });
  assert.equal(statusIn(textOf(r)), "partial", textOf(r));
  assert.equal(fake.seen.length, 51);
  assert.ok(fake.seen.length <= workflowMod.MAX_EXECUTIONS);
  assert.match(textOf(r), new RegExp(`omitted: .*${String(workflowMod.MAX_EXECUTIONS)}`));
});

await check("an expansion over MAX_EXECUTIONS by itself is refused as an omission: the run is partial, with no second ask", async () => {
  await session();
  useFake((s) => (s.task.includes("split it") ? { text: asJson({ steps: leaves(workflowMod.MAX_EXECUTIONS + 1) }) } : { text: "ok" }));
  const r = await call({ steps: [{ id: "split", task: "split it", expand: true }] });
  assert.equal(statusIn(textOf(r)), "partial", textOf(r));
  assert.equal(fake.seen.length, 1, "the planner alone");
  assert.match(textOf(r), new RegExp(`omitted: .*${String(workflowMod.MAX_EXECUTIONS)}`));
});

await check("an expansion landing exactly on MAX_EXECUTIONS runs: the step being settled is not charged a resample it cannot have", async () => {
  await session("exhaustive");
  useFake((s) => (s.task.includes("split it") ? { text: asJson({ steps: leaves(workflowMod.MAX_EXECUTIONS - 1) }) } : { text: "ok" }));
  const r = await call({ steps: [{ id: "split", task: "split it", expand: true }] });
  assert.equal(statusIn(textOf(r)), "passed", textOf(r));
  assert.equal(fake.seen.length, workflowMod.MAX_EXECUTIONS);
});

await check("one leaf past that boundary is still refused as an omission, with only the planner launched", async () => {
  await session("exhaustive");
  useFake((s) => (s.task.includes("split it") ? { text: asJson({ steps: leaves(workflowMod.MAX_EXECUTIONS) }) } : { text: "ok" }));
  const r = await call({ steps: [{ id: "split", task: "split it", expand: true }] });
  assert.equal(statusIn(textOf(r)), "partial", textOf(r));
  assert.equal(fake.seen.length, 1, "the planner alone");
  assert.match(textOf(r), new RegExp(`omitted: .*${String(workflowMod.MAX_EXECUTIONS)}`));
});

await check("a resample never passes MAX_EXECUTIONS: at the limit the step fails instead", async () => {
  const runId = await interruptedAt([{ id: "split", agent: "planner", task: "split it", expand: true }]);
  const stateFile = path.join(lastDir(runId), "state.json");
  const stopped = workflowMod.loadState(project, runId);
  assert.ok(stopped);
  fs.writeFileSync(stateFile, JSON.stringify({ ...stopped, executions: workflowMod.MAX_EXECUTIONS - 1 }));
  useFake(() => ({ text: "not an answer" }));
  const r = await call({ resume: runId });
  assert.equal(statusIn(textOf(r)), "failed", textOf(r));
  assert.equal(fake.seen.length, 1, "the step, and no resample");
  const ended = workflowMod.loadState(project, runId);
  assert.equal(ended?.executions, workflowMod.MAX_EXECUTIONS);
  assert.match(ended?.steps.split?.error ?? "", /no resample: the run is at 60 step executions/);
});

await check("a long done answer is capped in state.json and whole on disk", async () => {
  await session();
  const long = "x".repeat(200_000);
  useFake((s) => (s.task.includes("split it") ? { text: asJson({ done: long }) } : { text: "ok" }));
  const r = await call({ steps: [{ id: "split", task: "split it", expand: true }, { id: "after", agent: "scout", task: "then {previous}" }] });
  assert.equal(statusIn(textOf(r)), "passed", textOf(r));
  const runId = runIdIn(textOf(r));
  const saved = workflowMod.loadState(project, runId)?.steps.split?.output ?? "";
  assert.ok(saved.length <= 4001, `state.json keeps ${String(saved.length)} characters`);
  assert.equal(fs.readFileSync(path.join(lastDir(runId), "steps", "split.md"), "utf8").length, long.length);
  const size = fs.statSync(path.join(lastDir(runId), "state.json")).size;
  assert.ok(size < 16_000, `state.json is ${String(size)} bytes: the answer is not kept once acted on`);
});

await check("where expand may not go: a parallel member, with a gate, inside a gated segment, or in a saved workflow; no plan step may be a spawning role", () => {
  const refused = (steps: unknown[], why: RegExp): void => {
    const compiled = plan.compilePlan(steps, roles);
    assert.ok(!compiled.ok, JSON.stringify(steps));
    assert.match(plan.planRefusal(compiled.errors), why);
  };
  refused([{ agent: "delegator", task: "t" }], /delegator can start agents/);
  assert.ok(plan.compilePlan([{ agent: "delegator", task: "t", tools: ["read"] }], roles).ok, "tools that narrow it are fine");
  refused([{ parallel: [{ task: "t", expand: true }] }], /member/);
  refused([{ task: "t", expand: "yes" }], /expand must be/);
  refused([{ id: "a", task: "t", expand: true, gate: { pass: "x", retry: "a" } }], /gate/);
  refused([{ id: "a", task: "t" }, { id: "b", task: "t", expand: true }, { id: "c", task: "t", gate: { pass: "x", retry: "a" } }], /expand/);
  const saved = workflowMod.parseWorkflow("---\nname: saved\nsteps:\n  - { id: one, agent: scout, task: t, expand: true }\n---\n", "saved.md", "user");
  assert.equal(saved.workflow, undefined);
  assert.match(saved.errors.join("\n"), /expand.*inline plan/);
});

await check("strategy.expandDepth is 3 in both policy readers, and each refuses a bad value", async () => {
  const core = await import("../packages/core/lib/effort.ts");
  const rt = await loadModule<{ loadPolicy(): { strategy: { expandDepth: number } }; validatePolicy(p: unknown, dir: string): string[]; policyDir(): string }>("extensions/effort/policy.ts");
  assert.equal(core.loadEffortPolicy().strategy.expandDepth, 3);
  assert.equal(rt.loadPolicy().strategy.expandDepth, 3);
  const raw: unknown = JSON.parse(fs.readFileSync(path.join(rt.policyDir(), "effort.json"), "utf8"));
  assert.ok(typeof raw === "object" && raw !== null);
  const bad = { ...raw, strategy: { expandDepth: 0 } };
  assert.match(core.validateEffortPolicy(bad, rt.policyDir()).join("\n"), /strategy\.expandDepth/);
  assert.match(rt.validatePolicy(bad, rt.policyDir()).join("\n"), /strategy\.expandDepth/);
});

await check("the ledger charges an expansion only with the run's token, and only a planned run", async () => {
  await session();
  useFake(hangingExpansion);
  const done = call({ steps: [{ id: "split", task: "split it", expand: true }] });
  await until("the expanded step to start", () => fake.seen.some((s) => s.task.includes("hang")));
  const runId = liveRun();
  const registry: unknown = Reflect.get(globalThis, Symbol.for("pi-kit.effort"));
  const charge: unknown = Reflect.get(Object(registry), "chargeRunScope");
  assert.equal(typeof charge, "function");
  const wrong: unknown = typeof charge === "function" ? Reflect.apply(charge, registry, [runId, "not-the-token", 1]) : undefined;
  assert.equal(Reflect.get(Object(wrong), "ok"), false);
  assert.equal(Reflect.get(Object(wrong), "code"), "run-scope");
  const open: unknown = Reflect.get(Object(registry), "openRunScope");
  const unplannedId = `${runId}-unplanned`;
  const unplanned: unknown = typeof open === "function" ? Reflect.apply(open, registry, [unplannedId]) : undefined;
  assert.equal(Reflect.get(Object(unplanned), "ok"), true);
  const token: unknown = Reflect.get(Object(unplanned), "runToken");
  const refused: unknown = typeof charge === "function" ? Reflect.apply(charge, registry, [unplannedId, token, 1]) : undefined;
  assert.equal(Reflect.get(Object(refused), "ok"), false);
  assert.equal(Reflect.get(Object(refused), "code"), "run-scope");
  await control(runId, "stop");
  await done;
});

await check("saved YAML parses as before: parseSteps is the same validator, and a saved plan field stays allowed", () => {
  const parsed = workflowMod.parseWorkflow("---\nname: saved\nsteps:\n  - { id: one, agent: scout, task: t, model: big, max_runtime: 5m, tools: [] }\n---\n", "saved.md", "user");
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.workflow?.steps[0]?.model, "big");
  assert.equal(parsed.workflow?.steps[0]?.maxRuntimeMs, 300_000);
  const bad = workflowMod.parseWorkflow("---\nname: saved\nsteps:\n  - { id: one, agent: scout, task: t }\n  - { id: one, task: t2, gate: { pass: x, retry: nope } }\n---\n", "saved.md", "user");
  assert.deepEqual(bad.errors, ['saved.md: steps[1]: needs agent: or skill:', "saved.md: duplicate step ids: one", 'saved.md: step one: gate.retry "nope" must name this or an earlier top-level step', "saved.md: step one: gate.retry must be a top-level step"]);
});

await check('the reference generator documents workflow_run from its source, not "No description."', async () => {
  const reference = await loadModule<{ referenceContent(): string }>("packages/core/reference.ts");
  const page = reference.referenceContent();
  const at = page.indexOf("### `workflow_run`");
  assert.ok(at > 0, "the page lists workflow_run");
  const next = page.indexOf("\n### ", at + 1);
  const section = page.slice(at, next < 0 ? undefined : next);
  assert.doesNotMatch(section, /No description\./, section);
  assert.match(section, /relative to the run directory/, "the description comes from plan.ts");
});

await check("docs/workflows.md qualifies replanning after a refused expansion with the allowance", () => {
  const page = fs.readFileSync(path.join(ROOT, "docs", "workflows.md"), "utf8");
  assert.doesNotMatch(page, /so the agent can replan\./);
  assert.match(page, /replan[^.]*renews on the next user message/);
});

await check("expansion control data uses the original answer, including ordinary security vocabulary", async () => {
  for (const task of ["audit secret handling", "check token handling", "Fix the password reset flow in auth.ts"]) {
    await session();
    useFake((s) => s.task === "split vocabulary" ? { text: JSON.stringify({ steps: [{ id: "a", agent: "scout", task }, { id: "b", agent: "scout", task: "second leaf" }] }) } : { text: "ok" });
    const r = await call({ steps: [{ id: "split", task: "split vocabulary", expand: true }] });
    assert.equal(statusIn(textOf(r)), "passed", textOf(r));
    assert.deepEqual(fake.seen.map((s) => s.task), ["split vocabulary", task, "second leaf"]);
  }
  await session();
  useFake(() => ({ text: JSON.stringify({ done: "the token expired" }) }));
  const r = await call({ steps: [{ task: "finish vocabulary", expand: true }] });
  assert.equal(statusIn(textOf(r)), "passed", textOf(r));
  assert.equal(fake.seen.length, 1, "no redaction-induced resample");
});

await check("a resumed plan keeps executable task text and never runs a redacted definition", async () => {
  const task = "Fix the password reset flow in auth.ts, then rotate the token cache";
  const { done, runId } = await hanging([{ id: "first", agent: "planner", task: "hang here" }, { id: "second", agent: "planner", task }]);
  await control(runId, "stop");
  await done;
  await session();
  useFake(() => ({ text: "ok" }));
  const r = await call({ resume: runId });
  assert.equal(statusIn(textOf(r)), "passed", textOf(r));
  assert.equal(fake.seen[1]?.task, task);
});

await check("run file templates refuse symlinks in the file and in parent directories", () => {
  const dir = path.join(ws, "include-run");
  const outside = path.join(ws, "outside");
  fs.mkdirSync(dir);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "answer.md"), "outside contents");
  fs.symlinkSync(path.join(outside, "answer.md"), path.join(dir, "link.md"));
  fs.symlinkSync(outside, path.join(dir, "linked-dir"));
  const compiled = plan.compilePlan([{ task: "t" }], roles);
  assert.ok(compiled.ok);
  const state = workflowMod.newRunState(compiled.workflow, {});
  for (const rel of ["link.md", "linked-dir/answer.md"]) {
    assert.throws(() => workflowMod.renderTemplate(`{{file:${rel}}}`, { inputs: {}, state, runDir: dir, loop: 0 }), /symlink|symbolic link|outside|escapes/);
    assert.throws(() => workflowMod.renderTemplate(`{{file:${rel}?}}`, { inputs: {}, state, runDir: dir, loop: 0 }), /symlink|symbolic link|outside|escapes/, "optional suppresses absence only");
  }
});

await check("resume refuses an oversized plan before parsing or launching it", async () => {
  const { done, runId } = await hanging([{ agent: "planner", task: "hang here" }]);
  await control(runId, "stop");
  await done;
  const file = path.join(lastDir(runId), "plan.json");
  fs.appendFileSync(file, " ".repeat(2 * 1024 * 1024));
  useFake(() => ({ text: "must not run" }));
  const r = await call({ resume: runId });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /larger|limit|too large/);
  assert.equal(fake.seen.length, 0);
});

const STALL = "/[\\s\\S]*[\\s\\S]*[\\s\\S]*ZZZ/";

await check("a polynomial regex gate cannot stall the host: its timers beat, and the test times out as a miss", async () => {
  await session();
  useFake(() => ({ text: "a".repeat(2000) }));
  let beats = 0;
  const beat = setInterval(() => { beats++; }, 10);
  const started = Date.now();
  const r = await call({ steps: [{ id: "a", agent: "planner", task: "t", gate: { pass: STALL, retry: "a", max_loops: 0 } }] });
  clearInterval(beat);
  assert.match(textOf(r), /gate a did not pass/, textOf(r));
  assert.ok(beats >= 20, `the host timer beat ${String(beats)} times`);
  assert.ok(Date.now() - started < 8000);
});

await check("a regex gate passes on a match, as the kit's bugfix and feature gates rely on", async () => {
  await session();
  useFake(() => ({ text: "done\nVERDICT: PASS" }));
  const r = await call({ steps: [{ id: "a", agent: "planner", task: "t", gate: { pass: "/VERDICT:\\s*PASS/", retry: "a", max_loops: 1 } }] });
  assert.equal(statusIn(textOf(r)), "passed", textOf(r));
  assert.equal(fake.seen.length, 1, "no loop on a pass");
});

await check("a regex gate reads the tail of a long answer, where the verdict is", async () => {
  await session();
  useFake(() => ({ text: `${"x".repeat(70_000)}\nVERDICT: PASS` }));
  const r = await call({ steps: [{ id: "a", agent: "planner", task: "t", gate: { pass: "/VERDICT: PASS$/", retry: "a", max_loops: 1 } }] });
  assert.equal(statusIn(textOf(r)), "passed", textOf(r));
  assert.equal(fake.seen.length, 1);
});

await check("the gate worker imports only what loads outside pi's extension loader", () => {
  const source = fs.readFileSync(path.join(ROOT, "packages", "extensions", "third_party", "subagent", "gate-worker.mjs"), "utf8");
  const imports = [...source.matchAll(/^import\s[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1] ?? "");
  assert.ok(imports.length > 0);
  for (const name of imports) assert.match(name, /^node:/, name);
  assert.doesNotMatch(source, /\bimport\(/);
});

await check("a gate worker that dies is a reported run error, not a gate miss", async () => {
  const Real = workerThreads.Worker;
  for (const body of ["process.exit(3)", "throw new Error('boom')"]) {
    workerThreads.Worker = class extends Real {
      constructor() {
        super(body, { eval: true });
      }
    };
    syncBuiltinESMExports();
    try {
      await session();
      useFake(() => ({ text: "VERDICT: PASS" }));
      const r = await call({ steps: [{ id: "a", agent: "planner", task: "t", gate: { pass: "/PASS/", retry: "a", max_loops: 2 } }] });
      assert.equal(statusIn(textOf(r)), "failed", textOf(r));
      assert.match(textOf(r), /gate a could not be tested: the gate worker/);
      assert.equal(fake.seen.length, 1, "a dead worker does not loop the review");
    } finally {
      workerThreads.Worker = Real;
      syncBuiltinESMExports();
    }
  }
});

await check("malformed template whitespace is linear, and a literal {{}} is left alone", () => {
  const compiled = plan.compilePlan([{ task: "t" }], roles);
  assert.ok(compiled.ok);
  const state = workflowMod.newRunState(compiled.workflow, {});
  const render = (text: string): string => workflowMod.renderTemplate(text, { inputs: {}, state, runDir: ws, loop: 0 });
  const start = Date.now();
  render(`{{${" ".repeat(8000)}x`);
  assert.ok(Date.now() - start < 300, "unclosed whitespace templates are linear");
  assert.equal(render("<T>{{}}</T>"), "<T>{{}}</T>");
});

const fifo = (file: string): void => {
  fs.rmSync(file, { force: true });
  execFileSync("mkfifo", [file]);
};

await check("a FIFO in place of a run file refuses at once: {{file:}}, state.json and plan.json", async () => {
  const dir = path.join(ws, "fifo-run");
  fs.mkdirSync(dir);
  fifo(path.join(dir, "pipe"));
  const compiled = plan.compilePlan([{ task: "t" }], roles);
  assert.ok(compiled.ok);
  const state = workflowMod.newRunState(compiled.workflow, {});
  assert.throws(() => workflowMod.renderTemplate("{{file:pipe?}}", { inputs: {}, state, runDir: dir, loop: 0 }), /regular file/);
  const { done, runId } = await hanging([{ agent: "planner", task: "hang here" }]);
  await control(runId, "stop");
  await done;
  fifo(path.join(lastDir(runId), "plan.json"));
  useFake(() => ({ text: "must not run" }));
  const r = await call({ resume: runId });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /plan\.json is missing or unreadable/);
  fifo(path.join(lastDir(runId), "state.json"));
  assert.equal(workflowMod.loadState(project, runId), null);
  assert.equal(fake.seen.length, 0);
});

await check("a member's output replaced by a FIFO or a link fails the group; it neither hangs nor pulls a file in", async () => {
  const outside = path.join(ws, "outside-secret.md");
  fs.writeFileSync(outside, "outside contents");
  for (const plant of [fifo, (file: string): void => { fs.rmSync(file, { force: true }); fs.symlinkSync(outside, file); }]) {
    await session();
    useFake((s) => {
      if (s.task !== "slow") return { text: "quick" };
      setTimeout(() => plant(path.join(lastDir(liveRun()), "steps", "m1.md")), 40);
      return { text: "slow", delayMs: 120 };
    });
    const r = await call({ steps: [{ id: "g", parallel: [{ id: "m1", agent: "planner", task: "quick" }, { id: "m2", agent: "planner", task: "slow" }] }] });
    assert.equal(statusIn(textOf(r)), "failed", textOf(r));
    assert.match(textOf(r), /group g: run file/);
    assert.equal(fs.existsSync(path.join(lastDir(runIdIn(textOf(r))), "steps", "g.md")), false);
  }
});

await check("large plans are bounded before per-step reference analysis", () => {
  const started = Date.now();
  const c = plan.compilePlan(Array.from({ length: 4000 }, (_, i) => ({ id: `s${i}`, task: "t" })), roles);
  assert.equal(c.ok, false);
  assert.ok(Date.now() - started < 150, "refuse before building quadratic reference sets");
});

await check("required references to conditional outputs are refused before a launch", () => {
  const c = plan.compilePlan([{ id: "a", task: "t" }, { id: "fix", task: "conditional", when: { step: "a", status: "failed" } }, { task: "use {{steps.fix.output}}" }], roles);
  assert.equal(c.ok, false);
  assert.ok(plan.compilePlan([{ id: "a", task: "t" }, { id: "fix", task: "conditional", when: { step: "a", status: "failed" } }, { task: "use {{steps.fix.output?}}" }], roles).ok);
});

await check("review feedback is added when a task only mentions a reference in prose", async () => {
  await session();
  let reviews = 0;
  useFake((s) => ({ text: s.task.startsWith("review") ? ++reviews === 1 ? "FAIL repair the edge" : "PASS" : "built" }));
  const r = await call({ steps: [{ id: "build", task: "Fix steps.review.output handling" }, { id: "review", agent: "reviewer", task: "review", gate: { pass: "PASS", retry: "build", max_loops: 1 } }] });
  assert.equal(statusIn(textOf(r)), "passed", textOf(r));
  assert.match(fake.seen.filter((s) => s.task.startsWith("Fix"))[1]?.task ?? "", /FAIL repair the edge/);
});

await check("file references to expansion answers follow the parent's prefix", async () => {
  await session();
  useFake((s) => s.task === "split files" ? { text: JSON.stringify({ steps: [{ id: "a", agent: "planner", task: "first leaf" }, { id: "b", agent: "planner", task: "use {{file:steps/a.md}}" }] }) } : { text: "leaf result" });
  const r = await call({ steps: [{ id: "split", task: "split files", expand: true }] });
  assert.equal(statusIn(textOf(r)), "passed", textOf(r));
  assert.equal(fake.seen[2]?.task, "use leaf result");
});

await check("YAML max_loops refuses non-numeric, fractional and out-of-range values", () => {
  for (const value of ["two", "1.5", "-1", "11"]) {
    const r = workflowMod.parseWorkflow(`---\nname: loops\nsteps:\n  - id: a\n    agent: planner\n    task: t\n    gate: {pass: PASS, retry: a, max_loops: ${value}}\n---\n`, "loops.md", "user");
    assert.equal(r.workflow, undefined, value);
    assert.match(r.errors.join("\n"), /max_loops/, value);
  }
});

await check("live identities ignore object key ordering at every level", async () => {
  const models = await loadModule<typeof RunModelModule>("vendor/subagent/run-model.ts");
  assert.equal(models.runIdentity("plan", "same", { x: "1", y: { a: 2, b: 3 } }), models.runIdentity("plan", "same", { y: { b: 3, a: 2 }, x: "1" }));
});

await check("default member ids fit even when their group id reaches the length limit", () => {
  const c = plan.compilePlan([{ id: "a".repeat(41), parallel: [{ task: "one" }, { task: "two" }] }], roles);
  assert.ok(c.ok, JSON.stringify(c));
});

await check("a removed skill refuses resume before a child starts", async () => {
  const skillDir = path.join(process.env.PI_CODING_AGENT_DIR ?? agentDir, "skills", "temporary-skill");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: temporary-skill\ndescription: test\n---\nSkill body\n");
  try {
    const { done, runId } = await hanging([{ agent: "planner", task: "hang here" }, { agent: "planner", task: "needs skill", skills: ["temporary-skill"] }]);
    await control(runId, "stop");
    await done;
    fs.rmSync(skillDir, { recursive: true });
    useFake(() => ({ text: "must not run" }));
    const r = await call({ resume: runId });
    assert.equal(r.isError, true, textOf(r));
    assert.match(textOf(r), /temporary-skill/);
    assert.equal(fake.seen.length, 0);
  } finally {
    fs.rmSync(skillDir, { recursive: true, force: true });
  }
});

await check("passed writers at the cursor survive the pass-to-cursor crash window", async () => {
  const { done, runId } = await hanging([{ id: "writer", task: "finished writer" }, { id: "later", agent: "planner", task: "hang here" }]);
  await control(runId, "stop");
  await done;
  const state = workflowMod.loadState(project, runId);
  assert.ok(state);
  state.cursor = 0;
  fs.writeFileSync(path.join(lastDir(runId), "state.json"), JSON.stringify(state));
  useFake(() => ({ text: "resumed" }));
  const r = await call({ resume: runId });
  assert.equal(statusIn(textOf(r)), "passed", textOf(r));
  assert.deepEqual(fake.seen.map((s) => s.task), ["hang here"]);
});

await check("an answered expansion still budgets its possible resample on resume", () => {
  const c = plan.compilePlan([{ id: "split", task: "t", expand: true }], roles);
  assert.ok(c.ok);
  const state = workflowMod.newRunState(c.workflow, {});
  state.steps.split = { status: "passed", attempts: 1, runIds: [], cost: 0 };
  assert.equal(workflowMod.worstCaseAgents(c.workflow, state), 1);
});

await check("plan roles cannot load delegation extensions and agent-starting tools", () => {
  const base = roles.find((r) => r.name === "planner");
  assert.ok(base);
  for (const extension of ["subagent", "verify-gate", "conductor"]) {
    const c = plan.compilePlan([{ agent: "extended", task: "t" }], [{ ...base, name: "extended", tools: undefined, extensions: [extension] }]);
    assert.equal(c.ok, false, extension);
  }
  for (const tool of ["verify_completion", "dispatch_validator"]) assert.equal(plan.compilePlan([{ task: "t", tools: [tool] }], roles).ok, false, tool);
});

await check("constructor ids are own state keys and never mutate Object", async () => {
  await session();
  useFake(() => ({ text: "ok" }));
  const before = Object.getOwnPropertyDescriptors(Object);
  const r = await call({ steps: [{ id: "constructor", agent: "planner", task: "safe own key" }, { task: "next" }] });
  assert.equal(statusIn(textOf(r)), "passed", textOf(r));
  assert.deepEqual(Object.getOwnPropertyDescriptors(Object), before);
});

interface ExecutorView {
  executeWorkflow(w: WorkflowModule.WorkflowDef, state: WorkflowModule.RunState, options: Omit<WorkflowModule.ExecuteOptions, "spawnChild"> & { spawnChild: FakeSpawn }): Promise<WorkflowModule.RunState>;
}
const executor = await loadModule<ExecutorView>("vendor/subagent/workflow.ts");
const direct = (w: WorkflowModule.WorkflowDef, state: WorkflowModule.RunState, concurrency: number, signal?: AbortSignal): Promise<WorkflowModule.RunState> =>
  executor.executeWorkflow(w, state, { cwd: project, agents: roles, spawnChild, launchKind: "user", concurrency, signal });

await check("a secret-shaped expansion is resampled once, before any charge, and a plan with one is refused", async () => {
  const secret = "use api_key=abcdef123456 here";
  await session();
  let asked = 0;
  useFake((s) => (s.task.startsWith("split secrets") ? { text: asJson({ steps: [{ agent: "scout", task: ++asked === 1 ? secret : "clean" }] }) } : { text: "ok" }));
  const r = await call({ steps: [{ id: "split", task: "split secrets", expand: true }] });
  assert.equal(statusIn(textOf(r)), "passed", textOf(r));
  assert.match(fake.seen[1]?.task ?? "", /secret-shaped text/);
  assert.deepEqual(fake.seen.slice(2).map((s) => s.task), ["clean"]);
  assert.doesNotMatch(fs.readFileSync(path.join(lastDir(runIdIn(textOf(r))), "plan.json"), "utf8"), /abcdef123456/);
  await session();
  useFake(() => ({ text: asJson({ steps: [{ agent: "scout", task: secret }] }) }));
  const twice = await call({ steps: [{ id: "split", task: "split it", expand: true }] });
  assert.equal(statusIn(textOf(twice)), "failed", textOf(twice));
  assert.match(textOf(twice), /no usable answer/);
  const dirs = fs.readdirSync(workflowMod.runsRoot(project)).length;
  useFake(() => ({ text: "must not run" }));
  const fresh = await call({ steps: [{ agent: "scout", task: secret }] });
  assert.equal(fresh.isError, true);
  assert.match(textOf(fresh), /secret-shaped/);
  assert.equal(fake.seen.length, 0);
  assert.equal(fs.readdirSync(workflowMod.runsRoot(project)).length, dirs);
});

/** A plan stopped at its second step, with state.json as a kill left it: `split` passed, its answer not acted on. */
async function beforeSettling(answer: string | undefined): Promise<string> {
  await session();
  useFake((s) => (s.task.includes("split it") ? { text: answer ?? asJson({ done: "finished" }) } : { delayMs: 60_000 }));
  const done = call({ steps: [{ id: "split", task: "split it", expand: true }, { id: "after", agent: "planner", task: "hang here" }] });
  await until("the next step to start", () => fake.seen.length === 2);
  const runId = liveRun();
  await control(runId, "stop");
  await done;
  const state = workflowMod.loadState(project, runId);
  const parent = state?.steps.split;
  assert.ok(state && parent);
  delete parent.expanded;
  fs.writeFileSync(path.join(lastDir(runId), "state.json"), JSON.stringify({ ...state, cursor: 0 }));
  return runId;
}

await check("an answer this session never saw, written into state.json or the run directory, is gated on resume", async () => {
  const planted = asJson({ steps: [{ id: "x", task: "planted task" }] });
  const runId = await beforeSettling(undefined);
  const file = path.join(lastDir(runId), "state.json");
  const state = workflowMod.loadState(project, runId);
  assert.ok(state?.steps.split);
  state.steps.split.expandAnswer = planted;
  fs.writeFileSync(file, JSON.stringify(state));
  fs.writeFileSync(path.join(lastDir(runId), "steps", "split.md"), planted);
  useFake(() => ({ text: "must not run" }));
  const r = await call({ resume: runId });
  assert.equal(r.isError, true, textOf(r));
  assert.match(textOf(r), /Blocked: plan/);
  assert.equal(fake.seen.length, 0);
});

await check("a kill after a done answer replays it from state.json, and with the answer lost the writer is not re-run unasked", async () => {
  const answer = asJson({ done: "finished" });
  const runId = await beforeSettling(answer);
  const file = path.join(lastDir(runId), "state.json");
  const state = workflowMod.loadState(project, runId);
  assert.ok(state?.steps.split);
  state.steps.split.expandAnswer = answer;
  fs.writeFileSync(file, JSON.stringify(state));
  useFake(() => ({ text: "next" }));
  const r = await call({ resume: runId });
  assert.equal(statusIn(textOf(r)), "passed", textOf(r));
  assert.deepEqual(fake.seen.map((s) => s.task), ["hang here"], "the finished step is not relaunched");
  assert.equal(fs.readFileSync(path.join(lastDir(runId), "steps", "split.md"), "utf8"), "finished");
  const lost = await beforeSettling(undefined);
  useFake(() => ({ text: "must not run" }));
  const refused = await call({ resume: lost });
  assert.equal(refused.isError, true, textOf(refused));
  assert.match(textOf(refused), /writer step\(s\) split/);
  assert.equal(fake.seen.length, 0);
});

await check("a resume runs every member of a gated group's interrupted loop, never a pass from the loop before", async () => {
  const c = plan.compilePlan([{ id: "g", parallel: [{ id: "m1", agent: "planner", task: "one" }, { id: "m2", agent: "planner", task: "two" }, { id: "m3", agent: "planner", task: "three" }], gate: { pass: "VERDICT: PASS", retry: "g", max_loops: 2 } }], roles);
  assert.ok(c.ok);
  const state = workflowMod.newRunState(c.workflow, {});
  const abort = new AbortController();
  let launches = 0;
  useFake(() => {
    if (++launches === 4) abort.abort();
    return { text: "VERDICT: FAIL", delayMs: 5 };
  });
  assert.equal((await direct(c.workflow, state, 1, abort.signal)).status, "interrupted");
  const saved = workflowMod.loadState(project, state.id);
  assert.ok(saved);
  useFake(() => ({ text: "VERDICT: PASS" }));
  assert.equal((await direct(c.workflow, saved, 1)).status, "passed");
  assert.deepEqual(fake.seen.map((s) => s.task.split("\n")[0]), ["one", "two", "three"]);
});

await check("a plan's writers in one group run one at a time; a group that cannot edit runs together", async () => {
  await session();
  useFake(() => ({ text: "ok", delayMs: 20 }));
  const writers = await call({ steps: [{ id: "w", parallel: [{ task: "add x" }, { task: "add y" }, { task: "add z" }] }] });
  assert.equal(statusIn(textOf(writers)), "passed", textOf(writers));
  assert.equal(fake.maxLive(), 1);
  await session();
  useFake(() => ({ text: "ok", delayMs: 20 }));
  const readers = await call({ steps: [{ id: "r", parallel: [{ agent: "planner", task: "look at x" }, { agent: "planner", task: "look at y" }] }] });
  assert.equal(statusIn(textOf(readers)), "passed", textOf(readers));
  assert.equal(fake.maxLive(), 2);
});

await check("a refused expansion reads as skipped to later steps, whose {previous} gets the reason, not the steps", async () => {
  await session();
  const leaves = Array.from({ length: 9 }, (_, i) => ({ id: `l${String(i)}`, task: "leaf" }));
  useFake((s) => (s.task.includes("split it") ? { text: asJson({ steps: leaves }) } : { text: "ok" }));
  const r = await call({ steps: [{ id: "split", task: "split it", expand: true }, { id: "after", agent: "planner", task: "only if passed", when: { step: "split", status: "passed" } }, { id: "gone", agent: "planner", task: "reads {{steps.split.status}} and {{steps.split.output}}" }] });
  assert.equal(statusIn(textOf(r)), "partial", textOf(r));
  const tasks = fake.seen.map((s) => s.task);
  assert.ok(!tasks.includes("only if passed"), "dependent step skipped");
  assert.match(tasks.at(-1) ?? "", /^reads skipped and expansion refused/);
  assert.doesNotMatch(tasks.at(-1) ?? "", /"steps"/);
});

await check("a parallel group launches nothing when the tier's maxConcurrent is 0", async () => {
  const c = plan.compilePlan([{ id: "g", parallel: [{ agent: "planner", task: "one" }, { agent: "planner", task: "two" }] }], roles);
  assert.ok(c.ok);
  useFake(() => ({ text: "must not run" }));
  const state = await direct(c.workflow, workflowMod.newRunState(c.workflow, {}), 0);
  assert.equal(state.status, "failed");
  assert.match(state.error ?? "", /maxConcurrent is 0/);
  assert.equal(fake.seen.length, 0);
});

await check("a member's failed write stops its siblings and fails the run once, with nothing left running", async () => {
  const c = plan.compilePlan([{ id: "g", parallel: [{ id: "m1", agent: "planner", task: "one" }, { id: "m2", agent: "planner", task: "two" }, { id: "m3", agent: "planner", task: "three" }] }], roles);
  assert.ok(c.ok);
  const state = workflowMod.newRunState(c.workflow, {});
  useFake((s) => {
    if (s.task === "one") fs.mkdirSync(path.join(lastDir(state.id), "steps", "m1.md", "x"), { recursive: true });
    return s.task === "one" ? { text: "written over a directory", delayMs: 20 } : { delayMs: 60_000 };
  });
  await assert.rejects(direct(c.workflow, state, 2));
  assert.deepEqual(fake.seen.map((s) => s.task), ["one", "two"], "the queued member never starts");
  assert.equal(fake.maxLive() >= 1, true);
  await wait(30);
  assert.equal(workflowMod.loadState(project, state.id)?.status, "failed");
  assert.equal(workflowMod.loadState(project, state.id)?.steps.m2?.status, "aborted");
});

await check("the tool text says what {previous} is after expand; a default member id fits; a plan has no definition file", async () => {
  assert.match(plan.PLAN_DESCRIPTION, /after expand/);
  assert.ok(plan.PLAN_DESCRIPTION.includes(workflowMod.STEP_SHAPE), "the tool text and the expanding child read the same step shape");
  const c = plan.compilePlan([{ task: "t" }], roles);
  assert.ok(c.ok);
  assert.equal(c.workflow.file, "");
  const panel = await loadModule<typeof PanelModule>("vendor/subagent/wf-panel.ts");
  const models = await loadModule<typeof RunModelModule>("vendor/subagent/run-model.ts");
  const registry = new models.RunRegistry();
  const run = registry.start("r", "yaml", "plan", { file: c.workflow.file, source: "user" });
  assert.match(panel.planSave(run.snapshot(), project).message ?? "", /no recorded definition file/);
  for (const id of ["a", "b"]) run.phase(id);
  run.phase("a.x", "a.x", "pending", undefined, "a");
  run.phase("a.y", "a.y", "pending", undefined, "a.x");
  assert.deepEqual(run.snapshot().phases.map((p) => p.id), ["a", "a.x", "a.y", "b"], "an expansion shows where it runs");
});

await check("a path under a file is missing, not a raw error, and a run file error names no absolute path", () => {
  const compiled = plan.compilePlan([{ task: "t" }], roles);
  assert.ok(compiled.ok);
  const state = workflowMod.newRunState(compiled.workflow, {});
  const runDir = fs.mkdtempSync(path.join(ws, "enotdir-"));
  fs.mkdirSync(path.join(runDir, "steps"));
  fs.writeFileSync(path.join(runDir, "steps", "a.md"), "text");
  const render = (text: string): string => workflowMod.renderTemplate(text, { inputs: {}, state, runDir, loop: 0 });
  assert.equal(render("<{{file:steps/a.md/x?}}>"), "<>");
  assert.throws(() => render("{{file:steps/a.md/x}}"), (error: unknown) => error instanceof workflowMod.TemplateError && !error.message.includes(runDir));
});

await check("a step output past the read limit reaches a later step truncated; the run goes on", async () => {
  await session();
  useFake((s) => (s.task.startsWith("big") ? { text: "x".repeat(1_100_000) } : { text: "ok" }));
  const r = await call({ steps: [{ id: "a", agent: "scout", task: "big" }, { id: "b", agent: "scout", task: "after {previous}" }] });
  assert.equal(statusIn(textOf(r)), "passed", textOf(r));
  assert.match(fake.seen[1]?.task ?? "", /\[\.\.\. truncated at/);
});

await check("a gated group over the read limit is tested on every member's whole answer and never rejects the call", async () => {
  await session();
  useFake((s) => ({ text: `${"y".repeat(700_000)}${s.task.includes("second") ? "END-OF-B" : ""}` }));
  const r = await call({ steps: [{ id: "g", parallel: [{ id: "a", agent: "scout", task: "first" }, { id: "b", agent: "scout", task: "second" }], gate: { pass: "END-OF-B", retry: "g", max_loops: 0 } }] });
  assert.equal(statusIn(textOf(r)), "passed", textOf(r));
});

await check("state.json holds no expand answer once the step has settled", async () => {
  for (const answer of [{ done: "password hunter2 finished" }, { steps: [{ agent: "scout", task: "password hunter2 next" }] }]) {
    await session();
    useFake((s) => (s.task.startsWith("split") ? { text: asJson(answer) } : { text: "ok" }));
    const r = await call({ steps: [{ id: "split", task: "split it", expand: true }] });
    assert.equal(statusIn(textOf(r)), "passed", textOf(r));
    const text = fs.readFileSync(path.join(lastDir(runIdIn(textOf(r))), "state.json"), "utf8");
    assert.doesNotMatch(text, /expandAnswer/);
    assert.doesNotMatch(text, /hunter2/);
  }
});

await check("a plan refused for secret-shaped text names the field and never the value", async () => {
  await session();
  useFake(() => ({ text: "must not run" }));
  const r = await call({ steps: [{ id: "pk-migration", agent: "scout", task: "t" }] });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /steps\[0\]\.id/);
  assert.doesNotMatch(textOf(r), /pk-migration/);
  assert.equal(fake.seen.length, 0);
});

delegation.cleanup();
for (const r of restores.reverse()) r();
restoreKit();
rmWorkspace(ws);
if (failures.length) {
  for (const f of failures) console.error(`FAIL: ${f}`);
  process.exit(1);
}
console.log(`workflow-plan smoke: ${String(checks)} checks passed`);
process.exit(0); // the stopped fakes' reply timers would otherwise hold the process for a minute
