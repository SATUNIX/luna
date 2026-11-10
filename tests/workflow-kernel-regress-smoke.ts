#!/usr/bin/env node
// Script-workflow engine: regression cases for four reported defects (packages/extensions/third_party/subagent/wf-engine.ts,
// docs/script-workflows.md). Every case asserts the SAFE contract, so each fails while its defect is present, and the
// file reports every case instead of stopping at the first failure.
//   F1  Resume reuses a read-only result for a changed workspace (a, b) and for a changed role definition (c, d, e).
//   F2  A kept worktree's result is reused although its uncommitted files changed (a), were discarded (b) or the worktree is gone (c).
//   F3  Admission: a queued fan-out is held by the agent limit and by the output budget, at any concurrency
//       and inside a nested workflow(), not only when the calls run one at a time (a, b, c, d).
//   F4  A script that returns a failed required step is reported "passed" (outcome, run.json, run model, completion message).
// Controls (no defect, they pass today and must keep passing) guard each contract against a fix that overreaches:
// an unchanged checkout and role still reuse a read, an untouched kept worktree is still reused, serial calls still stop at
// the limits, a best-effort parallel() branch that fails is still null and does not fail the run.
// Any case or control that does not pass exits 1.
// Offline: children are fakes (tests/workflow-fakes.ts) behind the real effort and delegation-guard extensions.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isolateKitEnv, loadModule, rmWorkspace, setEnv, tmpWorkspace } from "../packages/core/eval/harness.ts";
import { installDelegation } from "../packages/core/eval/delegation.ts";
import type { AgentConfig } from "../packages/extensions/third_party/subagent/agents.ts";
import type * as EngineModule from "../packages/extensions/third_party/subagent/wf-engine.ts";
import type * as RunModelModule from "../packages/extensions/third_party/subagent/run-model.ts";
import type * as SandboxModule from "../packages/extensions/third_party/subagent/wf-sandbox.ts";
import type * as ToolModule from "../packages/extensions/third_party/subagent/wf-tool.ts";
import { fakeSpawner, type FakeReply, type FakeSpawn, type Spawned } from "./workflow-fakes.ts";

type Options = Omit<EngineModule.EngineOptions, "spawnChild"> & { spawnChild: FakeSpawn };
interface EngineView {
  startScriptRun(spec: EngineModule.ScriptSpec, args: unknown, opts: Options): EngineModule.StartResult;
  readJournal: typeof EngineModule.readJournal;
}

const restoreKit = isolateKitEnv();
const ws = tmpWorkspace("pi-kit-wf-kernel-regress-");
const restores = [setEnv("HOME", path.join(ws, "home")), setEnv("PI_KIT_SUBAGENT_RETRIES", "0"), setEnv("PI_KIT_SUBAGENT_STATE_DIR", path.join(ws, "state"))];
const delegation = await installDelegation({ tier: "standard" });

const engine = await loadModule<EngineView>("vendor/subagent/wf-engine.ts");
const { RunRegistry } = await loadModule<typeof RunModelModule>("vendor/subagent/run-model.ts");
const { formatCompletion } = await loadModule<typeof ToolModule>("vendor/subagent/wf-tool.ts");
const sandboxMod = await loadModule<typeof SandboxModule>("vendor/subagent/wf-sandbox.ts");
const support = sandboxMod.detectSupport();
const mode: SandboxModule.SandboxMode = support.bwrap ? "full" : "reduced";
console.log(`  (sandbox mode: ${mode})`);

// ---------------------------------------------------------------------------------------------
// Fixtures: roles, a scratch checkout per case, one run

const role = (name: string, tools?: string[], more: Partial<AgentConfig> = {}): AgentConfig => ({ name, description: name, systemPrompt: `You are ${name}.`, source: "kit", filePath: name, ...(tools ? { tools } : {}), ...more });
const READ_TOOLS = ["read", "grep", "find", "ls"];
const baseAgents: AgentConfig[] = [role("implementer"), role("planner", READ_TOOLS)];
const withPlanner = (more: Partial<AgentConfig>, tools: string[] = READ_TOOLS): AgentConfig[] => [role("implementer"), role("planner", tools, more)];

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
const git = (cwd: string, ...a: string[]): string => execFileSync("git", a, { cwd, encoding: "utf8", env: gitEnv }).trim();

