#!/usr/bin/env node
// Script-workflow engine hooks (packages/extensions/third_party/subagent/wf-engine.ts, docs/script-workflows.md).
//   1. agent(): the child gets the prompt over stdin and the data clause in its system prompt; plain text comes back.
//   2. parallel() and pipeline() with labels and phases; log(); telemetry phases and agents; run.json;
//      the /workflows panel (wf-panel.ts) lists the script run with its phases and agents.
//   3. schema: a StructuredOutput result comes back as an object; a bad schema makes agent() throw.
//   4. model: an unconfigured provider returns null with a log line; a configured one reaches --model.
//   5. effort maps to --thinking; agentType resolves roles and aliases; unknown values throw.
//   6. budget: agent() throws once the run's output tokens reach budget.total.
//   7. concurrency cap per run, the agent lifetime cap, and the default min(16, cpus - 2).
//   8. workflow(): one level of nesting, sharing the run's counters; nesting deeper throws.
//   9. isolation: "worktree": the agent runs in its own worktree; unchanged ones are removed, changed ones kept.
//  10. children: launch kind "workflow" at E1, depth 1, no subagent; a run without effort is refused.
//  11. workflow_control: pause holds new agents, skip makes agent() null, stop ends the run interrupted.
//  12. outcome (run-contract.ts): the host derives a run's status from what each step did, whatever the script hid;
//      refusals are omissions, so most of the cases above end partial; every surface agrees; YAML runs the same way.
// Offline: children are fakes (tests/workflow-fakes.ts) behind the real effort and delegation-guard extensions.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isolateKitEnv, loadModule, rmWorkspace, setEnv, tmpWorkspace } from "../packages/core/eval/harness.ts";
import { installDelegation } from "../packages/core/eval/delegation.ts";
import type { AgentConfig } from "../packages/extensions/third_party/subagent/agents.ts";
import type * as EngineModule from "../packages/extensions/third_party/subagent/wf-engine.ts";
import type * as RunModelModule from "../packages/extensions/third_party/subagent/run-model.ts";
import type * as ControlModule from "../packages/extensions/third_party/subagent/control.ts";
import type * as SandboxModule from "../packages/extensions/third_party/subagent/wf-sandbox.ts";
import type * as PanelModule from "../packages/extensions/third_party/subagent/wf-panel.ts";
import type * as ToolModule from "../packages/extensions/third_party/subagent/wf-tool.ts";
import type * as WorkflowModule from "../packages/extensions/third_party/subagent/workflow.ts";
import type * as ContractModule from "../packages/extensions/third_party/subagent/run-contract.ts";
import { fakeSpawner, type FakeReply, type FakeSpawn, type Spawned } from "./workflow-fakes.ts";

type Options = Omit<EngineModule.EngineOptions, "spawnChild"> & { spawnChild: FakeSpawn };
interface EngineView {
  startScriptRun(spec: EngineModule.ScriptSpec, args: unknown, opts: Options): EngineModule.StartResult;
  defaultConcurrency(): number;
  callKey: typeof EngineModule.callKey;
  WORKFLOW_AGENT_NOTE: string;
  MAX_AGENTS_PER_RUN: number;
  resolveModel: typeof EngineModule.resolveModel;
}

const restoreKit = isolateKitEnv();
const ws = tmpWorkspace("pi-kit-wf-hooks-");
const restores = [setEnv("HOME", path.join(ws, "home")), setEnv("PI_KIT_SUBAGENT_RETRIES", "0"), setEnv("PI_KIT_SUBAGENT_STATE_DIR", path.join(ws, "state"))];
const delegation = await installDelegation({ tier: "standard" });
let checks = 0;
const ok = (label: string): void => {
  checks++;
  console.log(`  OK: ${label}`);
};

const engine = await loadModule<EngineView>("vendor/subagent/wf-engine.ts");
const { RunRegistry } = await loadModule<typeof RunModelModule>("vendor/subagent/run-model.ts");
const sandboxMod = await loadModule<typeof SandboxModule>("vendor/subagent/wf-sandbox.ts");
const controlMod = await loadModule<typeof ControlModule>("vendor/subagent/control.ts");
const panelMod = await loadModule<typeof PanelModule>("vendor/subagent/wf-panel.ts");
const { formatCompletion } = await loadModule<typeof ToolModule>("vendor/subagent/wf-tool.ts");
type WorkflowView = Omit<typeof WorkflowModule, "executeWorkflow"> & {
  executeWorkflow(w: WorkflowModule.WorkflowDef, state: WorkflowModule.RunState, opts: Omit<WorkflowModule.ExecuteOptions, "spawnChild"> & { spawnChild: FakeSpawn }): Promise<WorkflowModule.RunState>;
};
const yamlMod = await loadModule<WorkflowView>("vendor/subagent/workflow.ts");
const support = sandboxMod.detectSupport();
const mode: SandboxModule.SandboxMode = support.bwrap ? "full" : "reduced";
console.log(`  (sandbox mode: ${mode})`);

