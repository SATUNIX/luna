/**
 * The shipped profile definitions (packages/kit/profiles/<name>.json), read in place.
 *
 * Which profiles weaken approvals by default and which commands a profile pins are properties of
 * the profile files, so they are read here instead of being listed again in code: a new or renamed
 * profile needs no edit in this extension. Self-containment rule: node:* builtins only.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSafe } from "./shared/safe-fs.ts";

/** The agent directory, matching session-helpers/compaction-state.ts (the core reads it too). */
function agentDir(): string {
  const env = process.env.PI_CODING_AGENT_DIR;
  if (env) return env === "~" ? os.homedir() : env.startsWith("~/") ? path.join(os.homedir(), env.slice(2)) : env;
  return path.join(os.homedir(), ".pi", "agent");
}

let cached: ReadonlyMap<string, Record<string, unknown>> | undefined;
let cachedExtensions: string[] | undefined;

/** Profile name -> its parsed JSON object. An unreadable or malformed file is left out. */
export function shippedProfileDefs(): ReadonlyMap<string, Record<string, unknown>> {
  if (cached) return cached;
  const defs = new Map<string, Record<string, unknown>>();
  try {
    const dir = fileURLToPath(new URL("../../../kit/profiles/", import.meta.url));
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
      try {
        const parsed: unknown = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) defs.set(file.slice(0, -".json".length), Object.fromEntries(Object.entries(parsed)));
      } catch {
        /* a malformed profile file is the installer's problem, not the menu's */
      }
    }
  } catch {
    /* no profiles directory: nothing is derived */
  }
  cached = defs;
  return defs;
}

/** Profiles whose firewall default is auto approvals: switching to one weakens the current setting. */
export function autoDefaultProfiles(): string[] {
  const out: string[] = [];
  for (const [name, def] of shippedProfileDefs()) {
    const firewall = def.firewall;
    if (typeof firewall === "object" && firewall !== null && "mode" in firewall && firewall.mode === "auto") out.push(name);
  }
  return out;
}

/** Slash commands a profile pins because it is defined by them (its `pinnedCommands`). */
export function pinnedCommandsOfProfile(name: string): string[] {
  const list = shippedProfileDefs().get(name)?.pinnedCommands;
  return Array.isArray(list) ? list.filter((c): c is string => typeof c === "string") : [];
}

/**
 * The three override lists `pi-kit/overrides.json` carries. The hub calls a prompt template a
 * "package" item because a profile selects the kit's prompt package by name; the file's key stays
 * `prompts`.
 */
export type OverrideKind = "extensions" | "skills" | "prompts";

/** Extensions whose removal widens what the agent may do; a toggle may never switch one off. */
export const MANDATORY_PROTECTIONS: readonly string[] = ["tool-firewall", "secret-guard", "protected-paths"];

export interface OverrideLists {
  extensions: { add: string[]; remove: string[] };
  skills: { exclude: string[]; include: string[] };
  prompts: { exclude: string[]; include: string[] };
}

const OVERRIDES_FILE = "overrides.json";

function overrideNames(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((name): name is string => typeof name === "string" && name.trim() !== "").map((name) => name.trim()) : [];
}

function overrideBlock(value: unknown, keys: readonly string[]): Record<string, string[]> {
  const record = typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  return Object.fromEntries(keys.map((key) => [key, overrideNames(record[key])]));
}

/** `<agent dir>/pi-kit/overrides.json`, normalised; a missing or malformed file reads as empty. */
export function readOverrideLists(): OverrideLists {
  let raw: unknown = {};
  try {
    raw = JSON.parse(fs.readFileSync(path.join(agentDir(), "pi-kit", OVERRIDES_FILE), "utf8"));
  } catch {
    /* no override file yet, or one that cannot be parsed: toggling starts from empty lists */
  }
  const record = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const extensions = overrideBlock(record.extensions, ["add", "remove"]);
  const skills = overrideBlock(record.skills, ["exclude", "include"]);
  const prompts = overrideBlock(record.prompts, ["exclude", "include"]);
  return {
    extensions: { add: extensions.add ?? [], remove: extensions.remove ?? [] },
    skills: { exclude: skills.exclude ?? [], include: skills.include ?? [] },
    prompts: { exclude: prompts.exclude ?? [], include: prompts.include ?? [] },
  };
}

/** Write the override lists atomically through the shared safe-write helper, 0600. */
export function writeOverrideLists(lists: OverrideLists): void {
  const file = path.join(agentDir(), "pi-kit", OVERRIDES_FILE);
  writeFileSafe(file, `${JSON.stringify(lists, null, 2)}\n`, { mode: 0o600 });
}

