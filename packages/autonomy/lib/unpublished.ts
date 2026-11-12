// Read-only view of whether a run's merged work reached its git remote. The host compares the
// run's own mirror.git refs and NEVER fetches or writes a ref: syncIntegration() (lib/gitmirror.ts)
// fetches, so the operator's status/top/inbox/doctor views cannot use it.
//
// mirror.git holds refs/heads/<integration> (the merged cycles) and refs/integration/remote (the
// integration branch as last fetched). When the local branch is strictly ahead of the remote ref,
// the merged work is not published; the oldest unpublished commit and the last publish failure in
// the supervisor log say since when and why.
import { spawnSync } from "node:child_process";
import fs from "node:fs";

/** Whether a run's merged integration branch is published to its git remote. */
export interface UnpublishedReport {
  /** "equal": both refs match; "ahead": local has unpublished commits; "behind": remote is ahead; "absent": no local branch; "unknown": cannot tell (or diverged). */
  state: "equal" | "ahead" | "behind" | "absent" | "unknown";
  /** Commits on the local branch that the remote ref does not have; 0 unless state is "ahead". */
  ahead: number;
  /** ISO timestamp of the last publish failure, else of the oldest unpublished commit; null unless "ahead". */
  since: string | null;
  /** The publish failure that explains it, else the last recorded publishError; null unless "ahead". */
  reason: string | null;
}

export interface UnpublishedOptions {
  /** The run's mirror.git (a bare repository the host owns). */
  mirrorDir: string;
  /** The integration branch (cfg.integrationBranch); null when the run has none. */
  branch: string | null;
  /** Whether the contract names a remote for the integration branch. */
  remoteConfigured: boolean;
  /** The supervisor log to read publish failures from. */
  logFile?: string | null;
  /** The last publish error recorded in state.selfImprove.publishError. */
  publishError?: string | null;
  /** The current time (the caller uses it to decide staleness; the report itself does not). */
  now: Date;
}

const GIT_MAX_BUFFER = 4 * 1024 * 1024;
const GIT_TIMEOUT_MS = 30_000;
const PUBLISH_FAILED = "publish failed";
const PUBLISH_RECOVERED = "publish recovered";

/** Run one read-only git command against the mirror; null on any failure (a view never throws). */
function git(mirrorDir: string, args: readonly string[]): string | null {
  const r = spawnSync("git", ["-c", "core.hooksPath=/dev/null", `--git-dir=${mirrorDir}`, ...args], {
    encoding: "utf8", timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (r.error || r.status !== 0) return null;
  return r.stdout.trim();
}

const revParse = (mirrorDir: string, ref: string): string | null => git(mirrorDir, ["rev-parse", "--verify", "--quiet", ref]);

const isAncestor = (mirrorDir: string, ancestor: string, descendant: string): boolean => git(mirrorDir, ["merge-base", "--is-ancestor", ancestor, descendant]) !== null;

/** The oldest commit on the branch that the remote ref does not have, as a strict ISO committer date. */
function oldestUnpublished(mirrorDir: string, remoteRef: string, branchRef: string): string | null {
  const out = git(mirrorDir, ["log", "--reverse", "--format=%cI", `${remoteRef}..${branchRef}`]);
  if (out === null) return null;
  const first = out.split("\n").find((line) => line.trim() !== "");
  return first ? first.trim() : null;
}

/**
 * The last supervisor-log line containing "publish failed": its timestamp (if any, else null) and
 * its message. A later "publish recovered" line means the last publish succeeded, so an older
 * failure is stale and the run is not currently blocked: the most recent outcome wins.
 */
function lastPublishFailure(logFile: string | null | undefined): { at: string | null; reason: string } | null {
  if (!logFile) return null;
  let text: string;
  try { text = fs.readFileSync(logFile, "utf8"); } catch { return null; }
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    if (line.includes(PUBLISH_RECOVERED)) return null;
    if (!line.includes(PUBLISH_FAILED)) continue;
    const trimmed = line.trim();
    const stamp = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)\s+/.exec(trimmed);
    return stamp ? { at: stamp[1] ?? null, reason: trimmed.slice(stamp[0].length).trim() } : { at: null, reason: trimmed };
  }
  return null;
}

/**
 * A read-only report on the run's integration branch and the remote ref the run already holds.
 * Never fetches: a ref the host has not fetched is "unknown", not "ahead".
 */
export function unpublishedReport(opts: UnpublishedOptions): UnpublishedReport {
  const { mirrorDir, branch, remoteConfigured } = opts;
  if (!branch || !remoteConfigured) return { state: "unknown", ahead: 0, since: null, reason: null };
  const branchRef = `refs/heads/${branch}`;
  const remoteRef = "refs/integration/remote";
  const local = revParse(mirrorDir, branchRef);
  if (!local) return { state: "absent", ahead: 0, since: null, reason: null };
  const remote = revParse(mirrorDir, remoteRef);
  if (!remote) return { state: "unknown", ahead: 0, since: null, reason: null };
  if (local === remote) return { state: "equal", ahead: 0, since: null, reason: null };
  if (isAncestor(mirrorDir, remote, local)) {
    const raw = git(mirrorDir, ["rev-list", "--count", `${remoteRef}..${branchRef}`]);
    const ahead = raw === null ? Number.NaN : Number.parseInt(raw, 10);
    if (!Number.isInteger(ahead) || ahead < 1) return { state: "unknown", ahead: 0, since: null, reason: null };
    const failure = lastPublishFailure(opts.logFile);
    const since = failure?.at ?? oldestUnpublished(mirrorDir, remoteRef, branchRef);
    const reason = failure?.reason ?? (opts.publishError?.trim() || null);
    return { state: "ahead", ahead, since, reason };
  }
  if (isAncestor(mirrorDir, local, remote)) return { state: "behind", ahead: 0, since: null, reason: null };
  return { state: "unknown", ahead: 0, since: null, reason: null }; // diverged: the host cannot say what is unpublished
}
