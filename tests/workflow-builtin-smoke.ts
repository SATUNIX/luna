#!/usr/bin/env node
// Kit built-in script workflows (packages/kit/workflows/*.js, docs/script-workflows.md#built-in-script-workflows)
// and the workflow-authoring skill (packages/kit/skills/workflow-authoring/SKILL.md).
//   1. The registry lists the five built-ins from the kit directory with no errors; every phase a script
//      uses is in its meta.phases; every agentType it names is a kit role.
//   2. The fence helper is the same in every script, and what it puts in a prompt is byte-identical to
//      untrusted() in the subagent extension's fence.ts (``` inside the data cannot close the fence).
//   3. understand: scope, capped reads (areas cut at scope or after the critic are logged, returned as
//      notRead and named to the synthesiser), a critic whose new areas are read, a map.
//   4. review-changes: findings deduplicated across dimensions, majority-of-skeptics verify, loop until
//      a round is dry; maxRounds stops the loop and says so.
//   5. design-panel: drafts per angle, judges score every draft (bad indexes ignored), the winner is synthesised.
//   6. research-sweep: sources deduplicated across modes, maxReads drops are logged and named to the synthesiser.
//   7. migrate: one worktree per site, unchanged ones removed, changed ones kept and reviewed; branches to merge.
//      A reported branch that is not luna/wf/<runId>/<n> fails the site: not reviewed, not in toMerge.
//   8. Missing required args fail the run with a message naming the argument.
//   9. The skill names the built-ins, the Luna notes and the tool's parameters.
//  10. Model-started YAML runs in a run scope (docs/workflows.md#execution-rules, docs/effort.md): the
//      kit's bugfix, feature and research with their worst cases, the per-request allowance, the tier's
//      parallel limit, no subagent below a step, uncapped approved scripts, resume in a new scope, and
//      state saved `running` before a sequential writer launches.
// Offline: children are fakes (tests/workflow-fakes.ts) behind the real effort and delegation-guard extensions.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ROOT, fakePi, isolateKitEnv, loadModule, rmWorkspace, setEnv, tmpWorkspace } from "../packages/core/eval/harness.ts";
import { installDelegation } from "../packages/core/eval/delegation.ts";
import type * as AgentsModule from "../packages/extensions/third_party/subagent/agents.ts";
import type * as ControlModule from "../packages/extensions/third_party/subagent/control.ts";
import type * as EngineModule from "../packages/extensions/third_party/subagent/wf-engine.ts";
import type * as LedgerModule from "../packages/extensions/src/effort/ledger.ts";
import type * as FenceModule from "../packages/extensions/third_party/subagent/fence.ts";
import type * as SandboxModule from "../packages/extensions/third_party/subagent/wf-sandbox.ts";
import type * as WorkflowModule from "../packages/extensions/third_party/subagent/workflow.ts";
import type * as WorkflowToolsModule from "../packages/extensions/third_party/subagent/workflow-tools.ts";
import type { ToolContext } from "../packages/extensions/third_party/subagent/types.ts";
import { fakeSpawner, type FakeReply, type FakeSpawn, type Spawned } from "./workflow-fakes.ts";

type Options = Omit<EngineModule.EngineOptions, "spawnChild"> & { spawnChild: FakeSpawn };
type StartOptions = Parameters<typeof WorkflowToolsModule.startWorkflow>[3];
type ToolsView = Omit<typeof WorkflowToolsModule, "startWorkflow"> & {
  startWorkflow(ctx: ToolContext, name: string, inputs: Record<string, string>, opts: Omit<StartOptions, "spawnChild"> & { spawnChild: FakeSpawn }): ReturnType<typeof WorkflowToolsModule.startWorkflow>;
};
interface EngineView {
  startScriptRun(spec: EngineModule.ScriptSpec, args: unknown, opts: Options): EngineModule.StartResult;
}

const KIT_WORKFLOWS = path.join(ROOT, "packages", "kit", "workflows");
const KIT_AGENTS = path.join(ROOT, "packages", "kit", "agents");
const BUILTINS = ["design-panel", "migrate", "research-sweep", "review-changes", "understand"];

const restoreKit = isolateKitEnv();
const ws = tmpWorkspace("pi-kit-wf-builtin-");
const restores = [
  setEnv("HOME", path.join(ws, "home")),
  setEnv("PI_CODING_AGENT_DIR", path.join(ws, "home", ".pi", "agent")),
  setEnv("PI_KIT_SUBAGENT_RETRIES", "0"),
  setEnv("PI_KIT_SUBAGENT_STATE_DIR", path.join(ws, "state")),
  setEnv("PI_KIT_WORKFLOWS_DIR", KIT_WORKFLOWS),
];
const delegation = await installDelegation({ tier: "standard" });
let checks = 0;
const ok = (label: string): void => {
  checks++;
  console.log(`  OK: ${label}`);
};

