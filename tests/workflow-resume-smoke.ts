#!/usr/bin/env node
// Script-workflow journal and resume (packages/extensions/third_party/subagent/wf-engine.ts, docs/script-workflows.md).
//   1. journal.jsonl records every agent() call with its key, label, phase, role and redacted value.
//   2. Same script and args: every call is reused (none launched), pipelines included, in any finish order.
//   3. An edited call and every call after it run live; the unchanged prefix is reused; labels are not part of the key.
//   4. A failed call is journaled but never reused.
//   5. Writers in the main checkout: reused only while the checkout is as the earlier run left it (T6);
//      they also run one at a time under the checkout's writer lock.
//      Identical concurrent calls each reuse their own entry; the runs root is left out of the fingerprint,
//      so a checkout that does not gitignore .pi/ reuses writers too.
//   6. A kept worktree's result is reused only while its branch still points where it ended.
//   7. An unknown run id is refused; the key is sha256 of the canonical {prompt, opts without label}.
// Offline: children are fakes (tests/workflow-fakes.ts) behind the real effort and delegation-guard extensions.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isolateKitEnv, loadModule, rmWorkspace, setEnv, tmpWorkspace } from "../packages/core/eval/harness.ts";
import { installDelegation } from "../packages/core/eval/delegation.ts";
import type { AgentConfig } from "../packages/extensions/third_party/subagent/agents.ts";
import type * as EngineModule from "../packages/extensions/third_party/subagent/wf-engine.ts";
import type * as SandboxModule from "../packages/extensions/third_party/subagent/wf-sandbox.ts";
import { fakeSpawner, type FakeReply, type FakeSpawn, type Spawned } from "./workflow-fakes.ts";

type Options = Omit<EngineModule.EngineOptions, "spawnChild"> & { spawnChild: FakeSpawn };
interface EngineView {
  startScriptRun(spec: EngineModule.ScriptSpec, args: unknown, opts: Options): EngineModule.StartResult;
  readJournal: typeof EngineModule.readJournal;
  callKey: typeof EngineModule.callKey;
  canonicalJson: typeof EngineModule.canonicalJson;
}

const restoreKit = isolateKitEnv();
const ws = tmpWorkspace("pi-kit-wf-resume-");
const restores = [setEnv("HOME", path.join(ws, "home")), setEnv("PI_KIT_SUBAGENT_RETRIES", "0"), setEnv("PI_KIT_SUBAGENT_STATE_DIR", path.join(ws, "state"))];
const delegation = await installDelegation({ tier: "standard" });
let checks = 0;
const ok = (label: string): void => {
  checks++;
  console.log(`  OK: ${label}`);
};

const engine = await loadModule<EngineView>("vendor/subagent/wf-engine.ts");
const sandboxMod = await loadModule<typeof SandboxModule>("vendor/subagent/wf-sandbox.ts");
const support = sandboxMod.detectSupport();
const mode: SandboxModule.SandboxMode = support.bwrap ? "full" : "reduced";

