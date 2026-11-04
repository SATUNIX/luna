// When the supervisor calls the manager, and when it stops a cycle without asking. Pure: the
// supervisor passes the cycle's observed state and the clock.

/** The run config's cycle limits that decide triggers and stops (lib/config.ts DEFAULTS.limits). */
export interface CycleLimits {
  readonly softMinutes: number;
  readonly hardMinutes: number;
  readonly idleMinutes: number;
  readonly noCommitMinutes: number;
  readonly managerCallsPerCycle: number;
  readonly autoRestartsPerCycle?: number;
  readonly redGatesInARow: number;
  readonly guardEscalations: number;
  readonly nothingFoundToStop: number;
}

/** The run config's budget in USD (lib/config.ts DEFAULTS.budget). */
export interface CycleBudget {
  readonly perCycleUsd: number;
  readonly perCycleHardUsd?: number | undefined;
  readonly totalUsd: number;
}

/** The part of the run config the triggers read. */
export interface TriggerConfig {
  readonly cycles: number;
  readonly limits: CycleLimits;
  readonly budget: CycleBudget;
}

/** The cycle's observed state; times are epoch milliseconds. */
export interface CycleObservation {
  readonly startedAt: number;
  readonly lastEventAt?: number | null | undefined;
  readonly lastCommitAt?: number | null | undefined;
  readonly costUsd?: number | undefined;
  readonly extendedMinutes?: number | undefined;
  /** Manager decisions that intervened (everything but CONTINUE and the unavailable-manager default). */
  readonly managerCalls?: number | undefined;
  /** Every manager call, CONTINUE included: a loop guard at three times managerCallsPerCycle. */
  readonly managerCallsTotal?: number | undefined;
  readonly exited?: { readonly code: number } | null | undefined;
  readonly redGatesInARow?: number | undefined;
  /** Guard episodes (notices at least GUARD_EPISODE_MS apart, lib/cycle.ts), not single notices. */
  readonly guardEscalations?: number | undefined;
  /** guardEscalations at the last guard decision or commit: only episodes since then count. */
  readonly guardBaseline?: number | undefined;
  readonly softReviewed?: boolean | undefined;
  /** Trigger keys already sent to the manager. */
  readonly handled?: ReadonlySet<string> | undefined;
}

/** A backstop that closes the cycle without the manager. */
export type CycleStop = "hard_limit" | "cycle_budget_hard" | "manager_calls_exhausted";

export function evaluate(s: CycleObservation, now: number, cfg: Pick<TriggerConfig, "limits" | "budget">): { stop: CycleStop | null; triggers: string[] } {
  const l = cfg.limits;
  // Hard backstops: no manager, the cycle is closed as partial.
  if ((now - s.startedAt) / 60_000 >= l.hardMinutes) return { stop: "hard_limit", triggers: [] };
  // The manager may let a cycle run past its budget (CONTINUE); the hard budget is final.
  if ((s.costUsd ?? 0) >= (cfg.budget.perCycleHardUsd ?? 2 * cfg.budget.perCycleUsd)) return { stop: "cycle_budget_hard", triggers: [] };
  if (managerCallsExhausted(s, l) && pending(s, now, cfg).length) return { stop: "manager_calls_exhausted", triggers: [] };

  return { stop: null, triggers: pending(s, now, cfg) };
}

/**
 * The per-cycle manager cap: interventions (NUDGE, RESTART_SESSION, ...) count against
 * managerCallsPerCycle; CONTINUE decisions do not, since a manager that keeps answering
 * "progressing" has not intervened. Every call counts against a looser loop guard of three times
 * the cap; hardMinutes and the hard budget still bound wall time and spend.
 */
export function managerCallsExhausted(s: Pick<CycleObservation, "managerCalls" | "managerCallsTotal">, l: Pick<CycleLimits, "managerCallsPerCycle">): boolean {
  return (s.managerCalls ?? 0) >= l.managerCallsPerCycle || (s.managerCallsTotal ?? 0) >= 3 * l.managerCallsPerCycle;
}

