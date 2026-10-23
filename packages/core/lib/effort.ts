/**
 * Effort policy for toolchain code (the autonomy runner, verify, docs generation, tests).
 *
 * The single source of truth is packages/extensions/src/effort/policy/effort.json plus the
 * prompt templates beside it. The runtime copy of this logic lives in the `effort` extension
 * (extensions may not import toolchain code); tests/effort-smoke.ts checks that the two agree
 * on aliases, clamping and limits so they cannot drift.
 *
 * Effort is an execution policy only: it never selects a model, a thinking level, a profile or
 * a permission. See docs/effort.md.
 */
import fs from "node:fs";
import path from "node:path";
import { array, isRecord, literal, number, object, parseJson, safeParse, string, withDefault, type Infer } from "./guard.ts";
import { FIRST_PARTY_DIR } from "./paths.ts";

// The policy lives inside the effort extension (self-contained, extractable); the toolchain reads it in place.
export const EFFORT_POLICY_DIR = path.join(FIRST_PARTY_DIR, "effort", "policy");
export const EFFORT_POLICY_PATH = path.join(EFFORT_POLICY_DIR, "effort.json");

const LIMIT_KEYS = ["maxConcurrent", "maxTotal", "maxScouts"] as const;
export type LimitKey = (typeof LIMIT_KEYS)[number];
const isCount = (v: unknown): v is number => Number.isInteger(v) && typeof v === "number" && v >= 0;

const Count = number({ integer: true, min: 0 });
const TierLimitsSchema = object({ maxConcurrent: Count, maxTotal: Count, maxScouts: Count });
const Positive = number({ integer: true, min: 1 });
/** Bounds on script-workflow launches (the "workflow" kind), separate from every tier budget. */
const WorkflowLimitsSchema = object({ workflowConcurrent: Positive, workflowTotalPerRun: Positive, workflowSessionTotal: Positive });
const WORKFLOW_KEYS = ["workflowConcurrent", "workflowTotalPerRun", "workflowSessionTotal"] as const;
const TierSchema = object({
  id: string({ pattern: /^[a-z]+$/ }),
  level: number({ integer: true }),
  code: string(),
  label: string({ minLength: 1 }),
  aliases: withDefault(array(string()), []),
  promptFile: string(),
  limits: TierLimitsSchema,
  /** The most Memento generations a task at this tier may use (0: none). */
  memento: object({ maxGenerations: Count }),
});
/**
 * The shape of effort.json. validateEffortPolicy checks the cross-field rules (ordering, aliases,
 * ceilings, prompt files on disk); this schema types the result once those hold.
 */
export const EffortPolicySchema = object({
  schemaVersion: literal(1),
  default: string(),
  sharedPromptFile: string(),
  ceilings: TierLimitsSchema,
  workflow: WorkflowLimitsSchema,
  recovery: object({ maxInvocations: Count, maxConcurrent: Count, roles: array(string()) }),
  memento: object({ maxGenerationsCeiling: Positive }),
  tiers: array(TierSchema),
});

export type TierLimits = Infer<typeof TierLimitsSchema>;
export type WorkflowLimits = Infer<typeof WorkflowLimitsSchema>;
export type EffortTier = Infer<typeof TierSchema>;
export type EffortPolicy = Infer<typeof EffortPolicySchema>;
/** User limit overrides per tier id; only non-negative integers take effect. */
export type LimitOverrides = Readonly<Record<string, Readonly<Partial<Record<LimitKey, unknown>>> | undefined>>;

/** `value[key]` for any object (arrays included, as property access allows); undefined otherwise. */
function prop(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return (value as Record<string, unknown>)[key];
}

/** A number for comparison; anything else compares false either way, as undefined did. */
const num = (value: unknown): number => (typeof value === "number" ? value : Number.NaN);

/**
 * The Memento problems (empty when valid): a positive ceiling, and every tier's
 * memento.maxGenerations a count within it that never falls below the tier before it. Mirrors the
 * effort extension's policy.ts mementoProblems (tests/effort-smoke.ts compares them).
 */
function mementoProblems(block: unknown, tiers: unknown[]): string[] {
  const problems: string[] = [];
  const ceiling = prop(block, "maxGenerationsCeiling");
  if (!isCount(ceiling) || ceiling < 1) problems.push("memento.maxGenerationsCeiling must be a positive integer");
  let previous: number | null = null;
  tiers.forEach((tier, index) => {
    const n = prop(prop(tier, "memento"), "maxGenerations");
    if (!isCount(n)) return void problems.push(`tiers[${index}].memento.maxGenerations must be a non-negative integer`);
    if (isCount(ceiling) && n > ceiling) problems.push(`tiers[${index}].memento.maxGenerations ${n} exceeds memento.maxGenerationsCeiling ${ceiling}`);
    if (previous !== null && n < previous) problems.push(`tiers[${index}].memento.maxGenerations must not fall below the previous tier's`);
    previous = n;
  });
  return problems;
}

