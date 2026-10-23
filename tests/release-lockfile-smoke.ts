#!/usr/bin/env node
/**
 * packages/core/release.ts regression coverage (F-05 lockfile maintenance + H-08 release-cutter
 * safety). A full functional test would need real `npm install --package-lock-only`
 * network access and mutate git state, which this repo's test suite deliberately avoids
 * (see packages/core/eval/harness.ts and every other tests/*.mjs - all offline, no network, no
 * git mutation). Instead this asserts against the script's own source, the same static-
 * analysis technique packages/core/verify.ts already uses for its security pattern parity check.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = fs.readFileSync(path.join(ROOT, "packages", "core", "release.ts"), "utf8");

function check(name: string, fn: () => void): boolean {
  try {
    fn();
    console.log(`  OK: ${name}`);
    return true;
  } catch (error: unknown) {
    console.error(`  FAIL: ${name}`);
    console.error(`    ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

const results = [
  // F-05: lockfile maintenance.
  check("version bump regenerates the lockfile", () => {
    assert.match(src, /npm install --package-lock-only/, "must run `npm install --package-lock-only` after bumping package.json");
  }),
  check("release gate verifies the lockfile reproduces a clean install", () => {
    assert.match(src, /npm ci --dry-run/, "must run `npm ci --dry-run` as part of the release gate (F-05's exact failure mode)");
  }),
  check("release commit stages package-lock.json alongside package.json", () => {
    assert.match(src, /\["package\.json", "package-lock\.json", \.\.\.workspaceManifests/, "the release commit must include package-lock.json and every workspace manifest");
    assert.match(src, /git\(\["add", \.\.\.installPinFiles\(ROOT\)/, "the release commit must include README.md and the pinned docs (the version badge and install pins move with the version)");
    assert.match(src, /setInstallPins\(text, version\)/, "the version bump must move the docs' install pins");
    assert.match(src, /git\(\["add", \.\.\.manifests\]\)/, "the release commit must stage those manifests");
    assert.doesNotMatch(src, /run\(`git (?:add|commit|tag)[^`]*\$\{/, "git commands that carry the version or a path are argv arrays, never shell strings");
  }),

  // H-08: release-cutter safety.
  check("clean-tree check has no package.json/package-lock.json exemption", () => {
    assert.doesNotMatch(
      src,
      /filter\(\(l\)\s*=>\s*!\/package/,
      "the clean-tree check must not exempt package.json/package-lock.json from requiring a clean tree - doing so let arbitrary dirty content be swept into the release commit",
    );
  }),
  check("version must be new: release.ts acts on the release plan", () => {
    // packages/core/lib/release-plan.ts decides (tests/release-plan-smoke.ts covers its cases): not tagged, newer than the
    // newest release tag, not older than package.json; a version the manifests already carry is only gated and tagged.
    assert.match(src, /const plan = planRelease\(version, prev, existingTags\);/, "must plan the release from the version, package.json's version and the existing tags");
    assert.match(src, /if \(!plan\.ok\) fail\(plan\.reason\);/, "must refuse with the plan's reason");
    assert.match(src, /if \(bump\) \{\s*const manifests/, "the release commit must happen only when the plan bumps");
    assert.doesNotMatch(src, /git push origin main/, "main is protected: release.ts must not tell the operator to push main directly");
  }),
  check("release gate is check:all (every profile, every suite, the clean install) plus the package and lockfile checks", () => {
    // `npm run check:all` is the repository's single definition of "all the checks" (docs/releasing.md): a narrower list in
    // the release script would let a new suite or profile go unrun at release time. It covers verify, eval, the per-profile
    // install checks, every smoke and security suite and the clean-install test.
    assert.match(src, /run\("npm run check:all", \{ always: true \}\)/, "the release gate must run `npm run check:all`");
    assert.doesNotMatch(src, /run\("node packages\/core\/verify\.ts"/, "a hand-picked subset of the checks must not replace check:all");
    assert.match(src, /pack-check\.ts/, "must prove the published package packs and works from its unpacked copy");
    assert.match(src, /lockfile-check\.ts/, "must run the lockfile integrity check");
  }),
  check("release gate runs a real, strict MkDocs build, and says up front when MkDocs is missing", () => {
    assert.match(src, /run\("python -m mkdocs build --strict", \{ always: true \}\)/, "must run a real `mkdocs build --strict`, not only the lighter custom link-checker");
    // `run` exits on failure, so a try/catch around it can never report a missing tool: the preflight has to come first.
    const preflight = src.indexOf('execSync("python -m mkdocs --version"');
    assert.ok(preflight > 0, "must check that MkDocs is installed before the long gate");
    assert.ok(preflight < src.indexOf('run("npm run check:all"'), "the MkDocs preflight must come before the long gate, not after it");
    assert.doesNotMatch(src, /try\s*\{\s*run\(/, "a try/catch around run() is dead code: run() exits the process on failure");
  }),
  check("dry-run actually exercises the validation gates", () => {
    const alwaysCount = (src.match(/\{\s*always:\s*true\s*\}/g) ?? []).length;
    assert.ok(alwaysCount >= 5, `every validation gate must run even in --dry-run (found ${alwaysCount} \`always: true\` gates, expected >= 5: npm ci, check:all, lockfile, mkdocs, pack-check) - a dry-run that skips every gate provides no real preflight evidence`);
  }),
];

const failed = results.filter(r => !r).length;
if (failed > 0) {
  console.error(`\n[release-lockfile-smoke] ${failed}/${results.length} FAILED`);
  process.exit(1);
}
console.log(`\n[release-lockfile-smoke] all ${results.length} checks passed`);
