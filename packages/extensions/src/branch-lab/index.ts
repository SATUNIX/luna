import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";

type Lease = {
  taskId: string;
  worktreePath: string;
  branch: string;
  baseBranch: string | null;
  pid: number | null;
  createdAt: string;
};

// Tool parameters as the schemas below declare them (pi validates them before execute).
type TaskParams = { taskId?: string; name?: string };

// `git merge --strategy=<x>` makes git look up a `git-merge-<x>` helper, so only git's
// own two-head strategies are accepted (CRT-5).
const MERGE_STRATEGIES = new Set(["ort", "recursive", "resolve", "ours", "subtree"]);

const DEFAULT_MAX_BRANCHES = 4;
const MAX_BASE_REF_LENGTH = 200;

function leasesPath(): string {
  return process.env.PI_KIT_BRANCH_LEASES_FILE || path.join(process.cwd(), ".pi", "branch-leases.json");
}

function maxBranches(): number {
  const parsed = Number(process.env.PI_KIT_MAX_BRANCHES || DEFAULT_MAX_BRANCHES);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_MAX_BRANCHES;
}

function branchRoot(): string {
  return path.join(os.tmpdir(), "pi-branch-lab");
}

function sanitizeTaskId(taskId: string): string {
  const normalized = taskId.trim();
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(normalized)) {
    throw new Error("Invalid taskId. Use 1-80 letters, numbers, dot, underscore, or dash characters.");
  }
  return normalized;
}

// baseBranch names a real git ref (or commit-ish), so it must allow `/` and `.`
// inside components (`origin/main`, `release/1.2`, a 40-char SHA) while still
// rejecting values that git would treat as unsafe or that could be mistaken for an
// option. This mirrors git-check-ref-format; `sanitizeTaskId` stays for taskId only.
function sanitizeBaseRef(baseRef: string): string {
  const normalized = baseRef.trim();
  if (!normalized) {
    throw new Error("Invalid baseBranch. Provide a git ref or commit such as origin/main, feature/x, or a SHA.");
  }
  if (normalized.length > MAX_BASE_REF_LENGTH) {
    throw new Error(`Invalid baseBranch. Git refs and commits must be at most ${MAX_BASE_REF_LENGTH} characters.`);
  }
  if (normalized.startsWith("-")) {
    throw new Error("Invalid baseBranch. A git ref or commit may not start with '-'.");
  }
  if (hasSpaceOrControl(normalized) || /[~^:?*[\\]/.test(normalized)) {
    throw new Error("Invalid baseBranch. A git ref may not contain whitespace, control characters, or any of ~ ^ : ? * [ \\.");
  }
  if (normalized.includes("..") || normalized.includes("//") || normalized.includes("@{")) {
    throw new Error("Invalid baseBranch. A git ref may not contain '..', '//', or '@{'.");
  }
  if (normalized.endsWith("/") || normalized.endsWith(".") || normalized.endsWith(".lock")) {
    throw new Error("Invalid baseBranch. A git ref may not end with '/', '.', or '.lock'.");
  }
  for (const component of normalized.split("/")) {
    if (component.length === 0 || component.startsWith(".") || component.endsWith(".") || component.endsWith(".lock")) {
      throw new Error("Invalid baseBranch. Each path component must be non-empty and may not start or end with '.'.");
    }
  }
  return normalized;
}

// True for any UTF-16 code unit git-check-ref-format rejects as space or control: U+0000-U+0020
// and U+007F. A code-unit loop rather than a regex range, so no control character sits in a
// pattern.
function hasSpaceOrControl(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

function branchNameFor(taskId: string): string {
  return `pi/${taskId}`;
}

// Worktrees are keyed by repository (CRT-7/ORC-8): two repositories that both lease task
// `t1` get different paths instead of colliding in one shared `<tmp>/pi-branch-lab/t1`.
async function repoRoot(): Promise<string> {
  const top = await runGit(["rev-parse", "--show-toplevel"]);
  if (!top) throw new Error("branch-lab: could not resolve the git repository top level");
  return path.join(branchRoot(), createHash("sha256").update(top).digest("hex").slice(0, 12));
}

async function worktreePathFor(taskId: string): Promise<string> {
  return path.join(await repoRoot(), taskId);
}

function ensureLeaseDir(): void {
  fs.mkdirSync(path.dirname(leasesPath()), { recursive: true });
  fs.mkdirSync(branchRoot(), { recursive: true });
}

// A lease file is operator-editable and can be hand-mangled (or corrupted) into a
// valid-JSON shape that still is not a list of leases, e.g. `[null]` or an object
// missing worktreePath. Dropping those entries here keeps every consumer
// (stableLeaseList, leaseFor, discardBranch) from dereferencing a malformed element.
function isLease(value: unknown): value is Lease {
  if (typeof value !== "object" || value === null) return false;
  const lease = value as Record<string, unknown>;
  return (
    typeof lease.taskId === "string" &&
    typeof lease.branch === "string" &&
    typeof lease.worktreePath === "string"
  );
}

function readLeases(): Lease[] {
  const file = leasesPath();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isLease) : [];
  } catch (error) {
    // Fail safe like the sibling stores (verifier-board, task-graph, memory-local): a
    // missing, truncated, or otherwise unreadable lease file must not make every branch
    // tool throw until an operator hand-deletes it. Missing files are the normal empty
    // state and stay silent; anything else gets one stderr note so a real bug is visible.
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      process.stderr.write(`branch-lab: ignoring unreadable lease file ${file}: ${(error as Error).message}\n`);
    }
    return [];
  }
}

