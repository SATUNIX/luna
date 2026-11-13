import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Checkpoints of the working tree, kept where the operator's branch, index and stash never see them.
//
// Each checkpoint is a commit object of the working tree (tracked changes and new, unignored files)
// written under refs/luna/checkpoints/<session>/<seq>. It is built in a private temporary index,
// so `git status`, the staged set, the branch and `git stash list` are untouched. Paths that look
// like credentials are left out of the snapshot (the same signatures secret-guard blocks), and so
// is Luna's own `.pi/` session data: neither is ever copied into git objects or touched by a restore.
//
// /checkpoints lists them, /undo shows what would change and, once confirmed, puts the working tree
// back to the checkpoint (it deletes files the agent created since, and restores or recreates the
// ones it changed). The state it replaced is kept at refs/luna/undone/<session>.
//
// History: checkpoints were `git stash create` objects held in memory and cleared on every
// agent_end, so a /fork right after a turn found nothing (H-04). They are no longer cleared by
// agent_end; a new session starts a new set; the set is bounded and oldest-first evicted.

function intEnv(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

const MAX_CHECKPOINTS = intEnv("PI_KIT_CHECKPOINT_MAX", 20);
const KEEP_DAYS = 14;
const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = 16 * 1024 * 1024;
const REF_ROOT = "refs/luna/checkpoints";
const UNDONE_ROOT = "refs/luna/undone";

// Credential and kit-session paths, as git pathspecs. Kept in step with secret-guard's
// SECRET_PATH_PATTERNS (tests/git-checkpoint-smoke.ts writes one file per family): secret-guard's
// /\.env$/ and /\.env\./ match `prod.env` and `a.env.bak` as well as `.env`, so these globs do too.
const EXCLUDED = [
  "**/*.env", "**/*.env.*", "**/*.key", "**/*.pem", "**/*.p12", "**/*.pfx",
  "**/*credentials*", "**/*secret*", "**/.ssh/**", "**/*id_rsa*", "**/*id_ed25519*",
  "**/.npmrc", "**/.netrc", "**/.pi/**",
].map((glob) => `:(exclude,glob,icase)${glob}`);

interface GitResult {
  ok: boolean;
  stdout: string;
}

function git(cwd: string, args: string[], env: Record<string, string> = {}): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", ...env }, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, encoding: "utf8" }, (error, stdout) => {
      resolve({ ok: error === null, stdout: stdout.trim() });
    });
  });
}

const IDENTITY = {
  GIT_AUTHOR_NAME: "Luna checkpoint", GIT_AUTHOR_EMAIL: "checkpoint@luna.invalid",
  GIT_COMMITTER_NAME: "Luna checkpoint", GIT_COMMITTER_EMAIL: "checkpoint@luna.invalid",
};

/** The repository's top directory, or undefined when cwd is not inside a work tree. */
async function topOf(cwd: string): Promise<string | undefined> {
  const top = await git(cwd, ["rev-parse", "--show-toplevel"]);
  return top.ok && top.stdout ? top.stdout : undefined;
}

/**
 * The working tree as a tree object, built in a private index. It is always the whole repository,
 * taken from its top directory: a snapshot of only the launch subdirectory would carry the rest of
 * the tree from HEAD, and a later /undo would then "restore" committed work outside it. Undefined when this is not a repository or git failed. */
async function snapshotTree(cwd: string): Promise<{ tree: string; head: string | undefined } | undefined> {
  const gitDir = await git(cwd, ["rev-parse", "--absolute-git-dir"]);
  const top = await topOf(cwd);
  if (!gitDir.ok || !gitDir.stdout || !top) return undefined;
  cwd = top;
  const index = path.join(gitDir.stdout, `luna-checkpoint-index-${process.pid}`);
  const env = { GIT_INDEX_FILE: index };
  try {
    const head = await git(cwd, ["rev-parse", "--verify", "-q", "HEAD"]);
    if (head.ok) await git(cwd, ["read-tree", "HEAD"], env);
    // A failed add leaves a partial snapshot; refuse it rather than record one.
    const add = await git(cwd, ["add", "-A", "--", ".", ...EXCLUDED], env);
    if (!add.ok) return undefined;
    const tree = await git(cwd, ["write-tree"], env);
    return tree.ok && tree.stdout ? { tree: tree.stdout, head: head.ok ? head.stdout : undefined } : undefined;
  } finally {
    fs.rmSync(index, { force: true });
  }
}

interface Checkpoint {
  seq: number;
  ref: string;
  commit: string;
  tree: string;
  when: number;
}