let repos = 0;
/** A fresh checkout: .pi/ ignored, a.txt committed as "original". */
function makeRepo(): string {
  const dir = path.join(ws, `repo-${String(++repos)}`);
  fs.mkdirSync(dir);
  git(dir, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(dir, ".gitignore"), ".pi/\n");
  fs.writeFileSync(path.join(dir, "a.txt"), "original\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  return dir;
}

const spec = (source: string, name = "kernel-regress"): EngineModule.ScriptSpec => ({ name, description: "test", source: `export const meta = { name: ${JSON.stringify(name)}, description: "test" };\n${source}`, phases: [] });

interface RunArgs {
  repo: string;
  source: string;
  reply: (s: Spawned) => FakeReply;
  roles?: AgentConfig[];
  resumeFrom?: string;
  concurrency?: number;
  maxAgents?: number;
  budgetTotal?: number;
  resolveWorkflow?: Options["resolveWorkflow"];
}
/** One real engine run behind a fake child. The outcome is returned whatever its status. */
async function run(a: RunArgs) {
  const fake = fakeSpawner(a.reply);
  const registry = new RunRegistry();
  const started = engine.startScriptRun(spec(a.source), undefined, {
    cwd: a.repo,
    agents: a.roles ?? baseAgents,
    sandbox: { mode, support },
    spawnChild: fake.spawn,
    registry,
    resumeFrom: a.resumeFrom,
    resolveWorkflow: a.resolveWorkflow,
    concurrency: a.concurrency,
    maxAgents: a.maxAgents,
    budgetTotal: a.budgetTotal,
  });
  if (!started.ok) throw new Error(started.error);
  const outcome = await started.done;
  return { started, outcome, fake, registry, journal: engine.readJournal(started.journalPath) };
}

// ---------------------------------------------------------------------------------------------
// Reporting: a case collects every failed expectation and the values it observed; a thrown error is a broken
// precondition (ERROR), which is not the defect under test.

class Probe {
  readonly failures: string[] = [];
  readonly notes: string[] = [];
  observe(what: string, value: unknown): void {
    this.notes.push(`${what} = ${JSON.stringify(value) ?? "undefined"}`);
  }
  eq(actual: unknown, expected: unknown, why: string): void {
    if (!isDeepStrictEqual(actual, expected)) this.failures.push(`${why}: expected ${JSON.stringify(expected)}, observed ${JSON.stringify(actual) ?? "undefined"}`);
  }
  atMost(actual: number, max: number, why: string): void {
    if (actual > max) this.failures.push(`${why}: expected at most ${String(max)}, observed ${String(actual)}`);
  }
  differs(actual: unknown, unwanted: unknown, why: string): void {
    if (isDeepStrictEqual(actual, unwanted)) this.failures.push(`${why}: must not be ${JSON.stringify(unwanted)}`);
  }
  that(ok: boolean, why: string): void {
    if (!ok) this.failures.push(why);
  }
}

interface CaseResult {
  id: string;
  control: boolean;
  state: "pass" | "FAIL" | "ERROR";
  failures: string[];
}
const results: CaseResult[] = [];

async function scenario(id: string, title: string, body: (p: Probe) => Promise<void>, control = false): Promise<void> {
  const probe = new Probe();
  let state: CaseResult["state"] = "pass";
  const failures: string[] = [];
  try {
    await body(probe);
    if (probe.failures.length > 0) state = "FAIL";
    failures.push(...probe.failures);
  } catch (error) {
    state = "ERROR";
    failures.push(`precondition broke: ${error instanceof Error ? error.message : String(error)}`);
  }
  results.push({ id, control, state, failures });
  console.log(`  ${state === "pass" ? "ok  " : state}  ${id}${control ? " (control)" : ""}: ${title}`);
  for (const f of failures) console.log(`        - ${f}`);
  for (const n of probe.notes) console.log(`        . ${n}`);
}

// ---------------------------------------------------------------------------------------------
// F1: a reused read

const READ_SOURCE = `return await agent("Report the contents of a.txt", { agentType: "planner" })`;
const readA = (s: Spawned): FakeReply => ({ text: fs.readFileSync(path.join(s.cwd, "a.txt"), "utf8").trim() });

/** A first run that read a.txt, then a resume of it: the first run's id and the resume's result. */
async function readThenResume(repo: string, between: () => void, resumeRoles?: AgentConfig[], firstRoles?: AgentConfig[]) {
  const first = await run({ repo, source: READ_SOURCE, reply: readA, ...(firstRoles ? { roles: firstRoles } : {}) });
  assert.equal(first.outcome.status, "passed", `first run ${first.outcome.status}: ${first.outcome.error ?? ""}`);
  assert.equal(first.outcome.value, "original", "the first run read the committed file");
  between();
  const resumed = await run({ repo, source: READ_SOURCE, reply: readA, resumeFrom: first.started.runId, ...(resumeRoles ? { roles: resumeRoles } : {}) });
  assert.equal(resumed.outcome.status, "passed", `resumed run ${resumed.outcome.status}: ${resumed.outcome.error ?? ""}`);
  return resumed;
}

/** The safe contract for a read whose inputs changed: it runs live and returns the live answer. */
function expectLiveRead(p: Probe, r: Awaited<ReturnType<typeof readThenResume>>, live: string): void {
  p.observe("reused (cached)", r.outcome.cached);
  p.observe("launched", r.outcome.launched);
  p.observe("value", r.outcome.value);
  p.eq(r.outcome.cached, 0, "the stale read is not reused");
  p.eq(r.outcome.launched, 1, "the read runs live again");
  p.eq(r.outcome.value, live, "the value the script gets is the live one");
}

await scenario("F1-control", "an unchanged checkout and role still reuse the read", async (p) => {
  const r = await readThenResume(makeRepo(), () => undefined);
  p.eq([r.outcome.cached, r.outcome.launched, r.outcome.value], [1, 0, "original"], "reused with nothing launched");
}, true);

await scenario("F1a", "resume after an uncommitted edit of a.txt", async (p) => {
  const repo = makeRepo();
  expectLiveRead(p, await readThenResume(repo, () => fs.writeFileSync(path.join(repo, "a.txt"), "edited\n")), "edited");
});

await scenario("F1b", "resume after a.txt was committed with new content", async (p) => {
  const repo = makeRepo();
  expectLiveRead(p, await readThenResume(repo, () => {
    fs.writeFileSync(path.join(repo, "a.txt"), "committed\n");
    git(repo, "commit", "-q", "-am", "change a.txt");
  }), "committed");
});

await scenario("F1c", "resume after the planner role's system prompt changed", async (p) => {
  const repo = makeRepo();
  expectLiveRead(p, await readThenResume(repo, () => undefined, withPlanner({ systemPrompt: "You are planner. Answer in capitals." })), "original");
});

await scenario("F1d", "resume after the planner role was given the write tool", async (p) => {
  const repo = makeRepo();
  expectLiveRead(p, await readThenResume(repo, () => undefined, withPlanner({}, [...READ_TOOLS, "write"])), "original");
});

await scenario("F1e", "resume after the planner role's model and thinking level changed", async (p) => {
  const repo = makeRepo();
  expectLiveRead(p, await readThenResume(repo, () => undefined, withPlanner({ model: "local/large", thinking: "high" }), withPlanner({ model: "local/small", thinking: "low" })), "original");
});

// ---------------------------------------------------------------------------------------------
// F2: a reused kept worktree

const ISO_SOURCE = `return await agent("change a.txt", { isolation: "worktree" })`;
const writeA = (): FakeReply => ({ text: "changed", write: { file: "a.txt", text: "changed by the agent\n" } });

/** A first run that leaves a dirty kept worktree (branch head still the base commit), then a resume of it. */
async function keptThenResume(repo: string, between: (worktree: string, branch: string) => void) {
  const first = await run({ repo, source: ISO_SOURCE, reply: writeA });
  assert.equal(first.outcome.status, "passed", `first run ${first.outcome.status}: ${first.outcome.error ?? ""}`);
  const kept = first.outcome.keptWorktrees[0];
  assert.ok(kept && first.outcome.keptWorktrees.length === 1, "the changed worktree is kept");
  assert.equal(kept.reason, "uncommitted changes", "it is kept for uncommitted changes");
  assert.equal(kept.head, kept.baseCommit, "the branch has no commit of its own, so its head never moves");
  between(kept.path, kept.branch);
  const resumed = await run({ repo, source: ISO_SOURCE, reply: () => ({ text: "live" }), resumeFrom: first.started.runId });
  assert.equal(resumed.outcome.status, "passed", `resumed run ${resumed.outcome.status}: ${resumed.outcome.error ?? ""}`);
  return { first, kept, resumed };
}

function expectLiveWorktree(p: Probe, r: Awaited<ReturnType<typeof keptThenResume>>): void {
  p.observe("reused (cached)", r.resumed.outcome.cached);
  p.observe("launched", r.resumed.outcome.launched);
  p.observe("value", r.resumed.outcome.value);
  p.eq(r.resumed.outcome.cached, 0, "the changed worktree's result is not reused");
  p.eq(r.resumed.outcome.launched, 1, "the agent runs live again");
}

await scenario("F2-control", "an untouched kept worktree is still reused", async (p) => {
  const r = await keptThenResume(makeRepo(), () => undefined);
  p.eq([r.resumed.outcome.cached, r.resumed.outcome.launched], [1, 0], "reused with nothing launched");
}, true);

await scenario("F2a", "resume after the kept worktree's dirty file was edited again", async (p) => {
  expectLiveWorktree(p, await keptThenResume(makeRepo(), (worktree) => fs.writeFileSync(path.join(worktree, "a.txt"), "edited after the run\n")));
});

await scenario("F2b", "resume after the kept worktree's dirty change was discarded", async (p) => {
  expectLiveWorktree(p, await keptThenResume(makeRepo(), (worktree) => git(worktree, "checkout", "--", "a.txt")));
});

await scenario("F2c", "resume after the kept worktree directory was removed but its branch left", async (p) => {
  const repo = makeRepo();
  expectLiveWorktree(p, await keptThenResume(repo, (worktree) => git(repo, "worktree", "remove", "--force", worktree)));
});

// ---------------------------------------------------------------------------------------------
// F3: a queued fan-out

const FAN_OUT = `return await parallel([1, 2, 3, 4, 5].map((i) => () => agent("job " + i, { agentType: "planner" })))`;
const SERIAL = `const out = []
  for (let i = 0; i < 5; i++) { try { out.push(await agent("job " + i, { agentType: "planner" })) } catch (e) { out.push("refused: " + e.message) } }
  return out`;

await scenario("F3-control", "serial calls stop at maxAgents 2 and at an output budget of 15 (20 spent)", async (p) => {
  const limited = await run({ repo: makeRepo(), source: SERIAL, reply: () => ({ text: "ok" }), maxAgents: 2 });
  p.eq([limited.outcome.status, limited.outcome.launched, limited.fake.seen.length], ["partial", 2, 2], "maxAgents stops a serial loop");
  const budgeted = await run({ repo: makeRepo(), source: SERIAL, reply: () => ({ text: "ok", output: 10 }), budgetTotal: 15 });
  p.eq([budgeted.outcome.status, budgeted.outcome.launched, budgeted.outcome.outputTokens], ["partial", 2, 20], "the budget stops a serial loop once 15 is passed");
}, true);

await scenario("F3a", "5 parallel agents, concurrency 1, maxAgents 2", async (p) => {
  const r = await run({ repo: makeRepo(), source: FAN_OUT, reply: () => ({ text: "ok", delayMs: 10 }), concurrency: 1, maxAgents: 2 });
  assert.equal(r.outcome.status, "partial", `the queued calls past the limit are refused: ${r.outcome.error ?? ""}`);
  p.observe("children spawned", r.fake.seen.length);
  p.observe("outcome.launched", r.outcome.launched);
  p.observe("most live at once", r.fake.maxLive());
  p.observe("value", r.outcome.value);
  p.atMost(r.fake.seen.length, 2, "children spawned under maxAgents 2");
  p.atMost(r.outcome.launched, 2, "outcome.launched under maxAgents 2");
  p.atMost(r.fake.maxLive(), 1, "children live at once under concurrency 1");
});

await scenario("F3b", "5 parallel agents of 10 output tokens, concurrency 1, output budget 15", async (p) => {
  // A serial loop under this budget launches 2 and spends 20 (F3-control); a queue must not do worse than that.
  const r = await run({ repo: makeRepo(), source: FAN_OUT, reply: () => ({ text: "ok", output: 10, delayMs: 10 }), concurrency: 1, budgetTotal: 15 });
  assert.equal(r.outcome.status, "partial", `the queued calls past the limit are refused: ${r.outcome.error ?? ""}`);
  p.observe("children spawned", r.fake.seen.length);
  p.observe("outcome.launched", r.outcome.launched);
  p.observe("output tokens spent", r.outcome.outputTokens);
  p.atMost(r.outcome.launched, 2, "agents launched under an output budget of 15");
  p.atMost(r.outcome.outputTokens, 20, "output tokens spent under an output budget of 15 (one launch of overshoot, as a serial loop)");
});

await scenario("F3c", "the same fan-out at concurrency 4 and an output budget of 15 launches at most 2", async (p) => {
  // A call must hold a slot before it checks the budget: otherwise all five read 0 spent and all of them launch.
  const r = await run({ repo: makeRepo(), source: FAN_OUT, reply: () => ({ text: "ok", output: 10, delayMs: 20 }), concurrency: 4, budgetTotal: 15 });
  assert.equal(r.outcome.status, "partial", `the queued calls past the limit are refused: ${r.outcome.error ?? ""}`);
  p.observe("children spawned", r.fake.seen.length);
  p.observe("outcome.launched", r.outcome.launched);
  p.observe("output tokens spent", r.outcome.outputTokens);
  p.atMost(r.fake.seen.length, 2, "children spawned under an output budget of 15 at concurrency 4");
  p.atMost(r.outcome.launched, 2, "agents launched under an output budget of 15 at concurrency 4");
  p.atMost(r.outcome.outputTokens, 20, "output tokens spent under an output budget of 15 at concurrency 4 (one launch of overshoot, as a serial loop)");
});

await scenario("F3f", "a call waiting for admission when the script returns never starts", async (p) => {
  // The run ends with one call still in the budget wait: it holds a slot but is not a running agent.
  const r = await run({ repo: makeRepo(), source: `const a = agent("a"); const b = agent("b"); await a; return "x"`, reply: () => ({ text: "ok", output: 1, delayMs: 20 }), concurrency: 4, budgetTotal: 100 });
  const atDone = r.fake.seen.length;
  await new Promise((resolve) => setTimeout(resolve, 400));
  p.observe("children at done", atDone);
  p.observe("children 400 ms later", r.fake.seen.length);
  p.eq(r.fake.seen.length, atDone, "no child starts after the run has ended");
});

await scenario("F3e", "a first agent that spends nothing does not lower the estimate to 0", async (p) => {
  // Decision 14's mean is over finished output: a call that spent none must not admit the rest of the fan-out at once.
  let replies = 0;
  const r = await run({ repo: makeRepo(), source: FAN_OUT, reply: () => (replies++ === 0 ? { text: "ok", output: 0 } : { text: "ok", output: 10, delayMs: 150 }), concurrency: 4, budgetTotal: 15 });
  assert.equal(r.outcome.status, "partial", `the queued calls past the limit are refused: ${r.outcome.error ?? ""}`);
  p.observe("children spawned", r.fake.seen.length);
  p.observe("outcome.launched", r.outcome.launched);
  p.observe("output tokens spent", r.outcome.outputTokens);
  p.observe("most live at once", r.fake.maxLive());
  p.atMost(r.outcome.launched, 3, "agents launched after one that spent nothing, under an output budget of 15 at concurrency 4");
  p.atMost(r.outcome.outputTokens, 20, "output tokens spent after one agent that spent nothing, under an output budget of 15 at concurrency 4");
});

const NESTED_FAN_OUT = `return await parallel([1, 2, 3, 4, 5].map((i) => () => agent("nested " + i, { agentType: "planner" })))`;

await scenario("F3d", "a nested workflow()'s fan-out is held by the same agent limit", async (p) => {
  // A nested script shares the run's counters; a queued fan-out inside it must not pass the limit either.
  const r = await run({
    repo: makeRepo(),
    source: `return await workflow("fan-out")`,
    reply: (s) => ({ text: s.task, delayMs: 20 }),
    concurrency: 4,
    maxAgents: 2,
    resolveWorkflow: async () => spec(NESTED_FAN_OUT, "fan-out"),
  });
  assert.equal(r.outcome.status, "partial", `the queued calls past the limit are refused: ${r.outcome.error ?? ""}`);
  p.observe("children spawned", r.fake.seen.length);
  p.observe("outcome.launched", r.outcome.launched);
  p.atMost(r.fake.seen.length, 2, "children spawned under maxAgents 2 inside a nested workflow()");
  p.atMost(r.outcome.launched, 2, "agents launched under maxAgents 2 inside a nested workflow()");
});

// ---------------------------------------------------------------------------------------------
// F4: a failed required step

await scenario("F4-control", "a failed best-effort branch in parallel() is null and the run reads partial", async (p) => {
  const r = await run({ repo: makeRepo(), source: `return await parallel([() => agent("fail"), () => agent("fine")])`, reply: (s) => (s.task === "fail" ? { fail: "provider down" } : { text: "FINE" }) });
  p.eq(r.outcome.value, [null, "FINE"], "the failed branch is null and the other branch's value is kept");
  p.eq(r.outcome.status, "partial", "a best-effort omission leaves the value and reads partial");
}, true);

await scenario("F4a", "return await agent() of a failing child: the run's status", async (p) => {
  const r = await run({ repo: makeRepo(), source: `return await agent("fail")`, reply: () => ({ fail: "provider down" }) });
  p.observe("outcome.status", r.outcome.status);
  p.observe("outcome.value", r.outcome.value ?? null);
  p.observe("outcome.error", r.outcome.error ?? null);
  p.observe("journal", r.journal.map((e) => ({ ok: e.ok, value: e.value, error: e.error })));
  p.differs(r.outcome.status, "passed", "a run whose only step failed and whose result is that step's null");
});

await scenario("F4b", "the same run as every surface reports it: run.json, the run model, the completion message", async (p) => {
  const r = await run({ repo: makeRepo(), source: `return await agent("fail")`, reply: () => ({ fail: "provider down" }) });
  const runJson: unknown = JSON.parse(fs.readFileSync(path.join(r.started.transcriptDir, "run.json"), "utf8"));
  const persisted: unknown = Reflect.get(Object(runJson), "status");
  const snapshot = r.registry.get(r.started.runId);
  const agentStatuses = (snapshot?.agents ?? []).map((a) => a.status);
  const completion = formatCompletion(r.outcome);
  p.observe("run.json status", persisted);
  p.observe("run model status", snapshot?.status);
  p.observe("run model agent statuses", agentStatuses);
  p.observe("completion message, first line", completion.split("\n")[0]);
  assert.deepEqual(agentStatuses, ["failed"], "the run model knows the agent failed");
  p.differs(persisted, "passed", "run.json status");
  p.differs(snapshot?.status, "passed", "run model status");
  p.that(!/ passed\.$/m.test(completion.split("\n")[0] ?? ""), "the completion message the model reads says the workflow passed");
});

// ---------------------------------------------------------------------------------------------

try {
  const cases = results.filter((r) => !r.control);
  const controls = results.filter((r) => r.control);
  const count = (list: CaseResult[], state: CaseResult["state"]): number => list.filter((r) => r.state === state).length;
  console.log(`\nworkflow-kernel-regress-smoke: ${String(cases.length)} cases (${String(count(cases, "pass"))} pass, ${String(count(cases, "FAIL"))} FAIL, ${String(count(cases, "ERROR"))} ERROR), ${String(controls.length)} controls (${String(count(controls, "pass"))} pass)`);
  for (const r of results) if (r.state !== "pass") console.log(`fatal: ${r.id}: ${r.state}`);
  process.exitCode = results.every((r) => r.state === "pass") ? 0 : 1;
} finally {
  delegation.cleanup();
  for (const restore of restores.reverse()) restore();
  restoreKit();
  rmWorkspace(ws);
}
