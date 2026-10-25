/**
 * Profile resolution shared by the installer (`install.ts`) and the in-TUI `/profile`
 * command (which drives the installer, since extensions may not import toolchain code).
 *
 * A profile selects extensions (`include`) and, since schema v2, which kit skills and prompt
 * templates are hidden (`skills.excludeCategories` / `skills.exclude` / `prompts.exclude`), or
 * which are the only ones shown (`skills.only` / `prompts.only`, used by the lite profile).
 * Operator customisations live in `<agent dir>/pi-kit/overrides.json` and are applied on top of
 * every profile, so switching profiles never silently undoes a hand-made change (previously a
 * re-install re-added removed extensions and wiped skill/prompt filters).
 *
 * overrides.json:
 *   {
 *     "extensions": { "add": ["name"], "remove": ["name"] },
 *     "skills":     { "exclude": ["name"], "include": ["name"] },
 *     "prompts":    { "exclude": ["name"], "include": ["name"] }
 *   }
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { array, boolean, isRecord, object, optional, parseJson, string, unknownValue, ValidationError, type Infer } from "./guard.ts";
import { globalAgentDir, readSettings, type PackageObject } from "./settings.ts";
import { PROFILES_DIR, WORKSPACE_ROOT } from "./paths.ts";

export const SKILLS_DIR = path.join(WORKSPACE_ROOT, "packages", "kit", "skills");
export const PROMPTS_DIR = path.join(WORKSPACE_ROOT, "packages", "kit", "prompts");

export function overridesPath(): string {
  return path.join(globalAgentDir(), "pi-kit", "overrides.json");
}

// The strings of an array, trimmed, without blanks; anything else is an empty list.
const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim()) : []);

// `value[key]` when value is an object, otherwise undefined.
const field = (value: unknown, key: string): unknown => (isRecord(value) ? value[key] : undefined);

/** Operator customisations applied on top of every profile (overrides.json, normalised). */
export interface Overrides {
  extensions: { add: string[]; remove: string[] };
  skills: { exclude: string[]; include: string[] };
  prompts: { exclude: string[]; include: string[] };
}

/** Any value, read as overrides: unknown keys and non-string names are dropped. */
export function normalizeOverrides(raw: unknown): Overrides {
  const o = field(raw, "extensions");
  const s = field(raw, "skills");
  const p = field(raw, "prompts");
  return {
    extensions: { add: list(field(o, "add")), remove: list(field(o, "remove")) },
    skills: { exclude: list(field(s, "exclude")), include: list(field(s, "include")) },
    prompts: { exclude: list(field(p, "exclude")), include: list(field(p, "include")) },
  };
}

export function readOverrides(file: string = overridesPath()): Overrides {
  try {
    return normalizeOverrides(parseJson(fs.readFileSync(file, "utf8")));
  } catch {
    return normalizeOverrides({});
  }
}

// Extensions whose removal widens what the agent may do. An overrides.json that removes one of
// these is refused (fail closed) instead of being applied: a hand-edit that drops a guard must be
// made deliberately in pi's own settings, never carried silently across profile switches.
export const MANDATORY_PROTECTION_EXTENSIONS: readonly string[] = ["tool-firewall", "secret-guard", "protected-paths"];

function errorCode(error: unknown): unknown {
  return isRecord(error) ? error.code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** readOverridesChecked()'s result: the overrides to apply, or why the file cannot be trusted. */
export interface CheckedOverrides {
  overrides: Overrides;
  error: string | null;
}

/**
 * Like readOverrides(), but a file that exists and cannot be trusted is reported, not swallowed.
 * A missing file is fine (no overrides). An unparseable one, or one that is not a JSON object, may
 * hold a `remove` of a protection we cannot see, so the caller must stop rather than guess.
 */
export function readOverridesChecked(file: string = overridesPath()): CheckedOverrides {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { overrides: normalizeOverrides({}), error: null };
    return { overrides: normalizeOverrides({}), error: `${file} cannot be read (${errorMessage(error)})` };
  }
  try {
    const parsed = parseJson(raw);
    if (!isRecord(parsed)) {
      return { overrides: normalizeOverrides({}), error: `${file} must contain a JSON object like {"extensions":{"add":[],"remove":[]}}` };
    }
    return { overrides: normalizeOverrides(parsed), error: null };
  } catch (error) {
    return { overrides: normalizeOverrides({}), error: `${file} is not valid JSON (${errorMessage(error)})` };
  }
}