async function listCheckpoints(cwd: string, session: string): Promise<Checkpoint[]> {
  const out = await git(cwd, ["for-each-ref", "--format=%(refname)%09%(objectname)%09%(tree)%09%(committerdate:unix)", `${REF_ROOT}/${session}/`]);
  if (!out.ok || !out.stdout) return [];
  const rows: Checkpoint[] = [];
  for (const line of out.stdout.split("\n")) {
    const [ref = "", commit = "", tree = "", when = ""] = line.split("\t");
    const seq = Number(ref.slice(ref.lastIndexOf("/") + 1));
    if (Number.isInteger(seq)) rows.push({ seq, ref, commit, tree, when: Number(when) * 1000 });
  }
  return rows.sort((a, b) => a.seq - b.seq);
}

interface Change {
  status: string;
  file: string;
}

/**
 * Paths that differ between a checkpoint and the working tree. Read with -z: without it git quotes
 * a path with non-ASCII characters, a tab, a quote or a newline ("caf\303\251.txt"), and that quoted
 * text matches no file.
 */
async function changesSince(cwd: string, checkpointTree: string, nowTree: string): Promise<Change[]> {
  const out = await git(cwd, ["diff-tree", "-z", "-r", "--no-renames", "--name-status", checkpointTree, nowTree]);
  if (!out.ok || !out.stdout) return [];
  const fields = out.stdout.split("\0");
  const rows: Change[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) rows.push({ status: fields[i] ?? "", file: fields[i + 1] ?? "" });
  return rows;
}

/** Put the working tree back to a checkpoint. Returns the number of paths changed, or an error text. */
async function restore(cwd: string, checkpoint: Checkpoint, nowTree: string): Promise<number | string> {
  const rows = await changesSince(cwd, checkpoint.tree, nowTree);
  const base = await topOf(cwd);
  if (!base) return "could not find the repository root; nothing was changed";
  const toRestore: string[] = [];
  for (const { status, file } of rows) {
    const target = path.resolve(base, file);
    if (!file || !target.startsWith(base + path.sep)) continue; // never outside the repository
    // A = added since the checkpoint (delete it); M or D = changed or removed since (bring it back).
    if (status === "A") fs.rmSync(target, { force: true });
    else toRestore.push(`:(literal)${file}`);
  }
  if (toRestore.length > 0) {
    // --worktree only: the index and the branch are not part of a checkpoint.
    const done = await git(base, ["restore", `--source=${checkpoint.commit}`, "--worktree", "--", ...toRestore]);
    if (!done.ok) return "git restore failed for some paths";
  }
  return rows.length;
}

function age(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
}

