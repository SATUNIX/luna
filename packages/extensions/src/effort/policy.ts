/**
 * Effort policy: the five tiers, their limits and prompt text.
 *
 * The data lives beside this file (policy/effort.json and the prompt templates) so the extension
 * stays self-contained; the toolchain reads the same files through packages/core/lib/effort.ts and
 * tests/effort-smoke.ts checks the two implementations agree.
 *
 * Effort is an execution policy only. Nothing here selects a model, a thinking level, a profile
 * or a permission.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface TierLimits {
  maxConcurrent: number;
  maxTotal: number;
  maxScouts: number;
}

/** Bounds on script-workflow launches (the "workflow" kind), separate from every tier budget. */
export interface WorkflowLimits {
  /** Live agents at once in one run. */
  workflowConcurrent: number;
  /** Agents one run may ever start (retries count; nothing is refunded). */
  workflowTotalPerRun: number;
  /** Agents all workflow runs of one session may start together. */
  workflowSessionTotal: number;
}

/** A tier's Memento allowance: the most generations a task at this tier may use (0: none). */
export interface MementoAllowance {
  maxGenerations: number;
}

export interface Tier {
  id: string;
  level: number;
  code: string;
  label: string;
  aliases: string[];
  promptFile: string;
  limits: TierLimits;
  memento: MementoAllowance;
}

export interface EffortPolicy {
  schemaVersion: 1;
  default: string;
  sharedPromptFile: string;
  ceilings: TierLimits;
  workflow: WorkflowLimits;
  recovery: { maxInvocations: number; maxConcurrent: number; roles: string[] };
  /** No tier's memento.maxGenerations may exceed this. */
  memento: { maxGenerationsCeiling: number };
  tiers: Tier[];
}

/** User-configurable limit overrides, per tier id (effort.json `limits`). */
export type LimitOverrides = Record<string, Partial<TierLimits>>;

const LIMIT_KEYS = ["maxConcurrent", "maxTotal", "maxScouts"] as const;
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;

export function policyDir(): string {
  const override = process.env.PI_KIT_EFFORT_POLICY_DIR?.trim();
  if (override) return override;
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "policy");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");

/** The three limits when every one is a count; null otherwise. */
function limitsOf(value: unknown): TierLimits | null {
  if (!isRecord(value)) return null;
  const { maxConcurrent, maxTotal, maxScouts } = value;
  return isCount(maxConcurrent) && isCount(maxTotal) && isCount(maxScouts) ? { maxConcurrent, maxTotal, maxScouts } : null;
}

const limitOf = (value: unknown, key: keyof TierLimits): unknown => (isRecord(value) ? value[key] : undefined);

const WORKFLOW_KEYS = ["workflowConcurrent", "workflowTotalPerRun", "workflowSessionTotal"] as const;

/** The workflow block's problems (empty when valid); mirrors packages/core/lib/effort.ts. */
function workflowProblems(value: unknown): string[] {
  if (!isRecord(value)) return ["workflow needs workflowConcurrent, workflowTotalPerRun and workflowSessionTotal"];
  const problems: string[] = [];
  for (const key of WORKFLOW_KEYS) {
    const n = value[key];
    if (!isCount(n) || n < 1) problems.push(`workflow.${key} must be a positive integer`);
  }
  const { workflowConcurrent: c, workflowTotalPerRun: run, workflowSessionTotal: session } = value;
  if (isCount(c) && isCount(run) && c > run) problems.push("workflow.workflowConcurrent cannot exceed workflow.workflowTotalPerRun");
  if (isCount(run) && isCount(session) && run > session) problems.push("workflow.workflowTotalPerRun cannot exceed workflow.workflowSessionTotal");
  return problems;
}

