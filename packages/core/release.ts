#!/usr/bin/env node
/**
 * Release cutter (Epic 8 Sprint 8.2, hardened post-independent-review — H-08). Produces
 * ONE reviewable release commit + an annotated tag `vX.Y.Z`. It runs the full gate first
 * and refuses to release if anything is red.
 *
 * IMPORTANT: this script NEVER pushes. `main` is protected, so the release commit lands through
 * a reviewed merge, and the operator pushes the tag once that commit is on `main`
 * (`git push origin vX.Y.Z`). There is no --push flag. The pushed `v*` tag is the release:
 * installs on the `latest` channel see it through /update, and the GitHub Actions release
 * workflow re-runs the gate (see docs/releasing.md).
 *
 * Usage:
 *   node packages/core/release.ts <version> [--dry-run]
 *   node packages/core/release.ts 0.2.4-beta.1
 *   node packages/core/release.ts 0.2.4
 *   node packages/core/release.ts <version> --bump-only   # sync version fields + lockfile only:
 *                                                          # no gates, no commit, no tag
 *
 * --bump-only is for preparing a release branch: it needs the CHANGELOG section but not a clean
 * tree, and it creates no commit and no tag. Once that change is merged, the operator runs the
 * full command on main, which finds every version field already at <version> and only gates and
 * tags (packages/core/lib/release-plan.ts).
 */
// eslint-disable-next-line no-restricted-imports -- run() takes fixed literal command lines (npm is a .cmd shim on Windows); the version and paths go through execFileSync in git(); tests/release-lockfile-smoke.ts asserts these literal lines
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isRecord, parseJson } from "./lib/guard.ts";
import { WORKSPACE_ROOT, PACKAGES_DIR } from "./lib/paths.ts";
import { SEMVER } from "./lib/semver.ts";
import { planRelease } from "./lib/release-plan.ts";
import { installPinFiles, setInstallPins, setReadmeBadgeVersion } from "./lib/version-badge.ts";

const ROOT = WORKSPACE_ROOT;
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const bumpOnly = args.includes("--bump-only");
const version = args.find((a) => SEMVER.test(a));

