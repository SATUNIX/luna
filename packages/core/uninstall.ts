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

const args = process.argv.slice(2);
const has = (flag: string): boolean => args.includes(flag);
const get = (flag: string, def: string): string | undefined => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : def; };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const explicitScope = args.includes("--scope") ? get("--scope", "global") : null;
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

// 3. Remove state marker after every managed removal succeeds.
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