function pending(s: CycleObservation, now: number, cfg: Pick<TriggerConfig, "limits" | "budget">): string[] {
  const l = cfg.limits;
  const min = (ms: number): number => ms / 60_000;
  const extra = s.extendedMinutes ?? 0;
  const handled = s.handled ?? new Set<string>();
  const out: string[] = [];
  const add = (key: string): void => { if (!handled.has(key)) out.push(key); };
  if (s.exited && s.exited.code !== 0) add(`crash:${s.exited.code}`);
  if (min(now - (s.lastEventAt ?? s.startedAt)) >= l.idleMinutes + extra) add(`idle:${Math.floor(extra)}`);
  if (min(now - (s.lastCommitAt ?? s.startedAt)) >= l.noCommitMinutes + extra) add(`no_commit:${Math.floor(extra)}`);
  if (!s.softReviewed && min(now - s.startedAt) >= l.softMinutes) add("soft_limit");
  if ((s.costUsd ?? 0) >= cfg.budget.perCycleUsd) add("cycle_budget");
  if ((s.redGatesInARow ?? 0) >= l.redGatesInARow) add(`red_gates:${s.redGatesInARow ?? 0}`);
  // One key per baseline: further notices in the same episode do not make new keys; a guard
  // decision or a commit moves the baseline (lib/cycle.ts) and re-arms the trigger.
  const baseline = s.guardBaseline ?? 0;
  if ((s.guardEscalations ?? 0) - baseline >= l.guardEscalations) add(`guard_escalations:${baseline}`);
  return out;
}

export type RunStop = "stop_file" | "total_budget" | "cycles_done" | "backlog_exhausted";

export interface RunProgress {
  readonly totalCostUsd: number;
  readonly cyclesDone: number;
  readonly stopFile?: boolean | undefined;
  readonly nothingFoundInARow?: number | undefined;
}

/** Run-level stop: total budget, cycle count, or the operator's STOP file. */
export function runStop({ totalCostUsd, cyclesDone, stopFile, nothingFoundInARow = 0 }: RunProgress, cfg: TriggerConfig): RunStop | null {
  if (stopFile) return "stop_file";
  if (totalCostUsd >= cfg.budget.totalUsd) return "total_budget";
  if (cyclesDone >= cfg.cycles) return "cycles_done";
  // The agent reviewed the codebase and found nothing worth doing, several cycles running: the
  // rest of the budget would only buy churn.
  if (nothingFoundInARow >= cfg.limits.nothingFoundToStop) return "backlog_exhausted";
  return null;
}

/**
 * The outcome and mode a cycle report declares (prompts/cycle.md asks for `Outcome: ...` and
 * `Mode: ...` lines at the top). Tolerates markdown emphasis; null when absent.
 */
export type ReportOutcome = "successful" | "partial" | "failed" | "nothing found";
export type ReportMode = "fix" | "improve";

const OUTCOMES: readonly ReportOutcome[] = ["successful", "partial", "failed", "nothing found"];
const MODES: readonly ReportMode[] = ["fix", "improve"];

export function reportOutcome(text: string | null | undefined): { outcome: ReportOutcome | null; mode: ReportMode | null } {
  const head = (text ?? "").split("\n").slice(0, 25).join("\n").replace(/[*_`]/g, "");
  const outcomeText = /^\s*outcome\s*:\s*(successful|partial|failed|nothing[ -]found)\b/im.exec(head)?.[1]?.toLowerCase().replace("-", " ");
  const modeText = /^\s*mode\s*:\s*(fix|improve)\b/im.exec(head)?.[1]?.toLowerCase();
  // The patterns admit only these words; the lookups give them their types.
  const outcome = OUTCOMES.find((o) => o === outcomeText) ?? null;
  const mode = MODES.find((m) => m === modeText) ?? null;
  return { outcome, mode };
}

/** Trailing run of completed cycles whose report said "nothing found". */
export function nothingFoundInARow(history: readonly { readonly reportOutcome?: string | null | undefined }[]): number {
  let n = 0;
  for (let i = history.length - 1; i >= 0 && history[i]?.reportOutcome === "nothing found"; i--) n++;
  return n;
}
