// The land half of the dispatch lifecycle: a reviewed cycle commit is merged into the run's
// branch only when a PASS verdict from another session names it, the branch has not moved since
// that verdict, no protected path is touched, and the product's checks are green both in a clean
// temporary clone and again on the merged branch. When the second run is red, the merge is reset
// so the trunk is never left red. One land runs at a time.
//
// Everything that touches the filesystem or a process is injected (`git` and `runChecks`), so the
// decision is a pure function of those answers and the request. `createLandLock` supplies the
// one-at-a-time guard; tests use it too. The CLI verb and the workflow step are later ports.
// Pinned by tests/autonomy-land-smoke.ts.

/** The result of one git invocation, the shape of `spawnSync("git", ...)` minus the noise. */
export interface LandGitResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Run git with an argument array (never a shell) in `cwd`. */
export type LandGit = (args: readonly string[], cwd: string) => LandGitResult;

/** What the product's check-all said for one checkout. */
export interface LandCheckResult {
  readonly ok: boolean;
  readonly detail?: string | undefined;
}

/** Run the product's checks in `cwd`; red means no land. */
export type LandCheckRunner = (cwd: string) => LandCheckResult | Promise<LandCheckResult>;

/** One land at a time, shared by every caller of `landReviewed` (or by the future CLI/workflow callers). */
export interface LandLock {
  tryAcquire(): boolean;
  release(): void;
}

/** A process-local lock. A second `landReviewed` that starts while this one is held is refused. */
export function createLandLock(): LandLock {
  let held = false;
  return {
    tryAcquire() { if (held) return false; held = true; return true; },
    release() { held = false; },
  };
}

/** A reviewer's PASS verdict, tied to the submitted commit and to the branch tip it was judged against. */
export interface LandVerdict {
  readonly verdict: "PASS";
  /** The reviewed commit; it must equal the request's `reviewedSha`. */
  readonly sha: string;
  /** The reviewing session (a separate reviewer, never the author). */
  readonly reviewer: string;
  /** `refs/heads/<branch>` when the verdict was recorded; a moved tip makes the verdict stale. */
  readonly tip: string;
}

export interface LandRequest {
  /** The repository that holds the run's branch (a working tree, or a bare mirror with a worktree). */
  readonly repo: string;
  /** A path that does not exist yet: the clean temporary clone the first check runs in. */
  readonly clone: string;
  readonly branch: string;
  readonly reviewedSha: string;
  /** The session that wrote the reviewed commit; a verdict from the same session is a self-review. */
  readonly author: string;
  readonly verdict: LandVerdict;
  readonly git: LandGit;
  readonly runChecks: LandCheckRunner;
  readonly lock: LandLock;
  /** Operator/run additions to `DEFAULT_LAND_PROTECTED` (each matches a repo-relative path). */
  readonly protectedPaths?: readonly RegExp[] | undefined;
  readonly log?: ((line: string) => void) | undefined;
}

export type LandRefusalCode =
  | "busy"
  | "invalid_sha"
  | "no_pass"
  | "self_review"
  | "verdict_mismatch"
  | "branch_moved"
  | "not_a_commit"
  | "clone_failed"
  | "merge_conflict"
  | "checks_failed"
  | "second_checks_failed"
  | "reset_failed"
  | "land_failed";

export type LandResult =
  | { readonly outcome: "landed"; readonly from: string; readonly to: string; readonly detail: string }
  | { readonly outcome: "refused"; readonly code: LandRefusalCode; readonly message: string }
  | { readonly outcome: "owner_inbox"; readonly code: "protected_path"; readonly message: string; readonly paths: readonly string[] };

/**
 * Paths no unattended land may touch: service units, the scripts they run, the control surface,
 * the shared library, the gate and the dispatcher/land machinery themselves. They go to the
 * owner's inbox instead. A run may add its own patterns through `protectedPaths`.
 */