/** Every extension the kit ships (a directory with extension.json), sorted; `_`-prefixed templates are skipped. */
export function shippedExtensionNames(): string[] {
  if (cachedExtensions) return cachedExtensions;
  const names = new Set<string>();
  for (const base of ["../../../extensions/src/", "../../../extensions/third_party/"]) {
    try {
      for (const entry of fs.readdirSync(fileURLToPath(new URL(base, import.meta.url)), { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith("_")) continue;
        if (fs.existsSync(fileURLToPath(new URL(`${base}${entry.name}/extension.json`, import.meta.url)))) names.add(entry.name);
      }
    } catch {
      /* no extensions directory: only the profiles and overrides are listed */
    }
  }
  cachedExtensions = [...names].sort();
  return cachedExtensions;
}

/** The items each toggle page lists: every shipped extension, every shipped skill/prompt, plus any live override. */
export function overrideItems(kind: OverrideKind, lists: OverrideLists = readOverrideLists()): string[] {
  const names = new Set<string>();
  if (kind === "extensions") {
    for (const def of shippedProfileDefs().values()) {
      const include = def.include;
      if (Array.isArray(include)) for (const name of include) if (typeof name === "string") names.add(name);
    }
    for (const name of shippedExtensionNames()) names.add(name);
    for (const name of [...lists.extensions.add, ...lists.extensions.remove]) names.add(name);
  } else if (kind === "skills") {
    try {
      for (const file of fs.readdirSync(fileURLToPath(new URL("../../../kit/skills/", import.meta.url)))) {
        if (fs.existsSync(fileURLToPath(new URL(`../../../kit/skills/${file}/SKILL.md`, import.meta.url)))) names.add(file);
      }
    } catch {
      /* no skills directory: only the overrides are listed */
    }
    for (const name of [...lists.skills.exclude, ...lists.skills.include]) names.add(name);
  } else {
    try {
      for (const file of fs.readdirSync(fileURLToPath(new URL("../../../kit/prompts/", import.meta.url)))) {
        if (file.endsWith(".md") && file !== "APPEND_SYSTEM.md") names.add(file.slice(0, -3));
      }
    } catch {
      /* no prompts directory: only the overrides are listed */
    }
    for (const name of [...lists.prompts.exclude, ...lists.prompts.include]) names.add(name);
  }
  return [...names].sort();
}

/** Whether an item is currently on under these overrides. */
export function overrideIsOn(kind: OverrideKind, name: string, lists: OverrideLists = readOverrideLists()): boolean {
  if (kind === "extensions") {
    // A name a shipped profile includes is on unless an override removes it. An opt-in extension
    // (auto-commit-on-exit, mcp-router, memory-local, schedule) is off until `add` pins it on.
    const inProfile = [...shippedProfileDefs().values()].some((def) => Array.isArray(def.include) && def.include.includes(name));
    return lists.extensions.add.includes(name) || (inProfile && !lists.extensions.remove.includes(name));
  }
  const list = kind === "skills" ? lists.skills : lists.prompts;
  return !list.exclude.includes(name) || list.include.includes(name);
}

function without(names: readonly string[], name: string): string[] {
  return names.filter((n) => n !== name);
}

function withName(names: readonly string[], name: string): string[] {
  return names.includes(name) ? [...names] : [...names, name];
}

export interface ToggleResult {
  ok: boolean;
  on: boolean;
  message: string;
}

/**
 * Flip one override item and write the file. Off is a removal/exclusion, on clears it (and pins it
 * with the matching include/add list so a profile's own exclusion cannot win). A mandatory
 * protection can be switched on, never off: that would silently drop a safety guard.
 */
export function toggleOverride(kind: OverrideKind, name: string): ToggleResult {
  const lists = readOverrideLists();
  const on = overrideIsOn(kind, name, lists);
  if (on && kind === "extensions" && MANDATORY_PROTECTIONS.includes(name)) {
    return { ok: false, on, message: `${name} is a mandatory protection and stays on` };
  }
  if (kind === "extensions") {
    lists.extensions = on
      ? { add: without(lists.extensions.add, name), remove: withName(lists.extensions.remove, name) }
      : { add: withName(lists.extensions.add, name), remove: without(lists.extensions.remove, name) };
  } else {
    const list = kind === "skills" ? lists.skills : lists.prompts;
    if (on) {
      list.exclude = withName(list.exclude, name);
      list.include = without(list.include, name);
    } else {
      list.exclude = without(list.exclude, name);
      list.include = withName(list.include, name);
    }
  }
  writeOverrideLists(lists);
  return { ok: true, on: !on, message: `${name} is ${on ? "off" : "on"} in the overrides; switch profile to apply it` };
}