function fail(msg: string): never {
  console.error(`[release] FAIL: ${msg}`);
  process.exit(1);
}
// H-08 fix: dry-run previously skipped every gate (`run()` only executed when
// `!dryRun`), so it provided no real preflight evidence. Every READ-ONLY validation gate
// below is now marked `always: true` and genuinely runs in dry-run too; only steps that
// mutate committed source state (the version bump, the lockfile regen, and the final
// git add/commit/tag) stay gated behind `!dryRun`. Surface exports and the docs build
// write only to gitignored `dist/`/`site/`, so they run unconditionally as well.
/** A package.json as a plain record: every key is kept, so a rewrite changes only `version`. */
function readJson(file: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = parseJson(fs.readFileSync(file, "utf8"));
  } catch (error) {
    fail(`invalid JSON in ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed)) fail(`invalid JSON in ${file}: not a JSON object`);
  return parsed;
}

function gitLines(command: string): string[] {
  try {
    return execSync(command, { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
  } catch (error) {
    fail(`git command failed: ${command} (${error instanceof Error ? error.message : String(error)})`);
  }
}

// A fixed command line is a string. Anything that carries the version or a path goes through git() as an argv array to a
// literal `git`, never through a shell.
function run(cmd: string, opts: { always?: boolean } = {}): void {
  console.log(`[release] > ${cmd}`);
  if (!dryRun || opts.always) {
    try {
      execSync(cmd, { cwd: ROOT, stdio: "inherit" });
    } catch (error) {
      fail(`command failed: ${cmd} (${error instanceof Error ? error.message : String(error)})`);
    }
  }
}

function git(args: string[]): void {
  const shown = `git ${args.map((a) => (/^[\w@:/.+=,-]+$/.test(a) ? a : JSON.stringify(a))).join(" ")}`;
  console.log(`[release] > ${shown}`);
  if (dryRun) return;
  try {
    execFileSync("git", args, { cwd: ROOT, stdio: "inherit" });
  } catch (error) {
    fail(`command failed: ${shown} (${error instanceof Error ? error.message : String(error)})`);
  }
}

const escapeRegExp = (text: string): string => text.replace(/[\\^$.*+?()[\]{}|/-]/g, "\\$&");

if (!version) fail("missing <version> (expected X.Y.Z or X.Y.Z-pre.N)");
if (/(^|[.-])next\./.test(version)) fail("snapshot (next) versions are published from main by CI, not released");

// 1. CHANGELOG gate: the version must already have a section (docs before release).
const changelogPath = path.join(ROOT, "CHANGELOG.md");
if (!fs.existsSync(changelogPath)) fail("CHANGELOG.md missing");
const changelog = fs.readFileSync(changelogPath, "utf8");
if (!new RegExp(`^##\\s*\\[${escapeRegExp(version)}\\]`, "m").test(changelog)) {
  fail(`CHANGELOG.md has no "## [${version}]" section — document the release first`);
}

// 2. Clean tree, with NO exclusions (H-08 fix: previously package.json/package-lock.json
// were excluded unconditionally, so arbitrary pre-existing dirty content in either would
// be silently swept into the release commit alongside the version bump this script makes
// itself). Everything, including package.json, must be clean before we touch anything.
const status = bumpOnly ? [] : gitLines("git status --porcelain");
if (status.length > 0) {
  fail(`working tree not clean — commit or stash first:\n${status.join("\n")}`);
}

// 3-4. The version must be new: not tagged, newer than the newest release tag in this clone, and
// not older than package.json (H-08 fix: previously accepted any digit-only version with no
// monotonicity check, so a downgrade or a repeat of an already-shipped version could be tagged as
// if it were new). A version the manifests already carry (the first release, or one prepared
// with --bump-only in a reviewed change) is only gated and tagged; a newer one is bumped and
// committed first. tests/release-plan-smoke.ts covers each case.
const existingTags = gitLines("git tag -l");
const pkgPath = path.join(ROOT, "package.json");
const pkg = readJson(pkgPath);
const prev = typeof pkg.version === "string" ? pkg.version : fail(`${pkgPath} has no string "version"`);
const plan = planRelease(version, prev, existingTags);
if (!plan.ok) fail(plan.reason);
const bump = plan.bump;

// 5. Bump package.json (and every workspace, which versions in lockstep), the README's version
// badge and the install pins in the public docs, and regenerate package-lock.json so the two stay in lockstep -
// previously only package.json was bumped/staged, so the lockfile's root version and
// resolved dependency tree silently drifted from every release onward (F-05).
console.log(`[release] version ${prev} -> ${version}`);
const workspaceManifests = fs
  .readdirSync(PACKAGES_DIR)
  .map((dir) => path.join(PACKAGES_DIR, dir, "package.json"))
  .filter((file) => fs.existsSync(file));
if (!dryRun && (bump || bumpOnly)) {
  pkg.version = version;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  for (const file of workspaceManifests) {
    const ws = readJson(file);
    ws.version = version;
    fs.writeFileSync(file, JSON.stringify(ws, null, 2) + "\n");
  }
  const readmePath = path.join(ROOT, "README.md");
  fs.writeFileSync(readmePath, setReadmeBadgeVersion(fs.readFileSync(readmePath, "utf8"), version));
  for (const file of installPinFiles(ROOT)) {
    const text = fs.readFileSync(file, "utf8");
    const pinned = setInstallPins(text, version);
    if (pinned !== text) fs.writeFileSync(file, pinned);
  }
  run("npm install --package-lock-only --ignore-scripts");
}
if (bumpOnly) {
  console.log(`\n[release] --bump-only: version fields, README badge, install pins and lockfile now say ${version}${dryRun ? " (dry-run: nothing written)" : ""}. No gates were run, nothing was committed or tagged.`);
  process.exit(0);
}

// 6. Full gate. MkDocs is part of it and is the one tool that is not an npm dependency, so find out now, not after
// the whole suite, that it is missing (`run` exits on failure, so a check after it could never report this).
// `npm ci` next, so a lockfile that can't reproduce a clean install blocks the release rather than shipping one
// (F-05's exact failure mode). Then `npm run check:all`: the repository's single definition of "all the checks"
// (what CI runs): the manifest, profile and catalogue checks, every smoke and security suite, the per-profile
// install checks, the clean-install test on the packed tarball, the test-wiring check and the Mermaid check.
// Then the checks that are not npm scripts of that kind: the lockfile check and a real, strict MkDocs build
// (the lighter link checker does not catch every class of broken link; requirements-docs.txt is the prerequisite).
try {
  execSync("python -m mkdocs --version", { cwd: ROOT, stdio: "ignore" });
} catch {
  fail("MkDocs is not installed — the docs build is part of the release gate. Run: python -m pip install --user -r requirements-docs.txt");
}
run("npm ci --dry-run --ignore-scripts", { always: true });
run("npm run check:all", { always: true });
run("node packages/core/lockfile-check.ts", { always: true });
run("python -m mkdocs build --strict", { always: true });

// 7. The one published package packs cleanly and works from its unpacked copy.
run("node packages/core/pack-check.ts", { always: true });

// 8. One reviewable commit + annotated tag. NO push.
if (bump) {
  const manifests = ["package.json", "package-lock.json", ...workspaceManifests.map((f) => path.relative(ROOT, f))];
  git(["add", ...manifests]);
  // The README's version badge and the docs' install pins move with the version.
  git(["add", ...installPinFiles(ROOT).map((f) => path.relative(ROOT, f))]);
  git(["commit", "-m", `chore(release): ${version}`]);
}
git(["tag", "-a", `v${version}`, "-m", `Release ${version}`]);

console.log(`\n[release] Done: ${bump ? "committed + " : ""}tagged v${version} (local only).`);
console.log("[release] NOT pushed. main is protected, so the release lands through review:");
if (bump) console.log("[release]   1. push this branch and merge it into main through a reviewed merge request;");
console.log(`[release]   ${bump ? "2" : "1"}. once the release commit is on main, push the tag: git push origin v${version}`);
console.log(`[release] Pushing the v${version} tag makes it the \`latest\` release for git installs; the GitHub release workflow (manual) re-runs the gate before any npm publish.`);
if (dryRun) console.log("[release] (dry-run: validation gates ran for real; no files changed, no commit/tag created)");
