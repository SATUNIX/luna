/**
 * User profiles: an operator's own profile, kept beside the kit's configuration and built from one of
 * the shipped profiles (a "base") or from blank.
 *
 *   <agent dir>/pi-kit/profiles/<name>.json
 *   {
 *     "name": "<name>",                          the file's own name, lower-case letters, digits and -
 *     "description": "...",                      optional
 *     "extends": "<base>" | "blank",             a shipped profile, or only the extensions every install needs
 *     "extensions": { "add": [], "remove": [] }, optional
 *     "skills":     { "exclude": [] },           optional, added to the base's exclusions
 *     "prompts":    { "exclude": [] }            optional, added to the base's exclusions
 *   }
 *
 * A user profile changes what loads and nothing about the gate: it inherits the base's firewall
 * policy and mode, its security level and its settings block, so it can never run with a weaker gate
 * than the profile it names (blank takes the defaults: firewall coding/manual, security balanced).
 * Its `remove` list may never name a mandatory protection or an extension every install requires;
 * such a profile is refused whole, never applied without the removal. Unknown keys are refused too,
 * so a misspelt field is an error, not a silent no-op.
 *
 * The installer (`packages/core/lib/profiles.ts`) and the `/profile` command (session-helpers) both
 * read user profiles through this file, so they agree on what a profile loads.
 * tests/user-profiles-smoke.ts pins each rule.
 */
import fs from "node:fs";
import path from "node:path";
import { createFileExclusive } from "./safe-fs.ts";

/** Extensions whose removal widens what the agent may do. */
export const MANDATORY_PROTECTIONS: readonly string[] = ["tool-firewall", "secret-guard", "protected-paths"];

/**
 * What a blank profile loads: distribution.json's requiredProfileExtensions plus every mandatory
 * protection (tests/user-profiles-smoke.ts checks the list against distribution.json).
 */
export const BLANK_INCLUDE: readonly string[] = ["tool-firewall", "protected-paths", "secret-guard", "delegation-guard", "effort", "session-helpers"];

export const BLANK = "blank";
const NAME = /^[a-z][a-z0-9-]{0,39}$/;
const TOP_KEYS = new Set(["name", "description", "extends", "extensions", "skills", "prompts"]);

export interface UserProfile {
  name: string;
  description: string;
  extends: string;
  extensions: { add: string[]; remove: string[] };
  skills: { exclude: string[] };
  prompts: { exclude: string[] };
}

/** Where user profiles live for an agent directory. */
export function userProfilesDir(agentDir: string): string {
  return path.join(agentDir, "pi-kit", "profiles");
}

/** A profile name, shipped or the operator's: never a path (the installer's --profile is checked with it). */
export const isProfileName = (name: string): boolean => NAME.test(name);
export const isUserProfileName = (name: string): boolean => NAME.test(name) && name !== BLANK;
/** An extension, skill or prompt name: a plain name, never a path. */
const ITEM = /^[a-z0-9][a-z0-9._-]{0,99}$/;
/** The largest user profile file read. */
export const USER_PROFILE_MAX_BYTES = 64 * 1024;

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

function names(value: unknown, where: string, problems: string[]): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((n): n is string => typeof n === "string" && n.trim() !== "")) {
    problems.push(`${where} must be a list of names`);
    return [];
  }
  const bad = value.map((n) => n.trim()).filter((n) => !ITEM.test(n) || n.includes(".."));
  if (bad.length) {
    problems.push(`${where} names ${bad.map((n) => JSON.stringify(n)).join(", ")}: use plain names (lower-case letters, digits, . _ -), never a path`);
    return [];
  }
  return [...new Set(value.map((n) => n.trim()))];
}

function block(value: unknown, where: string, keys: readonly string[], problems: string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const k of keys) out[k] = [];
  if (value === undefined) return out;
  if (!isRecord(value)) {
    problems.push(`${where} must be an object with ${keys.join(" and ")}`);
    return out;
  }
  for (const k of Object.keys(value)) if (!keys.includes(k)) problems.push(`${where}.${k} is not a known field (known: ${keys.join(", ")})`);
  for (const k of keys) out[k] = names(value[k], `${where}.${k}`, problems);
  return out;
}

/**
 * A user profile from JSON, checked: the value, the file stem it was read from, the shipped base
 * names and the extensions every install requires. Returns the profile, or every problem found.
 */