/** The workflow limits when they are valid; null otherwise. */
function workflowOf(value: unknown): WorkflowLimits | null {
  if (!isRecord(value) || workflowProblems(value).length) return null;
  const { workflowConcurrent, workflowTotalPerRun, workflowSessionTotal } = value;
  return isCount(workflowConcurrent) && isCount(workflowTotalPerRun) && isCount(workflowSessionTotal) ? { workflowConcurrent, workflowTotalPerRun, workflowSessionTotal } : null;
}

/**
 * The Memento problems (empty when valid): a positive ceiling, and every tier's
 * memento.maxGenerations a count within it that never falls below the tier before it. Mirrors
 * packages/core/lib/effort.ts mementoProblems (tests/effort-smoke.ts compares them).
 */
function mementoProblems(block: unknown, tiers: unknown[]): string[] {
  const problems: string[] = [];
  const ceiling = isRecord(block) ? block.maxGenerationsCeiling : undefined;
  if (!isCount(ceiling) || ceiling < 1) problems.push("memento.maxGenerationsCeiling must be a positive integer");
  let previous: number | null = null;
  tiers.forEach((tier, index) => {
    const memento = isRecord(tier) ? tier.memento : undefined;
    const n = isRecord(memento) ? memento.maxGenerations : undefined;
    if (!isCount(n)) return void problems.push(`tiers[${index}].memento.maxGenerations must be a non-negative integer`);
    if (isCount(ceiling) && n > ceiling) problems.push(`tiers[${index}].memento.maxGenerations ${n} exceeds memento.maxGenerationsCeiling ${ceiling}`);
    if (previous !== null && n < previous) problems.push(`tiers[${index}].memento.maxGenerations must not fall below the previous tier's`);
    previous = n;
  });
  return problems;
}

/** A tier's Memento allowance when it is a count; null otherwise. */
function mementoOf(value: unknown): MementoAllowance | null {
  const n = isRecord(value) ? value.maxGenerations : undefined;
  return isCount(n) ? { maxGenerations: n } : null;
}

/**
 * Check a parsed policy and, when it is valid, build the typed policy from the checked fields
 * (PRO-11: nothing is cast). Missing aliases default to none, as the toolchain's schema does.
 */
