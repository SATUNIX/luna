// `reconfigure`: the ONLY way effort, budgets or recovery limits change for an existing run. It
// cannot touch permissions, network, credentials, promotion, the image or the acceptance
// definitions (those are the boundary the operator authorised; changing them means a new run).
// Resume and interactive effort changes inside a worker never reach this path.
import { isRecord, parseJson } from "../../core/lib/guard.ts";
import { resolveContract } from "./contract.ts";
import type { EffortSnapshot } from "./worker-env.ts";

export const RECONFIGURABLE: readonly string[] = ["effort", "budget", "recovery"];

type ResolvedContract = NonNullable<ReturnType<typeof resolveContract>["contract"]>;
type ResolveOptions = NonNullable<Parameters<typeof resolveContract>[1]>;

/** The reconfigurable part of a run: its effort snapshot and limits. */
export interface ReconfigurableSettings {
  effort: ResolvedContract["effort"];
  budget: ResolvedContract["budget"];
  recovery: ResolvedContract["recovery"];
}

export interface ReconfigureRequest {
  contract: ResolvedContract;
  state: {
    readonly effort: EffortSnapshot;
    readonly limits: { readonly budget: ResolvedContract["budget"]; readonly recovery: ResolvedContract["recovery"] };
  };
  /** The operator's changes (CLI flags or a control file): unchecked until the resolver accepts them. */
  changes: unknown;
  effort?: ResolveOptions["effort"];
}

export type ReconfigurePlan =
  | { ok: false; problems: string[] }
  | {
    ok: true;
    problems: [];
    before: { effort: EffortSnapshot; budget: ResolvedContract["budget"]; recovery: ResolvedContract["recovery"] };
    after: ReconfigurableSettings;
    next: { effort: ResolvedContract["effort"]; limits: { budget: ResolvedContract["budget"]; recovery: ResolvedContract["recovery"] } };
  };

/** `current` with `change` laid over it; a change that is not an object goes to the resolver as given, to be refused. */
function overlay(current: object, change: unknown): unknown {
  if (change === undefined || change === null) return { ...current };
  return isRecord(change) ? { ...current, ...change } : change;
}

export function planReconfigure({ contract, state, changes, effort }: ReconfigureRequest): ReconfigurePlan {
  if (!isRecord(changes) || !Object.keys(changes).length) return { ok: false, problems: [`nothing to change; reconfigurable: ${RECONFIGURABLE.join(", ")}`] };
  const refused = Object.keys(changes).filter((k) => !RECONFIGURABLE.includes(k));
  if (refused.length) return { ok: false, problems: [`${refused.join(", ")} cannot be reconfigured: it is part of the authorised boundary (only ${RECONFIGURABLE.join(", ")} can change). Start a new run with a new authorisation instead.`] };
  const before = { effort: state.effort, budget: state.limits.budget, recovery: state.limits.recovery };
  const asked = changes["effort"];
  // A bare tier keeps the current cap unless it would exceed it; the resolver checks tier <= cap.
  const wantEffort = asked === undefined
    ? { tier: state.effort.tier, cap: state.effort.cap }
    : isRecord(asked) ? { tier: asked["tier"] ?? state.effort.tier, cap: asked["cap"] ?? state.effort.cap } : { tier: asked, cap: state.effort.cap };
  const want = {
    effort: wantEffort,
    budget: overlay(state.limits.budget, changes["budget"]),
    recovery: overlay(state.limits.recovery, changes["recovery"]),
  };
  // Validate by resolving a candidate contract: the same rules as at start.
  const { objective, authorisation: _a, ...rest } = contract;
  const candidate = { ...rest, objective: { title: objective.title, spec: objective.spec, backlog: objective.backlog }, effort: want.effort, budget: want.budget, recovery: want.recovery, authorisation: undefined };
  const r = resolveContract(parseJson(JSON.stringify(candidate)), { effort });
  const problems = r.problems.filter((p) => p.level === "error" && /^(effort|budget|recovery)/.test(p.path)).map((p) => `${p.path}: ${p.message}`);
  if (problems.length) return { ok: false, problems };
  if (!r.contract) return { ok: false, problems: ["the reconfigured contract could not be resolved"] };
  const after = { effort: r.contract.effort, budget: r.contract.budget, recovery: r.contract.recovery };
  return { ok: true, problems: [], before, after, next: { effort: after.effort, limits: { budget: after.budget, recovery: after.recovery } } };
}