/** What this kit version ships, for reconcileOverrides(). */
export interface OverridesKit {
  extensionExists: (name: string) => boolean;
  skills: readonly string[];
  prompts: readonly string[];
  /** distribution.json's requiredProfileExtensions: a removal of one is ignored with a warning. */
  required?: readonly string[];
  /** The overrides file named in messages (default: overridesPath()). */
  file?: string;
}

export interface ReconciledOverrides {
  overrides: Overrides;
  warnings: string[];
  errors: string[];
}

/**
 * Reconcile overrides with what this kit version ships. Names that no longer exist (an extension,
 * skill or prompt renamed or removed since the override was saved) are dropped with a warning: a
 * stale non-security override must not fail a whole profile switch. Removing a mandatory
 * protection extension is the opposite: it is an error, never applied. Removing any other extension
 * every profile requires (kit.required) is dropped with a warning, so the required base always loads.
 */
export function reconcileOverrides(overrides: Overrides, kit: OverridesKit): ReconciledOverrides {
  const warnings: string[] = [];
  const errors: string[] = [];
  const where = kit.file ?? overridesPath();
  const keep = (names: readonly string[], exists: (name: string) => boolean, label: string, hint?: string): string[] =>
    names.filter((n) => {
      if (exists(n)) return true;
      warnings.push(`${where}: ${label} "${n}" no longer exists in this kit and was skipped${hint ? ` (${hint})` : ""}`);
      return false;
    });
  for (const name of overrides.extensions.remove) {
    if (MANDATORY_PROTECTION_EXTENSIONS.includes(name)) {
      errors.push(
        `${where} removes the mandatory protection extension "${name}". Refusing to apply it: that would silently switch a safety guard off. ` +
          `Delete "${name}" from extensions.remove (or delete the file), then retry.`,
      );
    } else if (kit.required?.includes(name)) {
      warnings.push(`${where}: extensions.remove "${name}" was ignored: every profile requires it (requiredProfileExtensions in distribution.json)`);
    }
  }
  const removable = (n: string): boolean => !kit.required?.includes(n) || MANDATORY_PROTECTION_EXTENSIONS.includes(n);
  const sanitized = normalizeOverrides({
    extensions: {
      add: keep(overrides.extensions.add, kit.extensionExists, "extensions.add", "renamed or removed; re-add its new name if you still want it"),
      remove: keep(overrides.extensions.remove.filter(removable), (n) => kit.extensionExists(n) || MANDATORY_PROTECTION_EXTENSIONS.includes(n), "extensions.remove"),
    },
    skills: {
      exclude: keep(overrides.skills.exclude, (n) => kit.skills.includes(n), "skills.exclude"),
      include: keep(overrides.skills.include, (n) => kit.skills.includes(n), "skills.include"),
    },
    prompts: {
      exclude: keep(overrides.prompts.exclude, (n) => kit.prompts.includes(n), "prompts.exclude"),
      include: keep(overrides.prompts.include, (n) => kit.prompts.includes(n), "prompts.include"),
    },
  });
  return { overrides: sanitized, warnings, errors };
}

export function isEmptyOverrides(o: Overrides): boolean {
  return [o.extensions.add, o.extensions.remove, o.skills.exclude, o.skills.include, o.prompts.exclude, o.prompts.include].every((a) => a.length === 0);
}

// Renamed profiles keep working under their old name.
export const PROFILE_ALIASES: Readonly<Record<string, string>> = { engagement: "pentest" };

export function canonicalProfileName(name: string): string {
  // Own keys only: "constructor" or "__proto__" must not resolve to Object.prototype members.
  return (Object.hasOwn(PROFILE_ALIASES, name) ? PROFILE_ALIASES[name] : undefined) ?? name;
}

