// Worktree isolation for workflow agents (E5 slice S4).
//
// A workflow agent that writes gets its own git worktree at
// `<repo>/.pi/worktrees/<runId>/<n>` on branch `luna/wf/<runId>/<n>`, created from the checkout's
// HEAD. `.pi/` is git-ignored, so the worktrees never show up as untracked files in the main
// checkout. Running the child with its cwd set to the worktree makes the worktree its workspace:
// the worktree has its own `.git` file, which is what tool-firewall's workspaceRoot stops at.
//
// When the agent finishes, the worktree's link to its git dir is checked against what was recorded
// at creation (the agent can write files in its worktree), and git then runs with that git dir
// named explicitly and with fsmonitor and hooks off, so nothing the agent wrote runs here. A
// worktree whose link changed is kept and not inspected. An unchanged worktree (clean status, HEAD still the base commit) is
// removed together with its branch. A changed one is kept, never merged, and its outcome is
// returned (and appended to a journal file when one is given) so a person can review the branch.
//
// At most WORKTREE_CAP worktrees per checkout are live at once; a request beyond the cap waits for
// a slot instead of failing. Writers that run in the main checkout instead take the checkout's
// writer lock (withCheckoutLock), one at a time.
//
// Adapted from src/branch-lab/index.ts (createBranch / discardBranch): git always runs with the
// cwd the caller passes (the tool's ctx.cwd), never process.cwd().
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const WORKTREE_CAP = 16;
// Branch and directory names are built from these, so no dots (no "..", no ".lock"), no slashes.
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export interface WorkflowWorktree {
  runId: string;
  index: number;
  repoRoot: string;
  path: string;
  branch: string;
  baseCommit: string;
  /** The worktree's git dir (`<commonDir>/worktrees/<name>`) and the common dir, at creation. */
  gitDir: string;
  commonDir: string;
}

export interface WorktreeOutcome {
  runId: string;
  index: number;
  path: string;
  branch: string;
  baseCommit: string;
  status: "removed" | "kept";
  head: string;
  dirty: boolean;
  commits: number;
  reason?: string;
  at: string;
}

export function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || stdout || error.message).trim()));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

function canonical(dir: string): string {
  try { return fs.realpathSync(dir); } catch { return path.resolve(dir); }
}

/** The top of the checkout that contains `cwd` (a linked worktree is its own checkout). */
export async function checkoutRoot(cwd: string): Promise<string> {
  return canonical(await runGit(["rev-parse", "--show-toplevel"], cwd));
}

export function worktreeBranch(runId: string, index: number): string {
  return `luna/wf/${runId}/${index}`;
}

export function worktreeDir(repoRoot: string, runId: string, index: number): string {
  return path.join(repoRoot, ".pi", "worktrees", runId, String(index));
}

function assertIds(runId: string, index: number): void {
  if (!ID_PATTERN.test(runId)) throw new Error(`worktree: invalid run id ${JSON.stringify(runId)}`);
  if (!Number.isSafeInteger(index) || index < 0) throw new Error(`worktree: invalid agent index ${String(index)}`);
}

// --- the per-checkout cap: a wait, not a failure ---

interface Slots { active: number; waiters: Array<() => void> }
const slots = new Map<string, Slots>();

function slotsFor(root: string): Slots {
  let entry = slots.get(root);
  if (!entry) {
    entry = { active: 0, waiters: [] };
    slots.set(root, entry);
  }
  return entry;
}

function acquireSlot(root: string, signal?: AbortSignal): Promise<void> {
  const entry = slotsFor(root);
  if (entry.active < WORKTREE_CAP) {
    entry.active += 1;
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const grant = () => {
      signal?.removeEventListener("abort", onAbort);
      entry.active += 1;
      resolve();
    };
    const onAbort = () => {
      const at = entry.waiters.indexOf(grant);
      if (at >= 0) entry.waiters.splice(at, 1);
      reject(new Error("worktree: aborted while waiting for a worktree slot"));
    };
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener("abort", onAbort, { once: true });
    entry.waiters.push(grant);
  });
}

function releaseSlot(root: string): void {
  const entry = slots.get(root);
  if (!entry) return;
  entry.active = Math.max(0, entry.active - 1);
  const next = entry.waiters.shift();
  if (next) next();
  else if (entry.active === 0) slots.delete(root);
}

/** Live worktree slots and waiters for the checkout at `repoRoot` (for status and tests). */
export function worktreeSlots(repoRoot: string): { active: number; waiting: number } {
  const entry = slots.get(canonical(repoRoot));
  return { active: entry?.active ?? 0, waiting: entry?.waiters.length ?? 0 };
}

// --- create / finish ---

/**
 * Create the worktree for agent `index` of run `runId` in the checkout containing `cwd`. Waits
 * while WORKTREE_CAP worktrees of that checkout are live. Every created worktree must be passed
 * to finishWorkflowWorktree, which frees its slot.
 */
export async function createWorkflowWorktree(opts: { cwd: string; runId: string; index: number; signal?: AbortSignal }): Promise<WorkflowWorktree> {
  assertIds(opts.runId, opts.index);
  const repoRoot = await checkoutRoot(opts.cwd);
  await acquireSlot(repoRoot, opts.signal);
  try {
    const dir = worktreeDir(repoRoot, opts.runId, opts.index);
    if (fs.existsSync(dir)) throw new Error(`worktree: path already exists: ${dir}`);
    const baseCommit = await runGit(["rev-parse", "--verify", "HEAD^{commit}"], repoRoot);
    const branch = worktreeBranch(opts.runId, opts.index);
    fs.mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 });
    await runGit(["worktree", "add", "-b", branch, dir, baseCommit], repoRoot);
    const commonDir = canonical(path.resolve(repoRoot, await runGit(["rev-parse", "--git-common-dir"], repoRoot)));
    const gitDir = canonical(path.resolve(dir, await runGit(["rev-parse", "--git-dir"], dir)));
    return { runId: opts.runId, index: opts.index, repoRoot, path: canonical(dir), branch, baseCommit, gitDir, commonDir };
  } catch (error) {
    releaseSlot(repoRoot);
    throw error;
  }
}

