/**
 * The one decision policy: a signal and the counters that already exist turn into one move and its
 * text. Callers keep their delivery paths and effort owns the words, so the text has one source.
 *
 * Pure: no file, no clock, no global. Tier and tool activity reach `decide` from the effort
 * extension, never from a caller, and a move only chooses words: it changes no tool set, no firewall
 * decision and no tier. Rungs cannot repeat, because the counters behind them only rise.
 */

export type Trigger = "plan" | "delegate" | "review" | "stall" | "verify-fail" | "boost";
export type Move = "none" | "plan" | "reorient" | "angle" | "split" | "human";

export interface Signal {
  trigger: Trigger;
  signature?: string;
  /** progress-guard: how often this signal has fired. */
  detections?: number;
  /** recovery-orchestrator: this entry's attempt. A stall carrying it is a recovery entry. */
  attempt?: number;
  score?: number;
  changedLines?: number;
  repeatFail?: boolean;
}

export interface Decision {
  move: Move;
  /** The text the caller delivers, or null when its own path says it all. */
  steer: string | null;
  card: boolean;
}

/** What only effort knows. `allowance` is the tier's workflowAgents: what one request may plan. */
export interface StrategyEnv {
  level: number;
  standing: boolean;
  planTool: boolean;
  allowance: number;
}

export interface StrategyConfig {
  planMinTier: number;
  splitMinTier: number;
  delegateScore: number;
  reviewLines: number;
  stallAfter: number;
  quietTurns: number;
  maxAttempts: number;
  expandDepth: number;
}

export const DEFAULT_STRATEGY: StrategyConfig = { planMinTier: 5, splitMinTier: 3, delegateScore: 3, reviewLines: 400, stallAfter: 2, quietTurns: 20, maxAttempts: 2, expandDepth: 3 };

export const NO_MOVE: Decision = { move: "none", steer: null, card: false };

/** The tool a plan runs through: every move that names a plan needs it active. */
export const PLAN_TOOL = "workflow_run";

/** An `expand` step's worst case, for its one resample (docs/workflows.md). A smaller allowance cannot hold one. */
export const EXPAND_STEP_AGENTS = 2;

const SUBAGENT_MIN_LEVEL = 2;

const PLAN_STEER = "Run substantial work as an inline `workflow_run {steps}` plan, and do a task with one step, one file and one check directly.";
const DELEGATE_PLAN_STEER = "This task looks large enough to plan. Run it as `workflow_run {steps}`: a planner or scout step, implementer steps with self-contained tasks, and a reviewer step with a gate. Doing it directly stays allowed. Stay within any user restriction and the effort budget; complexity grants no permission. Afterwards call `verify_completion` if available: a `record_verdict` PASS is untrusted.";
const DELEGATE_SUBAGENT_STEER = "This task looks large enough to delegate: give a `subagent` a self-contained task, within any user restriction and the effort budget. Afterwards call `verify_completion` if available: a `record_verdict` PASS is untrusted.";
const REVIEW_STEER = "This is a large diff: `/workflows run review-changes` reviews it by dimension and checks its own findings.";
const REORIENT_STEER = "Check this against your goal, then take the smallest different next action, hand the stuck part to a fresh sub-agent that returns only the answer, or report the concrete blocker; do not edit files just to reset this detector.";
const ANGLE_STEER = "This signal keeps recurring, so stop and change approach: re-read your goal, write down what you tried and what failed, and delegate the stuck step or report the blocker instead of retrying it (skill `self-reflection-and-recovery`).";
const BOOST_STEER = "Check your recent actions against your goal: if they repeat, name the smallest different next action, and hand a stuck step to a fresh sub-agent (skill `self-reflection-and-recovery`).";
const SPLIT_STEER = 'Another pass over the whole problem will not help, so split it: start `workflow_run {steps}` with one step that has `expand: true` under a role that can do the work (a read-only `planner` expands only into read-only steps), whose final answer is {"steps":[...]} for the pieces or {"done":"..."} when nothing is left.';

/** A split needs a tier that plans, the tool, and an allowance that holds an expand step. */
function canSplit(env: StrategyEnv, c: StrategyConfig): boolean {
  return env.level >= c.splitMinTier && env.planTool && env.allowance >= EXPAND_STEP_AGENTS;
}

const SPLIT: Decision = { move: "split", steer: SPLIT_STEER, card: true };

function stall(s: Signal, env: StrategyEnv, c: StrategyConfig): Decision {
  const { attempt } = s;
  if (attempt === undefined) return (s.detections ?? 0) >= c.stallAfter ? { move: "angle", steer: ANGLE_STEER, card: false } : { move: "reorient", steer: REORIENT_STEER, card: false };
  if (attempt > c.maxAttempts) return { move: "human", steer: null, card: false };
  if (attempt === 2 && canSplit(env, c)) return SPLIT;
  // Recovery's own scaffold carries the scouts, as it did before there was a policy.
  return { move: "angle", steer: null, card: false };
}

export function decide(s: Signal, env: StrategyEnv, c: StrategyConfig): Decision {
  switch (s.trigger) {
    case "plan":
      return env.planTool && (env.level >= c.planMinTier || env.standing) ? { move: "plan", steer: PLAN_STEER, card: true } : NO_MOVE;
    case "delegate":
      if ((s.score ?? 0) < c.delegateScore || env.level < SUBAGENT_MIN_LEVEL) return NO_MOVE;
      return { move: "plan", steer: env.level >= c.splitMinTier && env.planTool ? DELEGATE_PLAN_STEER : DELEGATE_SUBAGENT_STEER, card: false };
    case "review":
      return (s.changedLines ?? 0) >= c.reviewLines && env.level >= c.splitMinTier ? { move: "plan", steer: REVIEW_STEER, card: false } : NO_MOVE;
    case "stall":
      return stall(s, env, c);
    case "verify-fail":
      return s.repeatFail === true && canSplit(env, c) ? SPLIT : NO_MOVE;
    case "boost":
      return { move: "angle", steer: BOOST_STEER, card: false };
  }
}

function positive(value: string | undefined): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/** The policy's numbers with the operator's environment on top: these names predate the policy and keep working. */
export function strategyConfig(base: StrategyConfig, env: Readonly<Record<string, string | undefined>>): StrategyConfig {
  return {
    ...base,
    stallAfter: positive(env.PI_KIT_GUARD_ESCALATE) ?? base.stallAfter,
    maxAttempts: positive(env.PI_KIT_RECOVERY_MAX_ATTEMPTS) ?? base.maxAttempts,
    delegateScore: positive(env.PI_KIT_ORCH_THRESHOLD) ?? base.delegateScore,
  };
}