// --- profile definitions (packages/kit/profiles/<name>.json) ----------------------------------

export const FIREWALL_POLICIES = ["coding", "pentest"] as const;
export const FIREWALL_MODES = ["auto", "manual"] as const;
export type FirewallPolicy = (typeof FIREWALL_POLICIES)[number];
export type FirewallMode = (typeof FIREWALL_MODES)[number];

const isFirewallPolicy = (value: unknown): value is FirewallPolicy => FIREWALL_POLICIES.some((p) => p === value);
const isFirewallMode = (value: unknown): value is FirewallMode => FIREWALL_MODES.some((m) => m === value);

/** A profile's `firewall` block: the policy and default mode it installs. */
export interface ProfileFirewall {
  policy?: FirewallPolicy;
  mode?: FirewallMode;
}

const names = optional(array(string()));

// `firewall` is checked by profileFirewall() below, whose messages name the profile.
const ProfileFileSchema = object({
  name: optional(string()),
  description: optional(string()),
  experimental: optional(boolean()),
  firewall: optional(unknownValue()),
  securityLevel: optional(unknownValue()),
  skills: optional(object({ excludeCategories: names, exclude: names, only: names })),
  prompts: optional(object({ exclude: names, only: names })),
  include: names,
});

/** A profile definition, validated (see loadProfileDef). */
export type Profile = Omit<Infer<typeof ProfileFileSchema>, "firewall" | "securityLevel"> & { firewall?: ProfileFirewall; securityLevel?: SecurityLevel };

/** A profile definition from JSON: the shape checked, the firewall block checked by profileFirewall(). */
export function parseProfile(value: unknown, where = "profile"): Profile {
  const { firewall: _raw, securityLevel: _security, ...def } = ProfileFileSchema.parse(value, where);
  const firewall = profileFirewall(value);
  const securityLevel = profileSecurityLevel(value);
  return { ...def, securityLevel, ...(firewall === undefined ? {} : { firewall }) };
}

export function loadProfileDef(name: string, dir: string = PROFILES_DIR): Profile {
  const file = path.join(dir, `${canonicalProfileName(name)}.json`);
  if (!fs.existsSync(file)) throw new Error(`Profile not found: ${file}`);
  const raw = fs.readFileSync(file, "utf8");
  let parsed: unknown;
  try {
    parsed = parseJson(raw);
  } catch (error) {
    throw new Error(`Profile ${file} is not valid JSON (${errorMessage(error)})`, { cause: error });
  }
  try {
    return parseProfile(parsed, file);
  } catch (error) {
    if (error instanceof ValidationError) throw new Error(`Profile ${file} is invalid: ${error.message}`, { cause: error });
    throw error;
  }
}

export function listProfiles(dir: string = PROFILES_DIR): string[] {
  return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")).sort();
}

// Profile include list with operator overrides applied (order-preserving, de-duplicated).
export function applyExtensionOverrides(include: readonly string[], overrides: Overrides): string[] {
  const remove = new Set(overrides.extensions.remove);
  const out = include.filter((n) => !remove.has(n));
  for (const n of overrides.extensions.add) if (!out.includes(n)) out.push(n);
  return out;
}

