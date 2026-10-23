// The flat configuration of the deprecated v0 shape (cycles / integration / limits ...), kept
// for the pure modules that still read it (lib/triggers.ts, lib/cycle.ts, lib/gitmirror.ts)
// and their tests. A real run reads a schemaVersion 1 contract (lib/contract.ts), which maps
// the v0 shape onto the self-improve template and derives the flat config with
// lib/runcfg.ts. There is no default remote: v0's built-in private one is gone.
// Durations are minutes, money is USD.
import fs from "node:fs";
import { isProtectedBranch } from "./contract.ts";
import { isPlainObject } from "./fsutil.ts";
import { parseJson } from "../../core/lib/guard.ts";
export { writeJsonAtomic } from "./fsutil.ts";

/** The v0 configuration's defaults (see DEFAULTS). */
export type V0Defaults = {
  cycles: number;
  model: string;
  managerModel: string;
  provider: string;
  upstream: string;
  image: string;
  engine: string;
  gitRemote: string | null;
  baseRef: string;
  integration: { branch: string; review: boolean; reviewModel: string | null };
  extraModels: string[];
  references: Record<string, string>;
  gitIdentity: { name: string; email: string };
  budget: { perCycleUsd: number; perCycleHardUsd: number; totalUsd: number };
  limits: {
    softMinutes: number; hardMinutes: number; idleMinutes: number; noCommitMinutes: number;
    managerCallsPerCycle: number; redGatesInARow: number; guardEscalations: number; nothingFoundToStop: number;
  };
  mirrorSeconds: number;
  container: { memory: string; cpus: string; pids: number; tmpSize: string; user: string };
  gate: { timeoutMinutes: number; memory: string; cpus: string };
};

/**
 * The resolved v0 configuration. Only the checks in resolveConfig are made: the other values are
 * taken from the file as v0 took them (this shape is deprecated and read by tests of pure modules).
 */
export type V0Config = V0Defaults & {
  run: string;
  branch: string;
  integrationBranch: string;
  tagPrefix: string;
  reviewModel: string;
  models: string[];
};

export const DEFAULTS: V0Defaults = {
  cycles: 50,
  model: "deepseek/deepseek-v4.1-flash",
  managerModel: "deepseek/deepseek-v4.1-flash",
  provider: "openrouter",
  upstream: "https://openrouter.ai/api/v1",
  image: "pi-autonomy:local",
  // Container engine: "podman" (rootless; no daemon, no docker group) or "docker".
  engine: "podman",
  gitRemote: null, // required by the contract mapping; the pure modules take it as given
  baseRef: "main",
  // Cycles build on one shared integration branch instead of a branch per run: each cycle
  // starts from its head, and a cycle that completes, passes the gate and passes the merge
  // review is fast-forwarded into it. Work that is not merged stays reachable through the
  // cycle's exp/<run>/cycle-NN tag. The branch name is configurable. review: an independent LLM review (lib/review.ts) before
  // every merge; reviewModel defaults to managerModel.
  integration: { branch: "experimental/main", review: true, reviewModel: null },
  // Extra model ids the relay will serve besides `model` (for example a subagent model).
  extraModels: [],
  // Read-only reference repositories for the agent: { name: "/path/to/git/repo" }. A
  // `git archive HEAD` snapshot (tracked files only) is taken at seed time and mounted at
  // /reference/<name>; the live repository is never mounted.
  references: {},
  // Author of the seed commit and of the agent's commits inside the container.
  gitIdentity: { name: "pi autonomy", email: "pi-autonomy@localhost" },
  // perCycleUsd: the manager reviews the cycle; perCycleHardUsd: the cycle is closed as partial
  // without asking; totalUsd: the run stops (and the relay refuses further requests).
  budget: { perCycleUsd: 5, perCycleHardUsd: 10, totalUsd: 100 },
  limits: {
    softMinutes: 180, // the manager reviews the cycle
    hardMinutes: 300, // the cycle is closed as partial, no manager call
    idleMinutes: 20, // no session events
    noCommitMinutes: 90, // events, but nothing pushed
    managerCallsPerCycle: 3,
    redGatesInARow: 2,
    guardEscalations: 3,
    nothingFoundToStop: 3, // cycles in a row whose report says "nothing found" end the run
  },
  mirrorSeconds: 30,
  // user: "host" runs containers as the operator's uid:gid, so bind-mounted run files stay
  // theirs (with podman, through --userns=keep-id). Rootless Docker wants "0:0", which maps
  // to the operator.
  container: { memory: "6g", cpus: "4", pids: 1024, tmpSize: "4g", user: "host" },
  gate: { timeoutMinutes: 60, memory: "6g", cpus: "4" },
};

