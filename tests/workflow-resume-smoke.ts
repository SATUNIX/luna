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
//  11. The fingerprint leaves out all of .pi, trusts no stat setting, writes no object to the repository and
//      gives up on a nested repository; a redacted result is not replayed, a writer's started row must reach
//      the journal, a finished writer outlives a stop, and a failed launch or worktree meets the agent limit fairly.
// Offline: children are fakes (tests/workflow-fakes.ts) behind the real effort and delegation-guard extensions.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { isolateKitEnv, loadModule, rmWorkspace, setEnv, tmpWorkspace } from "../packages/core/eval/harness.ts";
import { installDelegation } from "../packages/core/eval/delegation.ts";
import type { AgentConfig } from "../packages/extensions/third_party/subagent/agents.ts";
import type * as ControlModule from "../packages/extensions/third_party/subagent/control.ts";
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
const controlMod = await loadModule<typeof ControlModule>("vendor/subagent/control.ts");
const { formatCompletion } = await loadModule<typeof ToolModule>("vendor/subagent/wf-tool.ts");
const sandboxMod = await loadModule<typeof SandboxModule>("vendor/subagent/wf-sandbox.ts");
const support = sandboxMod.detectSupport();
const mode: SandboxModule.SandboxMode = support.bwrap ? "full" : "reduced";

const role = (name: string, tools?: string[]): AgentConfig => ({ name, description: name, systemPrompt: `You are ${name}.`, source: "kit", filePath: name, ...(tools ? { tools } : {}) });
const agents: AgentConfig[] = [role("implementer"), role("planner", ["read", "grep", "find", "ls"])];
const repo = path.join(ws, "repo");
fs.mkdirSync(repo);
const exec = promisify(execFile);
const gitIn = async (cwd: string, ...a: string[]): Promise<string> => (await exec("git", a, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" } })).stdout.trim();
const git = (...a: string[]): Promise<string> => gitIn(repo, ...a);
await git("init", "-q", "-b", "main");
fs.writeFileSync(path.join(repo, ".gitignore"), ".pi/\n");
fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
await git("add", "-A");
await git("commit", "-q", "-m", "base");

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
/** A run with no status expected, for a test that drives or reads it itself. */
function launchRun(source: string, reply: (s: Spawned) => FakeReply, extra: Partial<Options> = {}) {
  const fake = fakeSpawner(reply);
  const controls = new controlMod.ControlRegistry();
  const started = engine.startScriptRun(spec(source), undefined, { cwd: repo, agents, sandbox: { mode, support }, spawnChild: fake.spawn, controls, ...extra });
  if (!started.ok) throw new Error(started.error);
  return { started, fake, controls };
}
const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 1000 && !cond(); i++) await sleep(10);
  assert.ok(cond(), "timed out");
}