function appendJournal(file: string, outcome: WorktreeOutcome): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, `${JSON.stringify(outcome)}\n`, { mode: 0o600 });
}

// Git options for every finish-time command: nothing configured to run (fsmonitor, hooks) runs,
// and no command recurses into a submodule.
const SAFE_GIT = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "submodule.recurse=false"];

function readText(file: string): string {
  try { return fs.readFileSync(file, "utf8"); } catch { return ""; }
}

/** Why the worktree's link to its git dir no longer matches creation, or null when it does. */
function linkChanged(tree: WorkflowWorktree): string | null {
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(readText(path.join(tree.path, ".git")));
  if (!match?.[1] || canonical(path.resolve(tree.path, match[1])) !== tree.gitDir) return `${tree.path}/.git no longer names ${tree.gitDir}`;
  const common = readText(path.join(tree.gitDir, "commondir")).trim();
  if (!common || canonical(path.resolve(tree.gitDir, common)) !== tree.commonDir) return `${tree.gitDir}/commondir no longer names ${tree.commonDir}`;
  return null;
}

/**
 * Finish an agent's worktree: remove it and its branch when nothing changed, otherwise keep both
 * (no merge) and append the outcome to `journalFile` when given. Always frees the slot.
 */
export async function finishWorkflowWorktree(tree: WorkflowWorktree, opts: { journalFile?: string } = {}): Promise<WorktreeOutcome> {
  try {
    const base = { runId: tree.runId, index: tree.index, path: tree.path, branch: tree.branch, baseCommit: tree.baseCommit };
    if (!fs.existsSync(tree.path)) {
      const outcome: WorktreeOutcome = { ...base, status: "removed", head: tree.baseCommit, dirty: false, commits: 0, reason: "worktree directory was already gone", at: new Date().toISOString() };
      await runGit([...SAFE_GIT, "worktree", "prune"], tree.repoRoot).catch(() => "");
      return outcome;
    }
    const changed = linkChanged(tree);
    if (changed) {
      const outcome: WorktreeOutcome = { ...base, status: "kept", head: "", dirty: true, commits: 0, reason: `not inspected: ${changed}`, at: new Date().toISOString() };
      if (opts.journalFile) appendJournal(opts.journalFile, outcome);
      return outcome;
    }
    const inTree = ["--git-dir", tree.gitDir, "--work-tree", tree.path, ...SAFE_GIT];
    // `--ignore-submodules=dirty` never enters a nested repo (whose config, e.g. a clean filter, the
    // agent controls) but still reports a gitlink that was staged or moved to another commit.
    const status = await runGit([...inTree, "status", "--porcelain", "--untracked-files=all", "--ignore-submodules=dirty"], tree.path);
    const head = await runGit([...inTree, "rev-parse", "HEAD"], tree.path);
    const commits = head === tree.baseCommit ? 0 : Number(await runGit([...inTree, "rev-list", "--count", `${tree.baseCommit}..${head}`], tree.path)) || 0;
    const dirty = status.length > 0;
    if (!dirty && head === tree.baseCommit) {
      const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));
      try {
        await runGit([...SAFE_GIT, "worktree", "remove", tree.path], tree.repoRoot);
      } catch (error) {
        const outcome: WorktreeOutcome = { ...base, status: "kept", head, dirty, commits, reason: `removal failed: ${describe(error)}`, at: new Date().toISOString() };
        if (opts.journalFile) appendJournal(opts.journalFile, outcome);
        return outcome;
      }
      try { fs.rmdirSync(path.dirname(tree.path)); } catch { /* other agents of the run still have worktrees */ }
      try {
        await runGit([...SAFE_GIT, "branch", "-D", tree.branch], tree.repoRoot);
      } catch (error) {
        const outcome: WorktreeOutcome = { ...base, status: "removed", head, dirty, commits, reason: `worktree removed, branch ${tree.branch} left: ${describe(error)}`, at: new Date().toISOString() };
        if (opts.journalFile) appendJournal(opts.journalFile, outcome);
        return outcome;
      }
      return { ...base, status: "removed", head, dirty, commits, at: new Date().toISOString() };
    }
    const reason = dirty ? "uncommitted changes" : `${commits} commit(s) on ${tree.branch}`;
    const outcome: WorktreeOutcome = { ...base, status: "kept", head, dirty, commits, reason, at: new Date().toISOString() };
    if (opts.journalFile) appendJournal(opts.journalFile, outcome);
    return outcome;
  } finally {
    releaseSlot(tree.repoRoot);
  }
}

// --- the per-checkout writer lock (writers that run in the main checkout) ---

const locks = new Map<string, Promise<void>>();

/**
 * Run `fn` holding the writer lock of the checkout containing `cwd`. Writers of the same checkout
 * run one at a time, in arrival order. The lock is in-process: it orders the writers this pi
 * session launches, not other processes.
 */
export async function withCheckoutLock<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
  const root = await checkoutRoot(cwd);
  const previous = locks.get(root) ?? Promise.resolve();
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => held);
  locks.set(root, tail);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(root) === tail) locks.delete(root);
  }
}