const engine = await loadModule<EngineView>("vendor/subagent/wf-engine.ts");
const sandboxMod = await loadModule<typeof SandboxModule>("vendor/subagent/wf-sandbox.ts");
const workflowMod = await loadModule<typeof WorkflowModule>("vendor/subagent/workflow.ts");
const agentsMod = await loadModule<typeof AgentsModule>("vendor/subagent/agents.ts");
const fenceMod = await loadModule<typeof FenceModule>("vendor/subagent/fence.ts");
const support = sandboxMod.detectSupport();
const mode: SandboxModule.SandboxMode = support.bwrap ? "full" : "reduced";
console.log(`  (sandbox mode: ${mode})`);

const agents: AgentsModule.AgentConfig[] = [];
for (const f of fs.readdirSync(KIT_AGENTS).filter((x) => x.endsWith(".md"))) {
  const file = path.join(KIT_AGENTS, f);
  const role = agentsMod.parseAgentFile(fs.readFileSync(file, "utf8"), "kit", file);
  if (role) agents.push(role);
}
const project = path.join(ws, "project");
fs.mkdirSync(project, { recursive: true });

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const field = (v: unknown, key: string): unknown => (isRecord(v) ? v[key] : undefined);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const { scripts, errors } = workflowMod.discoverWorkflows(project);
const byName = new Map(scripts.map((s) => [s.name, s]));

async function runBuiltin(name: string, args: unknown, reply: (s: Spawned) => FakeReply, cwd = project) {
  const def = byName.get(name);
  assert.ok(def, `${name} is registered`);
  const { source } = workflowMod.readScript(def);
  const fake = fakeSpawner(reply);
  const started = engine.startScriptRun({ name: def.name, description: def.description, source, file: def.file, phases: def.phases }, args, { cwd, agents, sandbox: { mode, support }, spawnChild: fake.spawn });
  if (!started.ok) throw new Error(started.error);
  const outcome = await started.done;
  const runJson: unknown = JSON.parse(fs.readFileSync(path.join(started.transcriptDir, "run.json"), "utf8"));
  const logLines = list(field(runJson, "log")).map(String);
  return { outcome, fake, logLines };
}
const passed = (o: EngineModule.RunOutcome, status: EngineModule.RunOutcome["status"] = "passed"): unknown => {
  assert.equal(o.status, status, `run ${o.status}: ${o.error ?? ""}`);
  return o.value;
};
/** A built-in whose best-effort branch failed still shows its value, and the run names the omission. */
const partial = (o: EngineModule.RunOutcome): unknown => passed(o, "partial");
const tasksMatching = (seen: Spawned[], re: RegExp): Spawned[] => seen.filter((s) => re.test(s.task));