let repos = 0;
/** A fresh checkout: .pi/ ignored, a.txt committed. */
async function freshRepo(): Promise<string> {
  const dir = path.join(ws, `case-${String(++repos)}`);
  fs.mkdirSync(dir);
  await gitIn(dir, "init", "-q", "-b", "main");
  // `git commit` starts a detached `git maintenance run --auto` that holds objects/maintenance.lock for
  // a while under load. The fingerprint case lists the object store before and after, so a lock that
  // vanishes between the two reads as a change. Maintenance is off for these scratch repositories.
  await gitIn(dir, "config", "gc.auto", "0");
  await gitIn(dir, "config", "maintenance.auto", "false");
  fs.writeFileSync(path.join(dir, ".gitignore"), ".pi/\n");
  fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
  await gitIn(dir, "add", "-A");
  await gitIn(dir, "commit", "-q", "-m", "base");
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
  const misses: string[] = [];
  const finding = async (name: string, check: () => Promise<void>): Promise<void> => {
    try { await check(); ok(name); }
    catch (error) { misses.push(name); console.log(`  MISS: ${name}: ${error instanceof Error ? error.message : String(error)}`); }
  };
  await finding("all .pi telemetry is excluded from fingerprints", async () => {
    const dir = await freshRepo();
    fs.rmSync(path.join(dir, ".gitignore"));
    const before = await engine.workspaceFingerprint(dir);
    fs.mkdirSync(path.join(dir, ".pi"));
    fs.writeFileSync(path.join(dir, ".pi", "trace.jsonl"), "trace\n");
    fs.writeFileSync(path.join(dir, ".pi", "tool-firewall-audit.jsonl"), "audit\n");
    assert.equal(await engine.workspaceFingerprint(dir), before);
  });
  await finding("fingerprints detect restored mtime without trusting ctime", async () => {
    const dir = await freshRepo();
    await gitIn(dir, "config", "core.trustctime", "false");
    const file = path.join(dir, "a.txt");
    const time = new Date("2020-01-01T00:00:00Z");
    fs.utimesSync(file, time, time);
    await gitIn(dir, "add", "a.txt");
    const before = await engine.workspaceFingerprint(dir);
    await sleep(1100); // git compares ctime in whole seconds
    fs.writeFileSync(file, "b\n");
    fs.utimesSync(file, time, time);
    assert.notEqual(await engine.workspaceFingerprint(dir), before);
  });
  await finding("fingerprints leave the real object store untouched", async () => {
    const dir = await freshRepo();
    const objects = path.join(dir, ".git", "objects");
    const before = fs.readdirSync(objects, { recursive: true }).sort();
    fs.writeFileSync(path.join(dir, "untracked.txt"), "untracked content\n");
    await engine.workspaceFingerprint(dir);
    assert.deepEqual(fs.readdirSync(objects, { recursive: true }).sort(), before);
  });
  await finding("a nested repository with uncommitted edits cannot reuse results", async () => {
    const dir = await freshRepo();
    const nested = path.join(dir, "sub");
    fs.mkdirSync(nested);
    await gitIn(nested, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(nested, "input.txt"), "old\n");
    await gitIn(nested, "add", "-A");
    await gitIn(nested, "commit", "-qm", "nested");
    const source = `return await agent("read sub/input.txt", { agentType: "planner" })`;
    const first = await run(source, () => ({ text: "old" }), undefined, undefined, dir);
    fs.writeFileSync(path.join(nested, "input.txt"), "new\n");
    const resumed = await run(source, () => ({ text: "new" }), first.started.runId, undefined, dir);
    assert.deepEqual([resumed.outcome.cached, resumed.outcome.launched, resumed.outcome.value], [0, 1, "new"]);
  });
  await finding("a refused resume preserves earlier completed writers", async () => {
    const dir = await freshRepo();
    const source = `return [await agent("first"), await agent("second")]`;
    const first = await run(source, (s) => ({ text: s.task, ...(s.task === "first" ? { write: { file: "a.txt", text: "first applied once\n" } } : {}) }), undefined, undefined, dir);
    const rows = fs.readFileSync(first.started.journalPath, "utf8").split("\n").filter((line) => !line.includes('"label":"implementer #2"') || line.includes('"event":"started"'));
    fs.writeFileSync(first.started.journalPath, rows.join("\n"));
    const stray = path.join(dir, "stray.txt");
    fs.writeFileSync(stray, "stray\n");
    const refused = await run(source, () => ({ text: "unexpected" }), first.started.runId, undefined, dir, "failed");
    const again = await run(source, () => ({ text: "unexpected" }), refused.started.runId, undefined, dir, "failed");
    assert.equal(again.outcome.launched, 0, "a kept row names a seq of its old journal, which must not end a new started row");
    fs.rmSync(stray);
    const resumed = await run(source, (s) => ({ text: s.task }), again.started.runId, undefined, dir);
    assert.deepEqual([resumed.outcome.cached, resumed.outcome.launched], [1, 1]);
    assert.deepEqual(resumed.fake.seen.map((s) => s.task), ["second"]);
  });
  await finding("redacted JSON results are recomputed before returning to the script", async () => {
    const dir = await freshRepo();
    const source = `return JSON.parse(await agent("plan", { agentType: "planner" })).steps`;
    const text = JSON.stringify({ plan: "Review the auth token handling", steps: 2 });
    const first = await run(source, () => ({ text }), undefined, undefined, dir);
    const resumed = await run(source, () => ({ text }), first.started.runId, undefined, dir);
    assert.deepEqual([resumed.outcome.cached, resumed.outcome.launched, resumed.outcome.value], [0, 1, 2]);
  });
  await finding("a redacted replay over the transport cap is recomputed", async () => {
    const dir = await freshRepo();
    const source = `return (await agent("large", { agentType: "planner" })).length`;
    const text = "-token a ".repeat(100_000);
    const first = await run(source, () => ({ text }), undefined, undefined, dir);
    assert.ok(JSON.stringify(first.journal[0]?.value).length > 1024 * 1024);
    const resumed = await run(source, () => ({ text }), first.started.runId, undefined, dir);
    assert.deepEqual([resumed.outcome.cached, resumed.outcome.launched, resumed.outcome.value], [0, 1, text.length]);
  });
  await finding("reused kept worktrees remain in the outcome and run record", async () => {
    const dir = await freshRepo();
    const source = `return await agent("change", { isolation: "worktree" })`;
    const first = await run(source, () => ({ text: "changed", write: { file: "a.txt", text: "changed\n" } }), undefined, undefined, dir);
    const resumed = await run(source, () => ({ text: "unexpected" }), first.started.runId, undefined, dir);
    assert.equal(resumed.outcome.keptWorktrees[0]?.path, first.outcome.keptWorktrees[0]?.path);
    assert.match(fs.readFileSync(path.join(resumed.started.transcriptDir, "run.json"), "utf8"), /keptWorktrees/);
    assert.match(formatCompletion(resumed.outcome), /Kept worktree/);
  });
  await finding("parallel reuse ends at an earlier worktree rejection", async () => {
    const dir = await freshRepo();
    const source = `return await parallel([() => agent("change", { isolation: "worktree" }), () => agent("report", { agentType: "planner" })])`;
    const first = await run(source, (s) => ({ text: `old ${s.task}`, ...(s.task === "change" ? { write: { file: "a.txt", text: "changed\n" } } : {}) }), undefined, undefined, dir);
    const tree = first.outcome.keptWorktrees[0];
    assert.ok(tree);
    fs.writeFileSync(path.join(tree.path, "a.txt"), "edited\n");
    const resumed = await run(source, (s) => ({ text: `new ${s.task}` }), first.started.runId, undefined, dir);
    assert.deepEqual([resumed.outcome.cached, resumed.outcome.launched, resumed.outcome.value], [0, 2, ["new change", "new report"]]);
  });
  await finding("a writer cannot launch when its started row cannot be written", async () => {
    const dir = await freshRepo();
    const source = `try { await agent("read", { agentType: "planner" }) } catch {} try { await agent("write") } catch {} return "kept"`;
    const first = await run(source, () => {
      const runs = path.join(dir, ".pi", "workflows", "runs");
      const id = fs.readdirSync(runs)[0];
      assert.ok(id);
      const journal = path.join(runs, id, "journal.jsonl");
      fs.renameSync(journal, `${journal}.saved`);
      fs.symlinkSync(`${journal}.saved`, journal);
      return { text: "read" };
    }, undefined, undefined, dir, "partial");
    assert.deepEqual(first.fake.seen.map((s) => s.task), ["read"]);
  });
  await finding("a redacted writer result refuses the call rather than applying it twice", async () => {
    const dir = await freshRepo();
    const source = `return await agent("write")`;
    const first = await run(source, () => ({ text: "Review the auth token handling", write: { file: "a.txt", text: "applied\n" } }), undefined, undefined, dir);
    const resumed = await run(source, () => ({ text: "unexpected" }), first.started.runId, undefined, dir, "failed");
    assert.deepEqual([resumed.outcome.cached, resumed.outcome.launched, resumed.fake.seen.length], [0, 0, 0]);
    assert.deepEqual(resumed.outcome.omissions?.map((s) => [s.execution, s.reason?.code]), [["blocked", "redacted"]]);
    saysWhy(resumed, "redacted");
  });
  await finding("a redacted read does not relaunch the finished writer after it", async () => {
    const dir = await freshRepo();
    const source = `await agent("plan", { agentType: "planner" }); return await agent("write")`;
    const reply = (s: Spawned): FakeReply => (s.task === "plan" ? { text: "Review the auth token handling" } : { text: "done", write: { file: "a.txt", text: "applied\n" } });
    const first = await run(source, reply, undefined, undefined, dir);
    const resumed = await run(source, reply, first.started.runId, undefined, dir, "failed");
    assert.deepEqual(resumed.fake.seen.map((s) => s.task), ["plan"]);
    assert.deepEqual(resumed.outcome.omissions?.map((s) => [s.execution, s.reason?.code]), [["blocked", "redacted"]]);
  });
  await finding("a refused writer stays refused on every later resume", async () => {
    const written = { text: "Review the auth token handling", write: { file: "a.txt", text: "applied\n" } };
    const twice: FakeReply = { text: "unexpected", write: { file: "a.txt", text: "applied twice\n" } };
    for (const [source, first, later] of [
      [`return await agent("write")`, (): FakeReply => written, (): FakeReply => twice],
      [`await agent("plan", { agentType: "planner" }); return await agent("write")`, (s: Spawned): FakeReply => (s.task === "plan" ? { text: "Review the auth token handling" } : { text: "done", write: written.write }), (s: Spawned): FakeReply => (s.task === "plan" ? { text: "Review the auth token handling" } : twice)],
    ] as const) {
      const dir = await freshRepo();
      const done = await run(source, first, undefined, undefined, dir);
      let previous = done.started.runId;
      for (let resumes = 0; resumes < 3; resumes++) {
        const resumed = await run(source, later, previous, undefined, dir, "failed");
        assert.deepEqual(resumed.fake.seen.filter((s) => s.task === "write").length, 0);
        assert.deepEqual(resumed.outcome.omissions?.map((s) => [s.execution, s.reason?.code]), [["blocked", "redacted"]]);
        assert.equal(fs.readFileSync(path.join(dir, "a.txt"), "utf8"), "applied\n");
        previous = resumed.started.runId;
      }
    }
  });
  await finding("a refusal keeps the finished writers the script never reached", async () => {
    const dir = await freshRepo();
    const source = `await agent("plan", { agentType: "planner" }); await agent("one"); return await agent("two")`;
    const writes = (s: Spawned, secret: boolean, text: string): FakeReply => (s.task === "plan" ? { text: secret ? "Review the auth token handling" : "clean" } : { text: s.task, write: { file: `${s.task}.txt`, text } });
    const first = await run(source, (s) => writes(s, true, "applied\n"), undefined, undefined, dir);
    const refused = await run(source, (s) => writes(s, false, "twice\n"), first.started.runId, undefined, dir, "failed");
    assert.deepEqual(refused.fake.seen.map((s) => s.task), ["plan"]);
    // The live read came back clean, so its new row reuses and the prefix runs on to both writers.
    const resumed = await run(source, (s) => writes(s, false, "twice\n"), refused.started.runId, undefined, dir);
    assert.deepEqual(resumed.fake.seen.map((s) => s.task), []);
    assert.equal(fs.readFileSync(path.join(dir, "two.txt"), "utf8"), "applied\n");
  });
  await finding("a live read that ends the run does not cost a finished writer its refusal", async () => {
    const source = `await agent("plan", { agentType: "planner", required: true }); return await agent("write")`;
    const secret: FakeReply = { text: "Review the auth token handling" };
    const applied: FakeReply = { text: "done", write: { file: "a.txt", text: "applied\n" } };
    const twice: FakeReply = { text: "done", write: { file: "a.txt", text: "applied twice\n" } };
    const failed: FakeReply = { fail: "provider down" };
    for (const stopped of [false, true]) {
      const dir = await freshRepo();
      const applies = (read: FakeReply) => (s: Spawned): FakeReply => (s.task === "plan" ? read : twice);
      const checkNoRerun = (seen: readonly Spawned[]): void => {
        assert.deepEqual(seen.filter((s) => s.task === "write").length, 0);
        assert.equal(fs.readFileSync(path.join(dir, "a.txt"), "utf8"), "applied\n");
      };
      const first = await run(source, (s) => (s.task === "plan" ? secret : applied), undefined, undefined, dir);
      let previous = first.started.runId;
      if (stopped) {
        const live = launchRun(source, (s) => (s.task === "plan" ? { text: "held", delayMs: 30_000 } : twice), { cwd: dir, resumeFrom: previous });
        await until(() => live.fake.seen.length === 1);
        assert.equal(controlMod.controlRun(live.started.runId, "stop", live.controls).ok, true);
        await live.started.done;
        checkNoRerun(live.fake.seen);
        previous = live.started.runId;
      } else {
        const ended = await run(source, applies(failed), previous, undefined, dir, "failed");
        checkNoRerun(ended.fake.seen);
        previous = ended.started.runId;
      }
      // The read returns on some resumes and fails on others; the writer's turn is refused every time.
      for (const read of [secret, failed, secret]) {
        const resumed = await run(source, applies(read), previous, undefined, dir, "failed");
        checkNoRerun(resumed.fake.seen);
        previous = resumed.started.runId;
      }
      // A read that comes back clean restores the prefix, and the held-over writer is reused, not relaunched.
      const clean = await run(source, applies({ text: "clean" }), previous, undefined, dir, "failed");
      checkNoRerun(clean.fake.seen);
      const reused = await run(source, applies(failed), clean.started.runId, undefined, dir);
      assert.deepEqual(reused.fake.seen.map((s) => s.task), []);
      assert.equal(reused.outcome.cached, 2);
      assert.equal(fs.readFileSync(path.join(dir, "a.txt"), "utf8"), "applied\n");
    }
  });
  await finding("a stop after a writer finished keeps its result", async () => {
    const dir = await freshRepo();
    const bin = path.join(dir, ".bin");
    const hold = path.join(ws, "hold-git");
    const entered = path.join(ws, "entered-git");
    fs.mkdirSync(bin);
    const real = (await exec("sh", ["-c", "command -v git"])).stdout.trim();
    fs.writeFileSync(path.join(bin, "git"), `#!/bin/sh\ncase " $* " in *" add -A "*) if [ -e "${hold}" ]; then : > "${entered}"; while [ -e "${hold}" ]; do sleep 0.02; done; fi;; esac\nexec "${real}" "$@"\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(dir, ".git", "info", "exclude"), ".bin/\n");
    const restorePath = setEnv("PATH", `${bin}${path.delimiter}${process.env.PATH ?? ""}`);
    try {
      const source = `return await agent("write")`;
      const writes = (): FakeReply => ({ text: "done", write: { file: "a.txt", text: "applied\n" } });
      const live = launchRun(source, () => {
        fs.writeFileSync(hold, "");
        return writes();
      }, { cwd: dir });
      await until(() => fs.existsSync(entered));
      assert.equal(controlMod.controlRun(live.started.runId, "stop", live.controls).ok, true);
      fs.rmSync(hold);
      assert.equal((await live.started.done).status, "interrupted");
      const resumed = await run(source, writes, live.started.runId, undefined, dir);
      assert.deepEqual([resumed.outcome.cached, resumed.outcome.launched], [1, 0]);
    } finally {
      restorePath();
      fs.rmSync(hold, { force: true });
    }
  });
  await finding("a launch refused at the ledger gives its place in the agent limit back", async () => {
    const dir = await freshRepo();
    const source = `for (let i = 0; i < 3; i++) { try { await agent("refused " + i, { agentType: "stuck" }) } catch {} } return await agent("plan", { agentType: "planner" })`;
    const live = launchRun(source, () => ({ text: "planned" }), { cwd: dir, maxAgents: 3, agents: [...agents, role("stuck", ["subagent"])] });
    const outcome = await live.started.done;
    assert.deepEqual([outcome.launched, outcome.value], [1, "planned"], outcome.error ?? "");
  });
  await finding("a failed worktree counts toward the agent limit", async () => {
    const dir = path.join(ws, "outside-git");
    fs.mkdirSync(dir);
    const source = `for (let i = 0; i < 20; i++) { try { await agent("try " + i, { isolation: "worktree", agentType: "planner" }) } catch {} } return "done"`;
    const live = launchRun(source, () => ({ text: "unexpected" }), { cwd: dir, maxAgents: 5 });
    const outcome = await live.started.done;
    assert.equal(outcome.launched, 0);
    assert.equal(outcome.omissions?.filter((s) => s.reason?.code === "agent-limit").length, 15, JSON.stringify(outcome.omissions?.slice(0, 7)));
  });
  await finding("a stopped run's writer leaves the checkout queue", async () => {
    const dir = await freshRepo();
    // The holder keeps the checkout until the test stops it below, so the queue's order does not depend on
    // a wall-clock delay that a slow runner could outlast.
    const holder = launchRun(`return await agent("hold")`, () => ({ text: "held", delayMs: 60_000 }), { cwd: dir });
    await until(() => holder.fake.seen.length > 0);
    const queued = launchRun(`return await agent("queue")`, () => ({ text: "unexpected" }), { cwd: dir, drainMs: 200 });
    // The stop must land after the script has made its call. Starting the script is a subprocess, and
    // under load it took longer than a fixed sleep, so the stop arrived first and left nothing to omit.
    await until(() => (queued.controls.get(queued.started.runId)?.running().length ?? 0) > 0);
    await sleep(300);
    assert.equal(controlMod.controlRun(queued.started.runId, "stop", queued.controls).ok, true);
    const outcome = await queued.started.done;
    assert.equal(controlMod.controlRun(holder.started.runId, "stop", holder.controls).ok, true);
    await holder.started.done;
    assert.deepEqual(outcome.omissions?.map((s) => [s.execution, s.reason?.code]), [["cancelled", "stopped"]]);
  });
  assert.deepEqual(misses, [], "resume review regressions");
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
  await exec("git", ["init", "-q", "-b", "main"], { cwd: bare });
  fs.writeFileSync(path.join(bare, "a.txt"), "a\n");
  const bareWrote = await run(writers, (s) => ({ text: s.task, write: { file: `${s.task.replace(" ", "-")}.txt`, text: s.task } }), undefined, undefined, bare);
  assert.ok(fs.existsSync(path.join(bare, ".pi", "workflows", "runs")), "the runs root is inside the checkout");
  const bareSame = await run(writers, () => ({ text: "live" }), bareWrote.started.runId, undefined, bare);
  assert.equal(bareSame.outcome.cached, 3, "the run's own journal does not change the fingerprint");
  ok("writers are reused in a checkout that does not gitignore .pi/");

  // 6. A kept worktree's result.
  await git("add", "-A");
  await git("commit", "-q", "-m", "writers");
  const iso = `return await agent("change", { isolation: "worktree" })`;
  const kept = await run(iso, (s) => ({ text: "changed", write: { file: "a.txt", text: s.task } }));
  assert.equal(kept.outcome.keptWorktrees.length, 1);
  const branch = kept.outcome.keptWorktrees[0]?.branch ?? "";
  assert.equal(kept.journal[0]?.worktree?.status, "kept");
  const reused = await run(iso, () => ({ text: "live" }), kept.started.runId);
  assert.equal(reused.outcome.cached, 1, "the kept branch is where the agent left it");
  await git("worktree", "remove", "--force", kept.outcome.keptWorktrees[0]?.path ?? "");
  await git("branch", "-D", branch);
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
  const skillRepo = await freshRepo();
  const skillFirst = await run(askPlanner, () => ({ text: "first" }), undefined, undefined, skillRepo, "passed", skilled);
  const skillSame = await run(askPlanner, () => ({ text: "live" }), skillFirst.started.runId, undefined, skillRepo, "passed", skilled);
  assert.equal(skillSame.outcome.cached, 1, "an unchanged skill body still reuses");
  fs.writeFileSync(skillFile, "Use spaces.\n");
  const skillMoved = await run(askPlanner, () => ({ text: "live" }), skillSame.started.runId, undefined, skillRepo, "passed", skilled);
  assert.deepEqual([skillMoved.outcome.cached, skillMoved.outcome.launched, skillMoved.outcome.value], [0, 1, "live"]);
  saysWhy(skillMoved, "definition");
  ok("a role's skill body changing rejects the reuse, and the run says so");

  const v1Repo = await freshRepo();
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
  const failedRepo = await freshRepo();
  const twoWriters = `const a = await agent("first"); const b = await agent("second"); return [a, b]`;
  const failing = (s: Spawned): FakeReply => (s.task === "second" ? { fail: "provider down", write: { file: "a.txt", text: "half done\n" } } : { text: "ok", write: { file: "b.txt", text: "first\n" } });
  const failedFirst = await run(twoWriters, failing, undefined, undefined, failedRepo, "partial");
  const failedResumed = await run(twoWriters, live, failedFirst.started.runId, undefined, failedRepo);
  assert.deepEqual([failedResumed.outcome.cached, failedResumed.outcome.launched], [1, 1]);
  ok("a resume continues from the state a failed writer left");

  // 9. A started row with no end row.
  const writeCall = `return await agent("write")`;
  const writeRow = { event: "started", key: engine.callKey("write", null), label: "implementer #1", role: "implementer", writer: true };

  const changedRepo = await freshRepo();
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

  const heldRepo = await freshRepo();
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

  const cachedRowRepo = await freshRepo();
  const leftHalfDone = await run(twoWriters, failing, undefined, undefined, cachedRowRepo, "partial");
  const reachedSecond = await run(twoWriters, live, leftHalfDone.started.runId, undefined, cachedRowRepo);
  assert.deepEqual([reachedSecond.outcome.cached, reachedSecond.outcome.launched], [1, 1]);
  const killedSecond = fs.readFileSync(reachedSecond.started.journalPath, "utf8").split("\n").filter((l) => !l.includes(`"label":"implementer #2"`) || l.includes(`"event":"started"`));
  fs.writeFileSync(reachedSecond.started.journalPath, killedSecond.join("\n"));
  const cachedRowReplay = await run(twoWriters, live, reachedSecond.started.runId, undefined, cachedRowRepo);
  assert.deepEqual([cachedRowReplay.outcome.cached, cachedRowReplay.outcome.launched, cachedRowReplay.outcome.value], [1, 1, ["ok", "live"]]);
  ok("a cached writer row is an older run's state: a killed writer that changed nothing replays");

  const sameRepo = await freshRepo();
  const replayed = await run(writeCall, live, await killedRun(sameRepo, [writeRow]), undefined, sameRepo);
  assert.deepEqual([replayed.outcome.launched, replayed.outcome.value], [1, "live"]);
  ok("the same with the checkout unchanged replays");

  const readRepo = await freshRepo();
  const readKilled = await killedRun(readRepo, [{ event: "started", key: engine.callKey("report", read), label: "planner #1", role: "planner", writer: false }]);
  fs.writeFileSync(path.join(readRepo, "a.txt"), "edited\n");
  const readReplayed = await run(askPlanner, live, readKilled, undefined, readRepo);
  assert.deepEqual([readReplayed.outcome.launched, readReplayed.outcome.value], [1, "live"]);
  ok("a read-only unknown replays");

  const isoRepo = await freshRepo();
  const isolated = { isolation: "worktree" };
  const isoKilled = await killedRun(isoRepo, [{ ...writeRow, key: engine.callKey("write", isolated), isolated: true }]);
  fs.writeFileSync(path.join(isoRepo, "a.txt"), "edited\n");
  await gitIn(isoRepo, "commit", "-q", "-am", "moved on");
  const isoReplayed = await run(`return await agent("write", ${JSON.stringify(isolated)})`, live, isoKilled, undefined, isoRepo);
  assert.deepEqual([isoReplayed.outcome.launched, isoReplayed.outcome.value], [1, "live"]);
  ok("a worktree writer's unknown replays in a new worktree");

  // 10. The fingerprint.
  const openRepo = await freshRepo();
  fs.rmSync(path.join(openRepo, ".gitignore"));
  await gitIn(openRepo, "add", "-A");
  await gitIn(openRepo, "commit", "-q", "-m", "no ignore rules");
  const openFirst = await run(`return await agent("change", ${JSON.stringify(isolated)})`, (s) => ({ text: "changed", write: { file: "a.txt", text: s.task } }), undefined, undefined, openRepo);
  assert.equal(openFirst.outcome.keptWorktrees.length, 1);
  const openResumed = await run(`return await agent("change", ${JSON.stringify(isolated)})`, live, openFirst.started.runId, undefined, openRepo);
  assert.equal(openResumed.outcome.cached, 1, "the run's own worktree does not read as a change to the checkout");
  const openReadFirst = await run(askPlanner, () => ({ text: "read" }), undefined, undefined, openRepo);
  const openRead = await run(askPlanner, live, openReadFirst.started.runId, undefined, openRepo);
  assert.equal(openRead.outcome.cached, 1, "the agents' own logs do not read as a change to the checkout");
  ok("a read and a kept worktree under a .pi that is not ignored are still reused");

  const fpRepo = await freshRepo();
  const realIndex = path.join(fpRepo, ".git", "index");
  const indexBefore = fs.readFileSync(realIndex);
  const fpBefore = await engine.workspaceFingerprint(fpRepo);
  assert.equal(await engine.workspaceFingerprint(fpRepo), fpBefore, "the same checkout gives the same fingerprint");
  fs.writeFileSync(path.join(fpRepo, "a.txt"), "b\n");
  assert.notEqual(await engine.workspaceFingerprint(fpRepo), fpBefore, "a same-size edit straight after the commit changes it");
  await gitIn(fpRepo, "update-index", "--assume-unchanged", "a.txt");
  const hidden = fs.readFileSync(realIndex);
  assert.notEqual(await engine.workspaceFingerprint(fpRepo), fpBefore, "a file flagged assume-unchanged is still read");
  assert.ok(fs.readFileSync(realIndex).equals(hidden), "the real index is not written");
  assert.ok(!indexBefore.equals(hidden));
  ok("the fingerprint sees edits a seeded index could hide and leaves the real index alone");

  const linkRepo = await freshRepo();
  const isoCall = `return await agent("change", ${JSON.stringify(isolated)})`;
  const linkKept = await run(isoCall, (s) => ({ text: "changed", write: { file: "a.txt", text: s.task } }), undefined, undefined, linkRepo);
  const keptPath = linkKept.outcome.keptWorktrees[0]?.path ?? "";
  const fakeRepo = path.join(ws, "planted");
  const marker = path.join(ws, "filter-ran");
  fs.mkdirSync(fakeRepo);
  await gitIn(fakeRepo, "init", "-q", "-b", "main");
  await gitIn(fakeRepo, "config", "filter.planted.clean", `touch ${marker}; cat`);
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
