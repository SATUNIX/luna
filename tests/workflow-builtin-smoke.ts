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
// Offline: children are fakes (tests/workflow-fakes.ts) behind the real effort and delegation-guard extensions.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ROOT, isolateKitEnv, loadModule, rmWorkspace, setEnv, tmpWorkspace } from "../packages/core/eval/harness.ts";
import { installDelegation } from "../packages/core/eval/delegation.ts";
import type * as AgentsModule from "../packages/extensions/third_party/subagent/agents.ts";
import type * as EngineModule from "../packages/extensions/third_party/subagent/wf-engine.ts";
import type * as FenceModule from "../packages/extensions/third_party/subagent/fence.ts";
import type * as SandboxModule from "../packages/extensions/third_party/subagent/wf-sandbox.ts";
import type * as WorkflowModule from "../packages/extensions/third_party/subagent/workflow.ts";
import { fakeSpawner, type FakeReply, type FakeSpawn, type Spawned } from "./workflow-fakes.ts";

type Options = Omit<EngineModule.EngineOptions, "spawnChild"> & { spawnChild: FakeSpawn };
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
const passed = (o: EngineModule.RunOutcome): unknown => {
  assert.equal(o.status, "passed", `run ${o.status}: ${o.error ?? ""}`);
  return o.value;
};
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
    const v = passed(outcome);
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

  console.log(`\nworkflow-builtin-smoke: ${checks} checks passed`);
} finally {
  delegation.cleanup();
  for (const restore of restores.reverse()) restore();
  restoreKit();
  rmWorkspace(ws);
}