function checkPolicy(policy: unknown, dir: string): { problems: string[]; policy: EffortPolicy | null } {
  const problems: string[] = [];
  if (!isRecord(policy)) return { problems: ["effort policy is not an object"], policy: null };
  if (policy.schemaVersion !== 1) problems.push("schemaVersion must be 1");
  const rawTiers: unknown[] = Array.isArray(policy.tiers) ? policy.tiers : [];
  if (rawTiers.length !== 5) problems.push(`exactly five tiers are required (got ${rawTiers.length})`);
  const ids = new Set<unknown>();
  const tiers: Tier[] = [];
  rawTiers.forEach((tier, index) => {
    if (!isRecord(tier)) return void problems.push(`tiers[${index}] is not an object`);
    const { id, level, code, label, aliases, promptFile } = tier;
    if (typeof id !== "string" || !/^[a-z]+$/.test(id)) problems.push(`tiers[${index}].id must be lower-case letters`);
    if (ids.has(id)) problems.push(`tiers[${index}].id "${String(id)}" is duplicated`);
    ids.add(id);
    if (level !== index + 1 || code !== `E${index + 1}`) problems.push(`tiers[${index}] must be level ${index + 1} / code E${index + 1}`);
    if (typeof label !== "string" || !label) problems.push(`tiers[${index}].label is required`);
    if (aliases !== undefined && !isStringArray(aliases)) problems.push(`tiers[${index}].aliases must be an array of strings`);
    for (const key of LIMIT_KEYS) if (!isCount(limitOf(tier.limits, key))) problems.push(`tiers[${index}].limits.${key} must be a non-negative integer`);
    if (typeof promptFile !== "string" || !fs.existsSync(path.join(dir, promptFile))) problems.push(`tiers[${index}].promptFile is missing`);
    const limits = limitsOf(tier.limits);
    const memento = mementoOf(tier.memento);
    if (typeof id === "string" && typeof level === "number" && typeof code === "string" && typeof label === "string" && typeof promptFile === "string" && limits && memento) {
      tiers.push({ id, level, code, label, aliases: isStringArray(aliases) ? aliases : [], promptFile, limits, memento });
    }
  });
  const { default: def, sharedPromptFile, recovery } = policy;
  if (typeof def !== "string" || !ids.has(def)) problems.push(`default "${String(def)}" is not a tier id`);
  if (typeof sharedPromptFile !== "string" || !fs.existsSync(path.join(dir, sharedPromptFile))) problems.push("sharedPromptFile is missing");
  for (const key of LIMIT_KEYS) {
    const ceiling = limitOf(policy.ceilings, key);
    if (!isCount(ceiling) || ceiling < 1) problems.push(`ceilings.${key} must be a positive integer`);
  }
  const ceilings = limitsOf(policy.ceilings);
  problems.push(...workflowProblems(policy.workflow));
  const workflow = workflowOf(policy.workflow);
  problems.push(...mementoProblems(policy.memento, rawTiers));
  const mementoCeiling = isRecord(policy.memento) ? policy.memento.maxGenerationsCeiling : undefined;
  const r = isRecord(recovery) ? recovery : null;
  const roles = r?.roles;
  if (!r || !isCount(r.maxInvocations) || !isCount(r.maxConcurrent) || !isStringArray(roles)) problems.push("recovery needs maxInvocations, maxConcurrent and roles");
  if (problems.length) return { problems, policy: null };
  if (typeof def !== "string" || typeof sharedPromptFile !== "string" || !ceilings || !workflow || !isCount(mementoCeiling) || !r || !isCount(r.maxInvocations) || !isCount(r.maxConcurrent) || !isStringArray(roles)) {
    return { problems: ["effort policy is malformed"], policy: null };
  }
  return {
    problems,
    policy: { schemaVersion: 1, default: def, sharedPromptFile, ceilings, workflow, recovery: { maxInvocations: r.maxInvocations, maxConcurrent: r.maxConcurrent, roles }, memento: { maxGenerationsCeiling: mementoCeiling }, tiers },
  };
}

/** Problems with a parsed policy (empty when valid); mirrors packages/core/lib/effort.ts. */
export function validatePolicy(policy: unknown, dir: string): string[] {
  return checkPolicy(policy, dir).problems;
}

/** Load and validate the policy; throws with every problem when it is not valid. */
export function loadPolicy(dir = policyDir()): EffortPolicy {
  const file = path.join(dir, "effort.json");
  const { problems, policy } = checkPolicy(JSON.parse(fs.readFileSync(file, "utf8")), dir);
  if (!policy) throw new Error(`invalid effort policy ${file}: ${problems.join("; ")}`);
  return policy;
}

export const tierOf = (policy: EffortPolicy, id: string | null | undefined): Tier | null => policy.tiers.find((t) => t.id === id) ?? null;

/** The policy's default tier. validatePolicy guarantees it exists; a policy that breaks that throws. */
function defaultTier(policy: EffortPolicy): Tier {
  const tier = tierOf(policy, policy.default);
  if (!tier) throw new Error(`effort policy default "${policy.default}" is not a tier id`);
  return tier;
}

/** Canonical tier id for a name, E1..E5 or 1..5 (any case); null when it is not a tier. Never throws. */
export function normalizeTier(policy: EffortPolicy, input: unknown): string | null {
  if (typeof input === "number") input = String(input);
  if (typeof input !== "string") return null;
  const key = input.trim().toLowerCase();
  if (!key) return null;
  for (const tier of policy.tiers) {
    if (key === tier.id || key === tier.code.toLowerCase() || key === String(tier.level) || tier.aliases.includes(key)) return tier.id;
  }
  return null;
}