/** Validate the policy shape. Returns a list of problems (empty when valid). */
export function validateEffortPolicy(policy: unknown, baseDir = EFFORT_POLICY_DIR): string[] {
  const problems: string[] = [];
  if (!isRecord(policy)) return ["effort policy is not an object"];
  if (policy.schemaVersion !== 1) problems.push(`schemaVersion must be 1 (got ${JSON.stringify(policy.schemaVersion)})`);
  const tiers: unknown[] = Array.isArray(policy.tiers) ? policy.tiers : [];
  if (tiers.length !== 5) problems.push(`exactly five tiers are required (got ${tiers.length})`);
  const seen = new Set<unknown>();
  const aliases = new Set<string>();
  let previous: object | null = null;
  for (const [index, tier] of tiers.entries()) {
    const where = `tiers[${index}]`;
    if (!tier || typeof tier !== "object") { problems.push(`${where} is not an object`); continue; }
    const id = prop(tier, "id");
    const level = prop(tier, "level");
    const code = prop(tier, "code");
    const label = prop(tier, "label");
    const tierAliases = prop(tier, "aliases");
    const limits = prop(tier, "limits");
    const promptFile = prop(tier, "promptFile");
    if (typeof id !== "string" || !/^[a-z]+$/.test(id)) problems.push(`${where}.id must be lower-case letters`);
    if (seen.has(id)) problems.push(`${where}.id "${String(id)}" is duplicated`);
    seen.add(id);
    if (level !== index + 1) problems.push(`${where}.level must be ${index + 1} (tiers are ordered)`);
    if (code !== `E${index + 1}`) problems.push(`${where}.code must be E${index + 1}`);
    if (typeof label !== "string" || !label) problems.push(`${where}.label is required`);
    const codeKey = typeof code === "string" ? code.toLowerCase() : undefined;
    const own = [id, codeKey, String(level)];
    for (const alias of [...own, ...(Array.isArray(tierAliases) ? (tierAliases as unknown[]) : [])]) {
      if (alias === undefined) continue;
      const key = (typeof alias === "string" ? alias : JSON.stringify(alias)).toLowerCase();
      if (aliases.has(key) && !own.includes(key)) problems.push(`${where}: alias "${key}" is used by another tier`);
      aliases.add(key);
    }
    for (const key of LIMIT_KEYS) if (!isCount(prop(limits, key))) problems.push(`${where}.limits.${key} must be a non-negative integer`);
    if (limits && num(prop(limits, "maxScouts")) > num(prop(limits, "maxTotal"))) problems.push(`${where}: maxScouts cannot exceed maxTotal (scouts count within the shared total)`);
    if (limits && num(prop(limits, "maxConcurrent")) > num(prop(limits, "maxTotal"))) problems.push(`${where}: maxConcurrent cannot exceed maxTotal`);
    if (previous) for (const key of LIMIT_KEYS) if (num(prop(limits, key)) < num(prop(prop(previous, "limits"), key))) problems.push(`${where}.limits.${key} must not fall below the previous tier's`);
    previous = tier;
    if (typeof promptFile !== "string" || !fs.existsSync(path.join(baseDir, promptFile))) problems.push(`${where}.promptFile "${String(promptFile)}" does not exist`);
  }
  if (!seen.has(policy.default)) problems.push(`default "${String(policy.default)}" is not a tier id`);
  const sharedPromptFile = policy.sharedPromptFile;
  if (typeof sharedPromptFile !== "string" || !fs.existsSync(path.join(baseDir, sharedPromptFile))) problems.push(`sharedPromptFile "${String(sharedPromptFile)}" does not exist`);
  const ceilings = policy.ceilings;
  for (const key of LIMIT_KEYS) {
    const ceiling = prop(ceilings, key);
    if (!isCount(ceiling) || ceiling < 1) problems.push(`ceilings.${key} must be a positive integer`);
  }
  for (const tier of tiers) {
    for (const key of LIMIT_KEYS) {
      const value = prop(prop(tier, "limits"), key);
      const ceiling = prop(ceilings, key);
      if (num(value) > num(ceiling)) problems.push(`tier ${String(prop(tier, "id"))}: ${key} ${String(value)} exceeds the platform ceiling ${String(ceiling)}`);
    }
  }
  const workflow = policy.workflow;
  if (!isRecord(workflow)) problems.push("workflow needs workflowConcurrent, workflowTotalPerRun and workflowSessionTotal");
  else {
    for (const key of WORKFLOW_KEYS) {
      const n = workflow[key];
      if (!isCount(n) || n < 1) problems.push(`workflow.${key} must be a positive integer`);
    }
    const { workflowConcurrent: c, workflowTotalPerRun: run, workflowSessionTotal: session } = workflow;
    if (isCount(c) && isCount(run) && c > run) problems.push("workflow.workflowConcurrent cannot exceed workflow.workflowTotalPerRun");
    if (isCount(run) && isCount(session) && run > session) problems.push("workflow.workflowTotalPerRun cannot exceed workflow.workflowSessionTotal");
  }
  problems.push(...mementoProblems(policy.memento, tiers));
  const r = policy.recovery;
  if (!r || !isCount(prop(r, "maxInvocations")) || !isCount(prop(r, "maxConcurrent")) || !Array.isArray(prop(r, "roles"))) problems.push("recovery needs maxInvocations, maxConcurrent and roles");
  return problems;
}

