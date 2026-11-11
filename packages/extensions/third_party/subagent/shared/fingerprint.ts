// GENERATED from packages/core/shared/fingerprint.ts by packages/core/gen-shared.ts. Do not edit this copy:
// change the source and run `npm run gen:shared` (`npm run verify` fails when a copy differs).
/**
 * The checkout fingerprint: HEAD plus the tree of the whole working copy, untracked files included
 * (ignored ones are not), built in a scratch index and a scratch object store, so neither the real
 * index nor the repository's objects are touched. The scratch index starts as a copy of the real
 * one, so git hashes only the files that differ from the real index: a read of the whole tree would
 * cost every caller. Nothing refreshes the real index, so a file an earlier writer left is hashed
 * again by every later fingerprint.
 *
 * Workflow resume binds reuse to it, and verify-gate binds a verdict to the revision it checked.
 *
 * Extensions are self-contained, so each consumer holds a generated copy (`npm run gen:shared`).
 */
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Repository config must not run code or reach into submodules while a fingerprint is taken.
const SAFE_GIT = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "submodule.recurse=false"];
const INDEX_AGE_MARGIN_MS = 2000;
const OUTPUT_CAP = 16 * 1024 * 1024;
// One line per tracked file, and running out of room would refuse every reuse in a large checkout.
const LISTING_CAP = 256 * 1024 * 1024;
const GITLINK_ENTRY = /(?:^|\0)160000 /;

function git(args: string[], cwd: string, env?: Record<string, string | undefined>, maxBuffer = OUTPUT_CAP): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", [...SAFE_GIT, ...args], { cwd, env: env ?? process.env, maxBuffer }, (error, stdout, stderr) => {
      if (error) reject(new Error((stderr || error.message).trim()));
      else resolve(stdout.trim());
    });
  });
}

function realOr(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Copies the real index to `index`; false when it cannot stand in for a read of the working tree.
 * git trusts an entry's stat data only if the entry is older than the index, so the copy keeps the
 * index's age, set back past its timestamp's rounding: a nearby edit is then hashed, never assumed
 * clean. A file flagged assume-unchanged or skip-worktree would not be read at all, so an index with
 * any of those is not used.
 */
async function seedIndex(root: string, index: string, env: Record<string, string | undefined>): Promise<boolean> {
  try {
    const real = path.resolve(root, await git(["rev-parse", "--git-path", "index"], root));
    fs.copyFileSync(real, index);
    const age = new Date(fs.statSync(real).mtimeMs - INDEX_AGE_MARGIN_MS);
    fs.utimesSync(index, age, age);
    const flagged = /(?:^|\0)(?:[a-z]|S) /.test(await git(["ls-files", "-v", "-z"], root, env, LISTING_CAP));
    if (!flagged) return true;
  } catch {
    /* no index yet, or none git can read: the fresh path below decides */
  }
  fs.rmSync(index, { force: true });
  return false;
}

/** True for a fingerprint that names a revision: not `no-git` and not `unreadable:`. */
export function usableFingerprint(fingerprint: string): boolean {
  return fingerprint !== "no-git" && !fingerprint.startsWith("unreadable:");
}

/**
 * The checkout's fingerprint, or "no-git" outside a git checkout. All of `.pi` is left out, because
 * the journal, the worktrees, the agent logs, the trace, the verdicts and the firewall audit there
 * change with every call, whether or not the checkout ignores them; so is each directory in
 * `exclude` that lies outside `.pi`. The comparison trusts no stat setting of the repository. A
 * nested repository is one gitlink, which hides its uncommitted edits, and git must not run inside
 * it, so a checkout with one is `unreadable:`.
 */
export async function workspaceFingerprint(cwd: string, exclude: readonly (string | undefined)[] = []): Promise<string> {
  let root: string;
  try {
    root = realOr(await git(["rev-parse", "--show-toplevel"], cwd));
  } catch {
    return "no-git";
  }
  let tmp: string | undefined;
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wf-index-"));
    const index = path.join(tmp, "index");
    const objects = path.join(tmp, "objects");
    fs.mkdirSync(objects);
    const realObjects = path.resolve(root, await git(["rev-parse", "--git-path", "objects"], root));
    // Quoted, because this variable is a list split on ":" unless an entry starts with a quote.
    const env = { ...process.env, GIT_INDEX_FILE: index, GIT_OBJECT_DIRECTORY: objects, GIT_ALTERNATE_OBJECT_DIRECTORIES: JSON.stringify(realObjects) };
    const head = await git(["rev-parse", "--verify", "HEAD^{commit}"], root).catch(() => "no-head");
    if (!(await seedIndex(root, index, env)) && head !== "no-head") await git(["read-tree", "HEAD"], root, env);
    const excludes: string[] = [];
    const inside = (from: string, dir: string): string | undefined => {
      const skip = path.relative(realOr(from), realOr(dir));
      return skip === "" || skip === ".." || skip.startsWith(`..${path.sep}`) || path.isAbsolute(skip) ? undefined : skip;
    };
    const piDir = path.join(root, ".pi");
    const elsewhere = exclude.filter((dir) => dir !== undefined && inside(piDir, dir) === undefined);
    for (const dir of [piDir, ...elsewhere]) {
      if (dir === undefined) continue;
      const skip = inside(root, dir);
      if (skip === undefined) continue;
      const rel = skip.split(path.sep).join("/");
      // An ignored directory needs no exclude (git add refuses a pathspec naming an ignored path).
      if (!(await git(["check-ignore", "-q", "--", rel], root).then(() => true, () => false))) excludes.push(`:(exclude,literal)${rel}`);
    }
    await git(["-c", "core.trustctime=true", "-c", "core.checkStat=default", "add", "-A", "--", ".", ...excludes], root, env);
    const tree = await git(["write-tree"], root, env);
    if (GITLINK_ENTRY.test(await git(["ls-files", "-s", "-z"], root, env, LISTING_CAP))) return "unreadable:a nested repository";
    return crypto.createHash("sha256").update(`${head}\n${tree}`).digest("hex");
  } catch (error) {
    return `unreadable:${error instanceof Error ? error.message.slice(0, 80) : "error"}`;
  } finally {
    if (tmp !== undefined) fs.rmSync(tmp, { recursive: true, force: true });
  }
}
