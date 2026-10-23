#!/usr/bin/env node
/**
 * Lockfile integrity gate (supply chain).
 *
 * `npm ci` installs exactly what package-lock.json says, so the lockfile is the attack
 * surface: a tampered `resolved` URL or a dropped `integrity` hash installs arbitrary code
 * without any package.json change. This fails when any locked package:
 *
 *   - resolves from anywhere but https://registry.npmjs.org/ (no http:, git, file or
 *     third-party registries), except the workspace links of this monorepo;
 *   - lacks a sha512 `integrity` hash;
 *   - declares an install-time lifecycle script that is not on the reviewed allowlist
 *     below (CI installs with --ignore-scripts, but a developer `npm install` would run it).
 *
 * Usage: node packages/core/lockfile-check.ts
 */
import fs from "node:fs";
import path from "node:path";
import { boolean, number, object, optional, parseJsonAs, record, string, type Infer } from "./lib/guard.ts";
import { WORKSPACE_ROOT } from "./lib/paths.ts";

const REGISTRY = "https://registry.npmjs.org/";
// Reviewed packages that ship install scripts. Add an entry only after reading the script.
// All three arrive through the pi framework (a dev dependency here, used for type checks).
const INSTALL_SCRIPT_ALLOWLIST = new Set([
  "@google/genai", // preinstall: `echo 'preinstall: no-op'`
  "esbuild", // postinstall: `node install.js`, selects/validates the platform binary package
  "protobufjs", // postinstall: `node scripts/postinstall`, version-compat notice for its CLI
]);
// pi ships an npm-shrinkwrap.json; npm copies its nested entries into our lockfile without
// integrity hashes (npm still verifies them against the registry at install time). The
// registry-origin rule still applies to them.
const SHRINKWRAPPED = ["node_modules/@earendil-works/pi-coding-agent/node_modules/"];

/** The package-lock.json fields this gate reads (npm writes many more; they are ignored). */
const LockedPackageSchema = object({
  link: optional(boolean()),
  resolved: optional(string()),
  integrity: optional(string()),
  hasInstallScript: optional(boolean()),
});
const LockfileSchema = object({
  lockfileVersion: number(),
  packages: optional(record(LockedPackageSchema)),
});
export type Lockfile = Infer<typeof LockfileSchema>;

let lock: Lockfile;
try {
  lock = parseJsonAs(LockfileSchema, fs.readFileSync(path.join(WORKSPACE_ROOT, "package-lock.json"), "utf8"), "package-lock.json");
} catch (error) {
  console.error(`[lockfile-check] FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
if (lock.lockfileVersion < 2) {
  console.error("[lockfile-check] FAIL: lockfileVersion < 2 has no per-package integrity data");
  process.exit(1);
}

const problems: string[] = [];
let checked = 0;
for (const [key, entry] of Object.entries(lock.packages ?? {})) {
  if (key === "" || entry.link) continue; // the root project and workspace symlinks
  if (!key.includes("node_modules/")) continue; // workspace package directories
  checked++;
  const name = key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);
  if (!entry.resolved?.startsWith(REGISTRY)) problems.push(`${name}: resolved from ${entry.resolved ?? "(none)"}`);
  if (!entry.integrity?.startsWith("sha512-") && !SHRINKWRAPPED.some((prefix) => key.startsWith(prefix))) problems.push(`${name}: missing sha512 integrity`);
  if (entry.hasInstallScript && !INSTALL_SCRIPT_ALLOWLIST.has(name)) problems.push(`${name}: has an install script (review it, then allowlist it in packages/core/lockfile-check.ts)`);
}

if (problems.length) {
  console.error(`[lockfile-check] FAIL: ${problems.length} problem(s) in ${checked} locked packages`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`[lockfile-check] OK: ${checked} locked packages, all from ${REGISTRY} with sha512 integrity, no unreviewed install scripts`);
