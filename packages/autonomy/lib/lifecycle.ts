// The run lifecycle: explicit states, an explicit legal-transition table and the shape of
// state.json (the one authoritative record of a run). Pure functions over plain objects; the
// store (lib/store.ts) persists them and only the supervisor that holds the run lock writes.
//
// Outcomes are never conflated:
//   succeeded         every required acceptance check passed in a trusted evaluation, and the
//                     required independent review approved
//   failed            the run cannot or must not continue; `outcome.reason` says why
//                     (boundary_violation, recovery_exhausted, step_attempts_exhausted, ...)
//   cancelled         an operator ended it
//   budget_exhausted  money, steps or active minutes ran out (reason total_usd | max_steps | max_minutes)
//   blocked           NOT terminal: a genuinely external blocker or an approval/answer is needed
import { clone, isPlainObject } from "./fsutil.ts";
import type { CycleEntry } from "./templates/self-improve.ts";
import type { Budget, ContractDraft, EffortChoice, PromotionPolicy, RecoverySettings, RunContract, TemplateId } from "./contract.ts";

export const STATE_SCHEMA_VERSION = 1;

export const STATES = ["setup", "ready", "running", "paused", "blocked", "recovering", "succeeded", "failed", "cancelled", "budget_exhausted"] as const;
export type RunStatus = (typeof STATES)[number];
export const TERMINAL: ReadonlySet<string> = new Set<RunStatus>(["succeeded", "failed", "cancelled"]);

/** The legal transitions. budget_exhausted is not terminal only for `reconfigure`. */
export const TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  setup: ["ready", "failed", "cancelled"],
  ready: ["running", "paused", "failed", "cancelled"],
  running: ["paused", "blocked", "recovering", "succeeded", "failed", "cancelled", "budget_exhausted"],
  paused: ["running", "failed", "cancelled"],
  blocked: ["running", "paused", "failed", "cancelled"],
  recovering: ["running", "blocked", "paused", "failed", "cancelled", "budget_exhausted"],
  budget_exhausted: ["paused"],
  succeeded: [],
  failed: [],
  cancelled: [],
};

export const BUDGET_REASONS = ["total_usd", "max_steps", "max_minutes"] as const;
export type BudgetReason = (typeof BUDGET_REASONS)[number];
export const FAILURE_REASONS = ["boundary_violation", "recovery_exhausted", "step_attempts_exhausted", "review_rejected", "setup_failed", "worker_unavailable", "lock_lost", "internal_error", "operator_failed", "promotion_failed", "integration_diverged", "final_gate_red"] as const;
export type FailureReason = (typeof FAILURE_REASONS)[number];

export const isRunStatus = (value: unknown): value is RunStatus => (STATES as readonly unknown[]).includes(value);

// --- state.json --------------------------------------------------------------------------------

/** What the operator is asked (an approval or a question from the worker, or an external stop). */
export interface BlockerRecord {
  kind: "approval" | "question" | "external";
  id: string;
  method: string;
  question: string;
  options?: string[];
}

/** The blocker a blocked run waits on. */
export type RunBlocker = BlockerRecord & { since: string };

/** How a run ended (or why its budget ran out). */
export interface RunOutcome {
  status: "succeeded" | "failed" | "cancelled" | "budget_exhausted";
  reason: string;
  detail?: string;
  at: string;
}

export interface HistoryEntry {
  at: string;
  from: RunStatus | null;
  to: RunStatus;
  reason?: string | undefined;
  by: string;
  detail?: string;
}

/** One item of the supervisor's task board (from objective.backlog). */
export interface TaskItem {
  id: string;
  title: string;
  checks: string[];
  status: "todo" | "in_progress" | "done";
  evidence: string[];
  updatedAt: string | null;
}

/** One check's result as state.json keeps it (the tail stays in the evidence file). */
export interface CheckResultSummary {
  id: string;
  required: boolean;
  pass: boolean;
  exitCode: number;
  timedOut: boolean;
  seconds: number;
  /** The evidence file, relative to the run directory. */
  evidence: string;
}