export const DEFAULT_LAND_PROTECTED: readonly RegExp[] = [
  /\.(service|timer|socket|target)$/,
  /(^|\/)(scripts?|bin)\/[^/]+\.(sh|bash|py)$/,
  /(^|\/)(gate|check-all|prepush-scan|leak-scan|wiring|check-map)[^/]*$/,
  /^packages\/autonomy\/lib\/(board|dispatch|land|risk|review|acceptance|contract|boundary|manager|engine|runcfg|worker-env|promotion|hostrepo|runlock|gate-slots|attempts|triggers|lifecycle)\.ts$/,
  /^packages\/autonomy\/lib\/templates\//,
  /^packages\/autonomy\/(cli|supervisor|relay)\.ts$/,
  /^packages\/core\/(lib\/|policies\/)/,
  /^packages\/extensions\/src\/(tool-firewall|secret-guard|delegation-guard|protected-paths)\//,
  /^packages\/extensions\/third_party\/protected-paths\//,
  /^packages\/kit\/(profiles|agents|workflows)\//,
  /(^|\/)package\.json$/,
  /(^|\/)(credentials?|secrets?)[^/]*\.([cm]?[jt]s|json|sh)$|(^|\/)\.env(\.|$)/,
];

const SHA = /^[0-9a-f]{40}$/;
const IDENTITY = ["-c", "user.name=Luna Land", "-c", "user.email=land@luna.invalid"] as const;

const refused = (code: LandRefusalCode, message: string): LandResult => ({ outcome: "refused", code, message });

function gitOut(git: LandGit, cwd: string, args: readonly string[]): string | null {
  const r = git(args, cwd);
  return r.status === 0 ? r.stdout.trim() : null;
}