function frontmatterField(text: string, key: string): string | undefined {
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const value = fm?.[1]?.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1];
  return value?.trim().replace(/^["']|["']$/g, "");
}

/** A kit skill and its frontmatter `category`, if any. */
export interface KitSkill {
  name: string;
  category: string | undefined;
}

export function kitSkills(dir: string = SKILLS_DIR): KitSkill[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => fs.existsSync(path.join(dir, n, "SKILL.md")))
    .map((name) => ({ name, category: frontmatterField(fs.readFileSync(path.join(dir, name, "SKILL.md"), "utf8"), "category") }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function kitPrompts(dir: string = PROMPTS_DIR): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "APPEND_SYSTEM.md").map((f) => f.replace(/\.md$/, "")).sort();
}

// Names of kit skills hidden by a profile + overrides.
// An `only` allowlist, when present, hides everything not on it.
function outsideOnly(def: { only?: readonly string[] } | undefined, name: string): boolean {
  const only = list(def?.only);
  return only.length > 0 && !only.includes(name);
}

export function excludedSkills(profileDef: Profile | null | undefined, overrides: Overrides, skills: readonly KitSkill[] = kitSkills()): string[] {
  const cats = new Set(list(profileDef?.skills?.excludeCategories));
  const names = new Set([...list(profileDef?.skills?.exclude), ...overrides.skills.exclude]);
  const include = new Set(overrides.skills.include);
  return skills
    .filter((s) => ((s.category !== undefined && cats.has(s.category)) || names.has(s.name) || outsideOnly(profileDef?.skills, s.name)) && !include.has(s.name))
    .map((s) => s.name);
}

export function excludedPrompts(profileDef: Profile | null | undefined, overrides: Overrides, prompts: readonly string[] = kitPrompts()): string[] {
  const names = new Set([...list(profileDef?.prompts?.exclude), ...overrides.prompts.exclude]);
  const include = new Set(overrides.prompts.include);
  return prompts.filter((p) => (names.has(p) || outsideOnly(profileDef?.prompts, p)) && !include.has(p));
}

// pi package-filter patterns (relative to the package root). `!pattern` excludes.
export function skillFilterPatterns(excluded: readonly string[]): string[] {
  return excluded.map((n) => `!packages/kit/skills/${n}/SKILL.md`);
}

export function promptFilterPatterns(excluded: readonly string[]): string[] {
  return excluded.map((n) => `!packages/kit/prompts/${n}.md`);
}

function namesFromPatterns(patterns: unknown, re: RegExp): string[] {
  return list(patterns)
    .filter((p) => p.startsWith("!"))
    .flatMap((p) => p.match(re)?.[1] || []);
}

/**
 * Derive overrides from the difference between what a profile installs and what the operator's
 * settings entry actually contains (hand edits made before overrides existed), so the first
 * profile switch preserves them. Only hand-made changes are captured: extensions added or
 * removed, and skill/prompt exclusions the profile would not apply itself.
 *
 * `entry` is the kit's package entry from settings.json, `profileDef` the marker's profile,
 * `isInPackage(name)` tells kit extensions from external companions (which live in their own
 * package entries and so never appear in the kit entry).
 */
export function captureDrift(entry: Readonly<Partial<PackageObject>> | string | null | undefined, profileDef: Profile | null | undefined, isInPackage: (name: string) => boolean): Overrides {
  const kitEntry = typeof entry === "string" ? undefined : entry;
  const actualExt = list(kitEntry?.extensions)
    .flatMap((p) => p.match(/(?:src|third_party)\/([^/]+)\/index\.ts$/)?.[1] || []);
  const profileExt = list(profileDef?.include).filter((n) => isInPackage(n));
  const none = normalizeOverrides({});
  const profileSkillEx = new Set(excludedSkills(profileDef, none));
  const profilePromptEx = new Set(excludedPrompts(profileDef, none));
  return normalizeOverrides({
    extensions: {
      add: actualExt.filter((n) => !profileExt.includes(n)),
      remove: profileExt.filter((n) => !actualExt.includes(n)),
    },
    skills: { exclude: namesFromPatterns(kitEntry?.skills, /skills\/([^/]+)\/SKILL\.md$/).filter((n) => !profileSkillEx.has(n)) },
    prompts: { exclude: namesFromPatterns(kitEntry?.prompts, /prompts\/([^/]+)\.md$/).filter((n) => !profilePromptEx.has(n)) },
  });
}

export function writeOverrides(overrides: unknown, file: string = overridesPath()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(normalizeOverrides(overrides), null, 2) + "\n");
  fs.renameSync(tmp, file);
}

export { readSettings };

