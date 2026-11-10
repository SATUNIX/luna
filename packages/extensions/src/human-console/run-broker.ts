// Run-scoped approval broker for workflow agents (E5 slice S7).
//
// A script workflow can start many agents, each a separate pi child. When one of them needs an
// approval it files a request in the human console; tool-firewall tags that request with the run id
// (PI_KIT_WORKFLOW_RUN_ID, set by the subagent runner) and the action hash (sha256 of the tool name,
// its exact input, the resolved cwd and the workspace root, so the same relative input in another
// checkout is a different action). For such requests the console applies these rules, per run:
//
//   - at most RUN_OUTSTANDING_MAX (2) approval prompts are open at once; the rest stay pending
//     (and fail closed at the requester's own deadline if nobody gets to them);
//   - requests with the same action hash are grouped: while one is on screen the others wait, and
//     the operator's answer settles them all (a high-risk "Allow once" settles only the one shown);
//   - a denial sticks: every later request with that hash in the run is denied without asking;
//   - "Allow this exact action for the rest of this run" is offered for medium actions only; a
//     high-risk action (or one whose tier is missing) never gets a run grant;
//   - once more than RUN_DISTINCT_PAUSE_AFTER (10) distinct actions have been approved, the run is
//     paused and the operator is asked, No first, whether to resume it. Each further 10 asks again.
//
// This file holds the state machine only (no UI, no files); index.ts drives it.

export const RUN_OUTSTANDING_MAX = 2;
export const RUN_DISTINCT_PAUSE_AFTER = 10;
// Bounds on what one console process remembers, so a long session cannot grow it without limit.
const MAX_RUNS = 64;
const MAX_HASHES_PER_RUN = 2000;

export const RUN_CHOICE_DENY = "Deny (for the rest of this run)";
export const RUN_CHOICE_DENY_TELL = "Deny for the rest of this run and tell the agent why…";
export const RUN_CHOICE_ALLOW_ONCE = "Allow once";
export const RUN_CHOICE_ALLOW_RUN = "Allow this exact action for the rest of this run";
export const PAUSE_CHOICE_NO = "No, keep the run paused";
export const PAUSE_CHOICE_YES = "Yes, resume the run";

// A run id, exactly as its two producers write it: the script engine's `wf-` ids; a YAML run's
// control/scope id (`<ISO with - for : and .>Z-<workflow name>-<4 hex>`, workflow.ts newRunState)
// and the digest scope id runScopeId() substitutes for an id too long for the ledger (64 hex, or
// 59-61 with a resume suffix); each may carry a resume suffix `.r2`, `.r3` ... Arbitrary text stays
// out. Kept in step with WORKFLOW_RUN_ID in packages/extensions/src/tool-firewall/index.ts.
//
// The digest scope id has no path back to the run's control id (that map lives in workflow-tools.ts):
// accepting it still groups, caps and denies stickily for that scope, but its safety-pause attempt
// names an id the workflow control registry does not hold, so the console's existing "could not be
// paused" warning reports it. Its group state also restarts at the first resume, because the suffix
// shortens the digest and the resumed scope is a different id. That is no worse than the base, where
// such a run was tagged not at all; a run id short enough to stay a plain control id keeps its group
// across resumes.
export const RUN_ID_PATTERN = /^(?:wf-[a-z0-9-]{1,60}|\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-z][a-z0-9_-]{0,40}-[a-f0-9]{4}|[a-f0-9]{59,64})(?:\.r(?:[2-9]|[1-9][0-9]+))?$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
// The step label a workflow child's runner sets (PI_KIT_WORKFLOW_STEP): a role name and an optional
// number. Validated before it can reach a card; the tool-firewall checks the env with the same rule.
const STEP_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,40}$/;

/** The run a scope id belongs to: a resumed scope (`.r2`, `.r3` ...) groups with its control id. */
export function runGroupId(runId: string): string {
  return runId.replace(/\.r(?:[2-9]|[1-9][0-9]+)$/, "");
}

/** The menu for a run request, No first. High-risk actions get no run grant. */
export function runChoices(high: boolean): string[] {
  return high ? [RUN_CHOICE_DENY, RUN_CHOICE_DENY_TELL, RUN_CHOICE_ALLOW_ONCE] : [RUN_CHOICE_DENY, RUN_CHOICE_DENY_TELL, RUN_CHOICE_ALLOW_ONCE, RUN_CHOICE_ALLOW_RUN];
}

export interface RunRequest {
  id: string;
  /** The run's control id: a resumed scope's `.r<n>` suffix is stripped (runGroupId). */
  runId: string;
  hash: string;
  /** True unless the request says it is medium: an unknown tier is treated as high. */
  high: boolean;
  /** The workflow step's validated label (PI_KIT_WORKFLOW_STEP), when the child set one. */
  step?: string;
}