const role = (name: string, tools?: string[]): AgentConfig => ({ name, description: name, systemPrompt: `You are ${name}.`, source: "kit", filePath: name, ...(tools ? { tools } : {}) });
const agents: AgentConfig[] = [role("lonely", ["subagent"]), role("implementer"), role("scout", ["read", "grep", "find", "ls", "bash"]), role("planner", ["read", "grep", "find", "ls"]), role("reviewer", ["read", "grep", "find", "ls", "bash"])];
const project = path.join(ws, "project");
fs.mkdirSync(project, { recursive: true });

const spec = (source: string, name = "hooks-test"): EngineModule.ScriptSpec => ({ name, description: "test", source: `export const meta = { name: "${name}", description: "test" };\n${source}`, phases: [] });
async function run(source: string, reply: (s: Spawned) => FakeReply, extra: Partial<Options> = {}, args?: unknown) {
  const fake = fakeSpawner(reply);
  const registry = new RunRegistry();
  const started = engine.startScriptRun(spec(source), args, { cwd: project, agents, sandbox: { mode, support }, spawnChild: fake.spawn, registry, ...extra });
  if (!started.ok) throw new Error(started.error);
  const outcome = await started.done;
  return { started, outcome, fake, registry, snapshot: registry.get(started.runId) };
}
const value = (o: EngineModule.RunOutcome, status: EngineModule.RunOutcome["status"] = "passed"): unknown => {
  assert.equal(o.status, status, `run ${o.status}: ${o.error ?? ""}`);
  return o.value;
};
/** One YAML run behind a fake child. */
async function runYaml(steps: string, reply: (s: Spawned) => FakeReply) {
  const parsed = yamlMod.parseWorkflow(`---\nname: outcome-test\ndescription: test\nsteps:\n${steps}---\n`, path.join(project, "outcome-test.md"), "user");
  assert.ok(parsed.workflow, parsed.errors.join("; "));
  const registry = new RunRegistry();
  const fake = fakeSpawner(reply);
  const state = await yamlMod.executeWorkflow(parsed.workflow, yamlMod.newRunState(parsed.workflow, {}), { cwd: project, agents, spawnChild: fake.spawn, registry, launchKind: "user" });
  return { state, workflow: parsed.workflow, snapshot: registry.get(state.id), fake };
}