/** Load and validate the policy; throws with every problem when it is not valid. */
export function loadEffortPolicy(file = EFFORT_POLICY_PATH): EffortPolicy {
  const raw = parseJson(fs.readFileSync(file, "utf8"));
  const problems = validateEffortPolicy(raw, path.dirname(file));
  // The cross-field rules passed; the schema then types the result (and rejects what they do not
  // cover, such as non-string aliases or roles).
  const parsed = problems.length ? null : safeParse(EffortPolicySchema, raw, "policy");
  if (parsed && !parsed.ok) problems.push(parsed.error.message);
  if (!parsed?.ok) throw new Error(`invalid effort policy ${file}:\n  ${problems.join("\n  ")}`);
  return parsed.value;
}

/** Canonical tier id for a name, E1..E5 or 1..5 (any case); null when it is not a tier. Never throws. */
export function normalizeTier(input: unknown, policy: EffortPolicy = loadEffortPolicy()): string | null {
  if (typeof input === "number") input = String(input);
  if (typeof input !== "string") return null;
  const key = input.trim().toLowerCase();
  if (!key) return null;
  for (const tier of policy.tiers) {
    if (key === tier.id || key === tier.code.toLowerCase() || key === String(tier.level) || tier.aliases.includes(key)) return tier.id;
  }
  return null;
}

export const tierOf = (id: string, policy: EffortPolicy = loadEffortPolicy()): EffortTier | null => policy.tiers.find((t) => t.id === id) ?? null;

/** The tier `id` names, else the policy default (a valid policy always has one). */
function tierOrDefault(id: string, policy: EffortPolicy): EffortTier {
  const tier = tierOf(id, policy) ?? tierOf(policy.default, policy);
  if (!tier) throw new Error(`effort policy default "${policy.default}" is not a tier id`);
  return tier;
}

/** "E3 Standard" for display. */
export function tierLabel(id: string, policy: EffortPolicy = loadEffortPolicy()): string {
  const tier = tierOf(id, policy);
  return tier ? `${tier.code} ${tier.label}` : id;
}

/** A child may be at most as high as its parent's effective cap. Unknown values clamp to the cap. */
export function clampTier(requested: unknown, cap: unknown, policy: EffortPolicy = loadEffortPolicy()): string {
  const capTier = tierOrDefault(normalizeTier(cap, policy) ?? policy.default, policy);
  const want = tierOrDefault(normalizeTier(requested, policy) ?? capTier.id, policy);
  return want.level > capTier.level ? capTier.id : want.id;
}

/** The limits of a tier, optionally overridden by user configuration, never above the platform ceilings. */
export function tierLimits(id: string, policy: EffortPolicy = loadEffortPolicy(), overrides: LimitOverrides | null = {}): TierLimits {
  const tier = tierOrDefault(id, policy);
  const pick = (key: LimitKey): number => {
    const wanted = overrides?.[tier.id]?.[key];
    return Math.min(isCount(wanted) ? wanted : tier.limits[key], policy.ceilings[key]);
  };
  const out: TierLimits = { maxConcurrent: pick("maxConcurrent"), maxTotal: pick("maxTotal"), maxScouts: pick("maxScouts") };
  out.maxScouts = Math.min(out.maxScouts, out.maxTotal);
  out.maxConcurrent = Math.min(out.maxConcurrent, out.maxTotal);
  return out;
}

/** The script-workflow limits (a copy, so callers cannot change the loaded policy through it). */
export function workflowLimits(policy: EffortPolicy = loadEffortPolicy()): WorkflowLimits {
  return { ...policy.workflow };
}

/** The most Memento generations a task at tier `id` may use (the policy default for an unknown id). */
export function mementoGenerations(id: string, policy: EffortPolicy = loadEffortPolicy()): number {
  return Math.min(tierOrDefault(id, policy).memento.maxGenerations, policy.memento.maxGenerationsCeiling);
}

/** The text injected for a tier: the shared policy, then the tier's own contribution. */
export function renderEffortPrompt(id: string, policy: EffortPolicy = loadEffortPolicy(), baseDir = EFFORT_POLICY_DIR): string {
  const tier = tierOrDefault(id, policy);
  const read = (file: string): string => fs.readFileSync(path.join(baseDir, file), "utf8").trim();
  return `${read(policy.sharedPromptFile)}\n\n${read(tier.promptFile)}`;
}
