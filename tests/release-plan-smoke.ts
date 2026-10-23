#!/usr/bin/env node
/**
 * packages/core/lib/release-plan.ts: which versions `npm run release` accepts, and when it bumps
 * and commits instead of only gating and tagging. release.ts acts on this plan
 * (tests/release-lockfile-smoke.ts checks that it does).
 */
import assert from "node:assert/strict";
import { newestReleaseTag, planRelease } from "../packages/core/lib/release-plan.ts";

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

const SHIPPED = ["v0.2.4-beta.1", "v0.2.4-beta.3", "release/v0.2.4-beta.3", "latest", "v1.2"];

const results = [
  check("the newest release tag is found by semver precedence, ignoring tags that are not releases", () => {
    assert.equal(newestReleaseTag(SHIPPED), "v0.2.4-beta.3");
    assert.equal(newestReleaseTag(["v0.2.4-beta.2", "v0.2.4-beta.10", "v0.2.4-beta.9"]), "v0.2.4-beta.10", "beta.10 follows beta.9");
    assert.equal(newestReleaseTag(["v0.2.4-beta.3", "v0.2.4"]), "v0.2.4", "a release follows its prereleases");
    assert.equal(newestReleaseTag(["latest", "next", "v1.2", "release/v0.2.4"]), null);
    assert.equal(newestReleaseTag([]), null);
  }),
  check("the first release tags the version already in package.json, without a bump", () => {
    assert.deepEqual(planRelease("0.2.4-beta.0", "0.2.4-beta.0", []), { ok: true, bump: false, newestTag: null });
  }),
  check("a newer version is bumped, committed and tagged", () => {
    assert.deepEqual(planRelease("0.2.4-beta.4", "0.2.4-beta.3", SHIPPED), { ok: true, bump: true, newestTag: "v0.2.4-beta.3" });
    assert.deepEqual(planRelease("0.2.4", "0.2.4-beta.3", SHIPPED), { ok: true, bump: true, newestTag: "v0.2.4-beta.3" });
  }),
  check("a version --bump-only already wrote is only gated and tagged, even after earlier releases", () => {
    // The release-branch flow: --bump-only moves the fields in a reviewed change, and the full
    // command then runs on main. This used to fail with "not forward of current" once any tag existed.
    assert.deepEqual(planRelease("0.2.4-beta.4", "0.2.4-beta.4", SHIPPED), { ok: true, bump: false, newestTag: "v0.2.4-beta.3" });
  }),
  check("a version that is already tagged is refused", () => {
    assert.deepEqual(planRelease("0.2.4-beta.3", "0.2.4-beta.3", SHIPPED), { ok: false, reason: "tag v0.2.4-beta.3 already exists" });
  }),
  check("a version that is not newer than the newest release is refused, whatever package.json says", () => {
    assert.deepEqual(planRelease("0.2.4-beta.2", "0.2.4-beta.2", SHIPPED), { ok: false, reason: "version 0.2.4-beta.2 is not newer than the latest release v0.2.4-beta.3" });
    assert.deepEqual(planRelease("0.2.4-beta.2", "0.2.4-beta.1", SHIPPED), { ok: false, reason: "version 0.2.4-beta.2 is not newer than the latest release v0.2.4-beta.3" });
  }),
  check("a version older than package.json is refused as a downgrade", () => {
    assert.deepEqual(planRelease("0.2.5", "0.3.0", SHIPPED), { ok: false, reason: "version 0.2.5 is older than the current 0.3.0" });
  }),
  check("a version or a package.json version that is not semver is refused", () => {
    assert.equal(planRelease("0.2.x", "0.2.4-beta.3", SHIPPED).ok, false);
    assert.deepEqual(planRelease("0.2.4", "next", SHIPPED), { ok: false, reason: "package.json version next is not a semver version" });
  }),
];

const failed = results.filter((ok) => !ok).length;
if (failed > 0) {
  console.error(`\n[release-plan-smoke] ${failed}/${results.length} FAILED`);
  process.exit(1);
}
console.log(`\n[release-plan-smoke] all ${results.length} checks passed`);