const RUN_ID = /^[a-z0-9][a-z0-9-]{2,40}$/;

function merge(base: Record<string, unknown>, over: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over ?? {})) {
    const inner = base[key];
    out[key] = value && typeof value === "object" && !Array.isArray(value) && inner && typeof inner === "object"
      ? merge(inner as Record<string, unknown>, value)
      : value;
  }
  return out;
}

const obj = (v: unknown): Record<string, unknown> => (isPlainObject(v) ? v : {});
const gt = (a: unknown, b: unknown): boolean => (a as number) > (b as number);
const ge = (a: unknown, b: unknown): boolean => (a as number) >= (b as number);

/** The effective config. Throws on anything that would make the run unsafe or ambiguous. */
export function resolveConfig(raw: unknown): V0Config {
  const cfg = merge(DEFAULTS, raw);
  const problems: string[] = [];
  // The comparisons below are JavaScript's, as in v0: a wrong type compares false and is reported.
  if (typeof cfg.run !== "string" || !RUN_ID.test(cfg.run)) problems.push("run: lowercase id, 3-41 chars [a-z0-9-] (it names the working branch experimental/<run> and the tags exp/<run>/)");
  if (!Number.isInteger(cfg.cycles) || gt(1, cfg.cycles) || gt(cfg.cycles, 500)) problems.push("cycles: integer 1-500");
  const b = obj(cfg.budget);
  b.perCycleHardUsd ??= 2 * (b.perCycleUsd as number);
  if (!gt(b.perCycleUsd, 0) || !ge(b.perCycleHardUsd, b.perCycleUsd) || !ge(b.totalUsd, b.perCycleHardUsd)) problems.push("budget: 0 < perCycleUsd <= perCycleHardUsd <= totalUsd");
  const l = obj(cfg.limits);
  if (!(gt(l.idleMinutes, 0) && gt(l.noCommitMinutes, 0) && gt(l.softMinutes, 0) && gt(l.hardMinutes, l.softMinutes))) problems.push("limits: positive, and hardMinutes > softMinutes");
  if (!Number.isInteger(l.nothingFoundToStop) || gt(1, l.nothingFoundToStop)) problems.push("limits.nothingFoundToStop: integer >= 1");
  if (!/^https:\/\//.test(String(cfg.upstream))) problems.push("upstream: https URL");
  if (!/^[\w.-]+\/[\w.:-]+$/.test(String(cfg.model)) || /:online\b/.test(String(cfg.model))) problems.push("model: provider/model id (no :online variants)");
  for (const name of Object.keys(cfg.references ?? {})) if (!/^[a-z0-9][a-z0-9._-]{0,40}$/.test(name)) problems.push(`references: bad name ${JSON.stringify(name)}`);
  if (cfg.engine !== "podman" && cfg.engine !== "docker") problems.push('engine: "podman" or "docker"');
  if (!Array.isArray(cfg.extraModels)) problems.push("extraModels: array of model ids");
  if (!/^[\w.-]+(:[\w./-]+)?$/.test(String(cfg.image))) problems.push("image: docker image reference");
  const integration = obj(cfg.integration);
  const ib = typeof integration.branch === "string" ? integration.branch : null;
  if (ib === null || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,80}$/.test(ib) || ib.includes("..") || ib.endsWith("/") || ib.endsWith(".lock") || isProtectedBranch(ib) || ib === cfg.baseRef) problems.push("integration.branch: a valid branch name that is neither protected (main, master, release/...) nor the base ref");
  if (problems.length || ib === null) throw new Error(`invalid run config:\n  ${problems.join("\n  ")}`);
  const resolved = cfg as V0Defaults & { run: string };
  // branch: the cycle's working branch, local to the host mirror and the agent's bare repo (it is
  // never pushed to gitRemote); integration: the branch that is published.
  return { ...resolved, branch: `experimental/${resolved.run}`, integrationBranch: ib, tagPrefix: `exp/${resolved.run}/`,
    reviewModel: resolved.integration.reviewModel ?? resolved.managerModel, models: [resolved.model, ...resolved.extraModels] };
}

export function readConfig(file: string): V0Config {
  return resolveConfig(parseJson(fs.readFileSync(file, "utf8")));
}
