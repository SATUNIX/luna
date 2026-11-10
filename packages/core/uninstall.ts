#!/usr/bin/env node
/**
 * Uninstall pi-system and its managed companion packages.
 * Reads the install state marker: <cwd>/.pi/.pi-kit.json for a project install,
 * otherwise ~/.pi/agent/.pi-kit.json. Without an explicit --scope the project marker
 * in the current directory wins when it exists; otherwise the global marker is used.
 *
 * Usage:
 *   node packages/core/uninstall.ts [--scope <global|project>] [--dry-run] [--yes]
 */
import fs from "node:fs";
import path from "node:path";
import { globalAgentDir, findPackageEntry, KitMarkerSchema, SettingsSchema, type KitMarker } from "./lib/settings.ts";
import { isRecord, parseJson, safeParse } from "./lib/guard.ts";
import { displayCommand, runPi } from "./lib/pi-cli.ts";
import { ownedSettingKeys, profileSettingsPath, readProfileSettingsRecord, removeProfileSettings } from "./lib/profiles.ts";

const args = process.argv.slice(2);
const has = (flag: string): boolean => args.includes(flag);
const get = (flag: string, def: string): string | undefined => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : def; };

// Every argument must be a known flag, and a value flag needs a value that is not another flag:
// a typo such as `--scope bogus` used to be ignored and fall through to the auto-detected scope.
const VALUE_FLAGS = ["--scope"];
const BOOLEAN_FLAGS = ["--dry-run", "--yes"];
const USAGE = "usage: uninstall.ts [--scope global|project] [--dry-run] [--yes]";
for (let i = 0; i < args.length; i++) {
  const arg = args[i] ?? "";
  if (BOOLEAN_FLAGS.includes(arg)) continue;
  const problem = !VALUE_FLAGS.includes(arg)
    ? `unknown argument "${arg}"`
    : args[i + 1] === undefined || String(args[i + 1]).startsWith("--") ? `${arg} needs a value` : null;
  if (problem) {
    console.error(`[uninstall] ${problem}\n${USAGE}`);
    process.exit(1);
  }
  i++;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const scopeArg = args.includes("--scope") ? get("--scope", "global") : null;
if (scopeArg !== null && scopeArg !== "global" && scopeArg !== "project") { console.error(`[uninstall] unknown --scope "${String(scopeArg)}" (expected global or project)\n${USAGE}`); process.exit(1); }
const explicitScope = scopeArg;
const dryRun = has("--dry-run");

// Resolve which marker to read and the effective scope from it:
//   - an explicit --scope forces the location (global -> agent dir, project -> <cwd>/.pi),
//   - otherwise a project marker in the cwd is preferred and the global one is the fallback,
//     so the documented `install.ts --uninstall` from the repo root finds a project install.
const globalMarkerPath = path.join(globalAgentDir(), ".pi-kit.json");
const projectMarkerPath = path.join(process.cwd(), ".pi", ".pi-kit.json");
let markerPath: string;
let effectiveScope: "global" | "project";
if (explicitScope === "project") {
  markerPath = projectMarkerPath;
  effectiveScope = "project";
} else if (explicitScope === "global") {
  markerPath = globalMarkerPath;
  effectiveScope = "global";
} else if (fs.existsSync(projectMarkerPath)) {
  markerPath = projectMarkerPath;
  effectiveScope = "project";
} else {
  markerPath = globalMarkerPath;
  effectiveScope = "global";
}

// pi is run with an argument vector: the kit source and companions come from a state marker file, and are data.
function removeFromPi(source: string): void {
  // Pi remove returns failure for an absent registration. On a retry, earlier
  // successful removals are expected to be absent. Re-read the scoped settings
  // rather than interpreting arbitrary command errors as success.
  const settingsPath = path.join(path.dirname(markerPath), "settings.json");
  if (fs.existsSync(settingsPath)) {
    const parsed = parseJson(fs.readFileSync(settingsPath, "utf8"));
    if (!isRecord(parsed) || (parsed.packages !== undefined && !Array.isArray(parsed.packages))) {
      throw new Error(`Refusing removal with invalid settings at ${settingsPath}`);
    }
    const settings = safeParse(SettingsSchema, parsed, settingsPath);
    if (!settings.ok) throw new Error(`Refusing removal with invalid settings at ${settingsPath}`);
    if (findPackageEntry(settings.value, source, settingsPath) < 0) {
      console.log(`  Already absent: ${source}`);
      return;
    }
  }
  const args = ["remove", source, ...scopeArgs];
  console.log(`  > ${displayCommand(args)}`);
  if (!dryRun) runPi("pi", args);
}

console.log("\n[uninstall] pi-system");
console.log(`  scope:    ${effectiveScope}`);
console.log(`  dry-run:  ${dryRun}`);
console.log("");

// Read state marker
let marker: KitMarker | null = null;
if (fs.existsSync(markerPath)) {
  try {
    const parsed = parseJson(fs.readFileSync(markerPath, "utf8"));
    if (!isRecord(parsed)) throw new Error("the state marker is not a JSON object");
    marker = KitMarkerSchema.parse(parsed, markerPath);
    console.log(`[uninstall] Found state marker: source=${String(marker.kitSource)}, profile=${String(marker.profile)}`);
  } catch {
    console.warn("[uninstall] Could not parse state marker — will attempt removal by current path");
  }
}

const scopeArgs = effectiveScope === "project" ? ["-l"] : [];

// 1. Remove the kit package
const kitSource = marker?.kitSource ?? process.cwd();
let failures = 0;
console.log(`\n[uninstall] Removing kit (${kitSource})...`);
try {
  removeFromPi(kitSource);
} catch (e) {
  failures++;
  console.warn(`[uninstall] WARN: pi remove failed: ${errorMessage(e)}`);
}

// 2. Remove companion externals recorded in the marker (the schema keeps only string entries)
const companions = marker?.companions ?? [];
if (companions.length > 0) {
  console.log(`\n[uninstall] Removing ${companions.length} companion(s)...`);
  for (const src of companions) {
    try { removeFromPi(src); }
    catch (e) {
      failures++;
      console.warn(`[uninstall] WARN: pi remove ${src} failed: ${errorMessage(e)}`);
    }
  }
}

// A partial cleanup is recoverable only while the ownership record still names
// the kit and companions. Do not claim completion or discard it after a failure.
if (failures) {
  console.error(`[uninstall] Incomplete: ${failures} removal(s) failed. State marker retained at ${markerPath}. Resolve the errors and retry the same uninstall command.`);
  process.exit(1);
}

// 3. Hand back the pi settings a profile set (lite's compaction keys) before the marker goes: they
// change pi itself, not only the kit, so plain pi must not keep a small-window profile's numbers.
// Only a global install writes them (settings.json there is machine-global). A failure keeps the
// marker and the record, so the same command can be retried.
if (effectiveScope === "global") {
  const settingsFile = path.join(globalAgentDir(), "settings.json");
  try {
    const owned = readProfileSettingsRecord();
    const keys = ownedSettingKeys(owned);
    if (keys.length > 0) {
      if (dryRun) {
        console.log(`[uninstall] Dry run: would restore or remove ${keys.join(", ")} in ${settingsFile}`);
      } else {
        for (const warning of removeProfileSettings(settingsFile, owned)) console.warn(`[uninstall] WARN: ${warning}`);
        fs.rmSync(profileSettingsPath(), { force: true });
        console.log(`[uninstall] Restored the operator's own ${keys.join(", ")} in ${settingsFile} (the profile's values removed)`);
      }
    }
  } catch (e) {
    console.error(`[uninstall] Incomplete: could not restore the profile's settings in ${settingsFile}: ${errorMessage(e)}. State marker retained at ${markerPath}. Resolve the error and retry the same uninstall command.`);
    process.exit(1);
  }
}

// 4. Remove state marker after every managed removal succeeds.
if (!dryRun && fs.existsSync(markerPath)) {
  fs.unlinkSync(markerPath);
  console.log(`[uninstall] Removed state marker: ${markerPath}`);
}

console.log(`
[uninstall] Done.

Next steps:
  1. Start pi:   pi
  2. Reload:     /reload
  3. Verify:     pi list  (kit should no longer appear)
`);
