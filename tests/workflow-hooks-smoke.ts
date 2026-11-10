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
//  11. workflow_control: pause holds new agents (queued ones too), skip makes agent() null, stop ends the run
//      interrupted (inside a nested workflow() as well).
//  12. outcome (run-contract.ts): the host derives a run's status from what each step did, whatever the script hid;
//      refusals are omissions, so most of the cases above end partial; every surface agrees; YAML runs the same way.
//  13. the S4 and S5 review findings: admission is the last step before a launch, a script's leftovers stop with it,
//      the end of a run waits for what it stopped, every refused call is a named step, and refusals have a limit.
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

const makeRepo = (): string => {
  const repo = fs.mkdtempSync(path.join(ws, "repo-"));
  const git = (...a: string[]): void => { execFileSync("git", a, { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" } }); };
  git("init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, ".gitignore"), ".pi/\n");
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  return repo;
};

try {
  // 13. The S4 and S5 review findings, one case each. Each reports alone, so that one red run names them all.
  {
    const misses: string[] = [];
    const finding = async (id: string, fn: () => Promise<void>): Promise<void> => {
      try {
        await fn();
        console.log(`  OK: ${id}`);
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        misses.push(id);
        console.log(`  MISS: ${id}: ${text.split("\n").slice(0, 3).join(" ")}`);
      }
    };
    const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
    const until = async (cond: () => boolean, ms = 20_000): Promise<void> => {
      for (let i = 0; i < ms / 10 && !cond(); i++) await wait(10);
      assert.ok(cond(), "timed out");
    };
    const live = (source: string, reply: (s: Spawned) => FakeReply, extra: Partial<Options> = {}) => {
      const fake = fakeSpawner(reply);
      const controls = new controlMod.ControlRegistry();
      const started = engine.startScriptRun(spec(source), undefined, { cwd: project, agents, sandbox: { mode, support }, spawnChild: fake.spawn, controls, ...extra });
      assert.ok(started.ok);
      return { started, fake, controls };
    };
    const planner = `agentType: "planner"`;
    const readJson = (file: string): unknown => JSON.parse(fs.readFileSync(file, "utf8"));
    const field = (value: unknown, key: string): unknown => (typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined);
    const codes = (o: EngineModule.RunOutcome): Array<[string, string | undefined]> | undefined => o.omissions?.map((s) => [s.execution, s.reason?.code]);
    const outcomeOf = (o: Partial<EngineModule.RunOutcome>): EngineModule.RunOutcome => ({ runId: "wf-x", name: "n", status: "failed", scriptPath: "/s.js", transcriptDir: "/t", journalPath: "/j", launched: 1, cached: 0, outputTokens: 1, keptWorktrees: [], ...o });
    const omitted = (execution: ContractModule.Execution, code: string, required = false): ContractModule.StepResult => ({ stepId: "s", execution, required, reason: { code, text: code }, usage: { agents: 0, outputTokens: 0 } });
    const canResume = (o: Partial<EngineModule.RunOutcome>): boolean => /Resume with workflow/.test(formatCompletion(outcomeOf(o)));
    const parseYaml = (steps: string) => yamlMod.parseWorkflow(`---\nname: outcome-test\ndescription: test\nsteps:\n${steps}---\n`, path.join(project, "outcome-test.md"), "user");
    const skipYaml = async (origin: ControlModule.ControlOrigin, continueOnError = false) => {
      const parsed = parseYaml(`  - id: must\n    agent: scout\n    task: "must do"\n${continueOnError ? "    continue_on_error: true\n" : ""}  - id: after\n    agent: scout\n    task: "after"\n`);
      assert.ok(parsed.workflow);
      const controls = new controlMod.ControlRegistry();
      const state = yamlMod.newRunState(parsed.workflow, {});
      const { control, close } = controls.open(state.id);
      const fake = fakeSpawner((s) => (s.task.startsWith("must") ? { text: "x", delayMs: 2000 } : { text: "ok" }));
      const running = yamlMod.executeWorkflow(parsed.workflow, state, { cwd: project, agents, spawnChild: fake.spawn, registry: new RunRegistry(), launchKind: "user", control });
      await until(() => fake.seen.length > 0);
      assert.equal(controlMod.controlRun(state.id, "skip", controls, origin).ok, true);
      const final = await running;
      close();
      return { final, workflow: parsed.workflow };
    };

    await finding("r01 an agent's skip of a required YAML step is an omission, an operator's keeps today's meaning", async () => {
      const agentSkip = await skipYaml("agent");
      assert.equal(agentSkip.final.status, "partial");
      assert.deepEqual(yamlMod.stepResults(agentSkip.workflow, agentSkip.final).filter((s) => s.execution !== "completed").map((s) => [s.stepId, s.execution, s.required]), [["must", "skipped", false]]);
      assert.equal(yamlMod.loadState(project, agentSkip.final.id)?.status, "partial", "state.json agrees");
      assert.equal((await skipYaml("operator")).final.status, "passed");
      assert.equal((await skipYaml("agent", true)).final.status, "passed", "a best-effort step may be skipped");
    });
    await finding("r02 a writer waiting on the checkout lock does not start during a pause", async () => {
      const { started, fake, controls } = live(`return await parallel([() => agent("w1"), () => agent("w2")])`, (s) => ({ text: s.task, delayMs: 300 }), { cwd: makeRepo(), concurrency: 2 });
      await until(() => fake.seen.length > 0);
      controlMod.controlRun(started.runId, "pause", controls);
      await wait(900);
      assert.equal(fake.seen.length, 1, "only the first writer started before the pause");
      controlMod.controlRun(started.runId, "resume", controls);
      assert.deepEqual(value(await started.done), ["w1", "w2"]);
    });
    await finding("r02b r11 a pause holds a worktree agent past its slot wait; a skip or stop in the wait is that, not a failure", async () => {
      const repo = makeRepo();
      const holders = live(`return await parallel(Array.from({ length: 16 }, (_, i) => () => agent("h" + i, { isolation: "worktree" })))`, () => ({ text: "ok", delayMs: 2500 }), { cwd: repo, concurrency: 16 });
      await until(() => holders.fake.seen.length === 16, 30_000);
      const waiter = `let r; try { r = await agent("waiter", { isolation: "worktree" }) } catch (e) { return "threw: " + e.message } return r`;
      const paused = live(waiter, (s) => ({ text: s.task }), { cwd: repo });
      const skipped = live(waiter, (s) => ({ text: s.task }), { cwd: repo });
      const stopped = live(waiter, (s) => ({ text: s.task }), { cwd: repo });
      await until(() => [paused, skipped, stopped].every((r) => r.controls.get(r.started.runId)?.running().length === 1));
      controlMod.controlRun(paused.started.runId, "pause", paused.controls);
      assert.equal(controlMod.controlRun(skipped.started.runId, "skip", skipped.controls).ok, true);
      assert.equal(controlMod.controlRun(stopped.started.runId, "stop", stopped.controls).ok, true);
      const skip = await skipped.started.done;
      const stop = await stopped.started.done;
      await holders.started.done;
      await wait(300);
      assert.equal(paused.fake.seen.length, 0, "the slot came free during the pause");
      controlMod.controlRun(paused.started.runId, "resume", paused.controls);
      assert.equal(value(await paused.started.done), "waiter");
      assert.deepEqual([skip.status, skip.value, skip.omissions ?? [], skipped.fake.seen.length], ["passed", null, [], 0], "a skip of a best-effort call is no omission and no throw");
      assert.deepEqual([stop.status, codes(stop), stopped.fake.seen.length], ["interrupted", [["cancelled", "stopped"]], 0]);
    });
    await finding("r16 writers queued on the lock are checked against the budget when their turn comes", async () => {
      let n = 0;
      const r = await run(`return await parallel([1, 2, 3, 4, 5, 6].map((i) => () => agent("w" + i)))`, () => (++n === 1 ? { text: "ok", output: 1 } : { text: "ok", output: 1000 }), { cwd: makeRepo(), concurrency: 4, budgetTotal: 100 });
      assert.equal(r.fake.seen.length, 2);
      assert.equal(r.outcome.outputTokens, 1001);
      assert.ok(codes(r.outcome)?.every(([e, c]) => e === "blocked" && c === "budget"), JSON.stringify(codes(r.outcome)));
    });
    await finding("r03 r03b a script's leftover calls stop with that script", async () => {
      const order: string[] = [];
      const returned = await run(`const v = await workflow("n"); const c = await agent("parent"); return [v, c]`, (s) => { order.push(s.task); return { text: s.task, delayMs: 200 }; }, { concurrency: 1, resolveWorkflow: async () => spec(`agent("n1"); agent("n2"); return "early"`, "n") });
      assert.deepEqual(value(returned.outcome, "partial"), ["early", "parent"]);
      assert.ok(!order.includes("n2"), order.join());
      order.length = 0;
      const died = await run(`let r; try { r = await workflow("child") } catch (e) { r = "caught" } await agent("parent", { ${planner} }); return r`, (s) => { order.push(s.task); return { text: s.task, delayMs: 200 }; }, { concurrency: 1, resolveWorkflow: async () => spec(`agent("n1", { ${planner} }); agent("n2", { ${planner} }); agent("n3", { ${planner} }); throw new Error("boom")`, "child") });
      assert.deepEqual(value(died.outcome, "partial"), "caught");
      assert.ok(!order.includes("n2") && !order.includes("n3"), order.join());
    });
    await finding("r23 calls sent just before the return are stopped, not started, charged and killed", async () => {
      const r = await run(`agent("a", { ${planner} }); agent("b", { ${planner} }); agent("c", { ${planner} }); return 1`, () => ({ text: "ok", delayMs: 500 }), { concurrency: 4 });
      assert.equal(value(r.outcome, "partial"), 1);
      // The calls share the script's last slice, so the host reads its end before starting any of them.
      assert.equal(r.outcome.launched, 0, `launched ${String(r.outcome.launched)}`);
      assert.equal(r.outcome.outputTokens, 0);
      assert.deepEqual(codes(r.outcome), [["cancelled", "run-ended"], ["cancelled", "run-ended"], ["cancelled", "run-ended"]]);
    });
    await finding("r04 r04b the resume line judges the failure that ended the run as well as the omissions", async () => {
      assert.equal(canResume({ error: "x", errorKind: "crash", omissions: [omitted("blocked", "model-refused")] }), true, "a crash keeps it");
      assert.equal(canResume({ error: "x", errorKind: "required", omissions: [omitted("blocked", "unknown-role", true), omitted("failed", "error")] }), false, "a required refusal comes back");
      assert.equal(canResume({ status: "partial", omissions: [omitted("failed", "syntax")] }), false, "a nested script that does not compile fails the same way");
      assert.equal(canResume({ status: "partial", omissions: [omitted("blocked", "agent-limit")] }), true, "a new scope clears the per-run total");
      assert.equal(canResume({ error: "x", errorKind: "syntax", omissions: [omitted("failed", "error")] }), false);
      assert.equal(canResume({ error: "x", errorKind: "protocol" }), true, "a hook result the host could not deliver is transient");
      assert.equal(canResume({ error: "x", errorKind: "limit", omissions: [omitted("blocked", "options")] }), false, "a refused flood comes back");
    });
    await finding("r06 a group's members count against the execution ceiling", async () => {
      const members = Array.from({ length: 80 }, (_, i) => `      - id: m${String(i)}\n        agent: scout\n        task: "t${String(i)}"\n`).join("");
      const r = await runYaml(`  - id: g\n    parallel:\n${members}`, () => ({ text: "ok" }));
      assert.equal(r.fake.seen.length, 0);
      assert.equal(r.state.status, "failed");
      assert.match(r.state.error ?? "", /60 step executions/);
    });
    await finding("r07 r08 a gate on a parallel member and a when on a parallel group are refused at parse time", async () => {
      const member = parseYaml(`  - id: g\n    parallel:\n      - id: review\n        agent: scout\n        task: "review"\n        gate:\n          pass: APPROVED\n`);
      assert.match(member.errors.join(), /review.*gate/);
      const group = parseYaml(`  - id: first\n    agent: scout\n    task: "first"\n  - id: g\n    when:\n      step: first\n      status: failed\n    parallel:\n      - id: fixup\n        agent: scout\n        task: "fixup"\n`);
      assert.match(group.errors.join(), /g: .*when/);
    });
    await finding("r09 an oversized result is a failure from the start: journal, panel and resume", async () => {
      const repo = makeRepo();
      const src = `return await agent("x", { ${planner}, required: true })`;
      const first = await run(src, () => ({ text: "-----BEGIN " + `PRIVATE KEY-----\n${"A".repeat(1_200_000)}` }), { cwd: repo });
      assert.equal(first.outcome.status, "failed");
      assert.equal(first.snapshot?.agents[0]?.status, "failed", "the panel row agrees");
      const rows = fs.readFileSync(first.outcome.journalPath, "utf8").trim().split("\n").map((l): unknown => JSON.parse(l));
      assert.equal(field(rows.find((r) => field(r, "key") !== undefined && field(r, "event") === undefined), "ok"), false, "journaled as failed");
      const second = await run(src, () => ({ text: "fresh" }), { cwd: repo, resumeFrom: first.started.runId });
      assert.deepEqual([value(second.outcome), second.outcome.cached, second.fake.seen.length], ["fresh", 0, 1]);
      assert.match(formatCompletion(first.outcome), /Resume with workflow/, "a resume launches it again");
    });
    await finding("r10 spend and the worktree survive a finish that cannot read the worktree", async () => {
      const spoil = (s: Spawned): FakeReply => {
        const gitdir = fs.readFileSync(path.join(s.cwd, ".git"), "utf8").replace("gitdir:", "").trim();
        fs.writeFileSync(path.join(gitdir, "index"), "garbage");
        return { text: "done", output: 500 };
      };
      const r = await run(`return await agent("x", { isolation: "worktree" })`, spoil, { cwd: makeRepo(), concurrency: 1 });
      assert.equal(r.outcome.outputTokens, 500);
      assert.equal(value(r.outcome), "done");
      assert.match(r.outcome.keptWorktrees[0]?.reason ?? "", /not inspected/);
    });
    await finding("r12 a group's cost counts once", async () => {
      const step = (cost: number, attempts: number): WorkflowModule.StepState => ({ status: "passed", attempts, runIds: [], cost });
      const state: WorkflowModule.RunState = { version: 1, id: "r", workflow: "w", workflowFile: "w.md", inputs: {}, status: "passed", cursor: 0, loops: {}, steps: { g: step(3, 0), a: step(1, 1), b: step(2, 1) }, startedAt: "", updatedAt: "", executions: 2 };
      assert.match(yamlMod.summarizeRun(state), /\$3\.0000/);
    });
    await finding("r19 a rerun step drops its old error", async () => {
      let tries = 0;
      const r = await runYaml(`  - id: a\n    agent: scout\n    task: "a"\n    continue_on_error: true\n  - id: c\n    agent: scout\n    task: "c"\n    gate:\n      pass: OK\n      retry: a\n      max_loops: 2\n`, (s) => (s.task.startsWith("a") ? (tries++ === 0 ? { fail: "boom" } : { text: "fine" }) : { text: tries > 1 ? "OK" : "NO" }));
      assert.equal(r.state.status, "passed");
      assert.equal(r.state.steps.a?.error, undefined);
    });
    await finding("r20 an executor throw leaves state.json failed, and a bad outputTokens does not load", async () => {
      const parsed = parseYaml(`  - id: a\n    agent: scout\n    task: "a"\n`);
      assert.ok(parsed.workflow);
      const state = yamlMod.newRunState(parsed.workflow, {});
      const dir = path.join(yamlMod.runsRoot(project), state.id);
      const fake = fakeSpawner(() => {
        fs.rmSync(path.join(dir, "steps"), { recursive: true, force: true });
        fs.writeFileSync(path.join(dir, "steps"), "x");
        return { text: "ok" };
      });
      await assert.rejects(yamlMod.executeWorkflow(parsed.workflow, state, { cwd: project, agents, spawnChild: fake.spawn, registry: new RunRegistry(), launchKind: "user" }));
      assert.equal(yamlMod.loadState(project, state.id)?.status, "failed");
      const onDisk = readJson(path.join(dir, "state.json"));
      assert.ok(typeof onDisk === "object" && onDisk !== null);
      const saved = field(field(onDisk, "steps"), "a");
      assert.ok(typeof saved === "object" && saved !== null);
      Reflect.set(saved, "outputTokens", "many");
      fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(onDisk));
      assert.equal(yamlMod.loadState(project, state.id), null);
    });
    await finding("r13 nested sandboxes have slots of their own", async () => {
      const r = await run(`return await parallel(["a", "b"].map((n) => () => workflow("child", { n })))`, (s) => ({ text: s.task, delayMs: 50 }), { concurrency: 1, resolveWorkflow: async () => spec(`await agent(args.n + "1"); return await agent(args.n + "2")`, "child") });
      assert.deepEqual(r.fake.seen.map((s) => s.task), ["a1", "a2", "b1", "b2"], "one nested script at a time");
    });
    await finding("r14 r15 the end of a run waits for what it stopped", async () => {
      const usage = { input: 5, output: 700, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } };
      const base = fakeSpawner((s) => (s.task.startsWith("slow") ? { text: "late", delayMs: 5000 } : { text: "fast", output: 10, delayMs: 200 }));
      const spawn: FakeSpawn = (command, args, options) => {
        const child = base.spawn(command, args, options);
        let task = "";
        child.stdin.on("data", (d: Buffer) => { task += d.toString(); });
        child.stdin.on("end", () => { if (task.includes("slow")) child.stdout.write(`${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "turn 1" }], stopReason: "toolUse", usage } })}\n`); });
        return child;
      };
      const r = await run(`agent("slow", { ${planner} }); return await agent("fast", { ${planner} })`, () => ({}), { spawnChild: spawn, concurrency: 4 });
      assert.equal(r.outcome.outputTokens, 710);
      assert.equal(field(readJson(path.join(r.outcome.transcriptDir, "run.json")), "outputTokens"), 710);
      assert.deepEqual(r.outcome.omissions?.map((o) => o.usage.outputTokens), [700]);

      const repo = makeRepo();
      const stopping = live(`return await agent("w", { isolation: "worktree" })`, (s) => { fs.writeFileSync(path.join(s.cwd, "work.txt"), "half done\n"); return { text: "late", delayMs: 5000 }; }, { cwd: repo });
      await until(() => stopping.fake.seen.length === 1);
      await wait(100);
      controlMod.controlRun(stopping.started.runId, "stop", stopping.controls);
      const stopped = await stopping.started.done;
      assert.equal(stopped.keptWorktrees.length, 1);
      assert.match(formatCompletion(stopped), /Kept worktree/);
      assert.equal(field(field(readJson(path.join(stopped.transcriptDir, "run.json")), "keptWorktrees"), "length"), 1);

      const stuck = fakeSpawner((s) => ({ text: s.task, delayMs: s.task === "slow" ? 1500 : 100 }));
      const unkillable: FakeSpawn = (command, args, options) => Object.assign(stuck.spawn(command, args, options), { kill: () => true });
      const bounded = await run(`agent("slow", { ${planner} }); return await agent("quick", { ${planner} })`, () => ({}), { spawnChild: unkillable, concurrency: 2, drainMs: 100 });
      assert.deepEqual(bounded.outcome.omissions?.map((o) => o.reason?.text), ["still running when the run ended"], "a stuck child cannot hold the end of the run");
    });
    await finding("r17 r25 a refused workflow() or agent() call is a step, under its label, and a malformed required counts", async () => {
      const resolveWorkflow = async (): Promise<EngineModule.ScriptSpec> => spec(`let m = "none"; try { await workflow("deeper") } catch (e) { m = e.message } return m`, "child");
      for (const source of [`await parallel([() => workflow("audit", "x".repeat(1200000))]); return "done"`, `const a = {}; a.a = a; await parallel([() => workflow("audit", a)]); return "done"`, `await parallel([() => workflow(42)]); return "done"`, `await parallel([() => workflow("audit", { toJSON: () => undefined })]); return "done"`]) {
        const r = await run(source, () => ({ text: "x" }), { resolveWorkflow });
        assert.equal(r.outcome.status, "partial", source);
        assert.deepEqual(codes(r.outcome), [["blocked", "workflow-refused"]], source);
      }
      const deeper = await run(`return await workflow("child")`, () => ({ text: "x" }), { resolveWorkflow });
      assert.equal(deeper.outcome.status, "partial");
      assert.deepEqual(codes(deeper.outcome), [["blocked", "workflow-refused"]]);
      assert.equal(deeper.outcome.omissions?.[0]?.stepId, "workflow deeper");
      const big = await run(`await workflow("audit", "x".repeat(1200000)).catch(() => null); return "done"`, () => ({ text: "x" }), { resolveWorkflow });
      assert.equal(big.outcome.omissions?.[0]?.stepId, "workflow audit", "the refusal keeps its name");

      const malformed = await run(`return await parallel([() => agent("deploy", { required: "true", ${planner} }), () => agent("notes", { ${planner} })])`, () => ({ text: "ok" }));
      assert.equal(malformed.outcome.status, "failed");
      assert.deepEqual(malformed.outcome.omissions?.map((o) => [o.execution, o.required]), [["blocked", true]]);
      const prelude = await run(`return await parallel([() => agent(undefined, { required: "yes", label: "named" }), () => agent("notes", { ${planner} })])`, () => ({ text: "ok" }));
      assert.equal(prelude.outcome.status, "failed");
      assert.deepEqual(prelude.outcome.omissions?.map((o) => [o.stepId, o.required]), [["named", true]]);
      const parsed = await run(`return await parallel([() => agent("deploy", { required: "true", label: "deploy-prod", ${planner} }), () => agent("notes", { ${planner} })])`, () => ({ text: "ok" }));
      assert.equal(parsed.outcome.status, "failed");
      assert.deepEqual(parsed.outcome.omissions?.map((o) => [o.stepId, o.required]), [["deploy-prod", true]], "a call that fails its options keeps its label");
      for (const bad of [`model: "m".repeat(201)`, `isolation: "elsewhere"`]) {
        const r = await run(`await agent("x", { ${bad}, label: "named", ${planner} }).catch(() => null); return "done"`, () => ({ text: "ok" }));
        assert.deepEqual(r.outcome.omissions?.map((o) => o.stepId), ["named"], bad);
      }
      const long = await run(`await agent("x", { required: "true", label: "l".repeat(5000), ${planner} }).catch(() => null); return "done"`, () => ({ text: "ok" }));
      assert.equal(long.outcome.omissions?.[0]?.stepId.length, 200, "the label is capped as a parsed one is");
    });
    await finding("r18 what stringify really produced decides, so toJSON cannot end the run as protocol", async () => {
      for (const opts of [`{ toJSON: () => undefined }`, `{ toJSON: () => 7 }`, `{ toJSON: () => [1] }`]) {
        const r = await run(`return await parallel([() => agent("x", ${opts}), () => agent("fine", { ${planner} })])`, () => ({ text: "ok", delayMs: 50 }));
        assert.deepEqual(value(r.outcome, "partial"), [null, "ok"], opts);
        assert.deepEqual(codes(r.outcome), [["blocked", "options"]], opts);
      }
    });
    await finding("r21 a refused loop fails the run past STEP_CAP refusals", async () => {
      for (const [source, extra] of [[`await agent("first", { ${planner} }); for (;;) { try { await agent("again", { ${planner} }) } catch (e) {} }`, { budgetTotal: 5 }], [`for (;;) { try { await agent(undefined) } catch (e) {} }`, {}], [`for (;;) { await agent("x", { model: "gone/none" }) }`, { availableModels: () => [] }]] as const) {
        const r = await run(source, () => ({ text: "ok" }), extra);
        assert.equal(r.outcome.status, "failed", source);
        assert.equal(r.outcome.errorKind, "limit", source);
        assert.match(r.outcome.error ?? "", /10000 refused calls/);
      }
    });
    await finding("r22 a model string is capped like a label", async () => {
      const r = await run(`const m = "m".repeat(1000000); for (let i = 0; i < 10; i++) await agent("x", { model: m }).catch(() => null); return "done"`, () => ({ text: "ok" }), { availableModels: () => [] });
      assert.equal(value(r.outcome, "partial"), "done");
      assert.ok(fs.statSync(path.join(r.outcome.transcriptDir, "run.json")).size < 100_000);
      assert.ok(fs.statSync(r.outcome.journalPath).size < 100_000);
    });
    await finding("r24 children that report no output hold a budgeted run to one agent at a time, and nothing else does", async () => {
      const fan = `return await parallel([1, 2, 3].map((i) => () => agent("p" + i, { ${planner} })))`;
      const silent = await run(fan, () => ({ text: "ok", output: 0, delayMs: 100 }), { concurrency: 3, budgetTotal: 15 });
      assert.equal(silent.fake.maxLive(), 1);
      assert.equal(value(silent.outcome, "passed") !== undefined, true);
      const unbudgeted = await run(fan, () => ({ text: "ok", output: 0, delayMs: 100 }), { concurrency: 3 });
      assert.equal(unbudgeted.fake.maxLive(), 3);
    });
    await finding("a label like secret-scan keeps its omission line", async () => {
      const text = formatCompletion(outcomeOf({ status: "partial", value: "v", omissions: [{ ...omitted("failed", "error"), stepId: "secret-scan" }] }));
      assert.match(text, /secret-scan failed: error/);
    });
    await finding("the skip message does not promise that the run goes on", async () => {
      const control = new controlMod.ControlRegistry().open("wf-y").control;
      const handle = control.agent("a", "a1");
      const asked = control.act("skip", "agent");
      assert.doesNotMatch(asked.message, /goes on/);
      assert.equal(handle.skipOrigin(), "agent");
    });
    await finding("a vault workflow keeps a partial run", async () => {
      const vault = path.join(ws, "vault");
      // The slug walks up to the nearest .git, so give it one: a .git another process leaves above the temp root must not move it.
      const vaulted = path.join(ws, "vaulted");
      fs.mkdirSync(path.join(vaulted, ".git"), { recursive: true });
      const restore = setEnv("PI_KIT_VAULT", vault);
      try {
        const parsed = yamlMod.parseWorkflow(`---\nname: kept\ndescription: test\nvault: true\nsteps:\n  - id: a\n    agent: scout\n    task: "fail now"\n    continue_on_error: true\n---\n`, path.join(project, "kept.md"), "user");
        assert.ok(parsed.workflow);
        const fake = fakeSpawner(() => ({ fail: "provider down" }));
        const state = await yamlMod.executeWorkflow(parsed.workflow, yamlMod.newRunState(parsed.workflow, {}), { cwd: vaulted, agents, spawnChild: fake.spawn, registry: new RunRegistry(), launchKind: "user" });
        assert.equal(state.status, "partial");
        assert.deepEqual(fs.readdirSync(path.join(vault, "Projects")), ["vaulted"]);
        assert.ok(fs.existsSync(path.join(vault, "Projects", "vaulted", "Workflows", state.id)));
      } finally {
        restore();
      }
    });
    assert.deepEqual(misses, [], "every review finding holds");
    ok("the S4 and S5 review findings hold");
  }

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
    const stray = await run(`return await agent("x", { invalid: "not the prelude" })`, failing);
    assert.equal(stray.outcome.status, "passed", "a script's opts.invalid is an ordinary unknown option");
    assert.equal(stray.fake.seen.length, 1);
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
    assert.match(formatCompletion(oversized.outcome), /Resume with workflow/, "journaled as a failure, so a resume launches it again");
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
    assert.equal(flood.outcome.errorKind, "limit", "a refusal costs one round trip, so past the cap the run ends");
    assert.match(flood.outcome.error ?? "", /more than 10000 refused calls/);
    assert.equal(flood.outcome.omissionCount, 10001);
    assert.equal(flood.outcome.omissions?.length, 10001);
    const floodJson: unknown = JSON.parse(fs.readFileSync(path.join(flood.started.transcriptDir, "run.json"), "utf8"));
    assert.ok(typeof floodJson === "object" && floodJson !== null);
    const floodList: unknown = Reflect.get(floodJson, "omissions");
    assert.ok(Array.isArray(floodList));
    assert.deepEqual([floodList.length, Reflect.get(floodJson, "omissionCount")], [200, 10001]);
    assert.match(formatCompletion(flood.outcome), /<untrusted source="workflow-omissions">[\s\S]*?```\n10001 steps did not complete; the first 20:/);
    const emptyHanded = await run(`let n = 0; while (n++ < 3) { try { await agent(undefined) } catch {} } return null`, failing);
    assert.equal(emptyHanded.outcome.errorKind, "omitted");
    assert.match(emptyHanded.outcome.error ?? "", /no result, and 3 steps did not complete/);
    const requiredFlood = await run(`let n = 0; while (n++ < 10100) { try { await agent(undefined, { required: true }) } catch {} } return "went on"`, failing);
    assert.equal(requiredFlood.outcome.status, "failed", "a required refusal fails the run past the cap as well");
    const hugeRefusal = await run(`await agent("x", { agentType: "z".repeat(500000) }).catch(() => null); return "went on"`, failing);
    assert.equal(value(hugeRefusal.outcome, "partial"), "went on");
    const hugeReason = hugeRefusal.outcome.omissions?.[0]?.reason;
    assert.ok(hugeReason, "the refusal is on the record");
    assert.ok(hugeReason.text.length <= 1000, "a refusal keeps a bounded reason");

    // Agents still running when the script returns are stopped with the run, and that is an omission.
    const orphan = await run(`agent("slow"); await agent("fine", { label: "quick" }); return "done"`, (s) => ({ text: s.task, delayMs: s.task === "slow" ? 2000 : 0 }), { concurrency: 2 });
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
    const clean = { errored: false, stopped: false, hasResult: true };
    const status = (steps: ContractModule.StepResult[], end: Partial<typeof clean> = {}): string => deriveOutcome(steps, { ...clean, ...end }).status;
    assert.equal(status([step("completed")]), "passed");
    assert.equal(status([]), "passed", "no steps at all is a script that needed none");
    assert.equal(status([step("failed")], { hasResult: false }), "failed");
    assert.equal(status([step("completed")], { hasResult: false }), "passed", "no result alone is not an omission");
    assert.equal(status([step("failed")]), "partial");
    assert.equal(status([step("failed", true)]), "failed");
    assert.equal(status([step("completed")], { errored: true }), "failed");
    assert.equal(status([step("failed", true)], { errored: true, stopped: true }), "interrupted", "stopped wins");
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

    // A pause must hold the calls already queued for a slot, not only the ones that have yet to reach the gate.
    const queueFake = fakeSpawner((s) => ({ text: s.task, delayMs: 300 }));
    const queueing = engine.startScriptRun(spec(`return await parallel([1, 2, 3, 4, 5].map((i) => () => agent("q" + i)))`), undefined, { cwd: project, agents, sandbox: { mode, support }, spawnChild: queueFake.spawn, controls, concurrency: 1 });
    assert.ok(queueing.ok);
    for (let i = 0; i < 200 && queueFake.seen.length < 1; i++) await wait(10);
    assert.equal(controlMod.controlRun(queueing.runId, "pause", controls).ok, true);
    await wait(900);
    assert.deepEqual(queueFake.seen.map((x) => x.task), ["q1"], "a call queued for a slot launches nothing while the run is paused");
    assert.equal(controlMod.controlRun(queueing.runId, "resume", controls).ok, true);
    assert.deepEqual(value(await queueing.done), ["q1", "q2", "q3", "q4", "q5"], "every queued call runs after the resume");
    ok("workflow_control: a pause holds the calls queued for a slot, and every one of them runs after the resume");

    // A pause that arrives while a call is waiting for budget must hold its launch too.
    const budgetPauseFake = fakeSpawner((s) => ({ text: s.task, output: 10, delayMs: 300 }));
    const budgetPause = engine.startScriptRun(spec(`return await parallel([1, 2, 3].map((i) => () => agent("b" + i)))`), undefined, { cwd: project, agents, sandbox: { mode, support }, spawnChild: budgetPauseFake.spawn, controls, concurrency: 2, budgetTotal: 15 });
    assert.ok(budgetPause.ok);
    for (let i = 0; i < 200 && budgetPauseFake.seen.length < 1; i++) await wait(10);
    assert.equal(controlMod.controlRun(budgetPause.runId, "pause", controls).ok, true);
    await wait(900);
    assert.equal(budgetPauseFake.seen.length, 1, "a call waiting for budget does not launch while the run is paused");
    assert.equal(controlMod.controlRun(budgetPause.runId, "resume", controls).ok, true);
    const budgetPauseDone = await budgetPause.done;
    assert.deepEqual(value(budgetPauseDone, "partial"), ["b1", "b2", null], "the call goes on after the resume, and the third is refused by the budget");
    assert.deepEqual([budgetPauseDone.launched, budgetPauseDone.outputTokens], [2, 20], "two launches, as a serial loop under the same budget");
    ok("workflow_control: a pause during a budget wait holds the launch until the resume");

    // A stop inside a nested workflow() aborts its running agent and starts nothing more.
    const nestedStopFake = fakeSpawner(() => ({ text: "x", delayMs: 2000 }));
    const nestedStop = engine.startScriptRun(spec(`return await workflow("child")`), undefined, {
      cwd: project,
      agents,
      sandbox: { mode, support },
      spawnChild: nestedStopFake.spawn,
      controls,
      concurrency: 1,
      resolveWorkflow: async () => spec(`const out = []\nfor (let i = 0; i < 3; i++) out.push(await agent("n" + i))\nreturn out`, "child"),
    });
    assert.ok(nestedStop.ok);
    for (let i = 0; i < 200 && nestedStopFake.seen.length < 1; i++) await wait(10);
    assert.equal(controlMod.controlRun(nestedStop.runId, "stop", controls).ok, true);
    const stoppedNested = await nestedStop.done;
    assert.equal(stoppedNested.status, "interrupted");
    assert.equal(stoppedNested.launched, 1, "one agent launched inside the nested run");
    assert.deepEqual(nestedStopFake.seen.map((x) => x.task), ["n0"], "a stop inside a nested workflow() starts nothing more");
    assert.ok((stoppedNested.omissions ?? []).length > 0, "the stopped nested run names its omissions");
    assert.ok((stoppedNested.omissions ?? []).every((o) => o.execution === "cancelled"), "every step the stop cut is cancelled, none completed");
    ok("workflow_control: a stop during a nested workflow() aborts its running agent, starts nothing more and ends interrupted");

    // A structured retry is one launch, and both of its attempts' output is charged to the run's budget.
    let schemaReplies = 0;
    const retryFake = fakeSpawner((s) => (s.task.startsWith("t") ? { text: "t" } : schemaReplies++ === 0 ? { text: "no", output: 10 } : { structured: { a: 1 }, output: 10 }));
    const retrying = engine.startScriptRun(spec(`let b\nconst a = await agent("s", { schema: { type: "object", properties: { a: { type: "number" } }, required: ["a"] } })\ntry { b = await agent("t") } catch (e) { b = e.message }\nreturn [a, b, budget.spent()]`), undefined, { cwd: project, agents, sandbox: { mode, support }, spawnChild: retryFake.spawn, controls, concurrency: 1, budgetTotal: 15 });
    assert.ok(retrying.ok);
    const retried = await retrying.done;
    const retriedValue = value(retried, "partial");
    assert.ok(Array.isArray(retriedValue));
    assert.deepEqual(retriedValue[0], { a: 1 }, "the retry's structured reply is the value");
    assert.match(String(retriedValue[1]), /budget exhausted: 20 of 15/, "the next call sees both attempts' output");
    assert.equal(retriedValue[2], 20, "budget.spent() counts the retried attempt");
    assert.deepEqual([retried.launched, retried.outputTokens, retryFake.seen.length], [1, 20, 2], "one launch, two children, both charged");
    ok("workflow budget: a structured retry's output is charged to the run while launched stays 1");

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