// --- tool-firewall config (<agent dir>/pi-kit/firewall.json) ---
// A profile's `firewall` field sets the firewall policy (coding | pentest) and default mode
// (auto | manual). The policy always follows the profile: switching to or from pentest must
// never keep the other profile's gate. The mode follows the profile too, unless the operator
// chose it with /auto (source "user") and the policy is unchanged. judgeModel, learn and
// knownHosts are the operator's and are always kept.
export function firewallConfigPath(): string {
  return process.env.PI_KIT_FIREWALL_CONFIG?.trim() || path.join(globalAgentDir(), "pi-kit", "firewall.json");
}

// The firewall gate is safety-critical configuration, so an unknown value is an error, not a
// default: `policy: "pentset"` used to become "coding" (the looser policy) without a word, and an
// existing file naming a policy this kit does not know used to be overwritten with the profile's.
/**
 * The `firewall` block of a profile definition (validated or straight from JSON), checked. Absent
 * (or null) is undefined; anything else that is not a known policy/mode object throws.
 */
export function profileFirewall(profileDef: unknown): ProfileFirewall | undefined {
  const fw = field(profileDef, "firewall");
  if (fw === undefined || fw === null) return undefined;
  const name = String(field(profileDef, "name"));
  if (!isRecord(fw)) {
    throw new Error(`profile "${name}": "firewall" must be an object like {"mode":"manual","policy":"coding"}`);
  }
  const { policy, mode } = fw;
  if (policy !== undefined && !isFirewallPolicy(policy)) {
    throw new Error(`profile "${name}" names an unknown firewall policy ${JSON.stringify(policy)} (known: ${FIREWALL_POLICIES.join(", ")}). Refusing to fall back to another policy.`);
  }
  if (mode !== undefined && !isFirewallMode(mode)) {
    throw new Error(`profile "${name}" names an unknown firewall mode ${JSON.stringify(mode)} (known: ${FIREWALL_MODES.join(", ")}).`);
  }
  return { ...(policy === undefined ? {} : { policy }), ...(mode === undefined ? {} : { mode }) };
}

function assertKnownFirewall(profileDef: unknown, existing: unknown, file?: string): ProfileFirewall | undefined {
  const fw = profileFirewall(profileDef);
  if (isRecord(existing)) {
    const at = file ? ` in ${file}` : "";
    if (existing.policy !== undefined && !isFirewallPolicy(existing.policy)) {
      throw new Error(`the existing firewall config${at} names an unknown policy ${JSON.stringify(existing.policy)} (known: ${FIREWALL_POLICIES.join(", ")}). Fix it or delete the file, then retry; it is not overwritten automatically because that could loosen the gate.`);
    }
    if (existing.mode !== undefined && !isFirewallMode(existing.mode)) {
      throw new Error(`the existing firewall config${at} names an unknown mode ${JSON.stringify(existing.mode)} (known: ${FIREWALL_MODES.join(", ")}). Fix it or delete the file, then retry.`);
    }
  }
  return fw;
}

/**
 * firewall.json as stored: the gate's mode/policy, who chose the mode, and the operator's own keys
 * (judgeModel, learn, knownHosts, ...), which are always carried over.
 */
export interface FirewallConfig {
  mode: FirewallMode;
  policy: FirewallPolicy;
  source: "user" | "profile";
  [key: string]: unknown;
}

/**
 * Read the existing firewall.json. Absent is fine ({}); present-but-unreadable, not an object, or
 * naming an unknown policy/mode is an error (fail closed, never a silent reset).
 */
export function readFirewallConfigChecked(file: string = firewallConfigPath()): Record<string, unknown> {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return {};
    throw new Error(`cannot read the firewall config ${file}: ${errorMessage(error)}`, { cause: error });
  }
  let parsed: unknown;
  try {
    parsed = parseJson(raw);
  } catch (error) {
    throw new Error(`the firewall config ${file} is not valid JSON (${errorMessage(error)}). Fix or delete it, then retry; it is not overwritten automatically because it holds your firewall choices.`, { cause: error });
  }
  if (!isRecord(parsed)) {
    throw new Error(`the firewall config ${file} must be a JSON object like {"mode":"manual","policy":"coding"}. Fix or delete it, then retry.`);
  }
  return parsed;
}

