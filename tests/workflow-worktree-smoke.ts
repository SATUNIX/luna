#!/usr/bin/env node
// Worktree isolation for workflow agents (E5 slice S4), offline against a scratch git repo:
//   1. an unchanged worktree is removed with its branch; the main checkout stays clean.
//   2. a changed worktree (uncommitted edits, or commits) is kept and journaled, never merged.
//   3. the worktree's cwd becomes the workspace (tool-firewall's workspaceRoot stops at it).
//   4. protected-paths blocks git's hooks/, config and info/ in the common dir, from the worktree
//      and from the main checkout, plus the main checkout's control files from inside a worktree.
//   5. a worktree's link to its git dir is protected; rewriting it (junk, or a git dir the agent
//      made) drops no protection, and a `.git` file that names no git dir blocks every write.
//   6. finish never runs what the agent planted: a changed link (the `.git` file or the git dir's
//      commondir) is kept uninspected, fsmonitor/hooks are off, a nested repo's clean filter does
//      not run (its staged gitlink still counts as a change); a branch left behind after
//      the worktree was removed is reported as removed with the branch named.
//   7. the 16-worktree cap is a wait, not a failure; an aborted wait rejects.
//   8. bad run ids and indexes are refused; the per-checkout writer lock runs writers one at a time.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { loadExtension, loadModule, fakePi, tmpWorkspace, rmWorkspace, setEnv, isolateKitEnv } from "../packages/core/eval/harness.ts";
import {
  WORKTREE_CAP, createWorkflowWorktree, finishWorkflowWorktree, worktreeSlots, withCheckoutLock, type WorkflowWorktree,
} from "../packages/extensions/third_party/subagent/worktree.ts";
import type * as FirewallConfig from "../packages/extensions/src/tool-firewall/config.ts";

const ws = tmpWorkspace("pi-kit-wf-worktree-");
const restores = [
  isolateKitEnv(),
  setEnv("HOME", path.join(ws, "home")),
  setEnv("PI_CODING_AGENT_DIR", path.join(ws, "agent")),
  setEnv("PI_KIT_FIREWALL_PROFILE", "coding"),
  setEnv("GIT_CONFIG_NOSYSTEM", "1"),
  setEnv("GIT_CONFIG_GLOBAL", path.join(ws, "gitconfig")),
];
fs.mkdirSync(path.join(ws, "home"), { recursive: true });
fs.writeFileSync(path.join(ws, "gitconfig"), "[user]\n\tname = Smoke\n\temail = smoke@example.invalid\n[init]\n\tdefaultBranch = main\n");
let checks = 0;

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
fs.mkdirSync(path.join(ws, "repo"));
const repo = fs.realpathSync(path.join(ws, "repo"));
git(repo, "init", "-q");
fs.writeFileSync(path.join(repo, ".gitignore"), ".pi/\n");
fs.writeFileSync(path.join(repo, "README.md"), "base\n");
git(repo, "add", "-A");
git(repo, "commit", "-q", "-m", "base");
const mainHead = git(repo, "rev-parse", "HEAD");
const journal = path.join(ws, "run", "worktrees.jsonl");

