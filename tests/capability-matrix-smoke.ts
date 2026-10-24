#!/usr/bin/env node
/**
 * B-096 regression coverage: the capability matrix must include the shipped `lite`
 * profile, and the committed docs/capability-matrix.md must be exactly what the
 * generator emits (so the doc cannot drift from the code).
 *
 * Deterministic and offline - no pi/docker/network.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { capabilityMatrixContent } from "../packages/core/capability-matrix.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const content = capabilityMatrixContent();

// The lite profile ships (packages/kit/profiles/lite.json) and install.ts accepts
// --profile lite, so the matrix must carry a lite column header ...
assert.ok(
  content.includes("| Extension | Category | Status | lite |"),
  "capability matrix must have a `lite` column header",
);

// ... and a lite row in the "Profiles at a glance" table, with its extension count.
interface ProfileFile {
  include?: string[];
}
const liteProfile = JSON.parse(
  fs.readFileSync(path.join(ROOT, "packages", "kit", "profiles", "lite.json"), "utf8"),
) as ProfileFile;
const liteCount = (liteProfile.include ?? []).length;
assert.ok(
  content.includes(`| \`lite\` |`),
  "capability matrix must have a lite row in the profiles table",
);
assert.ok(
  content.includes(`| \`lite\` | Low-context / small local models | T0–T1 | ${liteCount} |`),
  `capability matrix lite row must report ${liteCount} extensions and its task class`,
);

// The committed doc must be byte-identical to a fresh generation.
const docPath = path.join(ROOT, "docs", "capability-matrix.md");
const doc = fs.readFileSync(docPath, "utf8");
assert.equal(
  doc,
  content,
  "docs/capability-matrix.md is stale vs packages/core/capability-matrix.ts (run npm run catalog)",
);

console.log("capability-matrix smoke: OK");