/** A trusted acceptance evaluation, as state.json keeps it. */
export interface EvaluationSummary {
  sha: string;
  step: number;
  at: string;
  allRequiredPass: boolean;
  results: CheckResultSummary[];
}

export interface AcceptanceReview {
  required: boolean;
  status: "pending" | "skipped" | "approved" | "rejected";
  verdict?: string;
  reason?: string;
  concerns?: string[];
  sha?: string;
  at?: string;
  attempts?: number;
  note?: string;
}

export interface AcceptanceState {
  latest: EvaluationSummary | null;
  history: Array<{ step: number; sha: string; allRequiredPass: boolean }>;
  review: AcceptanceReview;
}

export interface WorkerRecord {
  container: string;
  attempt: number;
  step: number;
  startedAt: string;
}

export interface Artefact {
  kind: string;
  path: string;
  step: number;
  at: string;
}

export interface Usage {
  usd: number;
  minutes: number;
  steps: number;
}

/** Recovery counters (lib/recovery.ts). */
export interface RecoveryState {
  stalls: number;
  softNudgesUsed: number;
  hardRestartsUsed: number;
  totals: { softNudges: number; hardRestarts: number };
  attemptsByTarget: Record<string, number>;
  violations: number;
  lastFingerprint: string | null;
  passingBefore: string[];
  lastHead?: string | null;
}

/** How a run's boundary was authorised (lib/boundary.ts decideStart, or the CLI). */
export interface RunAuthorisation {
  boundaryDigest: string;
  by: string | null;
  at: string | null;
  via: string;
}

export interface PromotionState {
  policy: PromotionPolicy;
  status: string;
  /** Finished promotion keys: a record on disk, `true` once handled in this process. */
  done: Record<string, { at: string; result: string } | true>;
  started?: Record<string, string>;
  error?: string | null;
  targets?: Array<{ key: string; description: string }>;
}

export interface Reconfiguration {
  at: string;
  by: string;
  refused?: string[];
  before?: LimitsSnapshot;
  after?: LimitsSnapshot;
  reason?: string | null;
}

/** The effort and limits a reconfiguration changes. */
export interface LimitsSnapshot {
  effort: EffortChoice;
  budget: Budget;
  recovery: RecoverySettings;
}

export interface SetupState {
  preparedAt?: string;
  base?: string | null;
  boundaryVerifiedAt?: string;
  boundaryChecks?: number;
}

/** The operator's answer to the question a blocked run waited on, kept for the next session's briefing (lib/engine.ts). */
export interface PendingAnswer {
  text: string;
  question?: string;
  kind?: BlockerRecord["kind"];
  approved?: boolean;
  at: string;
}

/** The self-improve template's own record (lib/templates/self-improve.ts). */
export interface SelfImproveState {
  history: CycleEntry[];
  merged: number;
  lastGoodSha: string;
  seedSha: string;
  current: { n: number; startedAt: string; startSha: string } | null;
  /** The published refs state (gitmirror publish), so an unchanged state is not pushed again. */
  lastPushed: string | null;
  publishError?: string | null;
  lastSyncError?: string | null;
}

/** state.json: the one authoritative record of a run. */
export interface RunState {
  schemaVersion: typeof STATE_SCHEMA_VERSION;
  run: string;
  template: TemplateId;
  contractDigest: string;
  boundaryDigest: string;
  authorisation: RunAuthorisation;
  status: RunStatus;
  phase: "work" | "acceptance" | "review" | "promotion" | null;
  blocker: RunBlocker | null;
  outcome: RunOutcome | null;
  step: number;
  tasks: TaskItem[];
  acceptance: AcceptanceState;
  worker: WorkerRecord | null;
  artefacts: Artefact[];
  usage: Usage;
  recovery: RecoveryState;
  effort: EffortChoice;
  limits: { budget: Budget; recovery: RecoverySettings };
  promotion: PromotionState;
  pendingQuestions: Array<BlockerRecord & { at: string }>;
  reconfigurations: Reconfiguration[];
  history: HistoryEntry[];
  createdAt: string;
  updatedAt: string;
  sessions?: number;
  steers?: Array<{ at: string; message: string }>;
  setup?: SetupState;
  ui?: { autoAnswered: number; blocked: number };
  pendingAnswer?: PendingAnswer | null;
  /** The last fatal error the supervisor recorded before it stopped (the run stays resumable). */
  lastError?: string;
  selfImprove?: SelfImproveState;
  /** Generations (Memento mode), when the contract enables them and the Memento allowance permits more than one (engine.ts). */
  generations?: GenerationState;
  /** How many generations a contract that enables them was allowed, decided once per run (engine.ts mementoDecision). */
  memento?: MementoDecision;
}

