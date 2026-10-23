// The firewall owns securityLevel. No other extension imports this module at runtime.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agentDir, isRecord, kitStateDir } from "./config.ts";

export const LEVELS = ["off", "relaxed", "balanced", "guarded", "strict"] as const;
export type SecurityLevel = (typeof LEVELS)[number];
export type SecurityConfig = { schemaVersion: 1; level: SecurityLevel; source: "operator" | "profile"; revision: number; changedAt: string };
export type SecuritySnapshot = Readonly<{
  requested: SecurityLevel; effective: SecurityLevel; source: "operator" | "profile";
  revision: number; floors: readonly Readonly<{ level: SecurityLevel; reason: string }>[];
  pinnedBy?: string; unavailable: readonly string[]; warnings: readonly string[];
}>;
// Stable public, process-local contract for the footer and control centre:
// globalThis[REGISTRY_KEY] = { snapshot(): SecuritySnapshot }. Both registry and returned
// snapshot (including floors/unavailable/warnings) are frozen. No mutators or authority.
export const REGISTRY_KEY = Symbol.for("pi-kit.security");
export const OFF_REASON = "off needs a supervisor-verified, operator-authorised container boundary; that attestation is unavailable";
export const UNAVAILABLE = Object.freeze(["content screening", "OpenAPPA flow engine", "intent ledger", "detector", OFF_REASON]);
export const DESCRIPTIONS: Readonly<Record<SecurityLevel, string>> = Object.freeze({
  off: `unavailable: ${OFF_REASON}`,
  relaxed: "balanced behaviour; no reviewed medium routine effects are available",
  balanced: "configured approval strategy, exact grants, learning and judge",
  guarded: "advisory learning and similarity; medium judge only; uncertain actions ask",
  strict: "operator approval, once only; unknown external tools deny; low tier still runs",
});
export const isLevel = (value: unknown): value is SecurityLevel => LEVELS.some((level) => level === value);
export const rank = (level: SecurityLevel): number => LEVELS.indexOf(level);
export const strongest = (...levels: SecurityLevel[]): SecurityLevel => levels.reduce((a, b) => rank(a) >= rank(b) ? a : b, "off");
export const securityPath = (): string => process.env.PI_KIT_SECURITY_CONFIG?.trim() || path.join(kitStateDir(), "security.json");

export function parseSecurity(value: unknown): SecurityConfig {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isLevel(value.level)
    || (value.source !== "operator" && value.source !== "profile")
    || typeof value.revision !== "number" || !Number.isSafeInteger(value.revision) || value.revision < 0
    || typeof value.changedAt !== "string" || !Number.isFinite(Date.parse(value.changedAt))) throw new Error("invalid security.json schema, level, source, revision or changedAt");
  return { schemaVersion: 1, level: value.level, source: value.source, revision: value.revision, changedAt: value.changedAt };
}

// Cache by the complete bytes, never by mtime. Read failures are deliberately retried.
let cachedText: string | undefined;
let cachedConfig: SecurityConfig | undefined;
export function readSecurity(file = securityPath()): { config?: SecurityConfig; warning?: string } {
  try {
    const text = fs.readFileSync(file, "utf8");
    if (text !== cachedText || !cachedConfig) {
      const parsed: unknown = JSON.parse(text);
      cachedConfig = parseSecurity(parsed);
      cachedText = text;
    }
    return { config: cachedConfig };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    return { warning: `security.json cannot be loaded; fail closed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export function saveSecurity(level: SecurityLevel, source: SecurityConfig["source"], file = securityPath()): SecurityConfig {
  if (level === "off") throw new Error(OFF_REASON);
  const previous = readSecurity(file).config;
  const next: SecurityConfig = { schemaVersion: 1, level, source, revision: (previous?.revision ?? 0) + 1, changedAt: new Date().toISOString() };
  if (!Number.isSafeInteger(next.revision)) throw new Error("security revision exhausted");
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  return next;
}

/** Read the installed profile default for reset/failure; old installs fall back to balanced. */
export function profileDefault(cwd: string, policy: string): SecurityLevel {
  for (const marker of [path.join(cwd, ".pi", ".pi-kit.json"), path.join(agentDir(), ".pi-kit.json")]) {
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(marker, "utf8"));
      if (!isRecord(raw) || typeof raw.profile !== "string" || !/^[a-z][a-z0-9-]*$/.test(raw.profile)) continue;
      const file = fileURLToPath(new URL(`../../../kit/profiles/${raw.profile}.json`, import.meta.url));
      const def: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
      if (isRecord(def) && isLevel(def.securityLevel) && def.securityLevel !== "off") return def.securityLevel;
    } catch { /* old installation, missing marker or profile: safe migration default */ }
  }
  return policy === "pentest" ? "guarded" : "balanced";
}

export function resolveSecurity(defaultLevel: SecurityLevel, policy: string, env = process.env, file = securityPath()): SecuritySnapshot {
  const { config, warning } = readSecurity(file);
  const warnings = warning ? [warning] : [];
  const requested = warning ? strongest(defaultLevel, "balanced") : config?.level ?? defaultLevel;
  const floors: Array<{ level: SecurityLevel; reason: string }> = [];
  if (policy === "pentest") floors.push({ level: "guarded", reason: "pentest engagement policy" });
  // Even a hand-edited persisted off is never authority to disable the gate.
  if (requested === "off") { floors.push({ level: strongest(defaultLevel, "balanced"), reason: OFF_REASON }); warnings.push(OFF_REASON); }
  const pin = env.PI_KIT_SECURITY_LEVEL?.trim();
  if (pin && (!isLevel(pin) || pin === "off")) warnings.push(`ignored PI_KIT_SECURITY_LEVEL=${pin}: environment requests cannot select off or an unknown level`);
  else if (pin && isLevel(pin)) floors.push({ level: pin, reason: "PI_KIT_SECURITY_LEVEL" });
  const effective = strongest(requested, ...floors.map((f) => f.level));
  return Object.freeze({ requested, effective, source: config?.source ?? "profile", revision: config?.revision ?? 0,
    floors: Object.freeze(floors.map((f) => Object.freeze(f))), ...(pin && isLevel(pin) && rank(pin) > rank(requested) ? { pinnedBy: "PI_KIT_SECURITY_LEVEL" } : {}),
    unavailable: UNAVAILABLE, warnings: Object.freeze(warnings) });
}

// An effect-only admission set cannot safely contain code_exec (generated code, services),
// workspace_write (ownership, git remotes), process_control (unrelated processes), or read /
// network_read (medium includes sensitive or remote reads). Builds/tests are already low.
// All other effects carry explicit authority or uncertainty. Relaxed equals balanced for now.
export const ROUTINE_EFFECTS: ReadonlySet<string> = new Set();
