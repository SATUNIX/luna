// Bounded recovery for a run that is not making progress. Pure decisions over the persisted
// counters in state.recovery, so they survive a supervisor crash and a resume unchanged.
//
// The ladder, per stall episode: soft nudge(s) (a steering message in the same session), then
// hard restart(s) (a fresh pi session on the SAME workspace, briefed from verified state), then
// the run FAILS with reason recovery_exhausted. Nothing here resets spending, extends a budget
// or widens scope; the run's hard limits (budget, minutes, steps, cancellation, boundary
// violations) are checked by the engine and are never consulted through this module.
//
// Definitions (all from trusted, supervisor-observed facts, never from the worker's claims):
//   verified progress  a check passes that did not pass in the previous evaluation
//   activity           the accepted head moved (new commits with changes inside the write areas)
//   stall              neither of the above (or a rejected step / a dead worker)
// Episode counters (softNudgesUsed, hardRestartsUsed) reset only on verified progress. The
// totals never reset. A generation that ends (its time box ran out) without progress skips the
// nudges, as a dead session does, and spends a hard restart: the fresh generation is that restart.
// Separately, attemptsByTarget counts worker turns spent on one backlog
// target (or on the run's acceptance) and is never reset: maxAttemptsPerStep bounds it.
export const MAX_CONSECUTIVE_VIOLATIONS = 2;

/** state.recovery: the persisted counters. */
export interface RecoveryState {
  stalls?: number;
  softNudgesUsed: number;
  hardRestartsUsed: number;
  violations?: number;
  /** Worker turns per target ("task:<id>" or "acceptance"); never reset. */
  attemptsByTarget: Record<string, number>;
  totals?: { softNudges: number; hardRestarts: number };
}

/** state.limits.recovery. */
export interface RecoveryLimits {
  readonly softNudges: number;
  readonly hardRestarts: number;
  readonly maxAttemptsPerStep: number;
}

/** What the engine observed for one step. */
export interface RecoveryEvent {
  readonly verifiedProgress?: boolean | undefined;
  readonly activity?: boolean | undefined;
  readonly violation?: boolean | undefined;
  readonly crashed?: boolean | undefined;
  /** The step ended a generation (its time box ran out, engine.ts): its session is gone, so there is nothing to nudge. */
  readonly generation?: boolean | undefined;
  readonly target?: string | undefined;
  readonly complete?: boolean | undefined;
}

export type RecoveryFailure = "step_attempts_exhausted" | "boundary_violation" | "recovery_exhausted";

export type RecoveryDecision =
  | { action: "none" | "nudge" | "restart"; reason: string; recovery: RecoveryState }
  | { action: "stop"; failure: RecoveryFailure; reason: string; recovery: RecoveryState };

/** Newly passing checks since the previous evaluation. */
export function newlyPassing(previousPassing: readonly string[] | null | undefined, results: readonly { readonly id: string; readonly pass: boolean }[]): string[] {
  const before = new Set(previousPassing ?? []);
  return results.filter((r) => r.pass && !before.has(r.id)).map((r) => r.id);
}

/** The backlog target the worker is currently on: the first unfinished item with checks, else the run's acceptance. */
export function currentTarget(tasks: readonly { readonly id: string; readonly status: string; readonly checks: readonly unknown[] }[] | null | undefined): string {
  const next = (tasks ?? []).find((t) => t.status !== "done" && t.checks.length > 0);
  return next ? `task:${next.id}` : "acceptance";
}

/** The next recovery step for one observed step; `recovery` is returned updated, never mutated. */
export function decideRecovery(recovery: RecoveryState, limits: RecoveryLimits, ev: RecoveryEvent): RecoveryDecision {
  // A JSON copy, as state.json holds it.
  const rec = structuredClone(recovery);
  const totals = rec.totals ?? (rec.totals = { softNudges: 0, hardRestarts: 0 });
  if (ev.target && !ev.complete) {
    const attempts = (rec.attemptsByTarget[ev.target] ?? 0) + 1;
    rec.attemptsByTarget[ev.target] = attempts;
    if (attempts >= limits.maxAttemptsPerStep) {
      return { action: "stop", failure: "step_attempts_exhausted", reason: `${attempts} worker turns spent on ${ev.target} without completing it (limit ${limits.maxAttemptsPerStep})`, recovery: rec };
    }
  }
  const violations = ev.violation ? (rec.violations ?? 0) + 1 : 0;
  rec.violations = violations;
  if (violations >= MAX_CONSECUTIVE_VIOLATIONS) {
    return { action: "stop", failure: "boundary_violation", reason: `${violations} consecutive steps changed paths outside permissions.writeAreas`, recovery: rec };
  }
  if (ev.verifiedProgress) {
    rec.stalls = 0; rec.softNudgesUsed = 0; rec.hardRestartsUsed = 0;
    return { action: "none", reason: "verified progress", recovery: rec };
  }
  if (ev.activity && !ev.violation && !ev.crashed) {
    rec.stalls = 0;
    return { action: "none", reason: "the accepted head moved", recovery: rec };
  }
  const stalls = (rec.stalls ?? 0) + 1;
  rec.stalls = stalls;
  if (!ev.crashed && !ev.generation && rec.softNudgesUsed < limits.softNudges) {
    rec.softNudgesUsed++; totals.softNudges++;
    return { action: "nudge", reason: `stall ${stalls}: soft nudge ${rec.softNudgesUsed} of ${limits.softNudges}`, recovery: rec };
  }
  if (rec.hardRestartsUsed < limits.hardRestarts) {
    rec.hardRestartsUsed++; totals.hardRestarts++;
    return { action: "restart", reason: `${ev.crashed ? "the worker session died" : ev.generation ? `a generation ended without progress (stall ${stalls})` : `stall ${stalls}`}: hard restart ${rec.hardRestartsUsed} of ${limits.hardRestarts}`, recovery: rec };
  }
  return { action: "stop", failure: "recovery_exhausted", reason: `no verified progress after ${rec.softNudgesUsed} nudge(s) and ${rec.hardRestartsUsed} hard restart(s)`, recovery: rec };
}