function shaAt(git: LandGit, cwd: string, ref: string): string | null {
  const out = gitOut(git, cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  return out !== null && SHA.test(out) ? out : null;
}

function changedPaths(git: LandGit, cwd: string, from: string, to: string): string[] | null {
  const out = gitOut(git, cwd, ["diff", "--name-only", "--no-renames", from, to]);
  return out === null ? null : out.split("\n").map((line) => line.trim()).filter((line) => line !== "");
}

function mergeArgs(sha: string): string[] {
  return [...IDENTITY, "merge", "--no-ff", "--no-edit", sha];
}

function abortMerge(git: LandGit, cwd: string): void {
  git(["merge", "--abort"], cwd);
}

/**
 * Land `reviewedSha` into `branch`, or refuse with the reason. The branch is changed only after
 * the clean-clone check is green, and put back when the post-merge check is red.
 */
export async function landReviewed(request: LandRequest): Promise<LandResult> {
  const { repo, clone, branch, reviewedSha, author, verdict, git, runChecks, lock, protectedPaths = [], log = () => {} } = request;
  if (!lock.tryAcquire()) return refused("busy", "another land is in progress; one land runs at a time");
  try {
    if (!SHA.test(reviewedSha)) return refused("invalid_sha", `reviewed sha ${JSON.stringify(reviewedSha.slice(0, 64))} is not a 40-character commit`);
    if (verdict.verdict !== "PASS") return refused("no_pass", `the review verdict is ${String(verdict.verdict)}, not PASS`);
    if (verdict.reviewer.trim() === "" || verdict.reviewer === author) return refused("self_review", `the PASS verdict is from the author ${JSON.stringify(author)}; a separate reviewer must judge it`);
    if (verdict.sha !== reviewedSha) return refused("verdict_mismatch", `the PASS verdict names ${verdict.sha}, not the submitted ${reviewedSha}`);
    if (!SHA.test(verdict.tip)) return refused("verdict_mismatch", `the verdict's branch tip ${JSON.stringify(verdict.tip.slice(0, 64))} is not a 40-character commit`);

    const tip = shaAt(git, repo, `refs/heads/${branch}`);
    if (tip === null) return refused("land_failed", `branch ${JSON.stringify(branch)} does not resolve to a commit in ${JSON.stringify(repo)}`);
    if (tip !== verdict.tip) return refused("branch_moved", `branch ${branch} moved from ${verdict.tip} to ${tip} after the verdict; review the new tip`);
    if (shaAt(git, repo, reviewedSha) === null) return refused("not_a_commit", `reviewed sha ${reviewedSha} is not a commit in the repository`);

    const paths = changedPaths(git, repo, verdict.tip, reviewedSha);
    if (paths === null) return refused("land_failed", `cannot diff ${verdict.tip}..${reviewedSha}`);
    const hits = paths.filter((file) => [...DEFAULT_LAND_PROTECTED, ...protectedPaths].some((re) => re.test(file)));
    if (hits.length) return { outcome: "owner_inbox", code: "protected_path", message: `the reviewed commit changes ${hits.length} protected path(s); the owner decides these`, paths: hits };

    const cloned = git(["clone", "--quiet", "--no-hardlinks", repo, clone], repo);
    if (cloned.status !== 0) return refused("clone_failed", `cannot clone ${JSON.stringify(repo)}: ${cloned.stderr.trim().slice(0, 300)}`);
    const checkout = git(["checkout", "--quiet", branch], clone);
    if (checkout.status !== 0) return refused("clone_failed", `cannot check out ${branch} in the clone: ${checkout.stderr.trim().slice(0, 300)}`);
    const cloneMerge = git(mergeArgs(reviewedSha), clone);
    if (cloneMerge.status !== 0) {
      abortMerge(git, clone);
      return refused("merge_conflict", `merging ${reviewedSha} into the clone failed: ${cloneMerge.stderr.trim().slice(0, 300)}`);
    }
    log(`land: ${reviewedSha} merged into ${branch} in the clean clone; running checks`);
    const first = await runChecks(clone);
    if (!first.ok) return refused("checks_failed", `checks are red on the merged clone${first.detail ? `: ${first.detail}` : ""}; the branch was not touched`);

    // Re-read the tip after the clone check: a commit that arrived meanwhile makes the verdict stale.
    const beforeLand = shaAt(git, repo, `refs/heads/${branch}`);
    if (beforeLand !== tip) return refused("branch_moved", `branch ${branch} moved from ${tip} to ${beforeLand ?? "nothing"} while the clone was checked`);

    const landed = git(mergeArgs(reviewedSha), repo);
    if (landed.status !== 0) {
      abortMerge(git, repo);
      const after = shaAt(git, repo, `refs/heads/${branch}`);
      return refused("merge_conflict", `merging ${reviewedSha} into ${branch} failed: ${landed.stderr.trim().slice(0, 300)}${after === tip ? "" : `; the branch is now ${after ?? "unreadable"}`}`);
    }
    const merged = shaAt(git, repo, "HEAD");
    log(`land: ${reviewedSha} merged into ${branch}; re-running checks on ${merged ?? "the merged branch"}`);
    const second = await runChecks(repo);
    if (!second.ok) {
      const reset = git(["reset", "--hard", tip], repo);
      const after = reset.status === 0 ? shaAt(git, repo, "HEAD") : null;
      if (after !== tip) return refused("reset_failed", `checks are red after the merge and the reset did not restore ${tip} (HEAD is ${after ?? "unreadable"}); the branch may be red`);
      return refused("second_checks_failed", `checks are red on the merged ${branch}${second.detail ? `: ${second.detail}` : ""}; the merge was reset and the branch is unchanged`);
    }
    if (merged === null) return refused("land_failed", `the merge left no readable HEAD on ${branch}`);
    return { outcome: "landed", from: tip, to: merged, detail: `merged ${reviewedSha} into ${branch} and the checks are green` };
  } catch (error) {
    return refused("land_failed", error instanceof Error ? error.message : String(error));
  } finally {
    lock.release();
  }
}