/** Validate everything writeFirewallConfig() would need, without writing: run before any other write. */
export function checkFirewallConfig(profileDef: unknown, file: string = firewallConfigPath()): void {
  assertKnownFirewall(profileDef, readFirewallConfigChecked(file), file);
}

/** The firewall.json a profile installs over `existing` (the current file's object, or anything else for none). */
export function firewallConfigFor(profileDef: unknown, existing: unknown): FirewallConfig {
  const fw = assertKnownFirewall(profileDef, existing);
  const prev: Record<string, unknown> = isRecord(existing) ? existing : {};
  const policy: FirewallPolicy = fw?.policy === "pentest" ? "pentest" : "coding";
  const profileMode: FirewallMode = fw?.mode === "auto" ? "auto" : "manual";
  const userMode = prev.source === "user" && prev.policy === policy && isFirewallMode(prev.mode) ? prev.mode : undefined;
  const keepUserMode = userMode !== undefined;
  return {
    ...prev,
    mode: userMode ?? profileMode,
    policy,
    source: keepUserMode ? "user" : "profile",
  };
}

// Installer-side validation mirrors the self-contained firewall runtime schema. Extensions
// never import core or another extension. off remains unavailable without attestation.
export const SECURITY_LEVELS = ["relaxed", "balanced", "guarded", "strict"] as const;
export type SecurityLevel = (typeof SECURITY_LEVELS)[number];
const isSecurityLevel = (value: unknown): value is SecurityLevel => SECURITY_LEVELS.some((l) => l === value);
export function profileSecurityLevel(def: unknown): SecurityLevel {
  const value = field(def, "securityLevel");
  if (value === undefined) return field(def, "name") === "pentest" ? "guarded" : "balanced";
  if (!isSecurityLevel(value)) throw new Error(`profile "${String(field(def, "name"))}" names an unknown or unavailable securityLevel ${JSON.stringify(value)} (known: ${SECURITY_LEVELS.join(", ")}).`);
  return value;
}
export function securityConfigPath(): string {
  return process.env.PI_KIT_SECURITY_CONFIG?.trim() || path.join(globalAgentDir(), "pi-kit", "security.json");
}
function readSecurityConfigChecked(file: string): Record<string, unknown> | undefined {
  let value: unknown;
  try { value = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw new Error(`cannot read security config ${file}: ${errorMessage(error)}`, { cause: error });
  }
  if (!isRecord(value) || value.schemaVersion !== 1 || !isSecurityLevel(value.level)
    || (value.source !== "operator" && value.source !== "profile")
    || typeof value.revision !== "number" || !Number.isSafeInteger(value.revision) || value.revision < 0
    || typeof value.changedAt !== "string" || !Number.isFinite(Date.parse(value.changedAt))) throw new Error(`invalid security config ${file}; repair it before switching profiles`);
  return value;
}
export function checkSecurityConfig(def: unknown, file = securityConfigPath()): void {
  profileSecurityLevel(def);
  readSecurityConfigChecked(file);
}
export function writeSecurityConfig(def: unknown, file = securityConfigPath()): void {
  const level = profileSecurityLevel(def);
  const previous = readSecurityConfigChecked(file);
  if (previous?.source === "operator") return; // ordinary profile switches preserve the operator
  const revision = typeof previous?.revision === "number" ? previous.revision + 1 : 1;
  if (!Number.isSafeInteger(revision)) throw new Error("security revision exhausted");
  const next = { schemaVersion: 1, level, source: "profile", revision, changedAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    fs.renameSync(tmp, file);
  } finally { fs.rmSync(tmp, { force: true }); }
}

export function writeFirewallConfig(profileDef: unknown, file: string = firewallConfigPath()): FirewallConfig {
  const existing = readFirewallConfigChecked(file);
  assertKnownFirewall(profileDef, existing, file);
  const next = firewallConfigFor(profileDef, existing);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return next;
}