const role = (name: string, tools?: string[]): AgentConfig => ({ name, description: name, systemPrompt: `You are ${name}.`, source: "kit", filePath: name, ...(tools ? { tools } : {}) });
const agents: AgentConfig[] = [role("implementer"), role("planner", ["read", "grep", "find", "ls"])];
const repo = path.join(ws, "repo");
fs.mkdirSync(repo);
const git = (...a: string[]): string => execFileSync("git", a, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" } }).trim();
git("init", "-q", "-b", "main");
fs.writeFileSync(path.join(repo, ".gitignore"), ".pi/\n");
fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
git("add", "-A");
git("commit", "-q", "-m", "base");

const spec = (source: string): EngineModule.ScriptSpec => ({ name: "resume-test", description: "test", source: `export const meta = { name: "resume-test", description: "test" };\n${source}`, phases: [] });
async function run(source: string, reply: (s: Spawned) => FakeReply, resumeFrom?: string, args?: unknown, cwd = repo) {
  const fake = fakeSpawner(reply);
  const started = engine.startScriptRun(spec(source), args, { cwd, agents, sandbox: { mode, support }, spawnChild: fake.spawn, ...(resumeFrom ? { resumeFrom } : {}) });
  if (!started.ok) throw new Error(started.error);
  const outcome = await started.done;
  assert.equal(outcome.status, "passed", `${outcome.status}: ${outcome.error ?? ""}`);
  return { started, outcome, fake, journal: engine.readJournal(started.journalPath) };
}
const read = { agentType: "planner" };

try {
  // 1 + 2. Journal, then a full reuse (pipelines finish out of order).
  const source = `const a = await agent("first " + args.topic, ${JSON.stringify(read)})
    const b = await pipeline([3, 1, 2], (n) => agent("p1 " + n, ${JSON.stringify({ ...read, phase: "P" })}), (prev) => agent("p2 " + prev, ${JSON.stringify({ ...read, phase: "P" })}))
    const c = await agent("last", { agentType: "planner", label: "the end" })
    return { a, b, c }`;
  const reply = (s: Spawned): FakeReply => ({ text: s.task.toUpperCase(), delayMs: /^p1 (\d)/.exec(s.task) ? Number(/^p1 (\d)/.exec(s.task)?.[1]) * 15 : 0 });
  const first = await run(source, reply, undefined, { topic: "x" });
  assert.equal(first.outcome.launched, 8);
  assert.equal(first.journal.length, 8);
  const lastEntry = first.journal.find((e) => e.label === "the end");
  assert.ok(lastEntry);
  assert.equal(lastEntry.value, "LAST");
  assert.equal(lastEntry.role, "planner");
  assert.equal(lastEntry.writer, false);
  assert.equal(lastEntry.key, crypto.createHash("sha256").update(engine.canonicalJson({ prompt: "last", opts: { agentType: "planner" } })).digest("hex"), "the key leaves the label out");
  assert.equal(engine.callKey("last", { label: "other", agentType: "planner" }), lastEntry.key);
  assert.notEqual(engine.callKey("last", { agentType: "scout" }), lastEntry.key);
  ok("journal.jsonl records each call's key (sha256 of canonical {prompt, opts without label}), label, role and value");

  const again = await run(source, reply, first.started.runId, { topic: "x" });
  assert.deepEqual(again.outcome.value, first.outcome.value);
  assert.equal(again.outcome.launched, 0, "nothing is launched");
  assert.equal(again.outcome.cached, 8);
  assert.equal(again.fake.seen.length, 0);
  assert.ok(again.journal.every((e) => e.cached === true), "the new journal marks reused calls");
  ok("the same script and args reuse every call, pipelines included, whatever order they finished in");

  // 2b. Identical concurrent calls (best-of-N) each get their own journal entry.
  let n = 0;
  const bestOf = `return await parallel([1, 2, 3].map(() => () => agent("sample", ${JSON.stringify(read)})))`;
  const sampled = await run(bestOf, () => ({ text: `v${String(++n)}` }));
  assert.deepEqual(sampled.outcome.value, ["v1", "v2", "v3"]);
  const resampled = await run(bestOf, () => ({ text: "live" }), sampled.started.runId);
  assert.equal(resampled.outcome.cached, 3);
  assert.equal(resampled.outcome.launched, 0);
  assert.deepEqual(resampled.outcome.value, ["v1", "v2", "v3"], "no entry is handed to two calls");
  ok("identical concurrent calls each reuse their own journal entry");

  // 3. An edited call ends the prefix.
  const edited = await run(source.replace('"last"', '"last, edited"'), reply, again.started.runId, { topic: "x" });
  assert.equal(edited.outcome.cached, 7);
  assert.equal(edited.outcome.launched, 1);
  assert.deepEqual(edited.fake.seen.map((s) => s.task), ["last, edited"]);
  const changedArgs = await run(source, reply, again.started.runId, { topic: "y" });
  assert.equal(changedArgs.outcome.cached, 0, "the first call changed, so nothing after it is reused");
  assert.equal(changedArgs.outcome.launched, 8);
  ok("an edited call and every call after it run live; the unchanged prefix is reused");

  // 4. A failed call is never reused.
  let fail = true;
  const flaky = await run(`return [await agent("a", ${JSON.stringify(read)}), await agent("b", ${JSON.stringify(read)})]`, (s) => (s.task === "a" && fail ? { fail: "provider down" } : { text: s.task }));
  assert.deepEqual(flaky.outcome.value, [null, "b"]);
  assert.equal(flaky.journal.find((e) => e.label.endsWith("#1"))?.ok, false);
  fail = false;
  const retried = await run(`return [await agent("a", ${JSON.stringify(read)}), await agent("b", ${JSON.stringify(read)})]`, (s) => ({ text: s.task }), flaky.started.runId);
  assert.deepEqual(retried.outcome.value, ["a", "b"]);
  assert.equal(retried.outcome.cached, 0, "the failed first call is re-run, and the prefix ends there");
  ok("a failed call is journaled with ok false and re-run on resume");

  // 5. Writers in the main checkout.
  const writers = `return await parallel([1, 2, 3].map((i) => () => agent("write " + i)))`;
  const wrote = await run(writers, (s) => ({ text: s.task, write: { file: `${s.task.replace(" ", "-")}.txt`, text: s.task }, delayMs: 20 }));
  assert.equal(wrote.fake.maxLive(), 1, "writers in the main checkout run one at a time");
  assert.ok(wrote.journal.every((e) => e.writer && typeof e.workspace === "string"), "each writer records the checkout's fingerprint");
  const same = await run(writers, () => ({ text: "live" }), wrote.started.runId);
  assert.equal(same.outcome.cached, 3, "an unchanged checkout reuses the writers");
  fs.writeFileSync(path.join(repo, "write-2.txt"), "edited by hand");
  const moved = await run(writers, (s) => ({ text: `live ${s.task}` }), same.started.runId);
  assert.equal(moved.outcome.cached, 0, "a checkout changed since the run reuses no writer");
  assert.equal(moved.outcome.launched, 3);
  ok("writers in the main checkout take the writer lock and are reused only while the checkout is as the earlier run left it");

  // 5b. The run directories are not part of the fingerprint, so a repo that does not ignore .pi/ reuses writers.
  const bare = path.join(ws, "bare");
  fs.mkdirSync(bare);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: bare });
  fs.writeFileSync(path.join(bare, "a.txt"), "a\n");
  const bareWrote = await run(writers, (s) => ({ text: s.task, write: { file: `${s.task.replace(" ", "-")}.txt`, text: s.task } }), undefined, undefined, bare);
  assert.ok(fs.existsSync(path.join(bare, ".pi", "workflows", "runs")), "the runs root is inside the checkout");
  const bareSame = await run(writers, () => ({ text: "live" }), bareWrote.started.runId, undefined, bare);
  assert.equal(bareSame.outcome.cached, 3, "the run's own journal does not change the fingerprint");
  ok("writers are reused in a checkout that does not gitignore .pi/");

  // 6. A kept worktree's result.
  git("add", "-A");
  git("commit", "-q", "-m", "writers");
  const iso = `return await agent("change", { isolation: "worktree" })`;
  const kept = await run(iso, (s) => ({ text: "changed", write: { file: "a.txt", text: s.task } }));
  assert.equal(kept.outcome.keptWorktrees.length, 1);
  const branch = kept.outcome.keptWorktrees[0]?.branch ?? "";
  assert.equal(kept.journal[0]?.worktree?.status, "kept");
  const reused = await run(iso, () => ({ text: "live" }), kept.started.runId);
  assert.equal(reused.outcome.cached, 1, "the kept branch is where the agent left it");
  git("worktree", "remove", "--force", kept.outcome.keptWorktrees[0]?.path ?? "");
  git("branch", "-D", branch);
  const gone = await run(iso, () => ({ text: "live" }), reused.started.runId);
  assert.equal(gone.outcome.cached, 0, "a deleted branch's result is not reused");
  ok("a kept worktree's result is reused only while its branch still points where the agent ended");

  // 7. Unknown run, redaction.
  const unknown = engine.startScriptRun(spec(`return 1`), undefined, { cwd: repo, agents, sandbox: { mode, support }, spawnChild: fakeSpawner(() => ({})).spawn, resumeFrom: "wf-nope" });
  assert.equal(unknown.ok, false);
  assert.match(unknown.ok ? "" : unknown.error, /No script workflow run "wf-nope"/);
  const secret = ["ghp", "_", "a".repeat(36)].join("");
  const redacted = await run(`return await agent("leak", ${JSON.stringify(read)})`, () => ({ text: `token ${secret}` }));
  assert.equal(redacted.outcome.value, `token ${secret}`, "the live value is the child's");
  const text = fs.readFileSync(redacted.started.journalPath, "utf8");
  assert.ok(!text.includes(secret) && text.includes("[REDACTED"), "the journal copy is redacted");
  ok("an unknown resume id is refused, and journal values are redacted");

  console.log(`\nworkflow-resume-smoke: ${checks} checks passed`);
} finally {
  delegation.cleanup();
  for (const restore of restores.reverse()) restore();
  restoreKit();
  rmWorkspace(ws);
}
