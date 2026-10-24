// The flat configuration the container builders, host git functions and cycle loop consume,
// derived in ONE place from the resolved contract. (lib/config.ts still resolves the flat v0
// shape for the pure modules' tests; a real run always goes contract -> runtimeConfig.)
import type { EffortChoice, GitRemoteDestination, LocalBranchDestination, ProviderId, RunContract, RuntimeSettings, TemplateId } from "./contract.ts";
import { limitProblems } from "./containment.ts";
import { isPlainObject } from "./fsutil.ts";
import { SELF_IMPROVE_LIMITS } from "./templates/self-improve.ts";

/** The self-improve cycle limits (minutes and counts); templateOptions.limits overrides them. */
export type SelfImproveLimits = { -readonly [K in keyof typeof SELF_IMPROVE_LIMITS]: number };

/** The flat run configuration (see runtimeConfig). */
export interface RunConfig {
  contract: RunContract;
  run: string;
  template: TemplateId;
  namePrefix: string;
  branch: string;
  tagPrefix: string;
  integrationBranch: string | null;
  baseRef: string;
  baseSource: string | null;
  integrationRemote: string | null;
  gitRemote: string | null;
  publishTags: boolean;
  image: string;
  engine: RuntimeSettings["engine"];
  container: Pick<RuntimeSettings, "memory" | "cpus" | "pids" | "tmpSize" | "user">;
  gate: { memory: string; cpus: string; timeoutMinutes: number };
  gitIdentity: RuntimeSettings["gitIdentity"];
  references: Record<string, string>;
  mirrorSeconds: number;
  provider: ProviderId;
  model: string;
  managerModel: string;
  reviewModel: string;
  models: string[];
  upstream: string;
  cycles: number;
  integration: { branch: string | null; review: boolean; reviewModel: string };
  budget: { perCycleUsd: number; perCycleHardUsd: number; totalUsd: number };
  limits: SelfImproveLimits;
}

export interface RuntimeConfigOptions {
  /** Container/network name prefix (default `pi-exp-<run>`); tests pass a `pi-autonomy-test-` prefix so nothing they create can be confused with a real run's. */
  namePrefix?: string;
  effort?: EffortChoice;
}

/** `o[key]` of a template option (templateOptions is checked by its template, not typed by the contract). */
const option = (o: unknown, key: string): unknown => (isPlainObject(o) ? o[key] : undefined);
const stringOr = <D>(v: unknown, fallback: D): string | D => (typeof v === "string" ? v : fallback);
const numberOr = (v: unknown, fallback: number): number => (typeof v === "number" ? v : fallback);


/** The flat configuration of a resolved contract. */
export function runtimeConfig(contract: RunContract, opts: RuntimeConfigOptions = {}): RunConfig {
  const r = contract.runtime;
  const t = contract.templateOptions;
  const integration = t.integration ?? { branch: null, review: false };
  const integrationBranch = stringOr(option(integration, "branch"), null);
  const promotion = contract.promotion;
  const repo = contract.inputs.repository;
  const localDest = promotion.destinations.find((d): d is LocalBranchDestination => d.kind === "local-branch");
  const remoteDest = promotion.destinations.find((d): d is GitRemoteDestination => d.kind === "git-remote");
  // Where the integration branch is synchronised and published: nowhere unless promotion says so.
  const integrationRemote = promotion.policy === "push" ? remoteDest?.url ?? null : promotion.policy === "local-branch" ? localDest?.repo ?? repo?.path ?? null : null;
  const hardUsd = numberOr(t.perStepHardUsd ?? undefined, 2 * contract.budget.perStepUsd);
  const limitOverrides = t.limits ?? {};
  const container = { memory: r.memory, cpus: r.cpus, pids: r.pids, tmpSize: r.tmpSize, user: r.user };
  const gate = { memory: stringOr(option(t.gate, "memory"), r.memory), cpus: stringOr(option(t.gate, "cpus"), "4"), timeoutMinutes: Math.max(1, ...contract.acceptance.checks.map((c) => c.timeoutMinutes)) };
  // Both engines read --memory 0 / --cpus 0 as "no limit": refuse such a config when it is read, not
  // only when a container is started (runtime.ts checked()). The contract resolver refuses them too.
  for (const [where, l] of [["runtime", container], ["templateOptions.gate", gate]] as const) {
    const problems = limitProblems(l);
    if (problems.length) throw new Error(`run ${contract.run}: ${where} limits refused: ${problems.join("; ")}`);
  }
  const limits = Object.fromEntries(Object.entries(SELF_IMPROVE_LIMITS).map(([k, v]) => [k, numberOr(option(limitOverrides, k), v)])) as SelfImproveLimits;
  return {
    contract,
    run: contract.run,
    template: contract.template,
    namePrefix: opts.namePrefix ?? `pi-exp-${contract.run}`,
    branch: `pi/${contract.run}`,
    tagPrefix: `pi/${contract.run}/`,
    integrationBranch,
    baseRef: repo?.ref ?? "HEAD",
    baseSource: repo?.path ?? repo?.url ?? null,
    integrationRemote,
    gitRemote: integrationRemote,
    publishTags: promotion.policy === "push" ? Boolean(remoteDest?.tags) : false,
    image: r.image,
    engine: r.engine,
    container,
    gate,
    gitIdentity: r.gitIdentity,
    references: contract.inputs.references,
    mirrorSeconds: r.mirrorSeconds,
    provider: contract.model.provider,
    model: contract.model.worker,
    managerModel: contract.model.manager,
    reviewModel: contract.model.review,
    models: [...new Set([contract.model.worker, contract.model.manager, contract.model.review, ...contract.model.extra].filter(Boolean))],
    upstream: contract.providerSettings.upstream,
    // Self-improve (lib/cycle.ts and lib/triggers.ts read these).
    cycles: contract.budget.maxSteps,
    integration: { branch: integrationBranch, review: option(integration, "review") !== false, reviewModel: contract.model.review },
    budget: { perCycleUsd: contract.budget.perStepUsd, perCycleHardUsd: hardUsd, totalUsd: contract.budget.totalUsd },
    limits,
  };
}
