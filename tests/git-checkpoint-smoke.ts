#!/usr/bin/env node
/**
 * git-checkpoint against a real temporary repository: checkpoints live on a shadow ref and never
 * touch the branch, index or stash; credential files are never snapshotted; /undo puts the working
 * tree back (including deleting new files) after showing the diff; a fresh session starts a new set;
 * and the set is bounded. Offline; a throwaway HOME and repository.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isolateKitEnv, loadExtension, fakePi, rmWorkspace, setEnv, tmpWorkspace } from "../packages/core/eval/harness.ts";

const ws = tmpWorkspace("pi-kit-checkpoint-");
const restoreEnv = [isolateKitEnv(), setEnv("HOME", path.join(ws, "home")), setEnv("PI_KIT_CHECKPOINT_MAX", "3")];
const repo = path.join(ws, "repo");
fs.mkdirSync(repo, { recursive: true });
const git = (...args: string[]): string => execFileSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
const write = (name: string, text: string): void => { fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true }); fs.writeFileSync(path.join(repo, name), text); };
const read = (name: string): string => fs.readFileSync(path.join(repo, name), "utf8");

git("init", "-q", "-b", "main");
write("a.txt", "one\n");
write(".gitignore", "ignored.log\n");
git("add", "-A");
git("commit", "-q", "-m", "base");

interface Shown { title: string; message: string }
function session(id: string, answers: { confirm: boolean; select?: string }) {
  const shown: Shown[] = [];
  const notes: string[] = [];
  const pi = fakePi();
  const ctx = {
    cwd: repo, hasUI: true,
    sessionManager: { getSessionId: () => id, getLeafEntry: () => ({ id: "leaf-1" }) },
    ui: {
      notify: (m: string) => notes.push(m),
      confirm: async (title: string, message: string) => { shown.push({ title, message }); return answers.confirm; },
      select: async () => answers.select,
    },
  };
  return { pi, ctx, shown, notes };
}

try {
  const register = await loadExtension("vendor/git-checkpoint/index.ts");
  const s = session("sess-a", { confirm: true });
  register(s.pi.api);
  await s.pi.handlers.get("session_start")({}, s.ctx);

  // Turn 1 starts on the clean tree; the agent then edits, creates a file and writes a credential file.
  await s.pi.handlers.get("turn_start")({}, s.ctx);
  write("a.txt", "two\n");
  write("new.txt", "made by the agent\n");
  write(".env", "TOKEN=hunter2\n");
  write("config/api.key", "k\n");
  write("ignored.log", "noise\n");
  const statusBefore = git("status", "--porcelain");
  await s.pi.handlers.get("turn_start")({}, s.ctx);

  assert.equal(git("status", "--porcelain"), statusBefore, "taking a checkpoint must not change the index or working tree");
  assert.equal(git("stash", "list"), "", "no stash entry");
  assert.equal(git("rev-list", "--count", "HEAD"), "1", "no commit on the branch");
  const refs = git("for-each-ref", "--format=%(refname)", "refs/luna/checkpoints/").split("\n");
  assert.deepEqual(refs, ["refs/luna/checkpoints/sess-a/1", "refs/luna/checkpoints/sess-a/2"]);
  const files = git("ls-tree", "-r", "--name-only", "refs/luna/checkpoints/sess-a/2").split("\n");
  assert.ok(files.includes("new.txt") && files.includes("a.txt"), "tracked changes and new files are in the checkpoint");
  assert.ok(!files.includes(".env") && !files.includes("config/api.key") && !files.includes("ignored.log"), `credentials and ignored files are not: ${files.join(",")}`);

  // A turn that found nothing changed adds no checkpoint.
  await s.pi.handlers.get("turn_start")({}, s.ctx);
  assert.equal(git("for-each-ref", "refs/luna/checkpoints/").split("\n").length, 2);

  // More work after the last checkpoint, then /undo: the diff is shown first.
  write("a.txt", "three\n");
  write("later.txt", "later\n");
  fs.rmSync(path.join(repo, "new.txt"));
  await s.pi.handlers.get("turn_start")({}, s.ctx); // checkpoint 3: the state to undo to
  write("a.txt", "four\n");
  write("worse.txt", "worse\n");
  await s.pi.commands.get("undo").handler("", s.ctx);
  assert.equal(s.shown.length, 1);
  assert.match(s.shown[0]?.message ?? "", /delete\tworse\.txt/);
  assert.match(s.shown[0]?.message ?? "", /restore\ta\.txt/);
  assert.equal(read("a.txt"), "three\n");
  assert.ok(!fs.existsSync(path.join(repo, "worse.txt")), "a file created since the checkpoint is removed");
  assert.equal(read(".env"), "TOKEN=hunter2\n", "a credential file is never touched by a restore");
  assert.equal(git("rev-list", "--count", "HEAD"), "1");
  assert.ok(git("rev-parse", "refs/luna/undone/sess-a"), "the replaced state is kept");

  // Declining changes nothing.
  const declined = session("sess-a", { confirm: false });
  register(declined.pi.api);
  await declined.pi.handlers.get("session_start")({}, declined.ctx);
  write("a.txt", "declined\n");
  await declined.pi.commands.get("undo").handler("1", declined.ctx);
  assert.equal(declined.shown.length, 1);
  assert.equal(read("a.txt"), "declined\n", "no restore without a yes");

  // Bounded: more checkpoints than PI_KIT_CHECKPOINT_MAX evict the oldest.
  const b = session("sess-b", { confirm: true });
  register(b.pi.api);
  await b.pi.handlers.get("session_start")({}, b.ctx);
  for (let i = 0; i < 6; i++) {
    write("a.txt", `edit ${i}\n`);
    await b.pi.handlers.get("turn_start")({}, b.ctx);
  }
  const bRefs = git("for-each-ref", "--format=%(refname)", "refs/luna/checkpoints/sess-b/").split("\n");
  assert.equal(bRefs.length, 3, "the set is bounded");
  assert.ok(!bRefs.some((r) => r.endsWith("/1")), "the oldest was evicted");
  assert.equal(git("for-each-ref", "refs/luna/checkpoints/sess-a/").split("\n").length > 0, true, "another session's checkpoints are kept");

  // /fork still offers the code state of the point it forks from.
  const f = session("sess-f", { confirm: true, select: "Yes, restore code to that point" });
  register(f.pi.api);
  await f.pi.handlers.get("session_start")({}, f.ctx);
  write("a.txt", "fork base\n");
  await f.pi.handlers.get("tool_result")({}, f.ctx);
  await f.pi.handlers.get("turn_start")({}, f.ctx);
  write("a.txt", "after fork point\n");
  await f.pi.handlers.get("session_before_fork")({ entryId: "leaf-1" }, f.ctx);
  assert.equal(read("a.txt"), "fork base\n");
  assert.equal(f.shown.length, 0, "the fork prompt already asked; no second confirmation");

  // Launched from a subdirectory: the checkpoint is the whole repository, so a commit made outside
  // the launch directory between a checkpoint and /undo is not "restored" away.
  write("sub/deep.txt", "deep\n");
  write("other/x.txt", "x1\n");
  git("add", "-A");
  git("commit", "-q", "-m", "more");
  const sd = session("sess-sub", { confirm: true });
  sd.ctx.cwd = path.join(repo, "sub");
  register(sd.pi.api);
  await sd.pi.handlers.get("session_start")({}, sd.ctx);
  write("other/x.txt", "x2 uncommitted\n");
  await sd.pi.handlers.get("turn_start")({}, sd.ctx); // checkpoint 1
  const ckFiles = git("ls-tree", "-r", "--name-only", "refs/luna/checkpoints/sess-sub/1").split("\n");
  assert.ok(ckFiles.includes("other/x.txt") && ckFiles.includes("a.txt"), "the checkpoint covers the whole repository");
  git("add", "other/x.txt");
  git("commit", "-q", "-m", "commit outside the launch directory");
  write("sub/deep.txt", "deep edited\n");
  await sd.pi.commands.get("undo").handler("", sd.ctx);
  assert.equal(read("sub/deep.txt"), "deep\n", "the launch subtree is restored");
  assert.equal(read("other/x.txt"), "x2 uncommitted\n", "committed work outside the launch directory is kept");

  // Pruning drops an old session's refs but never the current session's own.
  const old = "2020-01-01T00:00:00";
  const oldCommit = execFileSync("git", ["commit-tree", "HEAD^{tree}", "-m", "old"], { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_AUTHOR_DATE: old, GIT_COMMITTER_DATE: old } }).trim();
  git("update-ref", "refs/luna/checkpoints/sess-old/1", oldCommit);
  git("update-ref", "refs/luna/checkpoints/sess-keep/1", oldCommit);
  git("update-ref", "refs/luna/undone/sess-keep", oldCommit);
  const keep = session("sess-keep", { confirm: true });
  register(keep.pi.api);
  await keep.pi.handlers.get("session_start")({}, keep.ctx);
  assert.equal(git("for-each-ref", "refs/luna/checkpoints/sess-old/"), "", "another session's expired ref is dropped");
  assert.ok(git("rev-parse", "refs/luna/checkpoints/sess-keep/1") && git("rev-parse", "refs/luna/undone/sess-keep"), "the current session's own refs are kept");

  // Credential names secret-guard matches anywhere in the name (prod.env, a.env.bak) stay out of the
  // checkpoint, and paths git would otherwise quote (non-ASCII, tab, quote, newline) are restored and deleted.
  const odd = ["café.txt", "tab\there.txt", "quo\"te.txt", "new\nline.txt"];
  const u = session("sess-odd", { confirm: true });
  register(u.pi.api);
  await u.pi.handlers.get("session_start")({}, u.ctx);
  for (const name of odd) write(`odd/${name}`, "before\n");
  write("odd/gone-after.txt", "x\n");
  await u.pi.handlers.get("turn_start")({}, u.ctx); // checkpoint 1
  const oddFiles = git("-c", "core.quotepath=false", "ls-tree", "-r", "-z", "--name-only", "refs/luna/checkpoints/sess-odd/1").split("\0");
  for (const name of odd) assert.ok(oddFiles.includes(`odd/${name}`), `${JSON.stringify(name)} is in the checkpoint`);
  write("prod.env", "TOKEN=1\n");
  write("sub/a.env.bak", "TOKEN=2\n");
  write("odd/UPPER.ENV", "TOKEN=3\n");
  for (const name of odd) write(`odd/${name}`, "after\n");
  write("odd/café-new.txt", "created after\n");
  write("odd/new\nfile.txt", "created after\n");
  await u.pi.handlers.get("turn_start")({}, u.ctx); // checkpoint 2 sees the same odd names, changed
  const credFiles = git("ls-tree", "-r", "-z", "--name-only", "refs/luna/checkpoints/sess-odd/2").split("\0");
  assert.ok(!credFiles.some((f) => /(?:prod|a|UPPER)\.env/i.test(f)), `credential-named files are not snapshotted: ${credFiles.join(",")}`);
  for (const name of odd) write(`odd/${name}`, "worst\n");
  write("odd/café-new2.txt", "created later\n");
  await u.pi.commands.get("undo").handler("2", u.ctx);
  for (const name of odd) assert.equal(read(`odd/${name}`), "after\n", `${JSON.stringify(name)} is restored`);
  assert.ok(!fs.existsSync(path.join(repo, "odd", "café-new2.txt")), "a non-ASCII file created since is deleted");
  assert.equal(read("prod.env"), "TOKEN=1\n", "a credential file is never touched by a restore");

  // Outside a repository nothing is attempted and nothing throws.
  const plain = path.join(ws, "plain");
  fs.mkdirSync(plain);
  const n = session("sess-n", { confirm: true });
  n.ctx.cwd = plain;
  register(n.pi.api);
  await n.pi.handlers.get("session_start")({}, n.ctx);
  await n.pi.handlers.get("turn_start")({}, n.ctx);
  console.log("  OK: checkpoints sit on a shadow ref, skip credentials, undo with a diff first, are bounded and survive /fork");
} finally {
  for (const undo of restoreEnv) undo();
  rmWorkspace(ws);
}
console.log("\n[git-checkpoint-smoke] all checks passed");