try {
  // 1. unchanged: removed with its branch
  const t0 = await createWorkflowWorktree({ cwd: repo, runId: "r1", index: 0 });
  assert.equal(t0.path, path.join(repo, ".pi", "worktrees", "r1", "0"));
  assert.equal(t0.branch, "luna/wf/r1/0");
  assert.equal(t0.baseCommit, mainHead);
  assert.ok(fs.existsSync(path.join(t0.path, "README.md")), "the worktree is checked out");
  assert.equal(git(repo, "status", "--porcelain"), "", ".pi/worktrees is ignored by the main checkout");
  const r0 = await finishWorkflowWorktree(t0, { journalFile: journal });
  assert.equal(r0.status, "removed");
  assert.ok(!fs.existsSync(t0.path), "the unchanged worktree is gone");
  assert.equal(git(repo, "branch", "--list", "luna/wf/r1/0"), "", "its branch is deleted");
  assert.ok(!fs.existsSync(journal), "a removed worktree is not journaled");
  checks += 1;

  // 2. changed: kept and journaled, never merged
  const t1 = await createWorkflowWorktree({ cwd: repo, runId: "r1", index: 1 });
  fs.writeFileSync(path.join(t1.path, "new.txt"), "work\n");
  const t2 = await createWorkflowWorktree({ cwd: repo, runId: "r1", index: 2 });
  fs.writeFileSync(path.join(t2.path, "README.md"), "changed\n");
  git(t2.path, "commit", "-q", "-am", "agent work");
  const r1 = await finishWorkflowWorktree(t1, { journalFile: journal });
  const r2 = await finishWorkflowWorktree(t2, { journalFile: journal });
  assert.equal(r1.status, "kept");
  assert.equal(r1.dirty, true);
  assert.equal(r2.status, "kept");
  assert.equal(r2.commits, 1);
  assert.equal(r2.dirty, false);
  assert.ok(fs.existsSync(t1.path) && fs.existsSync(t2.path), "changed worktrees stay on disk");
  assert.equal(git(repo, "branch", "--list", "luna/wf/r1/2").replace(/^[*+ ]+/, ""), "luna/wf/r1/2");
  assert.equal(git(repo, "rev-parse", "HEAD"), mainHead, "nothing is merged into the main checkout");
  assert.equal(fs.readFileSync(path.join(repo, "README.md"), "utf8"), "base\n");
  const lines = fs.readFileSync(journal, "utf8").trim().split("\n").map((line): [unknown, unknown] => {
    const parsed: unknown = JSON.parse(line);
    assert.ok(typeof parsed === "object" && parsed !== null && "branch" in parsed && "status" in parsed);
    return [parsed.branch, parsed.status];
  });
  assert.deepEqual(lines, [["luna/wf/r1/1", "kept"], ["luna/wf/r1/2", "kept"]]);
  assert.equal(fs.statSync(journal).mode & 0o777, 0o600, "the journal is 0600");
  checks += 1;

  // 3. the worktree is its own workspace
  const config = await loadModule<typeof FirewallConfig>("extensions/tool-firewall/config.ts");
  fs.mkdirSync(path.join(t1.path, "src"), { recursive: true });
  assert.equal(config.workspaceRoot(t1.path), t1.path);
  assert.equal(config.workspaceRoot(path.join(t1.path, "src")), t1.path);
  assert.equal(config.workspaceRoot(repo), repo);
  checks += 1;

  // 4. git control files are protected
  const register = await loadExtension("vendor/protected-paths/index.ts");
  const pi = fakePi();
  register(pi.api);
  const call = (cwd: string, toolName: string, input: Record<string, unknown>) =>
    pi.handlers.get("tool_call")({ toolName, input }, { hasUI: false, ui: { notify() {} }, cwd });
  const gitDir = path.join(repo, ".git");
  for (const target of [path.join(gitDir, "hooks", "pre-commit"), path.join(gitDir, "config"), path.join(gitDir, "info", "exclude")]) {
    assert.equal((await call(t1.path, "write", { path: target }))?.block, true, `worktree write to ${target} is blocked`);
    assert.equal((await call(repo, "write", { path: target }))?.block, true, `main-checkout write to ${target} is blocked`);
  }
  assert.equal((await call(repo, "write", { path: ".git/hooks/post-checkout" }))?.block, true, "relative hook path is blocked");
  assert.equal((await call(t1.path, "bash", { command: `echo x > ${path.join(gitDir, "hooks", "post-merge")}` }))?.block, true, "bash redirect into hooks is blocked");
  assert.equal((await call(t1.path, "edit", { path: path.join(repo, ".pi", "verdicts.json") }))?.block, true, "main checkout control file is blocked from a worktree");
  assert.equal((await call(t1.path, "write", { path: ".pi/verdicts.json" }))?.block, true, "the worktree's own control file is blocked");
  assert.equal(await call(t1.path, "write", { path: "src/app.ts" }), undefined, "ordinary work in the worktree is allowed");
  assert.equal(await call(repo, "write", { path: ".git/description" }), undefined, "other .git files stay ordinary work under coding");
  checks += 1;

  // 5. the worktree's link to its git dir
  const t1Link = path.join(t1.path, ".git");
  const t1Original = fs.readFileSync(t1Link, "utf8");
  const verdicts = path.join(repo, ".pi", "verdicts.json");
  const hook = path.join(gitDir, "hooks", "pre-commit");
  assert.equal((await call(t1.path, "write", { path: ".git" }))?.block, true, "the worktree's .git file is blocked");
  assert.equal((await call(t1.path, "bash", { command: "echo junk > .git" }))?.block, true, "a bash rewrite of the .git file is blocked");
  for (const cwd of [t1.path, repo]) {
    assert.equal((await call(cwd, "write", { path: path.join(t1.gitDir, "commondir") }))?.block, true, `the worktree's commondir is blocked from ${cwd}`);
    assert.equal((await call(cwd, "write", { path: path.join(gitDir, "worktrees", "x", "gitdir") }))?.block, true, `<common>/worktrees/ is blocked from ${cwd}`);
  }
  fs.writeFileSync(t1Link, "junk\n");
  assert.equal((await call(t1.path, "write", { path: hook }))?.block, true, "a junk .git file keeps the hooks blocked");
  assert.equal((await call(t1.path, "write", { path: verdicts }))?.block, true, "a junk .git file keeps the main checkout's control files blocked");
  const junk = await call(t1.path, "write", { path: "src/app.ts" });
  assert.equal(junk?.block, true, "a .git file that names no git dir blocks every write");
  assert.match(String(junk?.reason), /does not name a valid git dir/);
  const fake = path.join(t1.path, "fake");
  fs.mkdirSync(path.join(fake, "worktrees", "w"), { recursive: true });
  fs.mkdirSync(path.join(fake, "objects"));
  fs.writeFileSync(path.join(fake, "worktrees", "w", "commondir"), "../..\n");
  fs.writeFileSync(t1Link, `gitdir: ${path.join(fake, "worktrees", "w")}\n`);
  assert.equal((await call(t1.path, "write", { path: hook }))?.block, true, "a .git file naming a made-up git dir keeps the real hooks blocked");
  assert.equal((await call(t1.path, "write", { path: verdicts }))?.block, true, "and the main checkout's control files");
  fs.writeFileSync(t1Link, t1Original);
  fs.rmSync(fake, { recursive: true });
  const stray = path.join(ws, "stray");
  fs.mkdirSync(stray);
  fs.writeFileSync(path.join(stray, ".git"), "junk\n");
  assert.equal((await call(stray, "write", { path: "a.txt" }))?.block, true, "a first-seen junk .git file fails closed");
  assert.equal(await call(t1.path, "write", { path: "src/app.ts" }), undefined, "the restored link allows ordinary work again");
  checks += 1;

  // 6. finish runs nothing the agent planted
  const marker = path.join(ws, "fsmonitor-ran");
  const evilCommon = path.join(ws, "evil-common");
  fs.cpSync(gitDir, evilCommon, { recursive: true });
  fs.appendFileSync(path.join(evilCommon, "config"), `[core]\n\tfsmonitor = "touch ${marker}; false"\n`);
  const t3 = await createWorkflowWorktree({ cwd: repo, runId: "r2", index: 0 });
  const evilGitDir = path.join(t3.path, "evilgit");
  fs.cpSync(t3.gitDir, evilGitDir, { recursive: true });
  fs.writeFileSync(path.join(evilGitDir, "commondir"), `${evilCommon}\n`);
  fs.writeFileSync(path.join(t3.path, ".git"), `gitdir: ${evilGitDir}\n`);
  const r3 = await finishWorkflowWorktree(t3, { journalFile: journal });
  assert.equal(r3.status, "kept");
  assert.match(String(r3.reason), /not inspected: .*\.git no longer names/);
  const t4 = await createWorkflowWorktree({ cwd: repo, runId: "r2", index: 1 });
  fs.writeFileSync(path.join(t4.gitDir, "commondir"), `${evilCommon}\n`);
  const r4 = await finishWorkflowWorktree(t4, { journalFile: journal });
  assert.equal(r4.status, "kept");
  assert.match(String(r4.reason), /not inspected: .*commondir no longer names/);
  const t5 = await createWorkflowWorktree({ cwd: repo, runId: "r2", index: 2 });
  git(repo, "config", "core.fsmonitor", `touch ${marker}; false`);
  const r5 = await finishWorkflowWorktree(t5);
  git(repo, "config", "--unset", "core.fsmonitor");
  assert.equal(r5.status, "removed", "fsmonitor is off for finish's own git commands");
  assert.ok(!fs.existsSync(marker), "no planted fsmonitor command ran in the parent");
  const t7 = await createWorkflowWorktree({ cwd: repo, runId: "r2", index: 4 });
  const sub = path.join(t7.path, "sub");
  fs.mkdirSync(sub);
  git(sub, "init", "-q");
  fs.writeFileSync(path.join(sub, "f.txt"), "a\n");
  git(sub, "add", "f.txt");
  git(sub, "commit", "-q", "-m", "sub");
  const filterMarker = path.join(ws, "clean-filter-ran");
  git(sub, "config", "filter.x.clean", `touch ${filterMarker}; cat`);
  fs.writeFileSync(path.join(sub, ".git", "info", "attributes"), "* filter=x\n");
  execFileSync("git", ["add", "sub"], { cwd: t7.path, stdio: "ignore" });
  fs.writeFileSync(path.join(sub, "f.txt"), "b\n");
  assert.ok(!fs.existsSync(filterMarker));
  const r7 = await finishWorkflowWorktree(t7, { journalFile: journal });
  assert.ok(!fs.existsSync(filterMarker), "no clean filter planted in a nested repo ran in the parent");
  assert.equal(r7.status, "kept");
  assert.equal(r7.dirty, true, "a staged gitlink is an uncommitted change");
  assert.equal(r7.reason, "uncommitted changes");
  const t6 = await createWorkflowWorktree({ cwd: repo, runId: "r2", index: 3 });
  const branchLock = path.join(gitDir, "refs", "heads", "luna", "wf", "r2", "3.lock");
  fs.writeFileSync(branchLock, "");
  const r6 = await finishWorkflowWorktree(t6);
  fs.rmSync(branchLock);
  assert.equal(r6.status, "removed");
  assert.ok(!fs.existsSync(t6.path), "the worktree itself is gone");
  assert.match(String(r6.reason), /worktree removed, branch luna\/wf\/r2\/3 left/);
  git(repo, "branch", "-D", "luna/wf/r2/3");
  checks += 1;

  // 7. the cap is a wait (r1/1 and r1/2 freed their slots when they finished)
  assert.deepEqual(worktreeSlots(repo), { active: 0, waiting: 0 });
  const held: WorkflowWorktree[] = [];
  for (let i = 0; i < WORKTREE_CAP; i++) held.push(await createWorkflowWorktree({ cwd: repo, runId: "cap", index: i }));
  let settled = false;
  const waiting = createWorkflowWorktree({ cwd: repo, runId: "cap", index: WORKTREE_CAP }).then((tree) => { settled = true; return tree; });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(settled, false, "the 17th worktree waits");
  assert.deepEqual(worktreeSlots(repo), { active: WORKTREE_CAP, waiting: 1 });
  const controller = new AbortController();
  const aborted = createWorkflowWorktree({ cwd: repo, runId: "cap", index: WORKTREE_CAP + 1, signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 50));
  controller.abort();
  await assert.rejects(aborted, /aborted while waiting/);
  const first = held.shift();
  assert.ok(first);
  await finishWorkflowWorktree(first);
  const late = await waiting;
  assert.equal(late.branch, `luna/wf/cap/${WORKTREE_CAP}`, "the waiter gets the freed slot");
  for (const tree of [...held, late]) assert.equal((await finishWorkflowWorktree(tree)).status, "removed");
  assert.deepEqual(worktreeSlots(repo), { active: 0, waiting: 0 });
  assert.ok(!fs.existsSync(path.join(repo, ".pi", "worktrees", "cap")), "the emptied run directory is removed");
  checks += 1;

  // 8. ids, and the writer lock
  await assert.rejects(createWorkflowWorktree({ cwd: repo, runId: "../x", index: 0 }), /invalid run id/);
  await assert.rejects(createWorkflowWorktree({ cwd: repo, runId: "a.lock", index: 0 }), /invalid run id/);
  await assert.rejects(createWorkflowWorktree({ cwd: repo, runId: "ok", index: -1 }), /invalid agent index/);
  assert.deepEqual(worktreeSlots(repo), { active: 0, waiting: 0 }, "refused ids take no slot");
  const order: string[] = [];
  let releaseFirst: () => void = () => {};
  const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const a = withCheckoutLock(repo, async () => { order.push("a:start"); await gate; order.push("a:end"); });
  const b = withCheckoutLock(path.join(repo), async () => { order.push("b:start"); order.push("b:end"); });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(order, ["a:start"], "a second writer of the same checkout waits");
  releaseFirst();
  await Promise.all([a, b]);
  assert.deepEqual(order, ["a:start", "a:end", "b:start", "b:end"]);
  await assert.rejects(withCheckoutLock(repo, async () => { throw new Error("boom"); }), /boom/);
  assert.equal(await withCheckoutLock(repo, async () => "after"), "after", "a failed writer releases the lock");
  checks += 1;
} finally {
  for (const restore of restores.reverse()) restore();
  rmWorkspace(ws);
}
console.log(`workflow-worktree smoke: ${checks} checks passed`);
