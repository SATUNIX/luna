/**
 * Memento opt-in: which models the operator allowed to work in Memento mode (generations), kept in
 * <agent dir>/pi-kit/autonomy.json. Off by default: a model is opted in only by an entry with
 * `"enabled": true`, which `/effort memento on` writes after a No-first select. protected-paths
 * keeps the file out of reach of the agent's own write tools, so the model cannot opt itself in.
 *
 * The allowance for a task is the tier's memento.maxGenerations (effort.json), lowered by the
 * model's own `maxGenerations` when it sets one (never raised: clamped like the user's limit
 * overrides), and 0 outside the long-horizon and autonomous profiles or for a model not opted in.
 *
 * Self-contained: node:* builtins only. The file is outside data: every field is checked here and
 * nothing in it is cast.
 *
 *   {
 *     "schemaVersion": 1,
 *     "memento": { "models": { "<provider>/<model id>": { "enabled": true, "maxGenerations": 2 } } }
 *   }
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** The profiles in which Memento mode may be used at all. */
export const MEMENTO_PROFILES: readonly string[] = ["long-horizon", "autonomous"];

/** `<provider>/<model id>`: a provider name, a slash, then the model id (which may hold slashes). */
const MODEL_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}\/[A-Za-z0-9][A-Za-z0-9._:@+/-]{0,199}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

export function optInPath(): string {
  return path.join(agentDir(), "pi-kit", "autonomy.json");
}

/** The opt-in key for a model, or null when the provider or id cannot form one. */
export function modelKey(provider: unknown, id: unknown): string | null {
  if (typeof provider !== "string" || typeof id !== "string") return null;
  const key = `${provider}/${id}`;
  return isModelKey(key) ? key : null;
}

export function isModelKey(key: string): boolean {
  return MODEL_KEY.test(key) && !key.split("/").includes("..");
}

/** One opted-in model: `maxGenerations` null means "the tier's allowance". */
export interface OptedIn {
  maxGenerations: number | null;
}

export interface OptIn {
  models: Map<string, OptedIn>;
  warnings: string[];
}

/** Read the opt-in file. Missing is normal (nothing opted in); anything malformed is ignored with a warning. */
export function readOptIn(file = optInPath()): OptIn {
  const out: OptIn = { models: new Map(), warnings: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    const code = isRecord(error) ? error.code : undefined;
    if (code !== "ENOENT") out.warnings.push(`ignored ${file}: not valid JSON`);
    return out;
  }
  if (!isRecord(raw)) {
    out.warnings.push(`ignored ${file}: not an object`);
    return out;
  }
  const memento = raw.memento;
  if (memento === undefined) return out;
  const models = isRecord(memento) ? memento.models : undefined;
  if (!isRecord(models)) {
    out.warnings.push(`ignored memento in ${file}: memento.models is not an object`);
    return out;
  }
  for (const [key, entry] of Object.entries(models)) {
    if (!isModelKey(key)) {
      out.warnings.push(`ignored memento.models entry ${JSON.stringify(key.slice(0, 80))} in ${file}: not a <provider>/<model id>`);
      continue;
    }
    // Only an explicit true opts in; anything else (false, "true", 1, a missing field) leaves the model off.
    if (!isRecord(entry) || entry.enabled !== true) continue;
    const max = entry.maxGenerations;
    if (max !== undefined && !isCount(max)) out.warnings.push(`ignored memento.models["${key}"].maxGenerations in ${file}: not a non-negative integer`);
    out.models.set(key, { maxGenerations: isCount(max) ? max : null });
  }
  return out;
}

/**
 * Opt a model in (`entry`) or out (null), keeping every other key and model in the file. Atomic,
 * mode 0600. An unreadable file is not overwritten: the caller reports the error instead.
 */
export function writeOptIn(key: string, entry: OptedIn | null, file = optInPath()): void {
  if (!isModelKey(key)) throw new Error(`"${key}" is not a <provider>/<model id>`);
  let existing: Record<string, unknown> = {};
  let text: string | null = null;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    const code = isRecord(error) ? error.code : undefined;
    if (code !== "ENOENT") throw error;
  }
  if (text !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`${file} is not valid JSON; fix or remove it first`);
    }
    if (!isRecord(parsed)) throw new Error(`${file} is not a JSON object; fix or remove it first`);
    existing = parsed;
  }
  const memento = isRecord(existing.memento) ? { ...existing.memento } : {};
  const others = Object.entries(isRecord(memento.models) ? memento.models : {}).filter(([k]) => k !== key);
  if (entry) others.push([key, entry.maxGenerations === null ? { enabled: true } : { enabled: true, maxGenerations: entry.maxGenerations }]);
  memento.models = Object.fromEntries(others);
  const next: Record<string, unknown> = { schemaVersion: 1, ...existing, memento };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** The installed profile: a project `.pi/.pi-kit.json` wins, else `<agent dir>/.pi-kit.json`; null when neither names one. */
export function installedProfile(cwd: string): string | null {
  const project = path.join(cwd, ".pi", ".pi-kit.json");
  const file = fs.existsSync(project) ? project : path.join(agentDir(), ".pi-kit.json");
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    const profile = isRecord(raw) ? raw.profile : undefined;
    return typeof profile === "string" && profile.trim() ? profile.trim() : null;
  } catch {
    return null;
  }
}

export interface Allowance {
  /** Generations a task may use (0: Memento mode is off for it). */
  maxGenerations: number;
  /** Why the number is what it is, for /effort memento status. */
  reason: string;
}

/** The Memento allowance for `model` at a tier allowing `tierMax` generations, in `profile`. */
export function mementoAllowance(input: { tierMax: number; profile: string | null; model: string | null; optIn: OptIn }): Allowance {
  const { tierMax, profile, model, optIn } = input;
  if (!profile || !MEMENTO_PROFILES.includes(profile)) return { maxGenerations: 0, reason: `the ${profile ? `"${profile}"` : "installed"} profile does not allow Memento mode (only ${MEMENTO_PROFILES.join(" and ")} do)` };
  if (!model) return { maxGenerations: 0, reason: "no model is selected" };
  const entry = optIn.models.get(model);
  if (!entry) return { maxGenerations: 0, reason: `${model} is not opted in` };
  if (tierMax === 0) return { maxGenerations: 0, reason: "this effort tier allows no generations" };
  if (entry.maxGenerations !== null && entry.maxGenerations < tierMax) return { maxGenerations: entry.maxGenerations, reason: `${model} is opted in with its own limit of ${entry.maxGenerations}` };
  return { maxGenerations: tierMax, reason: `${model} is opted in; the tier allows ${tierMax}` };
}