/** state.memento: the contract's generations capped to the Memento allowance (docs/autonomy.md, "Generations"). */
export interface MementoDecision {
  /** What the contract asked for (generations.maxGenerations). */
  requested: number;
  /** The Memento allowance for the run's worker model at its effort tier (0: not opted in, or not allowed). */
  allowance: number;
  /** Generations the run uses: the lower of the two, and 1 (a single generation) when the allowance is 0. */
  maxGenerations: number;
  /** Why, in words: the allowance's own reason. */
  reason: string;
  /** The opt-in key, profile and tier it was worked out for. */
  model: string | null;
  profile: string | null;
  tier: string;
  at: string;
}

/** One finished generation, as state.json records it. */
export interface GenerationRecord {
  generation: number;
  at: string;
  /** Which box ended it. */
  box: "minutes" | "usd";
  /** Whether a notebook was appended; the problems when it was not. */
  notebook: boolean;
  problems: string[];
  /** The recovery decision for the generation's last step. */
  action: string;
  /** The next generation started from the accepted head (resetOnNoProgress). */
  reset: boolean;
}

/** state.generations: where the current generation's box started, and the finished ones. */
export interface GenerationState {
  /** The current generation, from 1. */
  current: number;
  /** usage.minutes and usage.usd when it started. */
  startMinutes: number;
  startUsd: number;
  /** The accepted head when it started. */
  startHead: string | null;
  history: GenerationRecord[];
  /** The next worker starts with its workspace reset to the pushed branch (resetOnNoProgress). */
  resetPending?: boolean;
  /** The last step judged in this generation without ending it, and its recovery action (a worker that crashed or exited). */
  judged?: { step: number; action: string };
}

/**
 * Enough of a parsed state.json to treat it as a RunState: its version, run id and status. Only the
 * supervisor holding the run lock writes the file, so it is not checked field by field.
 */
export function isRunState(s: unknown): s is RunState {
  return isPlainObject(s) && s.schemaVersion === STATE_SCHEMA_VERSION && typeof s.run === "string" && isRunStatus(s.status);
}

export class IllegalTransition extends Error {
  readonly from: string;
  readonly to: string;
  readonly code = "illegal_transition";
  constructor(from: string, to: string, why?: string) {
    super(`illegal transition ${from} -> ${to}${why ? `: ${why}` : ""}`);
    this.from = from;
    this.to = to;
  }
}

export const isTerminal = (status: string): boolean => TERMINAL.has(status);
export const canTransition = (from: string, to: string): boolean => (isRunStatus(from) ? (TRANSITIONS[from] as readonly string[]) : []).includes(to);

/** Why a run may not be marked succeeded yet, or null. */
export function evidenceProblem(state: { acceptance?: { latest: Pick<EvaluationSummary, "allRequiredPass"> | null; review?: Pick<AcceptanceReview, "required" | "status"> } }): string | null {
  const latest = state.acceptance?.latest;
  if (!latest) return "no acceptance evaluation has been recorded";
  if (!latest.allRequiredPass) return "the latest trusted evaluation has failing required checks";
  const review = state.acceptance?.review;
  if (review?.required && review.status !== "approved") return `independent review is required and its status is ${review.status}`;
  return null;
}