try {
  // 12. Outcome. Listed first so that every case reports at once while a defect is present.
  {
    const failing = (s: Spawned): FakeReply => (s.task.startsWith("fail") ? { fail: "provider down" } : { text: s.task });
    const inParallel = await run(`return await parallel([() => agent("fail", { required: true }), () => agent("fine")])`, failing);
    const nested = await run(
      `try { await workflow("inner") } catch (e) { log(e.message) }
       return "survived"`,
      failing,
      { resolveWorkflow: async () => spec(`return await agent("fail", { required: true })`, "inner") },
    );
    const continued = await runYaml(
      `  - id: flaky
    agent: scout
    task: "fail now"
    continue_on_error: true
  - id: after
    agent: scout
    task: "fine"
`,
      failing,
    );
    let reviews = 0;
    const gated = await runYaml(
      `  - id: work
    agent: implementer
    task: "work"
  - id: review
    agent: reviewer
    task: "review"
    gate: { pass: APPROVED, retry: work, max_loops: 2 }
`,
      (s) => ({ text: s.task === "review" && ++reviews === 1 ? "NOT YET" : "APPROVED", output: 7 }),
    );
    assert.deepEqual(
      { inParallel: inParallel.outcome.status, nested: nested.outcome.status, continued: continued.state.status, gated: gated.state.status },
      { inParallel: "failed", nested: "failed", continued: "partial", gated: "passed" },
      "the host's derived status of a required failure in parallel(), one in a nested workflow(), a continue_on_error failure and a gate that passes on its second loop",
    );

    // The required failure is named although the script saw no throw; a best-effort sibling kept its value.
    assert.equal(inParallel.outcome.errorKind, "required");
    assert.match(inParallel.outcome.error ?? "", /required step implementer #1 did not complete \(failed: provider down\)/);
    assert.equal(nested.outcome.value, "survived", "the script itself ended normally");
    assert.deepEqual(nested.outcome.omissions?.map((o) => [o.execution, o.required]), [["failed", false], ["failed", true]], "the nested run and the agent inside it are both named, in call order");
    const serial = await run(`let seen; try { await agent("fail", { required: true }) } catch (e) { seen = e.message } await agent("fine"); return seen`, failing);
    assert.match(String(serial.outcome.value), /required step implementer #1 did not complete/, "a required agent throws, it does not return null");
    assert.equal(serial.outcome.status, "failed", "catching the throw does not launder the failure");
    assert.equal(serial.fake.seen.length, 2);
    const badRequired = await run(`try { await agent("x", { required: "yes" }) } catch (e) { return e.message }`, failing);
    assert.match(String(badRequired.outcome.value), /opts\.required must be a boolean/);
    assert.equal(badRequired.fake.seen.length, 0);
    const key = (opts: Record<string, unknown>): string => engine.callKey("p", opts);
    // A call the sandbox cannot pass on is still one step: it reaches the host, so no catch can hide it.
    const circularOpts = `(() => { const o = { required: true }; o.self = o; return o })()`;
    const refusedRequired = [
      `parallel([() => agent(undefined, { required: true }), () => agent("fine")])`,
      `parallel([() => agent(42, { required: true }), () => agent("fine")])`,
      `parallel([() => agent("x", ${circularOpts}), () => agent("fine")])`,
      `parallel([() => agent("y".repeat(1100000), { required: true }), () => agent("fine")])`,
      `pipeline([1], () => agent(undefined, { required: true }))`,
      `(async () => { try { await agent(42, { required: true }) } catch (e) { log(e.message) } return "went on" })()`,
    ];
    for (const call of refusedRequired) {
      const r = await run(`return await ${call}`, failing);
      assert.equal(r.outcome.status, "failed", `${call}: a required call the sandbox refused fails the run`);
      assert.equal(r.outcome.errorKind, "required", call);
      assert.deepEqual(r.outcome.omissions?.map((o) => [o.execution, o.required, o.reason?.code]), [["blocked", true, "options"]], call);
    }
    const badCalls = await run(`return await parallel([() => agent(undefined), () => agent("x", 7), () => agent("x", (() => { const o = {}; o.self = o; return o })()), () => agent("x", { get required() { throw new Error("no") }, self: 1n }), () => agent("fine")])`, failing);
    assert.deepEqual(value(badCalls.outcome, "partial"), [null, null, null, null, "fine"]);
    assert.deepEqual(badCalls.outcome.omissions?.map((o) => [o.execution, o.required, o.reason?.code]), Array.from({ length: 4 }, () => ["blocked", false, "options"]), "a best-effort bad call is a named omission");
    assert.deepEqual(badCalls.fake.seen.map((x) => x.task), ["fine"], "and launches nothing");
    const seenByScript = await run(`const seen = []; for (const bad of [() => agent(undefined), () => agent("x", []), () => agent("x", (() => { const o = {}; o.self = o; return o })()), () => agent("y".repeat(1100000))]) { try { await bad() } catch (e) { seen.push(e.message) } } return seen`, failing);
    assert.deepEqual(value(seenByScript.outcome, "partial"), ["agent(prompt, opts): prompt must be a string", "agent(prompt, opts): opts must be an object", "agent(prompt, opts): opts must be JSON-serialisable", "the call's arguments exceed 1 MiB"], "the script still sees why");
    assert.equal(key({ required: true }), key({}), "required changes the outcome, not the launch, so it leaves the journal key alone");

    // A later success does not close an omission: a retry loop cannot launder a failure.
    const retried = await run(
      `let n = 0, out = null
       while (out === null && n < 2) { n++; out = await agent(n === 1 ? "fail" : "fine") }
       return out`,
      failing,
    );
    assert.deepEqual([value(retried.outcome, "partial"), retried.outcome.omissions?.map((o) => o.execution)], ["fine", ["failed"]]);

    // Every surface says the same thing about a partial run.
    const partial = await run(`return await parallel([() => agent("fail"), () => agent("fine", { label: "good" })])`, failing);
    assert.deepEqual(value(partial.outcome, "partial"), [null, "fine"]);
    const runJson: unknown = JSON.parse(fs.readFileSync(path.join(partial.started.transcriptDir, "run.json"), "utf8"));
    assert.ok(typeof runJson === "object" && runJson !== null);
    assert.equal(Reflect.get(runJson, "status"), "partial");
    assert.deepEqual(Reflect.get(runJson, "omissions"), [{ stepId: "implementer #1", execution: "failed", required: false, reason: { code: "error", text: "provider down" } }]);
    assert.equal(partial.snapshot?.status, "partial");
    const text = formatCompletion(partial.outcome);
    assert.match(text, /^Workflow hooks-test \(run wf-[a-z0-9-]+\) partial\.\n/);
    assert.match(text, /<untrusted source="workflow-result">[\s\S]*"fine"/, "a partial run shows its value");
    assert.match(text, /<untrusted source="workflow-omissions">[\s\S]*implementer #1 failed: provider down/, "and names what is missing");
    assert.match(text, /Resume with workflow/, "resume retries a failed step");
    assert.equal(panelMod.tone("partial"), "warn");
    assert.ok(panelMod.renderText(partial.registry, new panelMod.Narrator()).includes("partial"), "the panel renders partial");

    // The resume line appears only when a resume can help.
    const refused = await run(`await agent("x", { agentType: "wizard" }).catch(() => null); return "went on"`, failing);
    assert.deepEqual([value(refused.outcome, "partial"), refused.outcome.omissions?.map((o) => [o.execution, o.reason?.code])], ["went on", [["blocked", "unknown-role"]]]);
    assert.ok(!/Resume with/.test(formatCompletion(refused.outcome)), "the same refusal would come back");
    const syntax = await run(`return (`, failing);
    assert.equal(syntax.outcome.status, "failed");
    assert.ok(!/Resume with/.test(formatCompletion(syntax.outcome)), "a script that does not compile cannot be resumed");

    // Failed, with an omission and no value.
    const empty = await run(`return await agent("fail")`, failing);
    assert.equal(empty.outcome.errorKind, "omitted");
    assert.match(empty.outcome.error ?? "", /no result, and 1 step did not complete: implementer #1/);

    // A result the sandbox cannot carry back is an omission too, so a swallowed throw cannot hide it.
    const big = (s: Spawned): FakeReply => ({ text: s.task === "big" ? "x".repeat(1_100_000) : "ok" });
    const oversized = await run(`return await parallel([() => agent("big"), () => agent("fine")])`, big);
    assert.deepEqual(value(oversized.outcome, "partial"), [null, "ok"]);
    assert.deepEqual(oversized.outcome.omissions?.map((o) => [o.execution, o.required, o.reason?.code]), [["failed", false, "result-too-large"]]);
    assert.ok(!/Resume with/.test(formatCompletion(oversized.outcome)), "a resume replays the same journaled result");
    const oversizedRequired = await run(`let seen; try { await agent("big", { required: true }) } catch (e) { seen = e.message } return seen ?? "went on"`, big);
    assert.equal(oversizedRequired.outcome.status, "failed", "a required result over the cap fails the run although the throw was caught");
    assert.equal(oversizedRequired.outcome.errorKind, "required");
    assert.match(String(oversizedRequired.outcome.value), /required step implementer #1 did not complete \(failed: the agent's result exceeds 1 MiB\)/);
    const oversizedNested = await run(
      `try { await workflow("inner") } catch (e) { log(e.message) }
       return "went on"`,
      big,
      { resolveWorkflow: async () => spec(`return "y".repeat(1100000)`, "inner") },
    );
    assert.equal(oversizedNested.outcome.status, "partial", "a nested result over the cap is an omission");
    assert.deepEqual(oversizedNested.outcome.omissions?.map((o) => [o.execution, o.reason?.code]), [["failed", "limit"]], "the runner refuses it before the host sees a value");

    // Run files keep a redacted label, like the log lines and the completion fence.
    const secret = ["sk", "ant", "api03", "A".repeat(95)].join("-");
    const leaky = await run(`return await parallel([() => agent("fail", { label: ${JSON.stringify(secret)} }), () => agent("fine")])`, failing);
    for (const file of ["run.json", "journal.jsonl"]) assert.ok(!fs.readFileSync(path.join(leaky.started.transcriptDir, file), "utf8").includes(secret), `${file} holds no secret-shaped label`);

    // What a script can make the host keep is bounded, like every other sandbox channel.
    const flood = await run(`let n = 0; while (n++ < 20000) { try { await agent(undefined) } catch {} } return null`, failing);
    assert.equal(flood.outcome.status, "failed");
    assert.equal(flood.outcome.errorKind, "omitted");
    assert.match(flood.outcome.error ?? "", /no result, and 20000 steps did not complete: .* and 19980 more$/);
    assert.equal((flood.outcome.error ?? "").split(": ")[1]?.split(", ").length, 20, "the error names twenty steps");
    assert.equal(flood.outcome.omissionCount, 20000);
    assert.ok((flood.outcome.omissions?.length ?? 0) <= 10000, "steps stay bounded");
    const floodJson: unknown = JSON.parse(fs.readFileSync(path.join(flood.started.transcriptDir, "run.json"), "utf8"));
    assert.ok(typeof floodJson === "object" && floodJson !== null);
    const floodList: unknown = Reflect.get(floodJson, "omissions");
    assert.ok(Array.isArray(floodList));
    assert.deepEqual([floodList.length, Reflect.get(floodJson, "omissionCount")], [200, 20000]);
    assert.match(formatCompletion(flood.outcome), /<untrusted source="workflow-omissions">[\s\S]*?```\n20000 steps did not complete; the first 20:/);
    const requiredFlood = await run(`let n = 0; while (n++ < 10100) { try { await agent(undefined, { required: true }) } catch {} } return "went on"`, failing);
    assert.equal(requiredFlood.outcome.status, "failed", "a dropped required refusal still fails the run");
    assert.equal(requiredFlood.outcome.omissionCount, 10100);
    assert.ok((requiredFlood.outcome.omissions?.length ?? 0) <= 10000);
    const hugeRefusal = await run(`await agent("x", { agentType: "z".repeat(500000) }).catch(() => null); return "went on"`, failing);
    assert.ok((hugeRefusal.outcome.omissions?.[0]?.reason?.text.length ?? 0) <= 1000, "a refusal keeps a bounded reason");

    // Agents still running when the script returns are stopped with the run, and that is an omission.
    const orphan = await run(`agent("slow"); await agent("fine", { label: "quick" }); return "done"`, (s) => ({ text: s.task, delayMs: s.task === "slow" ? 2000 : 0 }));
    assert.deepEqual([value(orphan.outcome, "partial"), orphan.outcome.omissions?.map((o) => [o.execution, o.reason?.code])], ["done", [["cancelled", "run-ended"]]]);

    // The YAML surfaces.
    assert.deepEqual(continued.snapshot?.status, "partial", "the run model agrees");
    assert.equal(continued.state.steps.flaky?.status, "failed");
    assert.equal(continued.state.steps.after?.status, "passed");
    const onDisk = yamlMod.loadState(project, continued.state.id);
    assert.equal(onDisk?.status, "partial", "state.json agrees and still loads");
    assert.match(yamlMod.summarizeRun(continued.state, continued.workflow), /· partial/);
    assert.match(yamlMod.summarizeRun(gated.state, gated.workflow), /^Agents: 4 launched; 28 output tokens\.$/m, "a YAML completion reports agents and output tokens");
    const requiredYaml = await runYaml(`  - id: must\n    agent: scout\n    task: "fail now"\n`, failing);
    assert.equal(requiredYaml.state.status, "failed");
    assert.match(requiredYaml.state.error ?? "", /step must failed: provider down/);
    const whenSkip = await runYaml(`  - id: first\n    agent: scout\n    task: "fine"\n  - id: maybe\n    agent: scout\n    task: "fine"\n    when: { step: first, status: failed }\n`, failing);
    assert.equal(whenSkip.state.status, "passed", "a when skip is the plan working, not an omission");
    const group = await runYaml(`  - id: fan\n    parallel:\n      - id: p1\n        agent: scout\n        task: "fail now"\n        continue_on_error: true\n      - id: p2\n        agent: scout\n        task: "fine"\n`, failing);
    assert.equal(group.state.status, "partial", "a parallel member is a step of its own");

    // The contract's table, first match wins.
    const { deriveOutcome } = await loadModule<typeof ContractModule>("vendor/subagent/run-contract.ts");
    const step = (execution: ContractModule.Execution, required = false): ContractModule.StepResult => ({ stepId: "s", execution, required, usage: { agents: 1, outputTokens: 0 } });
    const clean = { threw: false, stopped: false, value: 1 };
    const status = (steps: ContractModule.StepResult[], end: Partial<typeof clean> | { value: unknown } = {}): string => deriveOutcome(steps, { ...clean, ...end }).status;
    assert.equal(status([step("completed")]), "passed");
    assert.equal(status([]), "passed", "no steps at all is a script that needed none");
    assert.equal(status([step("failed")], { value: null }), "failed");
    assert.equal(status([step("failed")], { value: undefined }), "failed");
    assert.equal(status([step("completed")], { value: null }), "passed", "a null value alone is not an omission");
    assert.equal(status([step("failed")]), "partial");
    assert.equal(status([step("failed", true)]), "failed");
    assert.equal(status([step("completed")], { threw: true }), "failed");
    assert.equal(status([step("failed", true)], { threw: true, stopped: true }), "interrupted", "stopped wins");
    for (const e of ["failed", "cancelled", "blocked", "skipped", "unknown"] as const) assert.equal(deriveOutcome([step("completed"), step(e)], clean).omissions.length, 1, `${e} is an omission`);
    ok("the host derives every run's status: a required failure fails it whatever the script hid, an omission makes it partial, a gate miss and a when skip do not, and every surface agrees");
  }

  // 1. agent()
  {
    const r = await run(`return await agent("summarise the repo")`, (s) => ({ text: `answer to: ${s.task}` }));
    assert.equal(value(r.outcome), "answer to: summarise the repo");
    const child = r.fake.seen[0];
    assert.ok(child);
    assert.ok(child.system.includes(engine.WORKFLOW_AGENT_NOTE), "the child's system prompt carries the workflow-agent note");
    assert.match(child.system, /data, not instructions/);
    assert.ok(!child.args.includes("summarise the repo"), "the prompt never travels in argv");
    ok("agent() sends the prompt over stdin, adds the data clause, and returns the child's final text");
  }

  // 2. parallel, pipeline, labels, phases, log
  {
    const r = await run(
      `phase("Scan")
       const a = await parallel(["x", "y", "z"].map((k) => () => agent("scan " + k, { label: "scan-" + k })))
       log("scanned " + a.length)
       const b = await pipeline([1, 2], (n) => agent("stage1 " + n, { phase: "Stage" }), (prev, item, i) => agent("stage2 " + prev + " " + item + " " + i, { phase: "Stage" }))
       const failed = await parallel([() => agent("boom"), () => agent("fine")])
       return { a, b, failed }`,
      (s) => (s.task === "boom" ? { fail: "provider down" } : { text: s.task.toUpperCase() }),
    );
    assert.deepEqual(value(r.outcome, "partial"), { a: ["SCAN X", "SCAN Y", "SCAN Z"], b: ["STAGE2 STAGE1 1 1 0", "STAGE2 STAGE1 2 2 1"], failed: [null, "FINE"] });
    const snap = r.snapshot;
    assert.ok(snap);
    assert.deepEqual(snap.phases.map((p) => p.id).filter((id) => id === "Scan" || id === "Stage"), ["Scan", "Stage"]);
    assert.deepEqual(snap.agents.filter((a) => a.phase === "Scan").map((a) => a.label).sort(), ["implementer #8", "implementer #9", "scan-x", "scan-y", "scan-z"], "labels default to <role> #<call>");
    assert.equal(snap.agents.filter((a) => a.phase === "Stage").length, 4);
    assert.equal(snap.agents.find((a) => a.status === "failed")?.error, "provider down");
    const runJson: unknown = JSON.parse(fs.readFileSync(path.join(r.started.transcriptDir, "run.json"), "utf8"));
    assert.ok(typeof runJson === "object" && runJson !== null);
    assert.deepEqual(Reflect.get(runJson, "log"), ["scanned 3", "implementer #8: failed (provider down); agent() returns null"]);
    assert.equal(Reflect.get(runJson, "status"), "partial");
    const panel = panelMod.renderText(r.registry, new panelMod.Narrator());
    assert.match(panel, /Workflows \(1 run/, "the /workflows panel lists the script run");
    assert.ok(panel.includes(r.started.runId) && panel.includes("hooks-test"), "the panel shows the script run's id and name");
    assert.match(panel, /Scan/);
    assert.ok(panel.includes("scan-x"), "the panel shows the script run's agents");
    ok("parallel() and pipeline() run agents with labels and phases; a failed agent is null; log() lines and telemetry are recorded; /workflows shows the run");
  }

  // 3. schema
  {
    const schema = { type: "object", properties: { verdict: { type: "string", enum: ["pass", "fail"] } }, required: ["verdict"] };
    const r = await run(
      `const good = await agent("judge", { schema: ${JSON.stringify(schema)} })
       let bad
       try { await agent("judge", { schema: { type: "array" } }) } catch (e) { bad = e.message }
       return { good, bad }`,
      () => ({ structured: { verdict: "pass" }, text: "ignored" }),
    );
    const v = value(r.outcome, "partial");
    assert.ok(typeof v === "object" && v !== null);
    assert.deepEqual(Reflect.get(v, "good"), { verdict: "pass" });
    assert.match(String(Reflect.get(v, "bad")), /root must have "type": "object"/);
    assert.equal(r.fake.seen.length, 1, "a bad schema launches nothing");
    ok("schema returns the validated StructuredOutput object; an unsupported schema makes agent() throw before any launch");
  }

  // 4. model (T10)
  {
    const r = await run(
      `const a = await agent("x", { model: "elsewhere/big" })
       const b = await agent("y", { model: "local/small" })
       const c = await agent("z", { model: "small" })
       return [a, b, c]`,
      (s) => ({ text: s.task }),
      { availableModels: () => [{ provider: "local", id: "small" }] },
    );
    assert.deepEqual(value(r.outcome, "partial"), [null, "y", "z"]);
    assert.equal(r.fake.seen.length, 2);
    for (const child of r.fake.seen) assert.equal(child.args[child.args.indexOf("--model") + 1], "local/small");
    const log: unknown = Reflect.get(Object(JSON.parse(fs.readFileSync(path.join(r.started.transcriptDir, "run.json"), "utf8"))), "log");
    assert.ok(Array.isArray(log) && log.some((l) => /model "elsewhere\/big" refused \(provider "elsewhere" is not configured in this session\)/.test(String(l))));
    assert.deepEqual(engine.resolveModel("a/b", undefined), { ok: false, why: "the session's configured providers are unknown" });
    ok("a model whose provider is not configured returns null with a log line; a configured one reaches --model");
  }

  // 5. effort and agentType
  {
    const r = await run(
      `const out = []
       out.push(await agent("e", { effort: "max" }))
       out.push(await agent("t", { agentType: "Explore" }))
       out.push(await agent("p", { agentType: "planner" }))
       for (const bad of [{ effort: "huge" }, { agentType: "wizard" }, { isolation: "vm" }, { label: 3 }]) {
         try { await agent("bad", bad); out.push("no throw") } catch (e) { out.push(e.message) }
       }
       return out`,
      (s) => ({ text: s.task }),
    );
    const v = value(r.outcome, "partial");
    assert.ok(Array.isArray(v));
    assert.deepEqual(v.slice(0, 3), ["e", "t", "p"]);
    assert.match(String(v[3]), /opts\.effort must be one of/);
    assert.match(String(v[4]), /unknown agentType "wizard"/);
    assert.match(String(v[5]), /opts\.isolation must be "worktree"/);
    assert.match(String(v[6]), /opts\.label must be a string/);
    const [e, t, p] = r.fake.seen;
    assert.ok(e && t && p);
    assert.equal(e.args[e.args.indexOf("--thinking") + 1], "xhigh", "effort max maps to thinking xhigh");
    assert.equal(t.args[t.args.indexOf("--tools") + 1], "read,grep,find,ls,bash", "Explore is the scout role");
    assert.equal(p.args[p.args.indexOf("--tools") + 1], "read,grep,find,ls");
    assert.ok(!e.args.includes("--tools"), "the default role (implementer) has every tool");
    ok("effort maps to --thinking, agentType resolves kit roles and aliases, and bad options throw into the script");
  }

  // 6. budget
  {
    const r = await run(
      `const got = []
       try { for (let i = 0; i < 5; i++) got.push(await agent("b" + i)) } catch (e) { got.push(e.message) }
       return { got, spent: budget.spent(), total: budget.total, remaining: budget.remaining() }`,
      () => ({ text: "t", output: 10 }),
      { budgetTotal: 15 },
    );
    assert.deepEqual(value(r.outcome, "partial"), { got: ["t", "t", "budget exhausted: 20 of 15 output tokens spent"], spent: 20, total: 15, remaining: 0 });
    assert.deepEqual(r.outcome.omissions?.map((o) => [o.execution, o.reason?.code]), [["blocked", "budget"]], "the refusal reaches the host: the check left the prelude");
    assert.equal(r.outcome.outputTokens, 20);
    const none = await run(`return [budget.total, budget.remaining() === Infinity]`, () => ({}));
    assert.deepEqual(value(none.outcome), [null, true]);
    ok("budget counts the run's output tokens and agent() throws once budget.total is reached; with no total it is null and Infinity");
  }

  // 7. concurrency and the lifetime cap
  {
    const r = await run(`return (await parallel([1, 2, 3, 4, 5, 6].map((i) => () => agent("c" + i)))).length`, () => ({ text: "c", delayMs: 60 }), { concurrency: 2 });
    assert.equal(value(r.outcome), 6);
    assert.equal(r.fake.maxLive(), 2, "never more than the cap at once");
    const capped = await run(
      `const out = []
       try { for (let i = 0; i < 5; i++) out.push(await agent("n" + i)) } catch (e) { out.push(e.message) }
       return out`,
      () => ({ text: "n" }),
      { maxAgents: 3 },
    );
    assert.deepEqual(value(capped.outcome, "partial"), ["n", "n", "n", "agent limit reached: this run has started 3 agents (limit 3)"]);
    assert.deepEqual(capped.outcome.omissions?.map((o) => [o.execution, o.reason?.code]), [["blocked", "agent-limit"]]);
    assert.equal(engine.defaultConcurrency(), Math.max(1, Math.min(16, os.availableParallelism() - 2)));
    assert.equal(engine.MAX_AGENTS_PER_RUN, 1000);
    ok("concurrency is capped per run (default min(16, cpus - 2)) and the run's agent lifetime cap throws");
  }

  // 8. workflow() nesting
  {
    const child = spec(`phase("Inner")
      const a = await agent("inner " + args.n)
      let deeper
      try { await workflow("again") } catch (e) { deeper = e.message }
      return { a, deeper }`, "child");
    const r = await run(
      `const v = await workflow("child", { n: 7 })
       let missing
       try { await workflow("nope") } catch (e) { missing = e.message }
       return { v, missing }`,
      (s) => ({ text: s.task }),
      { resolveWorkflow: async (ref) => { if (ref === "child") return { ...child, phases: [] }; throw new Error(`Unknown script workflow "${typeof ref === "string" ? ref : ref.scriptPath}".`); } },
    );
    assert.deepEqual(value(r.outcome, "partial"), { v: { a: "inner 7", deeper: "workflow(): nesting is one level only; a nested workflow cannot call workflow()" }, missing: 'Unknown script workflow "nope".' });
    assert.ok(r.snapshot?.phases.some((p) => p.id === "▸ child"), "the nested run shows as a ▸ group");
    assert.ok(r.snapshot?.agents.some((a) => a.phase === "▸ child · Inner"), "its phases sit under the group");
    assert.equal(r.outcome.launched, 1, "the nested agent counts toward the run");
    ok("workflow() runs a nested script one level deep, under a ▸ group, sharing the run's counters");
  }

  // 9. worktree isolation
  {
    const repo = path.join(ws, "repo");
    fs.mkdirSync(repo);
    const git = (...a: string[]): string => execFileSync("git", a, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" } }).trim();
    git("init", "-q", "-b", "main");
    fs.writeFileSync(path.join(repo, ".gitignore"), ".pi/\n");
    fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    const r = await run(
      `return await parallel([() => agent("leave it", { isolation: "worktree" }), () => agent("change it", { isolation: "worktree" })])`,
      (s) => (s.task === "change it" ? { text: s.cwd, write: { file: "a.txt", text: "changed\n" } } : { text: s.cwd }),
      { cwd: repo },
    );
    const cwds = value(r.outcome);
    assert.ok(Array.isArray(cwds));
    for (const c of cwds) assert.match(String(c), /\.pi\/worktrees\/wf-[a-z0-9-]+\/\d$/, "each isolated agent runs in its own worktree");
    for (const seen of r.fake.seen) assert.equal(seen.env.PI_KIT_HUMAN_CONSOLE_DIR, path.resolve(repo, ".pi", "human-console"), "a worktree agent files approvals with the starting session's console");
    assert.equal(fs.readFileSync(path.join(repo, "a.txt"), "utf8"), "a\n", "the main checkout is untouched");
    assert.equal(r.outcome.keptWorktrees.length, 1, "the changed worktree is kept");
    assert.equal(r.outcome.keptWorktrees[0]?.reason, "uncommitted changes");
    assert.ok(!fs.existsSync(String(cwds[0])), "the unchanged worktree is removed");
    assert.match(git("branch", "--list", "luna/wf/*"), new RegExp(`luna/wf/${r.started.runId}/`), "the kept branch stays, never merged");
    ok("isolation: worktree runs agents in their own worktrees; unchanged ones are removed, changed ones kept unmerged");
  }

  // 10. children and effort
  {
    const r = await run(`return await agent("who")`, () => ({ text: "me" }));
    const child = r.fake.seen[0];
    assert.ok(child);
    assert.equal(child.env.PI_KIT_EFFORT, "minimal", "workflow agents run at E1");
    assert.equal(child.env.PI_KIT_SUBAGENT_DEPTH, "1");
    assert.equal(child.env.PI_KIT_SUBAGENT_MAX_DEPTH, "1", "and cannot delegate further");
    assert.equal(child.env.PI_KIT_WORKFLOW_RUN_ID, r.started.runId, "and names its run, for the run-scoped approval broker");
    assert.ok(!child.args.some((a) => a.endsWith(`${path.sep}subagent${path.sep}index.ts`)), "no subagent extension");
    assert.match(String(child.env.PI_KIT_EFFORT_LEDGER), /-workflows\.json$/, "charged to the run's pinned workflow scope");
    const refused = engine.startScriptRun(spec(`return 1`), undefined, { cwd: project, agents, sandbox: { mode, support }, spawnChild: fakeSpawner(() => ({})).spawn, effort: null });
    assert.equal(refused.ok, false);
    assert.match(refused.ok ? "" : refused.error, /need the effort extension/);
    const dir = r.started.transcriptDir;
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700, "the run directory is private");
    for (const f of ["journal.jsonl", "run.json", "script.js"]) assert.equal(fs.statSync(path.join(dir, f)).mode & 0o777, 0o600, `${f} is private`);
    ok("children run as workflow launches at E1, depth 1, without subagent; a run without effort is refused; run files are private");
  }

  // 10b. A role left with no tool once subagent is dropped is refused, not widened to every tool.
  {
    const r = await run(`try { await agent("x", { agentType: "lonely" }); return "ran" } catch (e) { return e.message }`, () => ({ text: "x" }));
    assert.match(String(value(r.outcome, "partial")), /role "lonely" has no tool a workflow agent may use/);
    assert.deepEqual(r.outcome.omissions?.map((o) => [o.execution, o.reason?.code]), [["blocked", "denied"]]);
    assert.equal(r.fake.seen.length, 0);
    ok("a role whose only tool is subagent is refused rather than run with every tool");
  }

  // 11. workflow_control
  {
    const controls = new controlMod.ControlRegistry();
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const fake = fakeSpawner((s) => ({ text: s.task, delayMs: s.task === "slow" ? 2000 : 150 }));
    const started = engine.startScriptRun(spec(`const a = await agent("one"); const b = await agent("two"); const c = await agent("slow"); return [a, b, c]`), undefined, { cwd: project, agents, sandbox: { mode, support }, spawnChild: fake.spawn, controls });
    assert.ok(started.ok);
    for (let i = 0; i < 200 && fake.seen.length < 1; i++) await wait(10);
    assert.equal(controlMod.controlRun(started.runId, "pause", controls).ok, true);
    await wait(600);
    assert.deepEqual(fake.seen.map((x) => x.task), ["one"], "a paused run starts no new agent");
    assert.equal(controlMod.controlRun(started.runId, "resume", controls).ok, true);
    for (let i = 0; i < 300 && fake.seen.length < 3; i++) await wait(10);
    assert.equal(controlMod.controlRun(started.runId, "skip", controls).ok, true);
    const o = await started.done;
    assert.deepEqual(value(o), ["one", "two", null], "a skipped agent resolves to null");
    const stopFake = fakeSpawner(() => ({ text: "x", delayMs: 2000 }));
    const stopping = engine.startScriptRun(spec(`return await agent("long")`), undefined, { cwd: project, agents, sandbox: { mode, support }, spawnChild: stopFake.spawn, controls });
    assert.ok(stopping.ok);
    for (let i = 0; i < 200 && stopFake.seen.length < 1; i++) await wait(10);
    assert.equal(controlMod.controlRun(stopping.runId, "stop", controls).ok, true);
    assert.equal((await stopping.done).status, "interrupted");
    ok("workflow_control: pause holds new agents, skip resolves the running agent to null, stop ends the run interrupted");

    // A skip does not excuse a required step, or the governed model could launder one to `passed`.
    for (const source of [`const v = await agent("slow", { required: true, label: "must" }); return { v }`, `try { await agent("slow", { required: true, label: "must" }) } catch (e) { log(e.message) } return "went on"`]) {
      const skipFake = fakeSpawner((s) => ({ text: s.task, delayMs: 2000 }));
      const skipping = engine.startScriptRun(spec(source), undefined, { cwd: project, agents, sandbox: { mode, support }, spawnChild: skipFake.spawn, controls });
      assert.ok(skipping.ok);
      for (let i = 0; i < 200 && skipFake.seen.length < 1; i++) await wait(10);
      assert.equal(controlMod.controlRun(skipping.runId, "skip", controls).ok, true);
      const skipped = await skipping.done;
      assert.equal(skipped.status, "failed", source);
      assert.match(skipped.error ?? "", /required step must did not complete \(skipped: operator\)/);
      assert.deepEqual(skipped.omissions?.map((x) => [x.stepId, x.execution, x.required]), [["must", "skipped", true]]);
    }
    ok("workflow_control: a skipped required agent throws into the script and fails the run, named, even if the script catches it");
  }

  console.log(`\nworkflow-hooks-smoke: ${checks} checks passed`);
} finally {
  delegation.cleanup();
  for (const restore of restores.reverse()) restore();
  restoreKit();
  rmWorkspace(ws);
}