export function parseUserProfile(
  value: unknown,
  stem: string,
  bases: readonly string[],
  required: readonly string[] = BLANK_INCLUDE,
): { ok: true; profile: UserProfile } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  if (!isRecord(value)) return { ok: false, problems: ["a user profile must be a JSON object"] };
  for (const k of Object.keys(value)) if (!TOP_KEYS.has(k)) problems.push(`"${k}" is not a known field (known: ${[...TOP_KEYS].join(", ")})`);
  const name = value.name;
  if (typeof name !== "string" || name !== stem) problems.push(`"name" must be "${stem}", the file's own name`);
  if (!isUserProfileName(stem)) problems.push(`"${stem}" is not a profile name: use lower-case letters, digits and -, starting with a letter, and not "${BLANK}"`);
  if (bases.includes(stem)) problems.push(`"${stem}" is a shipped profile; give yours another name`);
  const description = value.description;
  if (description !== undefined && typeof description !== "string") problems.push(`"description" must be text`);
  const base = value.extends;
  if (typeof base !== "string" || (base !== BLANK && !bases.includes(base))) {
    problems.push(`"extends" must name a shipped profile or "${BLANK}" (known: ${[...bases, BLANK].join(", ")})`);
  }
  const ext = block(value.extensions, "extensions", ["add", "remove"], problems);
  const skills = block(value.skills, "skills", ["exclude"], problems);
  const prompts = block(value.prompts, "prompts", ["exclude"], problems);
  for (const n of ext.remove ?? []) {
    if (MANDATORY_PROTECTIONS.includes(n)) problems.push(`extensions.remove names the mandatory protection "${n}"; a user profile cannot switch a safety guard off`);
    else if (required.includes(n)) problems.push(`extensions.remove names "${n}", which every install loads`);
  }
  if (problems.length) return { ok: false, problems };
  return {
    ok: true,
    profile: {
      name: stem,
      description: typeof description === "string" ? description.trim() : "",
      extends: String(base),
      extensions: { add: ext.add ?? [], remove: ext.remove ?? [] },
      skills: { exclude: skills.exclude ?? [] },
      prompts: { exclude: prompts.exclude ?? [] },
    },
  };
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/**
 * The profile definition a user profile stands for, in the shipped profiles' shape: the base's
 * definition (`baseDef`, ignored for blank) with the include list, skill and prompt exclusions
 * changed, and the base's gate (firewall, security level, settings) carried over unchanged.
 */
export function resolveUserProfile(profile: UserProfile, baseDef: unknown): Record<string, unknown> {
  const base: Record<string, unknown> = profile.extends !== BLANK && isRecord(baseDef) ? baseDef : {};
  const remove = new Set(profile.extensions.remove);
  const include = (profile.extends === BLANK ? [...BLANK_INCLUDE] : strings(base.include)).filter((n) => !remove.has(n));
  for (const n of profile.extensions.add) if (!include.includes(n)) include.push(n);
  // A base with an `only` allowlist (lite) drops the excluded names from it, since a profile may set
  // only one of `only` and `exclude`; any other base adds them to its own exclusions.
  const merge = (from: unknown, extra: readonly string[]): Record<string, unknown> | undefined => {
    const own = isRecord(from) ? from : {};
    if (Array.isArray(own.only)) return { ...own, only: strings(own.only).filter((n) => !extra.includes(n)) };
    const exclude = [...new Set([...strings(own.exclude), ...extra])];
    const out: Record<string, unknown> = { ...own, ...(exclude.length ? { exclude } : {}) };
    return Object.keys(out).length ? out : undefined;
  };
  const skills = merge(base.skills, profile.skills.exclude);
  const prompts = merge(base.prompts, profile.prompts.exclude);
  // A shipped profile with no securityLevel gets its default by name (profileSecurityLevel in
  // lib/profiles.ts), which a user profile's own name would lose: the level is written out.
  const securityLevel = base.securityLevel ?? (profile.extends === "engagement" ? "guarded" : "balanced");
  const description = profile.description || `Your profile, based on ${profile.extends}.`;
  return {
    ...base,
    name: profile.name,
    description,
    securityLevel,
    ...(skills ? { skills } : {}),
    ...(prompts ? { prompts } : {}),
    include,
  };
}

/**
 * Read and resolve `<dir>/<name>.json`. `readBase(name)` returns a shipped profile's raw definition.
 * Null when there is no such user profile; problems when there is one and it cannot be used.
 */