/**
 * Move a state to `to`. Returns a new state; throws IllegalTransition on anything not in the
 * table or failing a guard. `info`: { reason, by, at, detail, blocker }.
 */
export interface TransitionInfo {
  reason?: string;
  by?: string;
  at?: string;
  detail?: string;
  blocker?: BlockerRecord;
}

export function transition(state: RunState, to: string, info: TransitionInfo = {}): RunState {
  const from = state.status;
  if (!isRunStatus(to)) throw new IllegalTransition(from, to, "unknown state");
  if (!canTransition(from, to)) throw new IllegalTransition(from, to, isTerminal(from) ? `${from} is terminal` : undefined);
  const reason = info.reason ?? "";
  if (["failed", "cancelled", "budget_exhausted", "succeeded", "blocked"].includes(to) && !reason) throw new IllegalTransition(from, to, "a reason is required");
  if (to === "budget_exhausted" && !(BUDGET_REASONS as readonly string[]).includes(reason)) throw new IllegalTransition(from, to, `reason must be one of ${BUDGET_REASONS.join(", ")}`);
  if (to === "failed" && !(FAILURE_REASONS as readonly string[]).includes(reason)) throw new IllegalTransition(from, to, `reason must be one of ${FAILURE_REASONS.join(", ")}`);
  if (to === "succeeded") { const problem = evidenceProblem(state); if (problem) throw new IllegalTransition(from, to, problem); }
  if (from === "budget_exhausted" && info.by !== "reconfigure") throw new IllegalTransition(from, to, "an exhausted budget is only lifted by an explicit `reconfigure`");
  if (to === "blocked" && !info.blocker) throw new IllegalTransition(from, to, "a blocker record is required");
  const at = info.at ?? new Date().toISOString();
  const next = clone(state);
  next.status = to;
  next.updatedAt = at;
  next.blocker = to === "blocked" && info.blocker ? { ...info.blocker, since: at } : null;
  if (to === "succeeded" || to === "failed" || to === "cancelled" || to === "budget_exhausted") next.outcome = { status: to, reason, ...(info.detail ? { detail: info.detail.slice(0, 2000) } : {}), at };
  else if (from === "budget_exhausted") next.outcome = null; // lifted by reconfigure
  next.history = [...state.history, { at, from, to, reason: reason || undefined, by: info.by ?? "supervisor", ...(info.detail ? { detail: info.detail.slice(0, 500) } : {}) }].slice(-500);
  return next;
}

/** What `resume` does in a state. */
export interface ResumeAction {
  ok: boolean;
  action?: "redo_setup" | "start" | "takeover" | "unpause" | "answer";
  to?: RunStatus;
  message: string;
}

/** What `resume` means in each state. */
export function resumeAction(state: Pick<RunState, "status" | "blocker" | "outcome"> & { reason?: string }, { answer, approve = false, deny = false }: { answer?: string | undefined; approve?: boolean; deny?: boolean } = {}): ResumeAction {
  const status: string = state.status;
  switch (state.status) {
    case "setup": return { ok: true, action: "redo_setup", message: "setup was interrupted; it is repeated (idempotently) and the run continues" };
    case "ready": return { ok: true, action: "start", to: "running", message: "start running" };
    case "running":
    case "recovering": return { ok: true, action: "takeover", to: "running", message: "the previous supervisor is gone: take over its lock, remove orphaned containers and continue from the recorded state (recovery counters continue, nothing already published is repeated)" };
    case "paused": return { ok: true, action: "unpause", to: "running", message: "continue from the recorded state" };
    case "blocked": {
      const kind = state.blocker?.kind;
      if (kind === "approval") {
        if (approve || deny) return { ok: true, action: "answer", to: "running", message: approve ? "approval given" : "approval denied" };
        return { ok: false, message: "the run is waiting for an approval: resume with --approve or --deny (and optionally --answer <note>)" };
      }
      if (typeof answer === "string" && answer.trim()) return { ok: true, action: "answer", to: "running", message: "answer recorded; the worker continues with it" };
      return { ok: false, message: `the run is blocked (${kind ?? "blocker"}): ${state.blocker?.question ?? state.reason ?? "see status"}. Resume with --answer "<your answer>"` };
    }
    case "budget_exhausted": return { ok: false, message: `the run stopped: ${state.outcome?.reason}. Raise the limit with \`reconfigure\`, which pauses the run, then resume it` };
    case "succeeded": return { ok: false, message: "the run already succeeded; use `export` to take the results out" };
    case "failed": return { ok: false, message: `the run failed (${state.outcome?.reason}); failed is terminal. Export what exists, and start a new run from it if you want to go on` };
    case "cancelled": return { ok: false, message: "the run was cancelled; cancelled is terminal" };
    default: return { ok: false, message: `unknown state ${status}` };
  }
}

