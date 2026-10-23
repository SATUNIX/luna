// Promotion: moving the run's result outside the run directory. It is separate from in-zone
// deployment and from the worker: the worker never promotes, and nothing is pushed or written
// anywhere the contract's promotion policy and destinations do not name.
//
//   none          nothing leaves the run directory (use `export`)
//   local-branch  fast-forward a branch in a LOCAL repository; no remote is contacted
//   push          fast-forward push to a listed remote branch; needs the operator's approval
//                 (`promote`) unless promotion.requiresOperatorApproval is false
//
// Every step is idempotent and keyed in state.promotion: a key is recorded as started before
// the action and as done after it, and a run resumed after a crash checks the destination's
// actual ref before repeating anything, so a resume never publishes twice.
import type { HostRepo } from "./hostrepo.ts";

/** One promotion.destinations[] entry of the resolved contract. Any kind but local-branch is a git remote. */
export interface PromotionDestination {
  readonly kind: string;
  readonly branch: string;
  /** local-branch: the repository to fast-forward (default: inputs.repository.path). */
  readonly repo?: string | null | undefined;
  /** git-remote: where to push. */
  readonly url?: string | undefined;
  /** git-remote: push the run's tags too. */
  readonly tags?: boolean | undefined;
}

/** The fields of the resolved contract (lib/contract.ts) promotion reads. */
export interface PromotionContract {
  readonly promotion: {
    readonly policy: string;
    readonly requiresOperatorApproval?: boolean | undefined;
    readonly destinations: readonly PromotionDestination[];
  };
  readonly inputs: { readonly repository?: { readonly path?: string | null | undefined } | null | undefined };
}

/** One concrete promotion action, keyed so a resumed run never repeats it. */
export type PromotionTarget =
  | { key: string; kind: "local-branch"; repo: string | null; branch: string; sha: string; description: string }
  | { key: string; kind: "git-remote"; url: string; branch: string; tags: boolean | undefined; sha: string; description: string };

/** state.promotion as runPromotions reads and records it. */
export interface PromotionState {
  done: Record<string, true | { at: string; result: string }>;
  started?: Record<string, string>;
}

export type PromotionStatus = "none" | "awaiting_approval" | "done" | "failed";

export interface PromotionRun {
  status: PromotionStatus;
  done: string[];
  error?: string;
  targets: PromotionTarget[];
}

export interface RunPromotionsOptions {
  repo: Pick<HostRepo, "git" | "remoteRefSha" | "promoteLocal" | "promotePush">;
  contract: PromotionContract;
  cfg?: { readonly integrationRemote?: string | null | undefined } | null | undefined;
  state: { readonly promotion: PromotionState };
  sha: string;
  approved?: boolean | undefined;
  targets?: PromotionTarget[] | null | undefined;
  /** Persists one state update before the next step. */
  save: (update: (s: { promotion: PromotionState }) => void) => void;
  log?: ((line: string) => void) | undefined;
}

/** The concrete actions for a result commit. */
export function promotionTargets(contract: PromotionContract, cfg: RunPromotionsOptions["cfg"], sha: string): PromotionTarget[] {
  const p = contract.promotion;
  if (p.policy === "none") return [];
  return p.destinations.map((d) => {
    if (d.kind === "local-branch") {
      const repo = d.repo ?? contract.inputs.repository?.path ?? null;
      return { key: `local-branch|${repo ?? "mirror"}|${d.branch}|${sha}`, kind: "local-branch", repo, branch: d.branch, sha, description: repo ? `fast-forward branch ${d.branch} in ${repo}` : `branch ${d.branch} in the run's own mirror` };
    }
    // cfg.integrationRemote is derived from this very destination (lib/runcfg.ts); it is the one place the runtime may point at a resolved address.
    const url = cfg?.integrationRemote && p.destinations.filter((x) => x.kind === "git-remote").length === 1 ? cfg.integrationRemote : d.url;
    // The contract requires a url for every git remote; String() keeps the old text if one were missing.
    const where = String(url);
    return { key: `git-remote|${where}|${d.branch}|${sha}`, kind: "git-remote", url: where, branch: d.branch, tags: d.tags, sha, description: `push ${d.branch}${d.tags ? " and the run's tags" : ""} to ${where} (fast-forward only)` };
  });
}

/** Where the destination stands, without changing anything: does it already hold the sha? */
function alreadyThere(repo: RunPromotionsOptions["repo"], target: PromotionTarget): boolean {
  try {
    if (target.kind === "local-branch") return target.repo ? repo.remoteRefSha(target.repo, `refs/heads/${target.branch}`) === target.sha : repo.git()(["rev-parse", "--verify", "--quiet", `refs/heads/${target.branch}`], { allowFail: true }) === target.sha;
    return repo.remoteRefSha(target.url, `refs/heads/${target.branch}`) === target.sha;
  } catch { return false; }
}

/**
 * Carry out (or report) the promotions for `sha`. It changes state only through `save(fn)` (a
 * state updater, so the caller persists each step before the next one) and by marking a step
 * done in the `state` it was given.
 */
export function runPromotions({ repo, contract, cfg, state, sha, approved = false, targets: given, save, log = () => {} }: RunPromotionsOptions): PromotionRun {
  const targets = given ?? promotionTargets(contract, cfg, sha);
  if (!targets.length) return { status: "none", done: [], targets };
  if (contract.promotion.requiresOperatorApproval && !approved) return { status: "awaiting_approval", done: [], targets };
  const done: string[] = [];
  for (const t of targets) {
    if (state.promotion.done?.[t.key]) { done.push(t.key); continue; }
    if (state.promotion.started?.[t.key] && alreadyThere(repo, t)) {
      save((s) => { s.promotion.done[t.key] = { at: new Date().toISOString(), result: "found in place after an interrupted attempt" }; });
      state.promotion.done[t.key] = true; done.push(t.key);
      log(`promotion ${t.description}: already in place (a previous attempt finished)`);
      continue;
    }
    save((s) => { s.promotion.started = { ...(s.promotion.started ?? {}), [t.key]: new Date().toISOString() }; });
    try {
      const result = t.kind === "local-branch" ? (t.repo ? repo.promoteLocal(t.repo, t.branch, t.sha) : { status: "in the run's mirror" }) : repo.promotePush(t.url, t.branch, t.sha, { tags: t.tags });
      save((s) => { s.promotion.done[t.key] = { at: new Date().toISOString(), result: result.status }; });
      state.promotion.done[t.key] = true; done.push(t.key);
      log(`promotion ${t.description}: ${result.status}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`promotion ${t.description} failed: ${message}`);
      return { status: "failed", done, error: message, targets };
    }
  }
  return { status: "done", done, targets };
}
