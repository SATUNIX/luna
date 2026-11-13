/**
 * The shipped profile definitions (packages/kit/profiles/<name>.json), read in place.
 *
 * Which profiles weaken approvals by default and which commands a profile pins are properties of
 * the profile files, so they are read here instead of being listed again in code: a new or renamed
 * profile needs no edit in this extension. Self-containment rule: node:* builtins only.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let cached: ReadonlyMap<string, Record<string, unknown>> | undefined;

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