/** Progress of the contract's backlog from trusted evaluation results: the one authoritative task board. */
export function boardFromContract(contract: Pick<ContractDraft, "objective">): TaskItem[] {
  return contract.objective.backlog.map((item): TaskItem => ({ id: item.id, title: item.title, checks: item.acceptance ?? [], status: "todo", evidence: [], updatedAt: null }));
}

/** A fresh state for a run that is about to be set up. */
export interface NewStateOptions {
  contract: RunContract;
  contractDigest: string;
  boundaryDigest: string;
  authorisation: RunAuthorisation;
  effort: EffortChoice;
  now?: string;
}

export function newState({ contract, contractDigest, boundaryDigest, authorisation, effort, now = new Date().toISOString() }: NewStateOptions): RunState {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    run: contract.run,
    template: contract.template,
    contractDigest,
    boundaryDigest,
    authorisation,
    status: "setup",
    phase: null,
    blocker: null,
    outcome: null,
    step: 0,
    tasks: boardFromContract(contract),
    acceptance: { latest: null, history: [], review: { required: contract.acceptance.review, status: contract.acceptance.review ? "pending" : "skipped" } },
    worker: null,
    artefacts: [],
    usage: { usd: 0, minutes: 0, steps: 0 },
    recovery: { stalls: 0, softNudgesUsed: 0, hardRestartsUsed: 0, totals: { softNudges: 0, hardRestarts: 0 }, attemptsByTarget: {}, violations: 0, lastFingerprint: null, passingBefore: [] },
    effort: { ...effort },
    limits: { budget: { ...contract.budget }, recovery: { ...contract.recovery } },
    promotion: { policy: contract.promotion.policy, status: contract.promotion.policy === "none" ? "none" : "pending", done: {} },
    pendingQuestions: [],
    reconfigurations: [],
    history: [{ at: now, from: null, to: "setup", reason: "created", by: "supervisor" }],
    createdAt: now,
    updatedAt: now,
  };
}

/** Apply trusted check results to the task board. An item is done only when every check it names passed. */
export function applyResultsToBoard(tasks: readonly TaskItem[], results: ReadonlyArray<Pick<CheckResultSummary, "id" | "pass">>, { step, at = new Date().toISOString(), complete = false }: { step?: number; at?: string; complete?: boolean } = {}): TaskItem[] {
  const byId = new Map(results.map((r) => [r.id, r]));
  return tasks.map((t): TaskItem => {
    let status: TaskItem["status"] = t.status;
    let evidence = t.evidence;
    if (t.checks.length) {
      const rs = t.checks.map((id) => byId.get(id));
      if (rs.every((r) => r?.pass)) status = "done";
      else if (rs.some((r) => r && !r.pass)) status = t.status === "done" ? "todo" : "in_progress";
      evidence = rs.filter((r) => r !== undefined).map((r) => `step ${String(step)}: ${r.id} ${r.pass ? "pass" : "fail"}`);
    } else if (complete) {
      status = "done"; // items with no check of their own are covered by the run's overall acceptance
      evidence = [`step ${String(step)}: covered by the run's acceptance`];
    }
    return status === t.status && evidence === t.evidence ? t : { ...t, status, evidence, updatedAt: at };
  });
}