/** The run fields of a pending approval, or null when it is not a well-formed workflow-run request. */
export function runRequestOf(request: Record<string, unknown>): RunRequest | null {
  const { id, workflowRun, actionHash, riskClass, workflowStep } = request;
  if (typeof id !== "string" || typeof workflowRun !== "string" || typeof actionHash !== "string") return null;
  if (!RUN_ID_PATTERN.test(workflowRun) || !HASH_PATTERN.test(actionHash)) return null;
  const step = typeof workflowStep === "string" && STEP_PATTERN.test(workflowStep) ? workflowStep : undefined;
  return { id, runId: runGroupId(workflowRun), hash: actionHash, high: riskClass !== "medium", ...(step === undefined ? {} : { step }) };
}

export type Offer =
  | { kind: "resolve"; approved: boolean; reason: "sticky_deny" | "run_grant" }
  | { kind: "prompt" }
  | { kind: "wait"; reason: "grouped" | "outstanding" | "pause_question" };

interface RunState {
  denied: Set<string>;
  granted: Set<string>;
  approved: Set<string>;
  /** Open prompts: action hash -> ids of the requests waiting on that prompt (the shown one excluded). */
  open: Map<string, Set<string>>;
  pauseAt: number;
  asking: boolean;
}

export interface Settled {
  /** Ids of grouped requests that take the same answer now. */
  members: string[];
  /** True when this approval took the run past its distinct-approval threshold. */
  pause: boolean;
  distinct: number;
}

export class RunApprovalBroker {
  private readonly runs = new Map<string, RunState>();

  private state(runId: string): RunState {
    let s = this.runs.get(runId);
    if (!s) {
      if (this.runs.size >= MAX_RUNS) {
        const oldest = this.runs.keys().next().value;
        if (oldest !== undefined) this.runs.delete(oldest);
      }
      s = { denied: new Set(), granted: new Set(), approved: new Set(), open: new Map(), pauseAt: RUN_DISTINCT_PAUSE_AFTER, asking: false };
      this.runs.set(runId, s);
    }
    return s;
  }

  /** What to do with a pending request now. "prompt" reserves one of the run's prompt slots. */
  offer(req: RunRequest): Offer {
    const s = this.state(req.runId);
    if (s.denied.has(req.hash)) return { kind: "resolve", approved: false, reason: "sticky_deny" };
    if (!req.high && s.granted.has(req.hash)) return { kind: "resolve", approved: true, reason: "run_grant" };
    const group = s.open.get(req.hash);
    if (group) {
      group.add(req.id);
      return { kind: "wait", reason: "grouped" };
    }
    if (s.asking) return { kind: "wait", reason: "pause_question" };
    if (s.open.size >= RUN_OUTSTANDING_MAX) return { kind: "wait", reason: "outstanding" };
    s.open.set(req.hash, new Set());
    return { kind: "prompt" };
  }

  /** A grouped request went away (its requester gave up): it no longer takes the group's answer. */
  leave(req: RunRequest): void {
    this.runs.get(req.runId)?.open.get(req.hash)?.delete(req.id);
  }

  /** The prompt for `req` closed without an operator answer: free the slot, decide nothing. */
  abandon(req: RunRequest): void {
    this.runs.get(req.runId)?.open.delete(req.hash);
  }

  /** The operator answered the prompt for `req`. */
  settle(req: RunRequest, decision: { approved: boolean; runGrant: boolean }): Settled {
    const s = this.state(req.runId);
    const group = [...(s.open.get(req.hash) ?? [])].filter((id) => id !== req.id);
    s.open.delete(req.hash);
    if (!decision.approved) {
      if (s.denied.size < MAX_HASHES_PER_RUN) s.denied.add(req.hash);
      s.granted.delete(req.hash);
      return { members: group, pause: false, distinct: s.approved.size };
    }
    if (decision.runGrant && !req.high && s.granted.size < MAX_HASHES_PER_RUN) s.granted.add(req.hash);
    if (s.approved.size < MAX_HASHES_PER_RUN) s.approved.add(req.hash);
    const pause = s.approved.size > s.pauseAt && !s.asking;
    if (pause) s.asking = true;
    // A high-risk "Allow once" approves only the request that was shown; the others ask again.
    return { members: req.high ? [] : group, pause, distinct: s.approved.size };
  }

  /** The pause question was answered (or dismissed): prompts for the run may open again. */
  pauseAnswered(runId: string): void {
    const s = this.state(runId);
    s.asking = false;
    s.pauseAt = s.approved.size + RUN_DISTINCT_PAUSE_AFTER;
  }

  clear(): void {
    this.runs.clear();
  }
}
