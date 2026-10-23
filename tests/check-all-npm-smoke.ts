#!/usr/bin/env node
/**
 * B-097 regression coverage: the check-suite runner must resolve an npm command
 * that works on Windows (`npm.cmd` + shell), matching pack-check.ts. Also asserts
 * that importing the module no longer runs the suite (is-main guard), so `--list`
 * can be exercised.
 *
 * Deterministic and offline - no pi/docker/network.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { coveredAggregates, resolveNpmCommand, unknownSkips } from "../packages/core/check-all.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

assert.deepEqual(
  resolveNpmCommand("win32"),
  // eslint-disable-next-line no-restricted-syntax -- the expected value: this test pins the win32 npm.cmd shim that needs a shell
  { command: "npm.cmd", shell: true },
  "win32 must use the npm.cmd shim with shell:true",
);
assert.deepEqual(resolveNpmCommand("linux"), { command: "npm", shell: false });
assert.deepEqual(resolveNpmCommand("darwin"), { command: "npm", shell: false });

// Importing the module must not have started the suite; --list runs and exits 0.
const cli = spawnSync(process.execPath, [path.join(ROOT, "packages", "core", "check-all.ts"), "--list"], {
  encoding: "utf8",
});
assert.equal(cli.status, 0, `check-all --list must exit 0 (stderr: ${cli.stderr.trim()})`);
assert.match(cli.stdout, /check-all: \d+ check run\(s\) would run/);

// An aggregate is skipped only when every file it runs is the whole command of another check.
const scripts = {
  "smoke:a": "node tests/a-smoke.mjs",
  "smoke:b": "node tests/b-smoke.mjs",
  "smoke:c": "node tests/c-smoke.mjs --flag",
  "test:agg": "node tests/a-smoke.mjs && node tests/b-smoke.mjs",
  "test:partial": "node tests/a-smoke.mjs && node tests/new-smoke.mjs",
  "test:flagged": "node tests/a-smoke.mjs && node tests/c-smoke.mjs",
  "test:single": "node tests/z-smoke.mjs",
  "test:shell": "node tests/a-smoke.mjs && echo done",
};
const included = Object.keys(scripts);
const covered = coveredAggregates(scripts, included);
assert.deepEqual([...covered.keys()], ["test:agg"], "only a chain fully covered by other checks is skipped");
assert.deepEqual(covered.get("test:agg"), ["smoke:a", "smoke:b"]);
assert.ok(!covered.has("test:partial"), "a chain with a file no other check runs must keep running");
assert.ok(!covered.has("test:flagged"), "a file another check runs with different arguments is not covered");
assert.ok(!covered.has("test:single") && !covered.has("test:shell"), "a single command or a non-node step is never an aggregate");
const twins = coveredAggregates({ "test:x": "node tests/a.mjs && node tests/b.mjs", "test:y": "node tests/a.mjs && node tests/b.mjs" }, ["test:x", "test:y"]);
assert.equal(twins.size, 0, "two chains covering only each other would drop the files entirely, so neither is skipped");

// In this repository the security chain is covered, so check-all lists each of its files once.
const list = spawnSync(process.execPath, [path.join(ROOT, "packages", "core", "check-all.ts"), "--list"], { encoding: "utf8" });
assert.match(list.stdout, /skipping test:security/, "test:security repeats checks that run on their own");
assert.doesNotMatch(list.stdout, /^test:security$/m, "test:security is not run twice");
assert.match(list.stdout, /^smoke:tool-firewall$/m, "its one uncovered file has its own check");

// A --skip name that is not a check is an error (exit 2), not a silent full run.
assert.deepEqual(unknownSkips(new Set(["evl", "eval", "smoke:doc"]), new Set(["eval", "smoke:docs"])), ["evl", "smoke:doc"]);
assert.deepEqual(unknownSkips(new Set(), new Set(["eval"])), []);
const typo = spawnSync(process.execPath, [path.join(ROOT, "packages", "core", "check-all.ts"), "--list", "--skip=evl,smoke:doc"], { encoding: "utf8" });
assert.equal(typo.status, 2, "a misspelt --skip name exits 2");
assert.match(typo.stderr, /--skip names no check: evl, smoke:doc/);
assert.doesNotMatch(typo.stdout, /would run/, "nothing is listed when a skip name is unknown");
const skipped = spawnSync(process.execPath, [path.join(ROOT, "packages", "core", "check-all.ts"), "--list", "--skip=eval,test:security"], { encoding: "utf8" });
assert.equal(skipped.status, 0, `real check names, including an aggregate check-all drops itself, are accepted (stderr: ${skipped.stderr.trim()})`);
assert.doesNotMatch(skipped.stdout, /^eval$/m, "a skipped check is not listed");

console.log("check-all npm smoke: OK");
