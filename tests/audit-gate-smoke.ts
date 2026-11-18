#!/usr/bin/env node
/** The root npm audit gate: accepted advisories pass only while dated and dev-only. Offline. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { evaluate, findings, parseExceptions } from "../packages/core/audit-gate.ts";
import { WORKSPACE_ROOT } from "../packages/core/lib/paths.ts";

const toml = `[[IgnoredVulns]]\nid = "GHSA-aaaa-bbbb-cccc"\nignoreUntil = 2030-01-01T00:00:00Z\nreason = "no fix"\n`;
const audit = (sev: string): string => JSON.stringify({ vulnerabilities: {
  pm: { via: [{ name: "pm", severity: sev, url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc" }] },
  dep: { via: ["pm"] },
} });
const now = new Date("2026-11-18T00:00:00Z");
const ex = parseExceptions(toml);

assert.deepEqual(ex.map((e) => e.id), ["GHSA-aaaa-bbbb-cccc"]);
assert.deepEqual(findings(audit("high")), [{ id: "GHSA-aaaa-bbbb-cccc", pkg: "pm", severity: "high" }], "string via entries are dependencies, not advisories");
assert.deepEqual(evaluate(findings(audit("high")), [], ex, now).problems, [], "an accepted dev-only advisory passes");
assert.equal(evaluate(findings(audit("high")), [], [], now).problems.length, 1, "an unaccepted high advisory fails");
assert.equal(evaluate(findings(audit("critical")), findings(audit("critical")), ex, now).problems.length, 1, "an accepted advisory in the production tree still fails");
assert.equal(evaluate(findings(audit("high")), [], ex, new Date("2030-01-02T00:00:00Z")).problems.length, 2, "an expired exception fails, and so does the advisory it covered");
assert.deepEqual(evaluate(findings(audit("moderate")), [], [], now).problems, [], "moderate and below do not block");
assert.equal(evaluate([], [], ex, now).notes.length, 1, "an entry nothing matches is reported for removal");
assert.throws(() => parseExceptions(`[[IgnoredVulns]]\nid = "GHSA-x"\n`), /needs id, ignoreUntil and reason/, "every entry is dated and justified");

// The repository's own list parses, and every entry carries a reason and an expiry.
const own = parseExceptions(fs.readFileSync(path.join(WORKSPACE_ROOT, "osv-scanner.toml"), "utf8"));
assert.ok(own.every((e) => e.reason.length > 20), "each accepted advisory says why");
console.log("  OK: audit gate accepts only dated, dev-only advisories listed in osv-scanner.toml");
console.log("\n[audit-gate-smoke] all checks passed");