function writeLeases(leases: Lease[]): void {
  ensureLeaseDir();
  const file = leasesPath();
  // Atomic write: temp sibling + rename so a crash mid-write cannot truncate the live
  // file. The temp is removed on failure; after a successful rename it no longer exists.
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(leases, null, 2)}\n`);
    fs.renameSync(tmp, file);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* renamed away or never created */ }
  }
}

function leaseFor(taskId: string): Lease | undefined {
  return readLeases().find((lease) => lease.taskId === taskId);
}

function assertKnownWorktree(target: string): void {
  const resolvedRoot = path.resolve(branchRoot());
  const resolvedTarget = path.resolve(target);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`Refusing to manage worktree outside branch-lab root: ${target}`);
  }
}

function runGit(args: string[], cwd = process.cwd()): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || stdout || error.message).trim()));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: undefined };
}

function taskIdFrom(input: TaskParams): string {
  return sanitizeTaskId(input?.taskId || input?.name || "");
}

async function createBranch(input: TaskParams & { baseBranch?: string }): Promise<string> {
  const taskId = taskIdFrom(input);
  const existing = leaseFor(taskId);
  if (existing) return `branch-lab: existing lease ${taskId} at ${existing.worktreePath}`;

  const leases = readLeases();
  if (leases.length >= maxBranches()) throw new Error(`branch-lab: max branches reached (${maxBranches()})`);

  const baseBranch = input?.baseBranch ? sanitizeBaseRef(input.baseBranch) : null;
  const branch = branchNameFor(taskId);
  const worktreePath = await worktreePathFor(taskId);
  assertKnownWorktree(worktreePath);
  if (fs.existsSync(worktreePath)) throw new Error(`branch-lab: worktree path already exists: ${worktreePath}`);

  ensureLeaseDir();
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  const args = ["worktree", "add", worktreePath, "-b", branch];
  if (baseBranch) args.push(baseBranch);
  await runGit(args);

  leases.push({
    taskId,
    worktreePath,
    branch,
    baseBranch,
    pid: null,
    createdAt: new Date().toISOString(),
  });
  writeLeases(leases);
  return `branch-lab: created ${branch} at ${worktreePath}`;
}

async function branchExists(branch: string): Promise<boolean> {
  try {
    await runGit(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

async function isMerged(branch: string): Promise<boolean> {
  try {
    await runGit(["merge-base", "--is-ancestor", branch, "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

// CRT-5: without `force`, a discard must not destroy uncommitted work in the worktree or
// commits on the branch that the current HEAD does not contain.
async function assertSafeToDiscard(lease: Lease): Promise<void> {
  if (fs.existsSync(lease.worktreePath)) {
    const status = await runGit(["status", "--porcelain"], lease.worktreePath);
    if (status) {
      throw new Error(`branch-lab: refusing to discard ${lease.branch}: its worktree has uncommitted changes (pass force: true to discard them)`);
    }
  }
  if ((await branchExists(lease.branch)) && !(await isMerged(lease.branch))) {
    throw new Error(`branch-lab: refusing to discard ${lease.branch}: it has commits not merged into HEAD (pass force: true to discard them)`);
  }
}

async function discardBranch(input: TaskParams & { force?: boolean }): Promise<string> {
  const taskId = taskIdFrom(input);
  const leases = readLeases();
  const lease = leases.find((item) => item.taskId === taskId);
  if (!lease) throw new Error(`branch-lab: no lease for ${taskId}`);
  assertKnownWorktree(lease.worktreePath);
  if (input?.force !== true) await assertSafeToDiscard(lease);

  await runGit(["worktree", "remove", "--force", lease.worktreePath]);
  // The worktree removal does not delete the branch ref, so a discarded task's
  // pi/<taskId> branch would linger and the id could never be re-leased. Delete it too;
  // ignore "not found" (the branch may already be gone or have been merged).
  try { await runGit(["branch", "-D", lease.branch]); } catch { /* branch already absent */ }
  // Remove the per-repository directory once its last worktree is gone (rmdir only
  // succeeds on an empty directory).
  const repoDir = path.dirname(lease.worktreePath);
  if (path.resolve(repoDir) !== path.resolve(branchRoot())) {
    try { fs.rmdirSync(repoDir); } catch { /* still holds other worktrees */ }
  }
  writeLeases(leases.filter((item) => item.taskId !== taskId));
  return `branch-lab: discarded ${lease.branch}`;
}

async function mergeBranch(input: TaskParams & { strategy?: string }): Promise<string> {
  const taskId = taskIdFrom(input);
  const lease = leaseFor(taskId);
  if (!lease) throw new Error(`branch-lab: no lease for ${taskId}`);
  const strategy = typeof input?.strategy === "string" && input.strategy.trim() ? input.strategy.trim() : null;
  if (strategy && !MERGE_STRATEGIES.has(strategy)) {
    throw new Error(`branch-lab: unsupported merge strategy ${JSON.stringify(strategy)}; use one of ${[...MERGE_STRATEGIES].join(", ")}`);
  }
  const args = ["merge", lease.branch];
  if (strategy) args.splice(1, 0, `--strategy=${strategy}`);
  const output = await runGit(args);
  return `branch-lab: merged ${lease.branch}${output ? `\n${output}` : ""}`;
}

export default function branchLab(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    ensureLeaseDir();
    // CRT-7: a lease whose worktree is gone (for example /tmp cleared by a reboot) would
    // make branch_switch hand out a missing directory, so it is dropped here. The
    // pi/<taskId> branch and its commits are left in the repository.
    const leases = readLeases();
    const live = leases.filter((lease) => fs.existsSync(lease.worktreePath));
    if (live.length !== leases.length) {
      writeLeases(live);
      ctx.ui?.notify?.(`branch-lab: pruned ${leases.length - live.length} lease(s) whose worktree is gone`, "warning");
    }
    ctx.ui?.notify?.("branch-lab: loaded", "info");
  });

  // H-02 fix: all five tools below previously declared `async execute(input: any)`,
  // treating the FIRST positional argument as `params`. The real, documented signature
  // (node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:354)
  // is `execute(toolCallId, params, signal, onUpdate, ctx)` - a production-shaped call
  // like `branch_create.execute("call-1", {taskId:"review-task"}, ...)` passed the
  // toolCallId STRING where `input` expected an object, so `taskIdFrom` read
  // `input?.taskId` off a string and failed "Invalid taskId" before any git action ran.
  // `branch_list` (zero declared params) happened to not crash, but still never received
  // its real arguments either.
  pi.registerTool({
    name: "branch_create",
    label: "Branch: create",
    description: "Create a git worktree branch for isolated work.",
    parameters: Type.Object({
      taskId: Type.Optional(Type.String({ description: "Task identifier" })),
      name: Type.Optional(Type.String({ description: "Compatibility alias for taskId" })),
      baseBranch: Type.Optional(Type.String({ description: "Base branch or commit" })),
    }),
    async execute(_toolCallId, params) {
      return textResult(await createBranch(params));
    },
  });

  pi.registerTool({
    name: "branch_list",
    label: "Branch: list",
    description: "List branch-lab leases.",
    parameters: Type.Object({}),
    async execute() {
      const leases = readLeases();
      return textResult(leases.length ? stableLeaseList(leases) : "branch-lab: no active leases");
    },
  });

  pi.registerTool({
    name: "branch_switch",
    label: "Branch: switch",
    description: "Return the worktree path for an isolated branch.",
    parameters: Type.Object({
      taskId: Type.Optional(Type.String({ description: "Task identifier" })),
      name: Type.Optional(Type.String({ description: "Compatibility alias for taskId" })),
    }),
    async execute(_toolCallId, params) {
      const taskId = taskIdFrom(params);
      const lease = leaseFor(taskId);
      if (!lease) throw new Error(`branch-lab: no lease for ${taskId}`);
      return textResult(`branch-lab: use worktree ${lease.worktreePath}`);
    },
  });

  pi.registerTool({
    name: "branch_discard",
    label: "Branch: discard",
    description: "Remove a branch-lab worktree and lease. Refuses a worktree with uncommitted changes or a branch not merged into HEAD unless force is true.",
    parameters: Type.Object({
      taskId: Type.Optional(Type.String({ description: "Task identifier" })),
      name: Type.Optional(Type.String({ description: "Compatibility alias for taskId" })),
      force: Type.Optional(Type.Boolean({ description: "Discard even uncommitted changes and unmerged commits" })),
    }),
    async execute(_toolCallId, params) {
      return textResult(await discardBranch(params));
    },
  });

  pi.registerTool({
    name: "branch_merge",
    label: "Branch: merge",
    description: "Merge a branch-lab branch into the current git branch.",
    parameters: Type.Object({
      taskId: Type.Optional(Type.String({ description: "Task identifier" })),
      name: Type.Optional(Type.String({ description: "Compatibility alias for taskId" })),
      strategy: Type.Optional(Type.String({ description: "Optional git merge strategy: ort, recursive, resolve, ours, or subtree" })),
    }),
    async execute(_toolCallId, params) {
      return textResult(await mergeBranch(params));
    },
  });
}

function stableLeaseList(leases: Lease[]): string {
  return leases
    .map((lease) => `${lease.taskId}\t${lease.branch}\t${lease.worktreePath}`)
    .sort()
    .join("\n");
}
