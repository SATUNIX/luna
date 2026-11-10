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

export const RUN_STATUSES = ["running", "passed", "partial", "failed", "interrupted"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** How the run's own control flow ended, apart from its steps. */
export interface RunEnd {
  /** The run itself ended on an error: the script or the engine threw, or the YAML executor stopped on one. */
  errored: boolean;
  stopped: boolean;
  /** The run has something to show for its omissions. A YAML run's result is its step files, so it always has. */
  hasResult: boolean;
}

/**
 * The run's status, first match wins: stopped is `interrupted`; an error or a required step that did
 * not complete is `failed`; omissions with no result is `failed`; omissions with a result is
 * `partial`; otherwise `passed`. An omission is any step that did not complete. Each agent() call is
 * a step of its own, so a later success does not close it and a script's retry loop cannot launder a
 * failure. A YAML gate loop reruns one step, which reports its latest attempt (stepResults in
 * workflow.ts), so a gate that passes on a later loop reads as completed.
 */
export function deriveOutcome(steps: readonly StepResult[], end: RunEnd): { status: Exclude<RunStatus, "running">; omissions: StepResult[] } {
  const omissions = steps.filter((s) => s.execution !== "completed");
  if (end.stopped) return { status: "interrupted", omissions };
  if (end.errored || omissions.some((s) => s.required)) return { status: "failed", omissions };
  if (omissions.length === 0) return { status: "passed", omissions };
  return { status: end.hasResult ? "partial" : "failed", omissions };
}

/** Whether a finished run has a result to hand over. */
export const producedResult = (status: RunStatus): boolean => status === "passed" || status === "partial";

// A script that does not compile or load fails the same way every time.
const SCRIPT_REFUSED: ReadonlySet<string> = new Set(["syntax", "integrity"]);
// A resume starts with fresh limits and reuses the prefix, so these two refusals can clear.
const REFUSALS_THAT_CLEAR: ReadonlySet<string> = new Set(["budget", "agent-limit"]);
// How a run ends because of its steps or its own code, which its omissions then judge: a thrown refusal
// reads "script", and "limit" is a result too big or a flood of refusals. Any other kind can clear by itself.
const ENDED_BY_ITS_STEPS: ReadonlySet<string> = new Set(["required", "omitted", "limit", "script"]);

const canRetry = (o: StepResult): boolean => {
  const code = o.reason?.code ?? "";
  if (SCRIPT_REFUSED.has(code)) return false;
  return o.execution !== "blocked" || REFUSALS_THAT_CLEAR.has(code);
};

/**
 * Whether a resume of a finished script run could end differently, judging the failure that ended it
 * and then its omissions. A script that does not compile, or a required step refused the same way
 * again, needs an edit; a crash can clear, whatever else the run left out.
 */
export function resumable(o: { status: Exclude<RunStatus, "running">; errorKind?: string | undefined; omissions?: readonly StepResult[] | undefined }): boolean {
  if (o.status === "passed") return false;
  if (o.status === "interrupted") return true;
  const kind = o.errorKind ?? "";
  if (SCRIPT_REFUSED.has(kind)) return false;
  const omissions = o.omissions ?? [];
  if (omissions.some((s) => s.required && !canRetry(s))) return false;
  if (kind !== "" && !ENDED_BY_ITS_STEPS.has(kind)) return true;
  return omissions.length > 0 ? omissions.some(canRetry) : o.status === "failed";
}
