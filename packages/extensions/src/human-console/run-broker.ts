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

export const RUN_ID_PATTERN = /^wf-[a-z0-9-]{1,60}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

/** The menu for a run request, No first. High-risk actions get no run grant. */
export function runChoices(high: boolean): string[] {
  return high ? [RUN_CHOICE_DENY, RUN_CHOICE_DENY_TELL, RUN_CHOICE_ALLOW_ONCE] : [RUN_CHOICE_DENY, RUN_CHOICE_DENY_TELL, RUN_CHOICE_ALLOW_ONCE, RUN_CHOICE_ALLOW_RUN];
}

export interface RunRequest {
  id: string;
  runId: string;
  hash: string;
  /** True unless the request says it is medium: an unknown tier is treated as high. */
  high: boolean;
}

/** The run fields of a pending approval, or null when it is not a well-formed workflow-run request. */
export function runRequestOf(request: Record<string, unknown>): RunRequest | null {
  const { id, workflowRun, actionHash, riskClass } = request;
  if (typeof id !== "string" || typeof workflowRun !== "string" || typeof actionHash !== "string") return null;
  if (!RUN_ID_PATTERN.test(workflowRun) || !HASH_PATTERN.test(actionHash)) return null;
  return { id, runId: workflowRun, hash: actionHash, high: riskClass !== "medium" };
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