/** A child may be at most as high as its parent's effective cap; unknown values clamp to the cap. */
export function clampTier(policy: EffortPolicy, requested: unknown, cap: unknown): string {
  const capTier = tierOf(policy, normalizeTier(policy, cap)) ?? defaultTier(policy);
  const want = tierOf(policy, normalizeTier(policy, requested)) ?? capTier;
  return want.level > capTier.level ? capTier.id : want.id;
}

/** A tier's limits, optionally overridden by user configuration, never above the platform ceilings. */
export function tierLimits(policy: EffortPolicy, id: string, overrides: LimitOverrides = {}): TierLimits {
  const tier = tierOf(policy, id) ?? defaultTier(policy);
  const limit = (key: keyof TierLimits): number => {
    const wanted = overrides[tier.id]?.[key];
    return Math.min(isCount(wanted) ? wanted : tier.limits[key], policy.ceilings[key]);
  };
  const out: TierLimits = { maxConcurrent: limit("maxConcurrent"), maxTotal: limit("maxTotal"), maxScouts: limit("maxScouts") };
  out.maxScouts = Math.min(out.maxScouts, out.maxTotal);
  out.maxConcurrent = Math.min(out.maxConcurrent, out.maxTotal);
  return out;
}

/** The script-workflow limits (a copy: callers cannot change the loaded policy through it). */
export function workflowLimits(policy: EffortPolicy): WorkflowLimits {
  return { ...policy.workflow };
}

/** The most Memento generations a task at tier `id` may use (the policy default for an unknown id). */
export function mementoGenerations(policy: EffortPolicy, id: string): number {
  const tier = tierOf(policy, id) ?? defaultTier(policy);
  return Math.min(tier.memento.maxGenerations, policy.memento.maxGenerationsCeiling);
}

export function tierLabel(policy: EffortPolicy, id: string): string {
  const tier = tierOf(policy, id);
  return tier ? `${tier.code} ${tier.label}` : id;
}

/** The text injected for a tier: the shared policy, then the tier's own contribution. */
export function renderPrompt(policy: EffortPolicy, id: string, dir = policyDir()): string {
  const tier = tierOf(policy, id) ?? defaultTier(policy);
  const read = (file: string) => fs.readFileSync(path.join(dir, file), "utf8").trim();
  return `${read(policy.sharedPromptFile)}\n\n${read(tier.promptFile)}`;
}

/** The standing-mode file beside the tier prompts (ultracode; docs/effort.md, "Ultracode"). */
export const STANDING_PROMPT_FILE = "standing.md";

/**
 * The standing-mode paragraph, with its size guideline and budget filled in. A budget of null reads
 * "none set" (the engine then gives `budget.total` null, as when standing mode is off).
 */
export function renderStanding(size: number, budget: number | null, dir = policyDir()): string {
  const text = fs.readFileSync(path.join(dir, STANDING_PROMPT_FILE), "utf8").trim();
  const budgetText = budget === null ? "none set (`budget.total` is null)" : `${String(budget)} output tokens (\`budget.total\`); \`agent()\` throws once it is spent`;
  return text.replaceAll("{{size}}", String(size)).replaceAll("{{budget}}", budgetText);
}

export const PROMPT_START = "<!-- pi-kit:effort -->";
export const PROMPT_END = "<!-- /pi-kit:effort -->";

/**
 * Put exactly one effort block at the end of `systemPrompt`, replacing any earlier one. Applying
 * it twice (or after another handler already added a block) never duplicates the policy.
 */
export function withEffortBlock(systemPrompt: string, body: string): string {
  const stripped = systemPrompt.replace(new RegExp(`\\n*${escapeRe(PROMPT_START)}[\\s\\S]*?${escapeRe(PROMPT_END)}\\n*`, "g"), "\n\n").trimEnd();
  return `${stripped}\n\n${PROMPT_START}\n${body}\n${PROMPT_END}\n`;
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
