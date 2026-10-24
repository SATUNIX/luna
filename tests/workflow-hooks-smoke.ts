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
import { fakeSpawner, type FakeReply, type FakeSpawn, type Spawned } from "./workflow-fakes.ts";

type Options = Omit<EngineModule.EngineOptions, "spawnChild"> & { spawnChild: FakeSpawn };
interface EngineView {
  startScriptRun(spec: EngineModule.ScriptSpec, args: unknown, opts: Options): EngineModule.StartResult;
  defaultConcurrency(): number;
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
const value = (o: EngineModule.RunOutcome): unknown => {
  assert.equal(o.status, "passed", `run ${o.status}: ${o.error ?? ""}`);
  return o.value;
};

try {
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
    assert.deepEqual(value(r.outcome), { a: ["SCAN X", "SCAN Y", "SCAN Z"], b: ["STAGE2 STAGE1 1 1 0", "STAGE2 STAGE1 2 2 1"], failed: [null, "FINE"] });
    const snap = r.snapshot;
    assert.ok(snap);
    assert.deepEqual(snap.phases.map((p) => p.id).filter((id) => id === "Scan" || id === "Stage"), ["Scan", "Stage"]);
    assert.deepEqual(snap.agents.filter((a) => a.phase === "Scan").map((a) => a.label).sort(), ["implementer #8", "implementer #9", "scan-x", "scan-y", "scan-z"], "labels default to <role> #<call>");
    assert.equal(snap.agents.filter((a) => a.phase === "Stage").length, 4);
    assert.equal(snap.agents.find((a) => a.status === "failed")?.error, "provider down");
    const runJson: unknown = JSON.parse(fs.readFileSync(path.join(r.started.transcriptDir, "run.json"), "utf8"));
    assert.ok(typeof runJson === "object" && runJson !== null);
    assert.deepEqual(Reflect.get(runJson, "log"), ["scanned 3", "implementer #8: failed (provider down); agent() returns null"]);
    assert.equal(Reflect.get(runJson, "status"), "passed");
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
    const v = value(r.outcome);
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
    assert.deepEqual(value(r.outcome), [null, "y", "z"]);
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
    const v = value(r.outcome);
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
    assert.deepEqual(value(r.outcome), { got: ["t", "t", "budget exhausted: 20 of 15 output tokens spent"], spent: 20, total: 15, remaining: 0 });
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
    assert.deepEqual(value(capped.outcome), ["n", "n", "n", "agent limit reached: this run has started 3 agents (limit 3)"]);
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
    assert.deepEqual(value(r.outcome), { v: { a: "inner 7", deeper: "workflow(): nesting is one level only; a nested workflow cannot call workflow()" }, missing: 'Unknown script workflow "nope".' });
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
    assert.match(String(value(r.outcome)), /role "lonely" has no tool a workflow agent may use/);
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
  }

  console.log(`\nworkflow-hooks-smoke: ${checks} checks passed`);
} finally {
  delegation.cleanup();
  for (const restore of restores.reverse()) restore();
  restoreKit();
  rmWorkspace(ws);
}