// --- project-scope installs and the machine-global gate --------------------------------------
// firewall.json and security.json live in the global agent dir and are read by every session on the
// machine, whatever the project. A --scope project install therefore never writes them; instead it
// reports where the profile's gate differs from the global one, so the operator can apply it
// globally on purpose.
/**
 * Warnings for each part of the global gate (firewall mode/policy, security level) that `profileDef`
 * would set differently from the current global files. Read-only; empty when they already agree.
 */
export function globalGateDrift(profileDef: unknown, firewallFile: string = firewallConfigPath(), securityFile: string = securityConfigPath()): string[] {
  const name = String(field(profileDef, "name"));
  const apply = `To apply it to every session, run install.ts --scope global --profile ${name} (or /profile ${name} outside a project install).`;
  const out: string[] = [];
  const existing = readFirewallConfigChecked(firewallFile);
  const want = firewallConfigFor(profileDef, existing);
  const haveMode = existing.mode === "auto" ? "auto" : "manual";
  const havePolicy = existing.policy === "pentest" ? "pentest" : "coding";
  if (want.mode !== haveMode || want.policy !== havePolicy) {
    out.push(`profile "${name}" wants firewall ${want.mode}/${want.policy}, but the machine-global ${firewallFile} stays ${haveMode}/${havePolicy}: a --scope project install does not change it. ${apply}`);
  }
  const level = profileSecurityLevel(profileDef);
  const security = readSecurityConfigChecked(securityFile);
  if (security?.source !== "operator" && security?.level !== level) {
    out.push(`profile "${name}" wants securityLevel ${level}, but the machine-global ${securityFile} stays ${typeof security?.level === "string" ? security.level : "unset"}: a --scope project install does not change it. ${apply}`);
  }
  return out;
}

// --- whole-run rollback for `install.ts --settings-only` -------------------------------------
// The installer writes several files in sequence (settings.json, firewall.json, overrides.json, the
// .env scaffold, the marker). Each write is atomic, but a failure between two of them used to leave
// a mixed configuration. snapshotFiles() records every file first; the installer restores them on
// any non-zero exit. (A SIGKILL cannot run code: the in-session /profile command snapshots too.)
/** A file's bytes and permission bits before a run, or the fact that it did not exist. */
export type FileSnapshot =
  | { path: string; existed: true; bytes: Buffer; mode: number | null }
  | { path: string; existed: false; bytes: null; mode: null };

export function snapshotFiles(paths: readonly string[]): FileSnapshot[] {
  const seen = new Set<string>();
  const out: FileSnapshot[] = [];
  for (const p of paths) {
    const abs = path.resolve(p);
    if (seen.has(abs)) continue;
    seen.add(abs);
    try {
      out.push({ path: abs, existed: true, bytes: fs.readFileSync(abs), mode: fs.statSync(abs).mode & 0o7777 });
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      out.push({ path: abs, existed: false, bytes: null, mode: null });
    }
  }
  return out;
}

/** Restore snapshots; returns the paths that could not be restored. Never throws. */
export function restoreSnapshots(snaps: readonly FileSnapshot[]): string[] {
  const failed: string[] = [];
  for (const s of snaps) {
    try {
      if (s.existed) {
        fs.mkdirSync(path.dirname(s.path), { recursive: true });
        // Created 0600 and exclusively (O_EXCL, so a planted name is refused, not followed), then
        // given the snapshot's mode: a restored .env never exists world-readable, even briefly
        // (tests/profile-transaction-smoke.ts).
        const tmp = `${s.path}.${process.pid}.${randomBytes(6).toString("hex")}.restore.tmp`;
        try {
          fs.writeFileSync(tmp, s.bytes, { mode: 0o600, flag: "wx" });
          if (s.mode !== null) fs.chmodSync(tmp, s.mode);
          fs.renameSync(tmp, s.path);
        } catch (error) {
          fs.rmSync(tmp, { force: true });
          throw error;
        }
      } else {
        fs.rmSync(s.path, { force: true });
      }
      // The lock a dying writer may have left beside it.
      fs.rmSync(`${s.path}.pi-kit.lock`, { force: true });
    } catch {
      failed.push(s.path);
    }
  }
  return failed;
}