export function loadUserProfile(
  dir: string,
  name: string,
  bases: readonly string[],
  readBase: (base: string) => unknown,
  required: readonly string[] = BLANK_INCLUDE,
): { ok: true; profile: UserProfile; def: Record<string, unknown> } | { ok: false; problems: string[] } | null {
  if (!isUserProfileName(name)) return null;
  const file = path.join(dir, `${name}.json`);
  const read = readOwnFile(dir, file);
  if (read === null) return null;
  if ("problem" in read) return { ok: false, problems: [read.problem] };
  let value: unknown;
  try { value = JSON.parse(read.text); } catch (error) {
    return { ok: false, problems: [`${file} is not valid JSON (${error instanceof Error ? error.message : String(error)})`] };
  }
  const parsed = parseUserProfile(value, name, bases, required);
  if (!parsed.ok) return { ok: false, problems: parsed.problems.map((p) => `${file}: ${p}`) };
  return { ok: true, profile: parsed.profile, def: resolveUserProfile(parsed.profile, parsed.profile.extends === BLANK ? null : readBase(parsed.profile.extends)) };
}

const uid = (): number | null => (typeof process.getuid === "function" ? process.getuid() : null);

/** Problems with a directory a profile is read from: a link, not a directory, another owner, writable by others. */
function dirProblem(dir: string): string | null {
  let st: fs.Stats;
  try { st = fs.lstatSync(dir); } catch { return null; }
  if (st.isSymbolicLink()) return `${dir} is a symbolic link; user profiles are not read through one`;
  if (!st.isDirectory()) return `${dir} is not a directory`;
  const me = uid();
  if (me !== null && st.uid !== me) return `${dir} is owned by another user`;
  if (me !== null && (st.mode & 0o022) !== 0) return `${dir} is writable by its group or by everyone`;
  return null;
}

/**
 * A user profile file's text, read without following links: the profiles directory and its parent
 * must be real directories you own that neither your group nor others can write, and the file must
 * be a regular file you own, writable by you alone, with one link and at most USER_PROFILE_MAX_BYTES. Null when absent.
 */
function readOwnFile(dir: string, file: string): { text: string } | { problem: string } | null {
  let first: fs.Stats;
  try { first = fs.lstatSync(file); } catch { return null; }
  // Not even opened unless it is a regular file: a FIFO would block the open, a device the read.
  if (first.isSymbolicLink()) return { problem: `${file} is a symbolic link; user profiles are not read through one` };
  if (!first.isFile()) return { problem: `${file} is not a regular file` };
  for (const d of [path.dirname(dir), dir]) {
    const problem = dirProblem(d);
    if (problem) return { problem };
  }
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  } catch (error) {
    const code = isRecord(error) ? error.code : undefined;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    if (code === "ELOOP") return { problem: `${file} is a symbolic link; user profiles are not read through one` };
    return { problem: `${file} cannot be read (${error instanceof Error ? error.message : String(error)})` };
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { problem: `${file} is not a regular file` };
    if (st.nlink !== 1) return { problem: `${file} has more than one link` };
    if (st.size > USER_PROFILE_MAX_BYTES) return { problem: `${file} is ${String(st.size)} bytes; the limit is ${String(USER_PROFILE_MAX_BYTES)}` };
    const me = uid();
    if (me !== null && st.uid !== me) return { problem: `${file} is owned by another user` };
    if (me !== null && (st.mode & 0o022) !== 0) return { problem: `${file} is writable by its group or by everyone` };
    return { text: fs.readFileSync(fd, "utf8") };
  } finally {
    fs.closeSync(fd);
  }
}

/** The user profile names in `dir`, sorted (files with a valid name only). */
export function listUserProfiles(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).filter(isUserProfileName).sort();
  } catch {
    return [];
  }
}

/**
 * Create `<dir>/<name>.json` from a base or blank, with empty add and remove lists. Never overwrites:
 * an existing profile of that name is an error. The file is 0600 in a 0700 directory.
 */
export function createUserProfile(dir: string, name: string, base: string, bases: readonly string[]): { ok: true; file: string } | { ok: false; problem: string } {
  const value = { name, extends: base, extensions: { add: [], remove: [] } };
  const parsed = parseUserProfile(value, name, bases);
  if (!parsed.ok) return { ok: false, problem: parsed.problems.join("; ") };
  const file = path.join(dir, `${name}.json`);
  try {
    if (!createFileExclusive(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })) return { ok: false, problem: `${file} already exists` };
  } catch (error) {
    return { ok: false, problem: error instanceof Error ? error.message : String(error) };
  }
  return { ok: true, file };
}
