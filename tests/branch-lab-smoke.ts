#!/usr/bin/env node
/**
 * branch-lab lease-store hardening coverage.
 *
 * A crash mid-write previously truncated .pi/branch-leases.json (plain writeFileSync), and
 * readLeases then threw SyntaxError on every lease tool until an operator hand-deleted it.
 * This smoke is hermetic: fresh HOME / PI_CODING_AGENT_DIR / lease path plus a throwaway git
 * repo, so no real checkout, worktree, or branch is touched. It fails on the pre-fix source
 * because the corrupt-file read rejects instead of returning an empty list.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  loadExtension,
  fakePi,
  setEnv,
  tmpWorkspace,
  rmWorkspace,
  isolateKitEnv,
  textOf,
} from "../packages/core/eval/harness.ts";
import { array, literal, object, parseJsonAs, unknownValue } from "../packages/core/lib/guard.ts";

interface BranchLease {
  taskId: string;
  worktreePath: string;
  baseBranch?: string;
}

const readLeases = (file: string): BranchLease[] => JSON.parse(fs.readFileSync(file, "utf8")) as BranchLease[];

function withCwd<T>(cwd: string, fn: () => T | Promise<T>): Promise<T> {
  const previous = process.cwd();
  process.chdir(cwd);
  return Promise.resolve(fn()).finally(() => process.chdir(previous));
}

const taskId = `smoke-${process.pid}`;

// Real git is only needed to create the throwaway repo below. The extension's own git
// calls go through the fake on PATH, so this smoke stays hermetic and records argv.
const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();

async function main(): Promise<void> {
  const restoreEnv = isolateKitEnv();
  const ws = tmpWorkspace("pi-kit-branch-lab-");
  const leaseFile = path.join(ws, ".pi", "branch-leases.json");
  const restores = [
    restoreEnv,
    setEnv("PI_CODING_AGENT_DIR", path.join(ws, "agent")),
    setEnv("HOME", path.join(ws, "home")),
    setEnv("PI_KIT_BRANCH_LEASES_FILE", leaseFile),
  ];
  try {
    // Throwaway repo: created with the real git before the fake is on PATH.
    execFileSync(realGit, ["init"], { cwd: ws, stdio: "pipe" });
    execFileSync(realGit, ["config", "user.email", "smoke@example.invalid"], { cwd: ws });
    execFileSync(realGit, ["config", "user.name", "Smoke Test"], { cwd: ws });
    fs.writeFileSync(path.join(ws, "README.md"), "smoke\n");
    execFileSync(realGit, ["add", "README.md"], { cwd: ws });
    execFileSync(realGit, ["commit", "-m", "init"], { cwd: ws, stdio: "pipe" });

    // Fake git: records each invocation as "argv<TAB>arg..." and succeeds without
    // touching the repo. This captures the exact argv the extension hands to git.
    // `rev-parse --show-toplevel` (the repository key for worktree paths) prints the cwd.
    const gitLog = path.join(ws, "git-argv.log");
    const binDir = path.join(ws, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const shim = path.join(binDir, "git");
    fs.writeFileSync(
      shim,
      `#!/bin/sh\nprintf 'argv' >> '${gitLog}'\nfor a in "$@"; do printf '\\t%s' "$a" >> '${gitLog}'; done\nprintf '\\n' >> '${gitLog}'\n[ "$1" = rev-parse ] && [ "$2" = --show-toplevel ] && pwd\nexit 0\n`,
    );
    fs.chmodSync(shim, 0o755);
    restores.push(setEnv("PATH", `${binDir}${path.delimiter}${process.env.PATH ?? ""}`));
    // The repository-key lookup is not a repo-changing call, so it is left out here.
    const gitInvocations = () =>
      fs.existsSync(gitLog)
        ? fs.readFileSync(gitLog, "utf8").trim().split("\n").filter((line) => line && !line.startsWith("argv\trev-parse\t--show-toplevel"))
        : [];

    await withCwd(ws, async () => {
      const register = await loadExtension("extensions/branch-lab/index.ts");
      const pi = fakePi();
      register(pi.api);
      await pi.handlers.get("session_start")({}, { cwd: ws, ui: { notify() {} } });
      const ctx = { cwd: ws, hasUI: false, ui: { notify() {} } };
      const run = (name: string, params: Record<string, unknown> = {}) =>
        pi.tools.get(name).execute(name, params, undefined, undefined, ctx);

      // (b) A truncated/corrupt lease file must read as an empty list, not throw.
      fs.mkdirSync(path.dirname(leaseFile), { recursive: true });
      fs.writeFileSync(leaseFile, "{ not json");
      const corrupt = await run("branch_list");
      assert.match(
        textOf(corrupt),
        /no active leases/,
        "branch_list must treat a corrupt lease file as empty instead of throwing",
      );

      // (b2) F5: a lease file that is valid JSON but holds a non-object element
      // (`[null]`) or a partial lease missing worktreePath must drop those entries
      // instead of making branch_list dereference null/undefined and throw.
      fs.writeFileSync(leaseFile, "[null]");
      const nullLease = await run("branch_list");
      assert.match(
        textOf(nullLease),
        /no active leases/,
        "branch_list must drop a null lease element instead of dereferencing it",
      );

      fs.writeFileSync(leaseFile, JSON.stringify([{ taskId: "t", branch: "pi/t" }]));
      const partialLease = await run("branch_list");
      assert.match(
        textOf(partialLease),
        /no active leases/,
        "branch_list must drop a lease element missing worktreePath",
      );

      // (c) A normal write+read round-trip works, keeps the exact JSON shape, and leaves
      // no temp sibling behind.
      fs.rmSync(leaseFile, { force: true });
      const created = await run("branch_create", { taskId });
      assert.match(textOf(created), new RegExp(`created pi/${taskId}`));

      const onDisk = fs.readFileSync(leaseFile, "utf8");
      assert.equal(
        onDisk,
        `${JSON.stringify(JSON.parse(onDisk), null, 2)}\n`,
        "writeLeases must persist exact pretty JSON with a trailing newline",
      );
      assert.equal(parseJsonAs(array(unknownValue()), onDisk, leaseFile).length, 1, "the round-trip lease must be persisted");

      const listed = await run("branch_list");
      assert.match(textOf(listed), new RegExp(taskId), "branch_list must read back the written lease");

      const piDir = path.dirname(leaseFile);
      assert.deepEqual(
        fs.readdirSync(piDir).filter((f) => f.includes(".tmp-")),
        [],
        "no leftover .tmp-* file after a successful write",
      );

      // Cleanup: discard removes the worktree + branch and writes the store back to [].
      const discarded = await run("branch_discard", { taskId });
      assert.match(textOf(discarded), new RegExp(`discarded pi/${taskId}`));
      assert.deepEqual(JSON.parse(fs.readFileSync(leaseFile, "utf8")), []);
      assert.deepEqual(
        fs.readdirSync(piDir).filter((f) => f.includes(".tmp-")),
        [],
        "no leftover .tmp-* file after a second write",
      );

      // (d) WU-2: baseBranch accepts a real git ref containing '/'. Pre-change this
      // failed with "Invalid taskId" because baseBranch went through sanitizeTaskId.
      const baseTask = `smoke-base-${process.pid}`;
      const beforeBase = gitInvocations().length;
      const withBase = await run("branch_create", { taskId: baseTask, baseBranch: "feature/base" });
      assert.match(textOf(withBase), new RegExp(`created pi/${baseTask}`));

      const baseLease = readLeases(leaseFile).find((l) => l.taskId === baseTask);
      assert.ok(baseLease, "the base-ref lease must be persisted");
      assert.equal(baseLease.baseBranch, "feature/base", "the lease must record the real base ref");

      const afterBase = gitInvocations();
      assert.equal(afterBase.length, beforeBase + 1, "branch_create must make exactly one git call");
      const lastInvocation = afterBase.at(-1);
      assert.ok(lastInvocation !== undefined, "branch_create must make exactly one git call");
      const addArgv = lastInvocation.split("\t");
      assert.equal(addArgv[1], "worktree");
      assert.equal(addArgv[2], "add");
      assert.equal(addArgv.at(-1), "feature/base", "git argv must pass feature/base as the start point");
      assert.ok(addArgv.includes(`pi/${baseTask}`), "git argv must create the pi/<taskId> branch");

      // (e) Unsafe baseBranch values are rejected before git is invoked.
      const rejectTask = `smoke-reject-${process.pid}`;
      const unsafeRefs = ["-x", "a b", "a..b", "feature//x", "foo/", "foo.", ".hidden/x", "x~y", "a".repeat(201)];
      for (const unsafe of unsafeRefs) {
        const beforeReject = gitInvocations().length;
        await assert.rejects(
          () => run("branch_create", { taskId: rejectTask, baseBranch: unsafe }),
          /Invalid baseBranch/,
          `the unsafe baseBranch ${JSON.stringify(unsafe)} must be rejected`,
        );
        assert.equal(
          gitInvocations().length,
          beforeReject,
          `the unsafe baseBranch ${JSON.stringify(unsafe)} must not invoke git`,
        );
      }
      assert.ok(
        !readLeases(leaseFile).some((l) => l.taskId === rejectTask),
        "a rejected baseBranch must not write a lease",
      );

      // (f) A raw commit SHA is also a valid base ref.
      const sha = "0123456789abcdef0123456789abcdef01234567";
      const shaTask = `smoke-sha-${process.pid}`;
      await run("branch_create", { taskId: shaTask, baseBranch: sha });
      const shaLease = readLeases(leaseFile).find((l) => l.taskId === shaTask);
      assert.equal(shaLease?.baseBranch, sha, "a 40-char SHA must be accepted as a base ref");

      // (g) CRT-5: branch_merge accepts only an allow-listed strategy, checked before git runs.
      const beforeMerge = gitInvocations().length;
      await assert.rejects(
        () => run("branch_merge", { taskId: shaTask, strategy: "bogus-helper" }),
        /unsupported merge strategy "bogus-helper"/,
        "an unknown merge strategy must be rejected",
      );
      assert.equal(gitInvocations().length, beforeMerge, "a rejected merge strategy must not invoke git");
      await run("branch_merge", { taskId: shaTask, strategy: "ort" });
      assert.ok(
        gitInvocations().at(-1)?.split("\t").includes("--strategy=ort"),
        "an allow-listed strategy must reach git as --strategy=ort",
      );
    });
  } finally {
    // Fake git never creates worktrees, but branch_create made their per-repository parent.
    if (fs.existsSync(leaseFile)) {
      for (const lease of readLeases(leaseFile)) fs.rmSync(path.dirname(lease.worktreePath), { recursive: true, force: true });
    }
    for (const restore of restores.reverse()) restore();
    rmWorkspace(ws);
  }
}

function initRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync(realGit, ["init"], { cwd: dir, stdio: "pipe" });
  execFileSync(realGit, ["config", "user.email", "smoke@example.invalid"], { cwd: dir });
  execFileSync(realGit, ["config", "user.name", "Smoke Test"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "README.md"), "smoke\n");
  execFileSync(realGit, ["add", "README.md"], { cwd: dir });
  execFileSync(realGit, ["commit", "-m", "init"], { cwd: dir, stdio: "pipe" });
}

// Real-git coverage for CRT-5 (discard refuses dirty or unmerged work without force),
// CRT-7/ORC-8 (worktree paths keyed by repository; stale leases pruned at session start),
// and the shipped policy pinning branch_discard to "ask".
async function realGitSafety(): Promise<void> {
  const restoreEnv = isolateKitEnv();
  const ws = tmpWorkspace("pi-kit-branch-lab-real-");
  const restores = [
    restoreEnv,
    setEnv("PI_CODING_AGENT_DIR", path.join(ws, "agent")),
    setEnv("HOME", path.join(ws, "home")),
  ];
  const repos = [path.join(ws, "repo-a"), path.join(ws, "repo-b")];
  const worktrees: string[] = [];
  try {
    for (const repo of repos) initRepo(repo);
    const sharedId = `smoke-shared-${process.pid}`;
    const open = async (repo: string) => {
      const leaseFile = path.join(repo, ".pi", "branch-leases.json");
      restores.push(setEnv("PI_KIT_BRANCH_LEASES_FILE", leaseFile));
      const register = await loadExtension("extensions/branch-lab/index.ts");
      const pi = fakePi();
      register(pi.api);
      const notes: string[] = [];
      await pi.handlers.get("session_start")({}, { cwd: repo, ui: { notify: (m: string) => notes.push(m) } });
      const ctx = { cwd: repo, hasUI: false, ui: { notify() {} } };
      const run = (name: string, params: Record<string, unknown> = {}) =>
        pi.tools.get(name).execute(name, params, undefined, undefined, ctx);
      return { run, notes, leases: () => readLeases(leaseFile) };
    };
    const [repoA, repoB] = repos;
    assert.ok(repoA && repoB);

    // (h) CRT-7/ORC-8: the same taskId in two repositories gets two different worktrees.
    const a = await withCwd(repoA, async () => {
      const t = await open(repoA);
      await t.run("branch_create", { taskId: sharedId });
      return t;
    });
    const pathA = a.leases()[0]?.worktreePath;
    assert.ok(pathA && fs.existsSync(pathA), "repo A worktree must exist");
    worktrees.push(pathA);
    await withCwd(repoB, async () => {
      const b = await open(repoB);
      const created = await b.run("branch_create", { taskId: sharedId });
      assert.match(textOf(created), new RegExp(`created pi/${sharedId}`), "repo B must lease the same taskId");
      const pathB = b.leases()[0]?.worktreePath;
      assert.ok(pathB && fs.existsSync(pathB), "repo B worktree must exist");
      worktrees.push(pathB);
      assert.notEqual(pathB, pathA, "worktree paths must be keyed by repository");
      assert.equal(path.basename(pathB), sharedId);
      assert.equal(path.basename(path.dirname(path.dirname(pathB))), "pi-branch-lab");
    });

    await withCwd(repoA, async () => {
      const t = await open(repoA);
      // (i) CRT-5: a worktree with uncommitted changes is not discarded without force.
      fs.writeFileSync(path.join(pathA, "work.txt"), "uncommitted\n");
      await assert.rejects(
        () => t.run("branch_discard", { taskId: sharedId }),
        /uncommitted changes/,
        "a dirty worktree must not be discarded without force",
      );
      assert.ok(fs.existsSync(path.join(pathA, "work.txt")), "the uncommitted file must survive the refusal");
      assert.equal(t.leases().length, 1, "the lease must survive the refusal");

      // (j) CRT-5: committed work not merged into HEAD is not discarded without force.
      execFileSync(realGit, ["add", "work.txt"], { cwd: pathA });
      execFileSync(realGit, ["commit", "-m", "unmerged work"], { cwd: pathA, stdio: "pipe" });
      await assert.rejects(
        () => t.run("branch_discard", { taskId: sharedId }),
        /not merged into HEAD/,
        "an unmerged branch must not be discarded without force",
      );
      assert.ok(fs.existsSync(pathA), "the worktree must survive the refusal");

      // (k) force: true discards the worktree, the branch, and the lease.
      const forced = await t.run("branch_discard", { taskId: sharedId, force: true });
      assert.match(textOf(forced), new RegExp(`discarded pi/${sharedId}`));
      assert.ok(!fs.existsSync(pathA), "a forced discard must remove the worktree");
      assert.equal(t.leases().length, 0);
      assert.equal(
        execFileSync(realGit, ["branch", "--list", `pi/${sharedId}`], { cwd: repoA, encoding: "utf8" }).trim(),
        "",
        "a forced discard must delete the branch",
      );

      // (l) A clean, merged lease is discarded without force.
      await t.run("branch_create", { taskId: sharedId });
      const clean = await t.run("branch_discard", { taskId: sharedId });
      assert.match(textOf(clean), new RegExp(`discarded pi/${sharedId}`));

      // (m) CRT-7: session_start drops a lease whose worktree is gone, and keeps the branch.
      await t.run("branch_create", { taskId: sharedId });
      const stalePath = t.leases()[0]?.worktreePath;
      assert.ok(stalePath);
      fs.rmSync(stalePath, { recursive: true, force: true });
      const reopened = await open(repoA);
      assert.equal(reopened.leases().length, 0, "session_start must prune a lease whose worktree is gone");
      assert.ok(reopened.notes.some((n) => /pruned 1 lease/.test(n)), "the prune must be reported");
      assert.notEqual(
        execFileSync(realGit, ["branch", "--list", `pi/${sharedId}`], { cwd: repoA, encoding: "utf8" }).trim(),
        "",
        "pruning a lease must not delete its branch",
      );
    });

    // (n) CRT-5: both shipped policy copies make every branch_discard ask the operator.
    const root = path.resolve(import.meta.dirname, "..");
    for (const file of ["packages/extensions/src/tool-firewall/default-policy.json", "packages/core/policies/default.json"]) {
      const policy = parseJsonAs(
        object({ tools: object({ branch_discard: object({ decision: literal("allow", "ask", "deny") }) }) }),
        fs.readFileSync(path.join(root, file), "utf8"),
        file,
      );
      assert.equal(policy.tools.branch_discard.decision, "ask", `${file} must pin branch_discard to ask`);
    }
  } finally {
    for (const repo of repos) {
      try { execFileSync(realGit, ["worktree", "prune"], { cwd: repo, stdio: "pipe" }); } catch { /* repo may be gone */ }
    }
    for (const wt of worktrees) fs.rmSync(path.dirname(wt), { recursive: true, force: true });
    for (const restore of restores.reverse()) restore();
    rmWorkspace(ws);
  }
}

await main();
await realGitSafety();
console.log("[branch-lab-smoke] OK");
