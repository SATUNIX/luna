/**
 * Which of Luna's extensions are on, off or failed, as the short list the launch screen prints.
 *
 * "On" is the install marker's extension list (what the installer told pi to load). "Off" is every
 * other extension shipped in the kit. "Failed" is an enabled extension whose manifest says it
 * registers commands or tools but that has none of either in pi: pi isolates a load error to the
 * one extension and reports it separately, so a missing registration is the signal an extension
 * could see. Nothing here reads a path into the output; names only.
 *
 * Self-containment rule: import only node:* builtins and sibling modules.
 */
import fs from "node:fs";
import path from "node:path";

export type BootState = "ok" | "fail" | "off" | "idle";

export interface BootItem {
  name: string;
  state: BootState;
  /** A short reason, only for a failure or an idle extension. */
  note?: string;
}

/** What one shipped extension promises to register, from its `extension.json`. */
export interface ShippedExtension {
  name: string;
  registers: boolean;
  /** The manifest's explicit off switch, when it has one: only that variable at one of those values turns the extension idle. */
  offSwitch?: { env: string; values: string[] } | undefined;
}

/** The extension name a pi source path belongs to (`.../src/<name>/...` or `.../third_party/<name>/...`). */
export function extensionNameOf(sourcePath: string | undefined): string | undefined {
  return /[\\/](?:src|third_party)[\\/]([^\\/]+)[\\/]/.exec(sourcePath ?? "")?.[1];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** True when a parsed `extension.json` lists at least one command or tool under `registers`. */
function promisesRegistration(manifest: unknown): boolean {
  const reg = isRecord(manifest) ? manifest.registers : undefined;
  if (!isRecord(reg)) return false;
  return [reg.tools, reg.commands].some((list) => Array.isArray(list) && list.length > 0);
}

/** The explicit off switch a parsed `extension.json` declares (`offSwitch`), if it declares a well-formed one. */
function declaredOffSwitch(manifest: unknown): ShippedExtension["offSwitch"] {
  const sw = isRecord(manifest) ? manifest.offSwitch : undefined;
  if (!isRecord(sw) || typeof sw.env !== "string" || !Array.isArray(sw.values)) return undefined;
  return { env: sw.env, values: sw.values.filter((value): value is string => typeof value === "string") };
}

/** True when the extension's own off switch is set: a deliberate opt-out is not a failure. A variable the extension merely reads is not a switch. */
function switchedOff(offSwitch: ShippedExtension["offSwitch"], environment: NodeJS.ProcessEnv): boolean {
  return offSwitch?.values.includes(environment[offSwitch.env] ?? "\u0000unset") === true;
}

/** Every shipped extension and whether its manifest says it registers a command or a tool. */
export function readShipped(kitRoot: string): ShippedExtension[] {
  const out: ShippedExtension[] = [];
  for (const group of ["src", "third_party"]) {
    const dir = path.join(kitRoot, "packages", "extensions", group);
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.startsWith("_") || name.startsWith(".")) continue;
      try {
        const manifest: unknown = JSON.parse(fs.readFileSync(path.join(dir, name, "extension.json"), "utf8"));
        out.push({ name, registers: promisesRegistration(manifest), offSwitch: declaredOffSwitch(manifest) });
      } catch {
        continue; // not an extension directory
      }
    }
  }
  return out;
}

/** Classify every extension. `seen` is the set of extension names pi currently has a command or tool for. */
export function classify(enabled: readonly string[], shipped: readonly ShippedExtension[], seen: ReadonlySet<string>, environment: NodeJS.ProcessEnv = process.env): BootItem[] {
  const on = new Set(enabled);
  const byName = new Map(shipped.map((entry) => [entry.name, entry]));
  const names = [...new Set([...enabled, ...shipped.map((entry) => entry.name)])].sort();
  return names.map((name): BootItem => {
    if (!on.has(name)) return { name, state: "off" };
    const entry = byName.get(name);
    if (entry?.registers === true && !seen.has(name)) {
      return switchedOff(entry.offSwitch, environment) ? { name, state: "idle", note: "switched off by an environment variable" } : { name, state: "fail", note: "registered nothing" };
    }
    return { name, state: "ok" };
  });
}