function say(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void {
  try {
    if (ctx.hasUI) ctx.ui.notify(message, level);
  } catch {
    /* a stale ctx after a reload: drop the notice */
  }
}

export default function (pi: ExtensionAPI) {
  let session = "";
  let currentEntryId: string | undefined;
  let nextSeq = 1;
  const byEntry = new Map<string, number>();

  function idOf(ctx: ExtensionContext): string {
    try {
      const id: unknown = ctx.sessionManager.getSessionId();
      if (typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) return id;
    } catch {
      /* no session manager */
    }
    return `s${Date.now()}`;
  }

  /** Other sessions' checkpoints are kept for KEEP_DAYS, then their refs are dropped; this session's own never expire. */
  async function prune(cwd: string): Promise<void> {
    const out = await git(cwd, ["for-each-ref", "--format=%(refname)%09%(committerdate:unix)", `${REF_ROOT}/`, `${UNDONE_ROOT}/`]);
    if (!out.ok || !out.stdout) return;
    const cutoff = Date.now() / 1000 - KEEP_DAYS * 86_400;
    for (const line of out.stdout.split("\n")) {
      const [ref = "", when = ""] = line.split("\t");
      if (ref.startsWith(`${REF_ROOT}/${session}/`) || ref === `${UNDONE_ROOT}/${session}`) continue;
      if (ref && Number(when) < cutoff) await git(cwd, ["update-ref", "-d", ref]);
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    session = idOf(ctx);
    currentEntryId = undefined;
    byEntry.clear();
    const existing = await listCheckpoints(ctx.cwd, session);
    nextSeq = (existing[existing.length - 1]?.seq ?? 0) + 1;
    await prune(ctx.cwd);
  });

  pi.on("tool_result", async (_event, ctx) => {
    const leaf = ctx.sessionManager.getLeafEntry();
    if (leaf) currentEntryId = leaf.id;
  });

  pi.on("turn_start", async (_event, ctx) => {
    if (!session) return;
    const snap = await snapshotTree(ctx.cwd);
    if (!snap) return;
    const all = await listCheckpoints(ctx.cwd, session);
    const last = all[all.length - 1];
    if (last?.tree === snap.tree) {
      if (currentEntryId) byEntry.set(currentEntryId, last.seq); // nothing changed: the same state covers this point
      return;
    }
    const commit = await git(ctx.cwd, ["commit-tree", snap.tree, ...(snap.head ? ["-p", snap.head] : []), "-m", `luna checkpoint ${nextSeq}`], IDENTITY);
    if (!commit.ok || !commit.stdout) return;
    const seq = nextSeq++;
    await git(ctx.cwd, ["update-ref", `${REF_ROOT}/${session}/${seq}`, commit.stdout]);
    if (currentEntryId) byEntry.set(currentEntryId, seq);
    for (const old of all.slice(0, Math.max(0, all.length + 1 - MAX_CHECKPOINTS))) {
      await git(ctx.cwd, ["update-ref", "-d", old.ref]);
      for (const [entry, n] of byEntry) if (n === old.seq) byEntry.delete(entry);
    }
  });

  /** Restore a checkpoint; with `ask`, show what changes first and stop unless the operator agrees. */
  async function undoTo(ctx: ExtensionContext, checkpoint: Checkpoint, ask: boolean): Promise<void> {
    const now = await snapshotTree(ctx.cwd);
    if (!now) {
      say(ctx, "Could not read the working tree; nothing was changed.", "error");
      return;
    }
    const rows = await changesSince(ctx.cwd, checkpoint.tree, now.tree);
    if (rows.length === 0) {
      say(ctx, `Checkpoint ${checkpoint.seq} already matches the working tree: nothing to undo.`);
      return;
    }
    if (ask) {
      const labels: Record<string, string> = { A: "delete", M: "restore", D: "recreate" };
      const shown = rows.slice(0, 25).map(({ status, file }) => `${labels[status] ?? status}\t${JSON.stringify(file).slice(1, -1)}`);
      const more = rows.length > shown.length ? `\n... and ${rows.length - shown.length} more` : "";
      const yes = await ctx.ui.confirm(`Undo to checkpoint ${checkpoint.seq} (${age(checkpoint.when)})?`, `${shown.join("\n")}${more}\n\nThe current state is kept at ${UNDONE_ROOT}/${session}.`);
      if (!yes) return;
    }
    const keep = await git(ctx.cwd, ["commit-tree", now.tree, ...(now.head ? ["-p", now.head] : []), "-m", "luna state before undo"], IDENTITY);
    if (keep.ok && keep.stdout) await git(ctx.cwd, ["update-ref", `${UNDONE_ROOT}/${session}`, keep.stdout]);
    const result = await restore(ctx.cwd, checkpoint, now.tree);
    if (typeof result === "string") {
      say(ctx, `Undo stopped: ${result}`, "error");
      return;
    }
    // The restored checkpoint and every later one describe states that no longer exist.
    for (const c of await listCheckpoints(ctx.cwd, session)) if (c.seq >= checkpoint.seq) await git(ctx.cwd, ["update-ref", "-d", c.ref]);
    say(ctx, `Working tree restored to checkpoint ${checkpoint.seq} (${result} path(s)). Your branch and index were not touched.`);
  }

  pi.registerCommand("checkpoints", {
    description: "List this session's working-tree checkpoints (kept under refs/luna/checkpoints, never on your branch)",
    handler: async (_args, ctx) => {
      const all = await listCheckpoints(ctx.cwd, session);
      if (all.length === 0) {
        say(ctx, "No checkpoints yet: one is taken at the start of each turn that finds the working tree changed.");
        return;
      }
      say(ctx, ["Checkpoints (newest last); /undo [n] restores one:", ...all.map((c) => `  ${c.seq}  ${age(c.when)}`)].join("\n"));
    },
  });

  pi.registerCommand("undo", {
    description: "Put the working tree back to the latest checkpoint (or /undo <n>), showing what changes first",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;
      const all = await listCheckpoints(ctx.cwd, session);
      const wanted = args.trim() ? Number(args.trim()) : undefined;
      const checkpoint = wanted === undefined ? all[all.length - 1] : all.find((c) => c.seq === wanted);
      if (!checkpoint) {
        say(ctx, wanted === undefined ? "No checkpoints to undo to." : `No checkpoint ${args.trim()}; /checkpoints lists them.`, "warning");
        return;
      }
      await undoTo(ctx, checkpoint, true);
    },
  });

  pi.on("session_before_fork", async (event, ctx) => {
    const seq = byEntry.get(event.entryId);
    if (seq === undefined || !ctx.hasUI) return;
    const checkpoint = (await listCheckpoints(ctx.cwd, session)).find((c) => c.seq === seq);
    if (!checkpoint) return;
    const choice = await ctx.ui.select("Restore code state?", ["Yes, restore code to that point", "No, keep current code"]);
    if (choice?.startsWith("Yes")) await undoTo(ctx, checkpoint, false);
  });
}
