#!/usr/bin/env node
/**
 * Version for a `next` (main-branch) snapshot publish.
 *
 * Snapshots must sort ABOVE the release they were built after and BELOW the release that
 * follows, because `pi update` only moves forward (semver `gt`):
 *
 *   package.json 0.2.1-beta.0  ->  0.2.1-beta.0.next.20260924061500.g1a2b3c4
 *                                  (> 0.2.1-beta.0, < 0.2.1-beta.1 and 0.2.1)
 *   package.json 0.2.1         ->  0.2.2-next.20260924061500.g1a2b3c4
 *                                  (> 0.2.1, < 0.2.2)
 *
 * The UTC timestamp keeps successive snapshots of one base version ordered; the `g<sha>`
 * suffix records the commit (prefixed so an all-digit sha is never a numeric identifier).
 *
 * Usage:
 *   node packages/core/snapshot-version.ts [--sha <sha>] [--time <ISO>]   # print it
 *   node packages/core/snapshot-version.ts --write                         # also set package.json
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isRecord, parseJson } from "./lib/guard.ts";
import { WORKSPACE_ROOT } from "./lib/paths.ts";

const args = process.argv.slice(2);
const get = (flag: string): string | null | undefined => (args.indexOf(flag) >= 0 ? args[args.indexOf(flag) + 1] : null);

/**
 * The workspace package.json as a plain record (every key kept, so a rewrite changes only what
 * the caller sets) plus its `version` field.
 */
export function readPackageJson(pkgPath: string): { pkg: Record<string, unknown>; version: string } {
  const pkg = parseJson(fs.readFileSync(pkgPath, "utf8"));
  if (!isRecord(pkg)) throw new Error(`${pkgPath} is not a JSON object`);
  const { version } = pkg;
  return { pkg, version: typeof version === "string" ? version : String(version) };
}

export function snapshotVersion(base: string, sha: string, when: Date = new Date()): string {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(base);
  if (!m) throw new Error(`not a release version: ${base}`);
  const [, major, minor, patch, pre] = m;
  if (pre && /(^|\.)next(\.|$)/.test(pre)) throw new Error(`already a snapshot version: ${base}`);
  const stamp = when.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const commit = `g${sha.slice(0, 7).toLowerCase()}`;
  if (!/^g[0-9a-f]{7}$/.test(commit)) throw new Error(`not a git sha: ${sha}`);
  return pre ? `${major}.${minor}.${patch}-${pre}.next.${stamp}.${commit}` : `${major}.${minor}.${Number(patch) + 1}-next.${stamp}.${commit}`;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("snapshot-version.ts")) {
  const pkgPath = path.join(WORKSPACE_ROOT, "package.json");
  const { pkg, version: base } = readPackageJson(pkgPath);
  const sha = get("--sha") ?? process.env.GITHUB_SHA ?? execFileSync("git", ["rev-parse", "HEAD"], { cwd: WORKSPACE_ROOT, encoding: "utf8" }).trim();
  const time = get("--time");
  const when = time ? new Date(time) : new Date();
  const version = snapshotVersion(base, sha, when);
  if (args.includes("--write")) {
    pkg.version = version;
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  }
  console.log(version);
}
