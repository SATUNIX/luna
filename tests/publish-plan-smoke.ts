#!/usr/bin/env node
/**
 * The release channel rules (packages/core/publish-plan.ts): which version and which ONE
 * dist-tag a CI publish uses. `latest` must never move backwards and a prerelease must
 * never displace a stable release; main always goes to `next`.
 */
import assert from "node:assert/strict";
import { planPublish } from "../packages/core/publish-plan.ts";

type PublishInput = Parameters<typeof planPublish>[0];
type Case = [name: string, input: PublishInput, expected: string];
const plan = (input: PublishInput) => planPublish(input);

const tag = (v: string) => `refs/tags/v${v}`;
const cases: Case[] = [
  ["first release (beta) becomes latest", { ref: tag("0.2.1-beta.0"), packageVersion: "0.2.1-beta.0", distTags: {} }, "latest"],
  ["newer beta stays latest while there is no stable release", { ref: tag("0.2.1-beta.1"), packageVersion: "0.2.1-beta.1", distTags: { latest: "0.2.1-beta.0" } }, "latest"],
  ["first stable release becomes latest", { ref: tag("0.2.1"), packageVersion: "0.2.1", distTags: { latest: "0.2.1-beta.3" } }, "latest"],
  ["a beta after a stable release goes to beta", { ref: tag("0.3.0-beta.0"), packageVersion: "0.3.0-beta.0", distTags: { latest: "0.2.1" } }, "beta"],
  ["a maintenance release on an old line does not move latest", { ref: tag("0.2.2"), packageVersion: "0.2.2", distTags: { latest: "0.3.0" } }, "release-0.2"],
  ["the next snapshot tag does not affect release rules", { ref: tag("0.2.2"), packageVersion: "0.2.2", distTags: { latest: "0.2.1", next: "0.2.2-next.1.gabcdef0" } }, "latest"],
];
let failed = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  OK: ${name}`);
  } catch (error) {
    failed++;
    console.error(`  FAIL: ${name}\n    ${error instanceof Error ? error.message : String(error)}`);
  }
}
for (const [name, input, expected] of cases) check(name, () => assert.equal(plan(input).tag, expected));
check("main publishes a snapshot to next", () => {
  const snapshot = plan({ ref: "refs/heads/main", packageVersion: "0.2.1-beta.0", sha: "1a2b3c4d", now: new Date("2026-09-24T06:15:00Z") });
  assert.deepEqual(snapshot, { version: "0.2.1-beta.0.next.20260924061500.g1a2b3c4", tag: "next", kind: "snapshot" });
});
check("a tag that does not match package.json is refused", () => assert.throws(() => plan({ ref: tag("0.2.2"), packageVersion: "0.2.1" }), /does not match/));
check("a snapshot tag is refused", () => assert.throws(() => plan({ ref: tag("0.2.1-beta.0.next.1.gabc1234"), packageVersion: "0.2.1-beta.0.next.1.gabc1234" }), /snapshot/));
check("other branches publish nothing", () => assert.throws(() => plan({ ref: "refs/heads/feature", packageVersion: "0.2.1" }), /nothing to publish/));
if (failed) {
  console.error(`\n[publish-plan-smoke] ${failed} check(s) failed`);
  process.exit(1);
}
console.log("\n[publish-plan-smoke] all checks passed");
