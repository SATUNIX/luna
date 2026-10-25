#!/usr/bin/env node
/**
 * Lockfile integrity gate (supply chain).
 *
 * `npm ci` installs exactly what package-lock.json says, so the lockfile is the attack
 * surface: a tampered `resolved` URL or a dropped `integrity` hash installs arbitrary code
 * without any package.json change. Every tracked `package-lock.json` and `npm-shrinkwrap.json`
 * is checked (`git ls-files`, or a walk of the tree outside `node_modules` when there is no git
 * checkout), so a lockfile added later is covered without editing this file; finding none is a
 * failure. This fails when any locked package:
 *
 *   - resolves from anywhere but https://registry.npmjs.org/ (no http:, git, file or
 *     third-party registries), except the workspace links of this monorepo;
 *   - lacks a sha512 `integrity` hash;
 *   - declares an install-time lifecycle script that is not on the reviewed allowlist
 *     below (CI installs with --ignore-scripts, but a developer `npm install` would run it).
 *
 * Usage: node packages/core/lockfile-check.ts [--list]   (--list prints the lockfiles, one per line,
 * and exits non-zero when it finds none, so a CI loop over its output cannot pass over nothing)
 *
 * Pinned by `tests/lockfile-check-smoke.ts`.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

const LOCKFILE_NAMES = new Set(["package-lock.json", "npm-shrinkwrap.json"]);

/** Every tracked npm lockfile under `root`, repository-relative and sorted. */
export function discoverLockfiles(root: string): string[] {
  let files: string[];
  try {
    files = execFileSync("git", ["ls-files", "-z", "--", "*package-lock.json", "*npm-shrinkwrap.json"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\0").filter(Boolean);
  } catch {
    files = [];
    const walk = (rel: string): void => {
      for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
        const child = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) { if (!["node_modules", ".git"].includes(entry.name)) walk(child); }
        else if (entry.isFile() && LOCKFILE_NAMES.has(entry.name)) files.push(child);
      }
    };
    walk("");
  }
  return files.filter((f) => LOCKFILE_NAMES.has(path.posix.basename(f)) && !f.split("/").includes("node_modules")).sort();
}

/** The problems in one lockfile's text, and how many locked packages it checked. */
export function checkLockfile(text: string, label: string): { checked: number; problems: string[] } {
  let lock: Lockfile;
  try {
    lock = parseJsonAs(LockfileSchema, text, label);
  } catch (error) {
    return { checked: 0, problems: [`${label}: ${error instanceof Error ? error.message : String(error)}`] };
  }
  if (lock.lockfileVersion < 2) return { checked: 0, problems: [`${label}: lockfileVersion < 2 has no per-package integrity data`] };
  const problems: string[] = [];
  let checked = 0;
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    if (key === "" || entry.link) continue; // the root project and workspace symlinks
    if (!key.includes("node_modules/")) continue; // workspace package directories
    checked++;
    const name = key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);
    if (!entry.resolved?.startsWith(REGISTRY)) problems.push(`${label}: ${name}: resolved from ${entry.resolved ?? "(none)"}`);
    if (!entry.integrity?.startsWith("sha512-") && !SHRINKWRAPPED.some((prefix) => key.startsWith(prefix))) problems.push(`${label}: ${name}: missing sha512 integrity`);
    if (entry.hasInstallScript && !INSTALL_SCRIPT_ALLOWLIST.has(name)) problems.push(`${label}: ${name}: has an install script (review it, then allowlist it in packages/core/lockfile-check.ts)`);
  }
  return { checked, problems };
}

/** Print every lockfile under `root`, one per line; returns 1 (with an error) when there is none. */
export function list(root: string, print: (line: string) => void = console.log): number {
  const files = discoverLockfiles(root);
  if (!files.length) {
    console.error(`[lockfile-check] FAIL: --list found no package-lock.json under ${root}`);
    return 1;
  }
  for (const f of files) print(f);
  return 0;
}

/** Check every lockfile under `root`; returns the exit status after printing the result. */
export function run(root: string): number {
  const files = discoverLockfiles(root);
  if (!files.length) {
    console.error(`[lockfile-check] FAIL: no package-lock.json found under ${root}`);
    return 1;
  }
  const problems: string[] = [];
  let checked = 0;
  for (const file of files) {
    const result = checkLockfile(fs.readFileSync(path.join(root, file), "utf8"), file);
    checked += result.checked;
    problems.push(...result.problems);
  }
  if (problems.length) {
    console.error(`[lockfile-check] FAIL: ${problems.length} problem(s) in ${checked} locked packages across ${files.length} lockfile(s)`);
    for (const p of problems) console.error(`  - ${p}`);
    return 1;
  }
  console.log(`[lockfile-check] OK: ${checked} locked packages in ${files.length} lockfile(s) (${files.join(", ")}), all from ${REGISTRY} with sha512 integrity, no unreviewed install scripts`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = process.argv[2] === "--list" ? list(WORKSPACE_ROOT) : run(WORKSPACE_ROOT);
}
