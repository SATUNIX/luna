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
//   8. Journal v2: a changed skill body, a v1 journal and a checkout outside git reuse nothing, and each says why.
//   9. A started row with no end row is unknown: a read or a worktree writer replays, a main-checkout writer replays
//      only if the checkout is as the run left it, otherwise it is blocked:unknown-effect, on every later resume too.
//      Calls that ran while held back are never reused, and a cached writer row does not move the checkout's base.
//  10. The fingerprint leaves the real index alone, and a kept worktree whose git link moved is never fingerprinted.
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
import type * as ToolModule from "../packages/extensions/third_party/subagent/wf-tool.ts";
import { fakeSpawner, type FakeReply, type FakeSpawn, type Spawned } from "./workflow-fakes.ts";

type Options = Omit<EngineModule.EngineOptions, "spawnChild"> & { spawnChild: FakeSpawn };
interface EngineView {
  startScriptRun(spec: EngineModule.ScriptSpec, args: unknown, opts: Options): EngineModule.StartResult;
  readJournal: typeof EngineModule.readJournal;
  callKey: typeof EngineModule.callKey;
  canonicalJson: typeof EngineModule.canonicalJson;
  workspaceFingerprint: typeof EngineModule.workspaceFingerprint;
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
const { formatCompletion } = await loadModule<typeof ToolModule>("vendor/subagent/wf-tool.ts");
const sandboxMod = await loadModule<typeof SandboxModule>("vendor/subagent/wf-sandbox.ts");
const support = sandboxMod.detectSupport();
const mode: SandboxModule.SandboxMode = support.bwrap ? "full" : "reduced";

const role = (name: string, tools?: string[]): AgentConfig => ({ name, description: name, systemPrompt: `You are ${name}.`, source: "kit", filePath: name, ...(tools ? { tools } : {}) });
const agents: AgentConfig[] = [role("implementer"), role("planner", ["read", "grep", "find", "ls"])];
const repo = path.join(ws, "repo");
fs.mkdirSync(repo);
const gitIn = (cwd: string, ...a: string[]): string => execFileSync("git", a, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" } }).trim();
const git = (...a: string[]): string => gitIn(repo, ...a);
git("init", "-q", "-b", "main");
fs.writeFileSync(path.join(repo, ".gitignore"), ".pi/\n");
fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
git("add", "-A");
git("commit", "-q", "-m", "base");

const spec = (source: string): EngineModule.ScriptSpec => ({ name: "resume-test", description: "test", source: `export const meta = { name: "resume-test", description: "test" };\n${source}`, phases: [] });
async function run(source: string, reply: (s: Spawned) => FakeReply, resumeFrom?: string, args?: unknown, cwd = repo, status: EngineModule.RunOutcome["status"] = "passed", roles = agents) {
  const fake = fakeSpawner(reply);
  const started = engine.startScriptRun(spec(source), args, { cwd, agents: roles, sandbox: { mode, support }, spawnChild: fake.spawn, ...(resumeFrom ? { resumeFrom } : {}) });
  if (!started.ok) throw new Error(started.error);
  const outcome = await started.done;
  assert.equal(outcome.status, status, `${outcome.status}: ${outcome.error ?? ""}`);
  return { started, outcome, fake, journal: engine.readJournal(started.journalPath) };
}
const read = { agentType: "planner" };

let repos = 0;
/** A fresh checkout: .pi/ ignored, a.txt committed. */
function freshRepo(): string {
  const dir = path.join(ws, `case-${String(++repos)}`);
  fs.mkdirSync(dir);
  gitIn(dir, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(dir, ".gitignore"), ".pi/\n");
  fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
  gitIn(dir, "add", "-A");
  gitIn(dir, "commit", "-q", "-m", "base");
  return dir;
}

/** The narrator line in run.json and the completion line that give a rejected reuse's reason. */
function saysWhy(r: Awaited<ReturnType<typeof run>>, reason: string): void {
  const saved: unknown = JSON.parse(fs.readFileSync(path.join(r.started.transcriptDir, "run.json"), "utf8"));
  const log: unknown = Reflect.get(Object(saved), "log");
  assert.ok(Array.isArray(log) && log.some((l) => String(l).includes(`reuse.rejected{${reason}}`)), `the narrator names ${reason}: ${JSON.stringify(log)}`);
  assert.ok(formatCompletion(r.outcome).includes(`reuse.rejected{${reason}}`), `the completion message names ${reason}`);
}

/** A run directory whose journal holds a run row for the checkout as it is now, plus `rows`: what a killed run leaves. */
async function killedRun(dir: string, rows: Array<Record<string, unknown>>): Promise<string> {
  const first = await run(`return 1`, () => ({}), undefined, undefined, dir);
  const fingerprint = await engine.workspaceFingerprint(dir, path.join(dir, ".pi", "workflows", "runs"));
  const lines = [{ v: 2, seq: 1, event: "run", fingerprint }, ...rows.map((row, i) => ({ v: 2, seq: i + 2, ...row }))];
  fs.writeFileSync(first.started.journalPath, lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
  return first.started.runId;
}

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
  const flaky = await run(`return [await agent("a", ${JSON.stringify(read)}), await agent("b", ${JSON.stringify(read)})]`, (s) => (s.task === "a" && fail ? { fail: "provider down" } : { text: s.task }), undefined, undefined, repo, "partial");
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

  // 8. Reuse is bound to the definition and the journal format, and says why it was refused.
  const skills = path.join(ws, "skills");
  fs.mkdirSync(path.join(skills, "house-style"), { recursive: true });
  restores.push(setEnv("PI_KIT_SKILL_DIRS", skills));
  const skillFile = path.join(skills, "house-style", "SKILL.md");
  fs.writeFileSync(skillFile, "Use tabs.\n");
  const skilled = agents.map((a) => (a.name === "planner" ? { ...a, skills: ["house-style"] } : a));
  const askPlanner = `return await agent("report", ${JSON.stringify(read)})`;
  const skillRepo = freshRepo();
  const skillFirst = await run(askPlanner, () => ({ text: "first" }), undefined, undefined, skillRepo, "passed", skilled);
  const skillSame = await run(askPlanner, () => ({ text: "live" }), skillFirst.started.runId, undefined, skillRepo, "passed", skilled);
  assert.equal(skillSame.outcome.cached, 1, "an unchanged skill body still reuses");
  fs.writeFileSync(skillFile, "Use spaces.\n");
  const skillMoved = await run(askPlanner, () => ({ text: "live" }), skillSame.started.runId, undefined, skillRepo, "passed", skilled);
  assert.deepEqual([skillMoved.outcome.cached, skillMoved.outcome.launched, skillMoved.outcome.value], [0, 1, "live"]);
  saysWhy(skillMoved, "definition");
  ok("a role's skill body changing rejects the reuse, and the run says so");

  const v1Repo = freshRepo();
  const v1First = await run(askPlanner, () => ({ text: "old" }), undefined, undefined, v1Repo);
  const v1Rows: Array<Record<string, unknown>> = fs.readFileSync(v1First.started.journalPath, "utf8").trim().split("\n").map((l): Record<string, unknown> => {
    const row: unknown = JSON.parse(l);
    return typeof row === "object" && row !== null ? Object.fromEntries(Object.entries(row)) : {};
  }).filter((row) => row.event === undefined).map(({ definition: _gone, ...row }) => ({ ...row, v: 1 }));
  assert.equal(v1Rows.length, 1);
  fs.writeFileSync(v1First.started.journalPath, `${JSON.stringify(v1Rows[0])}\n`);
  assert.equal(engine.readJournal(v1First.started.journalPath).length, 1, "a v1 entry still parses");
  const v1Resumed = await run(askPlanner, () => ({ text: "live" }), v1First.started.runId, undefined, v1Repo);
  assert.deepEqual([v1Resumed.outcome.cached, v1Resumed.outcome.launched, v1Resumed.outcome.value], [0, 1, "live"]);
  saysWhy(v1Resumed, "legacy");
  const v2Again = await run(askPlanner, () => ({ text: "later" }), v1Resumed.started.runId, undefined, v1Repo);
  assert.equal(v2Again.outcome.cached, 1, "the resumed run wrote v2, so a v1 journal costs one resume");
  ok("a v1 journal reuses nothing, once, and says why");

  const plain = path.join(ws, "plain");
  fs.mkdirSync(plain);
  const plainFirst = await run(askPlanner, () => ({ text: "old" }), undefined, undefined, plain);
  const plainResumed = await run(askPlanner, () => ({ text: "live" }), plainFirst.started.runId, undefined, plain);
  assert.deepEqual([plainResumed.outcome.cached, plainResumed.outcome.launched, plainResumed.outcome.value], [0, 1, "live"]);
  saysWhy(plainResumed, "workspace");
  ok("outside git nothing is reused, reads included");

  const live = (): FakeReply => ({ text: "live" });
  const failedRepo = freshRepo();
  const twoWriters = `const a = await agent("first"); const b = await agent("second"); return [a, b]`;
  const failing = (s: Spawned): FakeReply => (s.task === "second" ? { fail: "provider down", write: { file: "a.txt", text: "half done\n" } } : { text: "ok", write: { file: "b.txt", text: "first\n" } });
  const failedFirst = await run(twoWriters, failing, undefined, undefined, failedRepo, "partial");
  const failedResumed = await run(twoWriters, live, failedFirst.started.runId, undefined, failedRepo);
  assert.deepEqual([failedResumed.outcome.cached, failedResumed.outcome.launched], [1, 1]);
  ok("a resume continues from the state a failed writer left");

  // 9. A started row with no end row.
  const writeCall = `return await agent("write")`;
  const writeRow = { event: "started", key: engine.callKey("write", null), label: "implementer #1", role: "implementer", writer: true };

  const changedRepo = freshRepo();
  const killed = await killedRun(changedRepo, [writeRow]);
  fs.writeFileSync(path.join(changedRepo, "a.txt"), "half done\n");
  const blocked = await run(writeCall, live, killed, undefined, changedRepo, "failed");
  assert.equal(blocked.fake.seen.length, 0, "nothing runs on top of an unknown effect");
  assert.equal(blocked.outcome.launched, 0);
  assert.equal(blocked.outcome.omissions?.[0]?.execution, "blocked");
  assert.equal(blocked.outcome.omissions?.[0]?.reason?.code, "unknown-effect");
  assert.ok(!formatCompletion(blocked.outcome).includes("Resume with"), "the operator starts a fresh run");
  const blockedAgain = await run(writeCall, live, blocked.started.runId, undefined, changedRepo, "failed");
  assert.equal(blockedAgain.outcome.omissions?.[0]?.reason?.code, "unknown-effect", "resuming the refusal does not launder it");
  const otherWriter = await run(`return await agent("something else")`, live, killed, undefined, changedRepo, "failed");
  assert.equal(otherWriter.fake.seen.length, 0, "no main-checkout writer runs on that state, whatever its prompt");
  const blockedRead = await run(`return await agent("report", ${JSON.stringify(read)})`, live, killed, undefined, changedRepo);
  assert.equal(blockedRead.outcome.launched, 1, "a read runs live");
  fs.writeFileSync(path.join(changedRepo, "a.txt"), "a\n");
  const restored = await run(writeCall, live, blockedAgain.started.runId, undefined, changedRepo);
  assert.deepEqual([restored.outcome.launched, restored.outcome.value], [1, "live"], "putting the checkout back as the run left it clears the block");
  ok("a killed main-checkout writer, checkout changed: blocked:unknown-effect, on every resume");

  const heldRepo = freshRepo();
  const readThenWrite = `const report = await agent("report", ${JSON.stringify(read)}); const wrote = await agent("write"); return [report, wrote]`;
  const heldKilled = await killedRun(heldRepo, [writeRow]);
  fs.writeFileSync(path.join(heldRepo, "a.txt"), "half done\n");
  const held = await run(readThenWrite, () => ({ text: "READ-OF-HALF-DONE" }), heldKilled, undefined, heldRepo, "failed");
  assert.equal(held.outcome.launched, 1, "the read runs, the writer does not");
  assert.equal(held.outcome.omissions?.[0]?.reason?.code, "unknown-effect");
  assert.ok(held.journal.length > 0 && held.journal.every((e) => !e.ok), "nothing from a held-back run reads as reusable");
  fs.writeFileSync(path.join(heldRepo, "a.txt"), "a\n");
  const afterHeld = await run(readThenWrite, (s) => ({ text: `fresh ${s.task}` }), held.started.runId, undefined, heldRepo);
  assert.deepEqual([afterHeld.outcome.cached, afterHeld.outcome.launched, afterHeld.outcome.value], [0, 2, ["fresh report", "fresh write"]]);
  ok("a read taken while held back is not reused once the checkout is restored");

  const cachedRowRepo = freshRepo();
  const leftHalfDone = await run(twoWriters, failing, undefined, undefined, cachedRowRepo, "partial");
  const reachedSecond = await run(twoWriters, live, leftHalfDone.started.runId, undefined, cachedRowRepo);
  assert.deepEqual([reachedSecond.outcome.cached, reachedSecond.outcome.launched], [1, 1]);
  const killedSecond = fs.readFileSync(reachedSecond.started.journalPath, "utf8").split("\n").filter((l) => !l.includes(`"label":"implementer #2"`) || l.includes(`"event":"started"`));
  fs.writeFileSync(reachedSecond.started.journalPath, killedSecond.join("\n"));
  const cachedRowReplay = await run(twoWriters, live, reachedSecond.started.runId, undefined, cachedRowRepo);
  assert.deepEqual([cachedRowReplay.outcome.cached, cachedRowReplay.outcome.launched, cachedRowReplay.outcome.value], [1, 1, ["ok", "live"]]);
  ok("a cached writer row is an older run's state: a killed writer that changed nothing replays");

  const sameRepo = freshRepo();
  const replayed = await run(writeCall, live, await killedRun(sameRepo, [writeRow]), undefined, sameRepo);
  assert.deepEqual([replayed.outcome.launched, replayed.outcome.value], [1, "live"]);
  ok("the same with the checkout unchanged replays");

  const readRepo = freshRepo();
  const readKilled = await killedRun(readRepo, [{ event: "started", key: engine.callKey("report", read), label: "planner #1", role: "planner", writer: false }]);
  fs.writeFileSync(path.join(readRepo, "a.txt"), "edited\n");
  const readReplayed = await run(askPlanner, live, readKilled, undefined, readRepo);
  assert.deepEqual([readReplayed.outcome.launched, readReplayed.outcome.value], [1, "live"]);
  ok("a read-only unknown replays");

  const isoRepo = freshRepo();
  const isolated = { isolation: "worktree" };
  const isoKilled = await killedRun(isoRepo, [{ ...writeRow, key: engine.callKey("write", isolated), isolated: true }]);
  fs.writeFileSync(path.join(isoRepo, "a.txt"), "edited\n");
  gitIn(isoRepo, "commit", "-q", "-am", "moved on");
  const isoReplayed = await run(`return await agent("write", ${JSON.stringify(isolated)})`, live, isoKilled, undefined, isoRepo);
  assert.deepEqual([isoReplayed.outcome.launched, isoReplayed.outcome.value], [1, "live"]);
  ok("a worktree writer's unknown replays in a new worktree");

  // 10. The fingerprint.
  const openRepo = freshRepo();
  fs.rmSync(path.join(openRepo, ".gitignore"));
  gitIn(openRepo, "add", "-A");
  gitIn(openRepo, "commit", "-q", "-m", "no ignore rules");
  const openFirst = await run(`return await agent("change", ${JSON.stringify(isolated)})`, (s) => ({ text: "changed", write: { file: "a.txt", text: s.task } }), undefined, undefined, openRepo);
  assert.equal(openFirst.outcome.keptWorktrees.length, 1);
  const openResumed = await run(`return await agent("change", ${JSON.stringify(isolated)})`, live, openFirst.started.runId, undefined, openRepo);
  assert.equal(openResumed.outcome.cached, 1, "the run's own worktree does not read as a change to the checkout");
  const openReadFirst = await run(askPlanner, () => ({ text: "read" }), undefined, undefined, openRepo);
  const openRead = await run(askPlanner, live, openReadFirst.started.runId, undefined, openRepo);
  assert.equal(openRead.outcome.cached, 1, "the agents' own logs do not read as a change to the checkout");
  ok("a read and a kept worktree under a .pi that is not ignored are still reused");

  const fpRepo = freshRepo();
  const realIndex = path.join(fpRepo, ".git", "index");
  const indexBefore = fs.readFileSync(realIndex);
  const fpBefore = await engine.workspaceFingerprint(fpRepo);
  assert.equal(await engine.workspaceFingerprint(fpRepo), fpBefore, "the same checkout gives the same fingerprint");
  fs.writeFileSync(path.join(fpRepo, "a.txt"), "b\n");
  assert.notEqual(await engine.workspaceFingerprint(fpRepo), fpBefore, "a same-size edit straight after the commit changes it");
  gitIn(fpRepo, "update-index", "--assume-unchanged", "a.txt");
  const hidden = fs.readFileSync(realIndex);
  assert.notEqual(await engine.workspaceFingerprint(fpRepo), fpBefore, "a file flagged assume-unchanged is still read");
  assert.ok(fs.readFileSync(realIndex).equals(hidden), "the real index is not written");
  assert.ok(!indexBefore.equals(hidden));
  ok("the fingerprint sees edits a seeded index could hide and leaves the real index alone");

  const linkRepo = freshRepo();
  const isoCall = `return await agent("change", ${JSON.stringify(isolated)})`;
  const linkKept = await run(isoCall, (s) => ({ text: "changed", write: { file: "a.txt", text: s.task } }), undefined, undefined, linkRepo);
  const keptPath = linkKept.outcome.keptWorktrees[0]?.path ?? "";
  const fakeRepo = path.join(ws, "planted");
  const marker = path.join(ws, "filter-ran");
  fs.mkdirSync(fakeRepo);
  gitIn(fakeRepo, "init", "-q", "-b", "main");
  gitIn(fakeRepo, "config", "filter.planted.clean", `touch ${marker}; cat`);
  fs.writeFileSync(path.join(fakeRepo, ".git", "info", "attributes"), "* filter=planted\n");
  fs.writeFileSync(path.join(keptPath, ".git"), `gitdir: ${path.join(fakeRepo, ".git")}\n`);
  const linkResumed = await run(isoCall, live, linkKept.started.runId, undefined, linkRepo);
  assert.equal(linkResumed.outcome.cached, 0);
  saysWhy(linkResumed, "worktree");
  assert.ok(!fs.existsSync(marker), "git never ran in a worktree whose link left the checkout's own git dir");
  ok("a kept worktree whose git link moved is rejected without running git in it");

  console.log(`\nworkflow-resume-smoke: ${checks} checks passed`);
} finally {
  delegation.cleanup();
  for (const restore of restores.reverse()) restore();
  restoreKit();
  rmWorkspace(ws);
}
