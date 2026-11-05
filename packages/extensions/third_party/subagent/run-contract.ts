/**
 * The run contract: what each step of a run did, and the one rule that turns that into the run's
 * status. Execution (did the step finish?) stays apart from verdict (was the work any good?): a
 * script's return value, a caught throw or a review gate's miss cannot change what a step did, and
 * the host, never the script, derives the outcome. wf-engine.ts and workflow.ts report through it.
 *
 * Pure, with no IO, so that every later check reads the same answer.
 *
 * See docs/script-workflows.md; tests/workflow-hooks-smoke.ts and tests/workflow-kernel-regress-smoke.ts.
 */

export type Execution = "completed" | "failed" | "cancelled" | "blocked" | "skipped" | "unknown";

export interface StepResult {
  stepId: string;
  execution: Execution;
  required: boolean;
  reason?: { code: string; text: string };
  usage: { agents: number; outputTokens: number };
  /** Where the step's record is: its journal seq, or its step output path. */
  ref?: string;
}

export type RunStatus = "running" | "passed" | "partial" | "failed" | "interrupted";

/** How the run's own control flow ended, apart from its steps. */
export interface RunEnd {
  threw: boolean;
  stopped: boolean;
  value: unknown;
}

/**
 * The run's status, first match wins: stopped is `interrupted`; a throw or a required step that did
 * not complete is `failed`; omissions with no value is `failed`; omissions with a value is
 * `partial`; otherwise `passed`. An omission is any step that did not complete: a later success does
 * not close it, so a retry loop cannot launder a failure.
 */
export function deriveOutcome(steps: readonly StepResult[], end: RunEnd): { status: Exclude<RunStatus, "running">; omissions: StepResult[] } {
  const omissions = steps.filter((s) => s.execution !== "completed");
  if (end.stopped) return { status: "interrupted", omissions };
  if (end.threw || omissions.some((s) => s.required)) return { status: "failed", omissions };
  if (omissions.length === 0) return { status: "passed", omissions };
  return { status: end.value === null || end.value === undefined ? "failed" : "partial", omissions };
}