try {
  // 1. registry, phases, roles
  {
    assert.deepEqual(errors, [], "the kit's workflows all parse");
    assert.deepEqual(scripts.filter((s) => s.source === "kit").map((s) => s.name), BUILTINS);
    const roleNames = new Set(agents.map((a) => a.name));
    for (const s of scripts) {
      const source = fs.readFileSync(s.file, "utf8");
      const titles = new Set(s.phases.map((p) => p.title));
      const used = [...source.matchAll(/\bphase(?:\(|: )'([^']+)'/g)].map((m) => m[1]);
      assert.ok(used.length > 0, `${s.name} uses phases`);
      for (const p of used) assert.ok(p !== undefined && titles.has(p), `${s.name}: phase "${p ?? ""}" is in meta.phases`);
      for (const m of source.matchAll(/agentType: '([^']+)'/g)) assert.ok(m[1] !== undefined && roleNames.has(m[1]), `${s.name}: agentType ${m[1] ?? ""} is a kit role`);
      assert.ok(source.includes("tests/workflow-builtin-smoke.ts"), `${s.name} names its test`);
    }
    ok("the registry lists the five kit script workflows; their phases are in meta.phases and their roles are kit roles");
  }

  // 2. fence copies
  {
    const blocks = scripts.map((s) => {
      const text = fs.readFileSync(s.file, "utf8");
      const start = text.indexOf("// fence:");
      const end = text.indexOf("// end fence");
      assert.ok(start >= 0 && end > start, `${s.name} carries the fence block`);
      return text.slice(start, end);
    });
    for (const b of blocks) assert.equal(b, blocks[0], "the fence block is identical in every kit script");
    ok("the fence helper is byte-identical in every kit script (its output is checked against fence.ts below)");
  }

  // 3. understand
  {
    const { outcome, fake, logLines } = await runBuiltin("understand", { question: "How does X work?", maxAreas: 3 }, (s) => {
      if (s.task.startsWith("List the subsystems")) return { structured: { areas: [{ name: "alpha", paths: ["src/a"], why: "core" }, { name: "beta", paths: ["src/b"] }] } };
      const read = /^Read the "([^"]+)" subsystem/.exec(s.task);
      if (read) return { structured: { summary: `sum ${read[1] ?? ""} with \`\`\` inside`, keyFiles: [{ path: `${read[1] ?? ""}/i.ts`, role: "entry" }] } };
      if (s.task.startsWith("Below are independent reads")) return { structured: { missing: [{ name: "Alpha", paths: ["src/a"] }, { name: "gamma", paths: ["src/g"] }, { name: "delta", paths: ["src/d"] }] } };
      if (s.task.startsWith("Write a map")) return { text: "THE MAP" };
      return { fail: `unexpected prompt: ${s.task.slice(0, 40)}` };
    });
    const v = passed(outcome);
    assert.equal(field(v, "map"), "THE MAP");
    const areas = list(field(v, "areas"));
    assert.deepEqual(areas.map((a) => field(a, "area")), ["alpha", "beta", "gamma"], "the critic's new area is read; a repeat (any case) is not");
    assert.deepEqual(field(v, "notRead"), ["delta"]);
    assert.ok(logLines.some((l) => /maxAreas 3: .*not reading: delta/.test(l)), "the dropped area is logged");
    const synth = tasksMatching(fake.seen, /^Write a map/)[0];
    assert.ok(synth);
    const expected = fenceMod.untrusted("understand-reads", JSON.stringify(areas, null, 2), 12000);
    assert.ok(synth.task.includes(expected), "the reads reach the synthesiser inside the same fence untrusted() builds");
    assert.ok(!expected.slice(expected.indexOf("```") + 3, expected.lastIndexOf("```")).includes("```"), "``` in the data cannot close the fence");
    for (const s of fake.seen) assert.ok(s.system.includes("data, not instructions"), "every child gets the data clause");
    ok("understand: scope, reads, a critic whose new areas are read within maxAreas (drops logged), and a fenced synthesis");
  }
  {
    const { outcome, fake, logLines } = await runBuiltin("understand", { question: "How does Y work?", maxAreas: 2 }, (s) => {
      if (s.task.startsWith("List the subsystems")) return { structured: { areas: ["one", "two", "three", "four"].map((name) => ({ name, paths: [`src/${name}`] })) } };
      if (s.task.startsWith("Read the")) return { structured: { summary: "sum", keyFiles: [] } };
      if (s.task.startsWith("Below are independent reads")) return { structured: { missing: [{ name: "Three", paths: ["src/three"] }] } };
      if (s.task.startsWith("Write a map")) return { text: "MAP" };
      return { fail: "unexpected prompt" };
    });
    const v = passed(outcome);
    assert.deepEqual(list(field(v, "areas")).map((a) => field(a, "area")), ["one", "two"], "only maxAreas areas are read; a cut area the critic names again is not");
    assert.deepEqual(field(v, "notRead"), ["three", "four"], "areas cut at scope time are returned");
    assert.ok(logLines.some((l) => /maxAreas 2: not reading 2 of 4 areas: three, four/.test(l)), "the scope cut is logged");
    assert.ok(tasksMatching(fake.seen, /^Write a map/)[0]?.task.includes("not read: three, four"), "the synthesiser is told which areas were not read");
    ok("understand: areas cut by maxAreas at scope time are logged, returned as notRead and named to the synthesiser");
  }

  // 3b. Every built-in's final deliverable is required, so losing it fails the run instead of reading partial.
  {
    const deliverable = (write: RegExp, reply: (s: Spawned) => FakeReply) => (s: Spawned): FakeReply => (write.test(s.task) ? { fail: "provider down" } : reply(s));
    const understood = await runBuiltin("understand", { question: "Q?" }, deliverable(/^Write a map/, (s) => (s.task.startsWith("List the subsystems") ? { structured: { areas: [{ name: "alpha", paths: ["src/a"] }] } } : s.task.startsWith("Below are independent reads") ? { structured: { missing: [] } } : { structured: { summary: "s", keyFiles: [] } })));
    assert.deepEqual([understood.outcome.status, understood.outcome.errorKind], ["failed", "script"]);
    assert.ok(understood.outcome.omissions?.some((o) => o.required && o.stepId === "synthesize"));
    const swept = await runBuiltin("research-sweep", { question: "Q?" }, deliverable(/^Answer the question/, (s) => (s.task.startsWith("Find the sources") ? { structured: { sources: [{ ref: "a", why: "b" }] } } : s.task.startsWith("Read this source") ? { structured: { facts: [] } } : { structured: { gaps: [] } })));
    assert.equal(swept.outcome.status, "failed");
    assert.ok(swept.outcome.omissions?.some((o) => o.required && o.stepId === "synthesize"));
    const panel = await runBuiltin("design-panel", { problem: "p", angles: ["only"] }, deliverable(/^Write the final design/, () => ({ text: "ONE" })));
    assert.equal(panel.outcome.status, "failed");
    const reviewed = await runBuiltin("review-changes", { dimensions: ["correctness"], maxRounds: 1 }, () => ({ fail: "provider down" }));
    assert.equal(reviewed.outcome.status, "failed", "a dimension no reviewer read in the first round is no review");
    ok("understand, research-sweep, design-panel and review-changes fail when their deliverable is lost");
  }

  // 4. review-changes
  {
    const A = { file: "f.ts", line: 1, summary: "A", failure: "a" };
    const B = { file: "f.ts", line: 2, summary: "B", failure: "b" };
    const reply = (s: Spawned): FakeReply => {
      if (s.task.startsWith("Review ")) {
        const later = s.task.includes("Already reported");
        if (later) return { structured: { findings: [A] } };
        return { structured: { findings: s.task.includes("Look only for correctness") ? [A, B] : [A] } };
      }
      if (s.task.startsWith("Try to refute")) {
        const isA = s.task.includes('"line": 1,');
        const reproLens = s.task.includes("Lens: can you construct");
        return { structured: { refuted: isA || reproLens, reason: "r" } };
      }
      return { fail: "unexpected prompt" };
    };
    const { outcome, fake, logLines } = await runBuiltin("review-changes", { target: "the diff", dimensions: ["correctness", "security"] }, reply);
    const v = passed(outcome);
    const confirmed = list(field(v, "confirmed"));
    assert.deepEqual(confirmed.map((c) => field(c, "summary")), ["B"], "only the finding a majority upholds survives");
    assert.equal(field(confirmed[0], "upheld"), 2);
    assert.equal(field(v, "rejected"), 1);
    assert.equal(field(v, "rounds"), 2);
    assert.equal(field(v, "stoppedBy"), "dry");
    assert.equal(tasksMatching(fake.seen, /^Try to refute/).length, 6, "each of the two distinct findings gets three skeptics (the duplicate is verified once)");
    assert.ok(logLines.includes("round 2: 2 findings, 0 new"));
    const capped = await runBuiltin("review-changes", { dimensions: ["correctness"], maxRounds: 1, votes: 1 }, reply);
    assert.equal(field(passed(capped.outcome), "stoppedBy"), "maxRounds");
    assert.ok(capped.logLines.some((l) => l.startsWith("maxRounds 1 reached")), "stopping at maxRounds is logged");
    ok("review-changes: dedup across dimensions, majority-of-skeptics verify, loop until dry; maxRounds is logged");
  }

  // 5. design-panel
  {
    const { outcome, fake, logLines } = await runBuiltin("design-panel", { problem: "Cache the index" }, (s) => {
      if (s.task.startsWith("Design a solution")) return s.task.includes("the user and operator") ? { fail: "down" } : { text: s.task.includes("MVP") ? "DRAFT-MVP" : "DRAFT-RISK" };
      if (s.task.startsWith("Score each draft")) return { structured: { scores: [{ draft: 0, score: 5 }, { draft: 1, score: 9, strengths: "safe" }, { draft: 1, score: 0 }, { draft: 7, score: 10 }] } };
      if (s.task.startsWith("Write the final design")) return { text: "FINAL" };
      return { fail: "unexpected prompt" };
    });
    const v = partial(outcome);
    assert.equal(field(v, "design"), "FINAL");
    assert.match(String(field(v, "winner")), /^risk first/);
    assert.deepEqual(list(field(v, "ranking")).map((r) => field(r, "score")), [9, 5], "a repeated or out-of-range draft index is ignored");
    assert.ok(logLines.includes("1 of 3 drafts returned nothing"));
    const synth = tasksMatching(fake.seen, /^Write the final design/)[0];
    assert.ok(synth?.task.includes(fenceMod.untrusted("design-draft-1", "DRAFT-RISK", 12000)), "the winning draft is fenced into the synthesis");
    assert.equal(tasksMatching(fake.seen, /^Score each draft/).length, 3);
    const single = await runBuiltin("design-panel", { problem: "p", angles: ["only"] }, (s) => ({ text: s.task.startsWith("Design a solution") ? "ONE" : "FINAL" }));
    assert.equal(field(passed(single.outcome), "winner"), "only");
    assert.equal(tasksMatching(single.fake.seen, /^Score each draft/).length, 0, "one draft is not judged");
    assert.ok(single.logLines.includes("only one draft came back; judging skipped"));
    ok("design-panel: drafts per angle, every judge scores every draft, the top mean wins and is synthesised");
  }

  // 6. research-sweep
  {
    const { outcome, fake, logLines } = await runBuiltin("research-sweep", { question: "Why?", modes: ["grep", "git log"], maxReads: 3 }, (s) => {
      if (s.task.startsWith("Find the sources")) return { structured: { sources: s.task.includes("this way: grep") ? [{ ref: "a.ts", why: "w" }, { ref: "b.ts", why: "w" }, { ref: "c.ts", why: "w" }] : [{ ref: "b.ts", why: "w" }, { ref: "d.ts", why: "w" }] } };
      if (s.task.startsWith("Read this source")) return { structured: { facts: [{ claim: "c", evidence: "e" }] } };
      if (s.task.startsWith("Below are the facts")) return { structured: { gaps: [{ ref: "a.ts", why: "again" }, { ref: "e.ts", why: "unread" }] } };
      if (s.task.startsWith("Answer the question")) return { text: "ANSWER" };
      return { fail: "unexpected prompt" };
    });
    const v = passed(outcome);
    assert.deepEqual(list(field(v, "reads")).map((r) => field(r, "ref")), ["a.ts", "b.ts", "c.ts"], "sources are deduplicated across modes");
    assert.deepEqual(field(v, "notRead"), ["d.ts", "e.ts"]);
    assert.ok(logLines.some((l) => l.includes("not reading 1 of 4 sources: d.ts")), "the cap is logged");
    assert.ok(tasksMatching(fake.seen, /^Answer the question/)[0]?.task.includes("found but not read: d.ts, e.ts"), "the synthesiser is told what was not read");
    ok("research-sweep: multi-mode sweep, dedup, capped deep reads (drops logged), a critic, a synthesis that names the gaps");
  }

  // 7. migrate
  {
    const repo = path.join(ws, "repo");
    fs.mkdirSync(repo);
    const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
    const git = (cwd: string, ...a: string[]): string => execFileSync("git", a, { cwd, encoding: "utf8", env: gitEnv }).trim();
    git(repo, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(repo, ".gitignore"), ".pi/\n");
    fs.writeFileSync(path.join(repo, "a.txt"), "old\n");
    fs.writeFileSync(path.join(repo, "b.txt"), "new\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "base");
    const { outcome, fake } = await runBuiltin(
      "migrate",
      { goal: "Replace old with new", sites: ["a.txt", "b.txt"], verify: "true" },
      (s) => {
        if (s.task.startsWith("Apply this change")) {
          const branch = git(s.cwd, "branch", "--show-current");
          if (s.task.includes("to a.txt only")) return { write: { file: "a.txt", text: "new\n" }, structured: { changed: true, branch, summary: "replaced", verified: true, verifyOutput: "ok" } };
          return { structured: { changed: false, branch, summary: "already new", verified: true } };
        }
        if (s.task.startsWith("A worker applied")) return { structured: { refuted: false, reason: "matches" } };
        return { fail: "unexpected prompt" };
      },
      repo,
    );
    const v = passed(outcome);
    const transforms = tasksMatching(fake.seen, /^Apply this change/);
    assert.equal(transforms.length, 2);
    for (const t of transforms) {
      assert.match(t.cwd, /\.pi\/worktrees\/wf-[a-z0-9-]+\/\d$/, "each site runs in its own worktree");
      assert.ok(t.task.includes("run `true`"), "the verify command reaches the worker");
    }
    assert.equal(tasksMatching(fake.seen, /^A worker applied/).length, 1, "only a changed site is reviewed");
    const toMerge = list(field(v, "toMerge")).map(String);
    assert.equal(toMerge.length, 1);
    assert.match(toMerge[0] ?? "", /^luna\/wf\/wf-[a-z0-9-]+\/\d$/);
    assert.equal(outcome.keptWorktrees.length, 1, "the changed worktree is kept, the unchanged one removed");
    assert.equal(outcome.keptWorktrees[0]?.branch, toMerge[0]);
    assert.equal(fs.readFileSync(path.join(repo, "a.txt"), "utf8"), "old\n", "nothing is merged into the main checkout");
    ok("migrate: one worktree per site, changed sites reviewed and kept as branches to merge, the checkout untouched");

    const bad = await runBuiltin(
      "migrate",
      { goal: "Replace old with new", sites: ["a.txt"] },
      (s) => {
        if (s.task.startsWith("Apply this change")) return { write: { file: "a.txt", text: "new\n" }, structured: { changed: true, branch: "main; rm -rf .", summary: "replaced", verified: false } };
        if (s.task.startsWith("A worker applied")) return { structured: { refuted: false, reason: "matches" } };
        return { fail: "unexpected prompt" };
      },
      repo,
    );
    const bv = passed(bad.outcome);
    assert.equal(tasksMatching(bad.fake.seen, /^A worker applied/).length, 0, "a site whose reported branch is not luna/wf/<runId>/<n> is not reviewed");
    assert.deepEqual(field(bv, "toMerge"), [], "nor offered to merge");
    assert.equal(field(list(field(bv, "sites"))[0], "failed"), true, "it is marked failed");
    assert.ok(bad.logLines.some((l) => l.includes("not a workflow worktree branch")), "the wrong branch is logged");
    ok("migrate: a reported branch that is not the engine's worktree branch fails the site, unreviewed and not in toMerge");
  }

  // 8. required args
  {
    for (const name of ["understand", "design-panel", "research-sweep", "migrate"]) {
      const { outcome, fake } = await runBuiltin(name, undefined, () => ({ text: "x" }));
      assert.equal(outcome.status, "failed");
      assert.match(outcome.error ?? "", /args\.(question|problem|goal) \(a string\) is required/);
      assert.equal(fake.seen.length, 0, `${name} launches nothing without its argument`);
    }
    ok("a built-in run without its required argument fails before launching anything");
  }

  // 9. the skill
  {
    const skill = fs.readFileSync(path.join(ROOT, "packages", "kit", "skills", "workflow-authoring", "SKILL.md"), "utf8");
    assert.match(skill, /^---\nname: workflow-authoring\n/);
    for (const name of BUILTINS) assert.ok(skill.includes(`\`${name}\``), `the skill names ${name}`);
    for (const word of ["scriptPath", "resumeFromRunId", "journal.jsonl", "isolation: 'worktree'", "luna/wf/", "untrusted", "firewall", "agentType", "effort", "pipeline(", "secret"]) assert.ok(skill.includes(word), `the skill covers ${word}`);
    assert.ok(!skill.includes(".claude/"), "the skill names no .claude/ path");
    const orchestration = fs.readFileSync(path.join(ROOT, "packages", "kit", "skills", "agent-orchestration", "SKILL.md"), "utf8");
    assert.ok(orchestration.includes("workflow-authoring"), "agent-orchestration points to the workflow-authoring skill");
    ok("the workflow-authoring skill names the built-ins, the Luna notes and the tool's parameters");
  }

  // 10. model-started YAML: real kit files, real effort and delegation-guard, fake children
  {
    const toolsMod = await loadModule<ToolsView>("vendor/subagent/workflow-tools.ts");
    const ledgerMod = await loadModule<typeof LedgerModule>("extensions/effort/ledger.ts");
    const effortMod = await loadModule<{ default: (api: ReturnType<typeof fakePi>["api"]) => void }>("extensions/effort/index.ts");
    const agentDir = process.env.PI_CODING_AGENT_DIR ?? "";
    restores.push(setEnv("PI_KIT_EFFORT_CONFIG", path.join(ws, "no-effort-config.json")));
    const userWorkflows = path.join(agentDir, "workflows");
    fs.mkdirSync(userWorkflows, { recursive: true });
    const members = ["a", "b", "c", "d", "e"].map((id) => `      - { id: ${id}, agent: scout, task: "look at ${id}" }`).join("\n");
    fs.writeFileSync(path.join(userWorkflows, "five.md"), `---\nname: five\ndescription: five at once\nsteps:\n  - id: all\n    parallel:\n${members}\n---\n`);
    fs.writeFileSync(path.join(userWorkflows, "spawner.md"), "---\nname: spawner\ndescription: a step that names subagent\nsteps:\n  - id: one\n    agent: delegator\n    task: delegate this\n    tools: [read, subagent]\n    extensions: [subagent]\n---\n");
    let boots = 0;
    /** One session at a tier: its own ledgers, and the turns as pi fires them. */
    const session = async (tier: string) => {
      const restoreTier = setEnv("PI_KIT_EFFORT", tier);
      const key = `yaml-${String(++boots)}`;
      const pi = fakePi();
      effortMod.default(pi.api);
      const ctx = { hasUI: false, cwd: project, ui: {}, sessionManager: { getSessionId: () => key } };
      await pi.handlers.get("session_start")({ reason: "startup" }, ctx);
      restoreTier();
      const turn = (event: Record<string, unknown>): unknown => pi.handlers.get("before_agent_start")({ systemPrompt: "", ...event }, ctx);
      const userTurn = (): unknown => turn({ messageType: "user", prompt: "go" });
      await userTurn();
      const wake = (): unknown => turn({ messageType: "custom", message: { customType: "luna-workflow-result", content: "done", display: true } });
      return { userTurn, wake, ledger: path.join(agentDir, "pi-kit", "effort", "ledgers", `${key}-workflows.json`) };
    };
    const ctxOf = (answer?: string): ToolContext => (answer === undefined ? { cwd: project, hasUI: false } : { cwd: project, hasUI: true, ui: { select: () => Promise.resolve(answer), notify: () => {}, setStatus: () => {} } });
    const inputsOf = (name: string): Record<string, string> => {
      const w = workflowMod.discoverWorkflows(project).workflows.find((x) => x.name === name);
      assert.ok(w, `${name} is a workflow`);
      return Object.fromEntries(Object.keys(w.inputs).map((k) => [k, "the login bug"]));
    };
    const verdict = (s: Spawned): FakeReply => ({ text: s.task.includes("VERDICT") ? "done\nVERDICT: PASS" : "done" });
    const started = async (name: string, reply: (s: Spawned) => FakeReply = verdict, opts: { signal?: AbortSignal; resume?: WorkflowModule.RunState; answer?: string } = {}) => {
      const fake = fakeSpawner(reply);
      // A live pid: the ledger reaps a slot whose process is gone, and a fake's pid is nobody's.
      const spawnChild: FakeSpawn = (command, args, options) => Object.assign(fake.spawn(command, args, options), { pid: process.pid });
      const r = await toolsMod.startWorkflow(ctxOf(opts.answer), name, opts.resume ? {} : inputsOf(name), { spawnChild, signal: opts.signal, resume: opts.resume });
      return { r, fake };
    };
    const statusOf = (r: Awaited<ReturnType<typeof started>>["r"]): string => r.error ?? r.state.status;
    const failures: string[] = [];
    const check = async (label: string, body: () => Promise<void>): Promise<void> => {
      try {
        await body();
        ok(label);
      } catch (error) {
        failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
        console.log(`  FAIL: ${label}`);
      }
    };

    await check("worst cases are pinned: bugfix 8, feature 8, research 5", () => {
      const { workflows } = workflowMod.discoverWorkflows(project);
      const worst = Object.fromEntries(workflows.filter((w) => w.source === "kit").map((w) => [w.name, workflowMod.worstCaseAgents(w)]));
      assert.deepEqual(worst, { bugfix: 8, feature: 8, research: 5 });
      return Promise.resolve();
    });

    await check("the worst case of what is left: a resume counts unpassed steps and every gate it can still reach", () => {
      const parsed = workflowMod.parseWorkflow(`---
name: nested
steps:
  - { id: one, agent: scout, task: t }
  - id: two
    agent: scout
    task: t
    gate: { pass: ok, retry: one, max_loops: 1 }
  - id: three
    parallel:
      - { id: three-a, agent: scout, task: t }
      - { id: three-b, agent: scout, task: t }
  - id: four
    agent: scout
    task: t
    gate: { pass: ok, retry: two, max_loops: 2 }
---
`, "nested.md", "user");
      const w = parsed.workflow;
      assert.ok(w, parsed.errors.join("; "));
      assert.equal(workflowMod.worstCaseAgents(w), 5 + 2 * 1 + 4 * 2, "gated segments add up where they overlap");
      const state = workflowMod.newRunState(w, {});
      state.cursor = 2;
      state.loops = { four: 1 };
      assert.equal(workflowMod.worstCaseAgents(w, state), 3 + 4 + 2, "3 steps left, 4 for gate four's last loop, and 2 for gate two, behind the cursor, which that loop reaches");
      return Promise.resolve();
    });

    await check("a scope id fits the ledger and changes per scope", () => {
      const state = workflowMod.newRunState({ name: "n".repeat(41), description: "", inputs: {}, steps: [], vault: false, source: "user", file: "x" }, {});
      assert.ok(state.id.length > 64, "the longest workflow name makes a run id longer than a ledger id");
      const first = workflowMod.runScopeId(state);
      assert.equal(first.length, 64);
      state.scopes = 1;
      const second = workflowMod.runScopeId(state);
      assert.match(second, /\.r2$/);
      assert.equal(second.length, 64);
      assert.notEqual(first, second);
      return Promise.resolve();
    });

    await check("model-started bugfix and feature pass at E3, research at E3 and E4; agents run at E1 on the run's ledger", async () => {
      for (const [tier, name, launches] of [["standard", "bugfix", 4], ["standard", "feature", 4], ["standard", "research", 5], ["thorough", "research", 5]] as const) {
        const s = await session(tier);
        const { r, fake } = await started(name);
        assert.equal(statusOf(r), "passed", `${name} at ${tier}`);
        assert.equal(fake.seen.length, launches, `${name} at ${tier}`);
        for (const child of fake.seen) {
          assert.equal(child.env.PI_KIT_EFFORT, "minimal");
          assert.equal(child.env.PI_KIT_EFFORT_LEDGER, s.ledger);
        }
      }
    });

    await check("bugfix at E2 is refused with 0 launches, a reason naming /effort, and no run directory", async () => {
      await session("focused");
      const before = workflowMod.listRuns(project, 1000).length;
      const { r, fake } = await started("bugfix");
      assert.match(r.error ?? "", /\/effort/);
      assert.equal(fake.seen.length, 0);
      assert.equal(workflowMod.listRuns(project, 1000).length, before);
    });

    await check("a second plan past the allowance is refused; a workflow-result wake does not refresh it; a user turn does", async () => {
      const s = await session("standard");
      assert.equal(statusOf((await started("bugfix")).r), "passed");
      const second = await started("feature");
      assert.match(second.r.error ?? "", /\/effort/, "8 of 8 are planned, so a second plan is refused");
      assert.equal(second.fake.seen.length, 0);
      await s.wake();
      const woken = await started("feature");
      assert.match(woken.r.error ?? "", /\/effort/, "a wake starts a turn and a fresh ledger, not a fresh allowance");
      assert.equal(woken.fake.seen.length, 0);
      await s.userTurn();
      assert.equal(statusOf((await started("feature")).r), "passed");
    });

    await check("5 parallel at E3 run 2 at a time", async () => {
      await session("standard");
      const { r, fake } = await started("five", () => ({ text: "seen", delayMs: 40 }));
      assert.equal(statusOf(r), "passed");
      assert.equal(fake.seen.length, 5);
      assert.equal(fake.maxLive(), 2);
    });

    await check("a concurrency denial is waited out, not a failed step", async () => {
      const policy = path.join(ws, "policy-one-live");
      fs.cpSync(path.join(ROOT, "packages", "extensions", "src", "effort", "policy"), policy, { recursive: true });
      const parsed: unknown = JSON.parse(fs.readFileSync(path.join(policy, "effort.json"), "utf8"));
      assert.ok(isRecord(parsed) && isRecord(parsed.workflow));
      parsed.workflow.workflowConcurrent = 1;
      fs.writeFileSync(path.join(policy, "effort.json"), JSON.stringify(parsed));
      const restorePolicy = setEnv("PI_KIT_EFFORT_POLICY_DIR", policy);
      try {
        await session("standard");
        const { r, fake } = await started("five", () => ({ text: "seen", delayMs: 40 }));
        assert.equal(statusOf(r), "passed");
        assert.equal(fake.seen.length, 5);
        assert.equal(fake.maxLive(), 1);
        // The same wait takes a pause: a step denied a slot launches nothing until the run resumes.
        await session("standard");
        const controlMod = await loadModule<typeof ControlModule>("vendor/subagent/control.ts");
        const engineMod = await loadModule<typeof EngineModule>("vendor/subagent/wf-engine.ts");
        const agentsMod = await loadModule<typeof AgentsModule>("vendor/subagent/agents.ts");
        const control = new controlMod.RunControl("paused-wait");
        const held = fakeSpawner(() => ({ text: "seen", delayMs: 40 }));
        const spawnChild: FakeSpawn = (command, args, options) => Object.assign(held.spawn(command, args, options), { pid: process.pid });
        const w = workflowMod.discoverWorkflows(project).workflows.find((x) => x.name === "five");
        assert.ok(w);
        const opened = engineMod.effortRegistry()?.openRunScope("paused-wait", { planned: 5 });
        assert.ok(opened?.ok);
        const executor = await loadModule<{ executeWorkflow(w: WorkflowModule.WorkflowDef, state: WorkflowModule.RunState, options: Omit<WorkflowModule.ExecuteOptions, "spawnChild"> & { spawnChild: FakeSpawn }): Promise<WorkflowModule.RunState> }>("vendor/subagent/workflow.ts");
        const running = executor.executeWorkflow(w, workflowMod.newRunState(w, {}), { cwd: project, agents: agentsMod.discoverAgents(project, "user").agents, spawnChild, control, launchKind: "workflow", workflowRun: { runId: "paused-wait", runToken: opened.runToken } });
        const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
        while (held.seen.length === 0) await pause(5);
        control.act("pause");
        const seen = held.seen.length;
        await pause(400);
        assert.equal(held.seen.length, seen, "no launch while paused");
        control.act("resume");
        assert.equal((await running).status, "passed");
        assert.equal(held.seen.length, 5);
      } finally {
        restorePolicy();
      }
    });

    await check("a YAML step naming subagent gets neither the tool nor the extension", async () => {
      await session("standard");
      const { r, fake } = await started("spawner");
      assert.equal(statusOf(r), "passed");
      const child = fake.seen[0];
      assert.ok(child);
      const tools = child.args[child.args.indexOf("--tools") + 1];
      assert.equal(tools, "read");
      assert.ok(!child.args.some((a) => /subagent[\\/]index\.ts$/.test(a)), child.args.join(" "));
    });

    await check("an approved script at E3 is not held to the 8 of a plan", async () => {
      await session("standard");
      const fake = fakeSpawner(() => ({ text: "done" }));
      const source = 'export const meta = { name: "ten", description: "ten agents" };\nfor (let i = 0; i < 10; i++) await agent(`task ${i}`, { agentType: "scout" });\nreturn "ok";';
      const run = engine.startScriptRun({ name: "ten", description: "ten agents", source, phases: [] }, undefined, { cwd: project, agents, sandbox: { mode, support }, spawnChild: fake.spawn });
      if (!run.ok) throw new Error(run.error);
      assert.equal((await run.done).status, "passed");
      assert.equal(fake.seen.length, 10);
    });

    await check("a model-started run interrupted then resumed opens a new scope and is charged only unpassed steps", async () => {
      const s = await session("standard");
      const stop = new AbortController();
      const first = await started("bugfix", (c) => {
        if (c.task.includes("Fix this bug")) stop.abort();
        return { ...verdict(c), delayMs: 5 };
      }, { signal: stop.signal });
      assert.equal(statusOf(first.r), "interrupted");
      const id = first.r.state?.id ?? "";
      const loaded = workflowMod.loadState(project, id);
      assert.ok(loaded);
      const again = await started("bugfix", verdict, { resume: loaded, answer: toolsMod.RESUME_WRITER_CHOICES[1] });
      assert.match(again.r.error ?? "", /\/effort/, "the first run's 8 are spent in this request");
      assert.equal(again.fake.seen.length, 0);
      await s.userTurn();
      const resumed = workflowMod.loadState(project, id);
      assert.ok(resumed);
      const { r, fake } = await started("bugfix", verdict, { resume: resumed, answer: toolsMod.RESUME_WRITER_CHOICES[1] });
      assert.equal(statusOf(r), "passed");
      assert.equal(fake.seen.length, 2, "fix and verify; reproduce and diagnose had passed");
      const saved = ledgerMod.readLedger(s.ledger)?.workflow;
      assert.ok(saved);
      assert.equal(saved.plannedUsed, 6, "fix + verify + 2 loops of both");
      assert.deepEqual(Object.keys(saved.runs).sort(), [id, `${id}.r2`]);
    });

    await check("state saved during a sequential writer step shows running, and interruptedWriterSteps finds it", async () => {
      await session("standard");
      const { workflows } = workflowMod.discoverWorkflows(project);
      const bugfix = workflows.find((w) => w.name === "bugfix");
      assert.ok(bugfix);
      const during: WorkflowModule.RunState[] = [];
      await started("bugfix", (c) => {
        if (c.task.includes("Fix this bug")) during.push(...workflowMod.listRuns(project, 1).filter((x) => x.workflow === "bugfix"));
        return verdict(c);
      });
      const saved = during[0];
      assert.ok(saved, "the run saved its state");
      assert.equal(saved.steps.fix?.status, "running");
      assert.deepEqual(toolsMod.interruptedWriterSteps(bugfix, saved, agents).map((step) => step.id), ["fix"]);
    });

    assert.deepEqual(failures, [], "model-started YAML cases");
  }

  console.log(`\nworkflow-builtin-smoke: ${checks} checks passed`);
} finally {
  delegation.cleanup();
  for (const restore of restores.reverse()) restore();
  restoreKit();
  rmWorkspace(ws);
}
