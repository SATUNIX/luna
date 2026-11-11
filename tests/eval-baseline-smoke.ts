#!/usr/bin/env node
/**
 * Dated eval baseline (board PG-27). `packages/core/eval/baseline.ts` records the offline fixture
 * suite's success rate, per-category counts and a chars/4 token estimate as `baselines/YYYY-MM-DD.json`,
 * and `--check` fails closed when the newest record is missing, malformed, or older than 7 days.
 *
 * Deterministic and offline: a temp workspace holds every file this test writes, the CLI runs under
 * the same temp directories, and the pure helpers are exercised without touching the checkout. The
 * real `--write` path spawns the whole eval suite once, which is the only slow case here.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isolateKitEnv, rmWorkspace, ROOT, tmpWorkspace } from "../packages/core/eval/harness.ts";
import {
  baselineAgeDays,
  BaselineSchema,
  canonicalSummaryText,
  checkBaselineDir,
  estimateTokens,
  summarise,
  type Baseline,
  type EvalRun,
} from "../packages/core/eval/baseline.ts";
import { parseJsonAs } from "../packages/core/lib/guard.ts";

const SCRIPT = path.join(ROOT, "packages", "core", "eval", "baseline.ts");

/** A tiny valid run payload: enough to unit-test the pure summariser and to seed dated files. */
const SAMPLE_RUN: EvalRun = {
  total: 2,
  passed: 1,
  failed: 1,
  results: [
    { name: "beta", category: "verification", pass: false },
    { name: "alpha", category: "security", pass: true },
  ],
};

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: "utf8", timeout: 240_000 });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** Write a schema-valid baseline file for `dir` under `date`, using the pure summariser. */
function writeBaselineFile(dir: string, date: string, run: EvalRun = SAMPLE_RUN): Baseline {
  const baseline = summarise(run, date, `${date}T00:00:00.000Z`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${date}.json`), JSON.stringify(baseline, null, 2) + "\n");
  return baseline;
}

// ---- a. --write: one dated file, matching date, 17/17, per-category counts, tokens -----------

function testWrite(): void {
  const ws = tmpWorkspace("pi-eval-baseline-write-");
  try {
    const dir = path.join(ws, "baselines");
    const { status, stderr } = runCli(["--write", "--dir", dir]);
    assert.equal(status, 0, `--write must exit 0: ${stderr}`);

    const files = fs.readdirSync(dir);
    assert.equal(files.length, 1, `--write produces exactly one file, saw ${files.join(", ")}`);
    const name = files[0];
    assert.ok(name !== undefined && /^\d{4}-\d{2}-\d{2}\.json$/.test(name), `unexpected baseline filename ${String(name)}`);

    const baseline = parseJsonAs(BaselineSchema, fs.readFileSync(path.join(dir, name), "utf8"), name);
    assert.equal(baseline.date, name.slice(0, 10), "the embedded date matches the filename");

    assert.equal(baseline.fixtures.total, 17, "the suite has 17 fixtures");
    assert.equal(baseline.fixtures.passed, 17, "all 17 fixtures pass");
    assert.equal(baseline.fixtures.failed, 0, "none fail");
    assert.equal(baseline.fixtures.successRate, 1, "successRate is 1 when everything passes");

    assert.deepEqual(
      Object.keys(baseline.perCategory).sort(),
      ["memory", "orchestration", "recovery", "security", "verification"],
      "every fixture category is recorded",
    );
    const expected: Record<string, { total: number; passed: number; failed: number; successRate: number }> = {
      security: { total: 3, passed: 3, failed: 0, successRate: 1 },
      verification: { total: 4, passed: 4, failed: 0, successRate: 1 },
      orchestration: { total: 3, passed: 3, failed: 0, successRate: 1 },
      recovery: { total: 3, passed: 3, failed: 0, successRate: 1 },
      memory: { total: 4, passed: 4, failed: 0, successRate: 1 },
    };
    for (const [category, stats] of Object.entries(expected)) {
      const recorded = baseline.perCategory[category];
      assert.ok(recorded, `${category} is recorded`);
      assert.deepEqual({ ...recorded }, stats, `${category} counts match the fixture suite`);
    }

    assert.ok(Number.isFinite(baseline.tokens) && baseline.tokens > 0, `tokens is a finite positive number (${String(baseline.tokens)})`);
    assert.ok(baseline.tokensBasis.length > 0, "tokensBasis explains the estimate");

    // A fresh record checks out.
    const fresh = runCli(["--check", "--dir", dir]);
    assert.equal(fresh.status, 0, `--check on a fresh baseline exits 0: ${fresh.stderr}`);
  } finally {
    rmWorkspace(ws);
  }
}

// ---- b. --check fails closed: empty, stale, malformed; ignores non-matching files -------------

function testCheckEmptyAndStale(): void {
  const ws = tmpWorkspace("pi-eval-baseline-check-");
  try {
    const empty = path.join(ws, "empty");
    fs.mkdirSync(empty, { recursive: true });
    const emptyCli = runCli(["--check", "--dir", empty]);
    assert.equal(emptyCli.status, 1, "an empty baseline dir fails the check");
    assert.deepEqual(checkBaselineDir(empty, new Date("2026-01-01T00:00:00Z")).ok, false, "the pure check agrees");

    const stale = path.join(ws, "stale");
    writeBaselineFile(stale, "2020-01-01");
    const staleCli = runCli(["--check", "--dir", stale]);
    assert.equal(staleCli.status, 1, "a 2020 baseline fails the check");
    assert.match(staleCli.stderr, /7.day/, "the failure names the 7-day freshness window");
  } finally {
    rmWorkspace(ws);
  }
}

// ---- c. the 7-day boundary, the newest file, malformed records, and ignored files -------------

function testCheckBoundaryNewestMalformed(): void {
  const ws = tmpWorkspace("pi-eval-baseline-boundary-");
  try {
    const dir = path.join(ws, "dated");
    writeBaselineFile(dir, "2026-01-01");

    assert.equal(baselineAgeDays("2026-01-01", new Date("2026-01-08T00:00:00Z")), 7, "exactly 7 days is age 7");
    assert.equal(checkBaselineDir(dir, new Date("2026-01-08T00:00:00Z")).ok, true, "exactly 7 days is still fresh");
    assert.equal(baselineAgeDays("2026-01-01", new Date("2026-01-09T00:00:00Z")), 8, "8 days is age 8");
    const eight = checkBaselineDir(dir, new Date("2026-01-09T00:00:00Z"));
    assert.equal(eight.ok, false, "8 days fails");
    assert.match(eight.message, /7.day/, "the message names the 7-day window");

    // Newest is chosen by date, not mtime, and a non-matching file is ignored.
    writeBaselineFile(dir, "2026-01-05");
    fs.writeFileSync(path.join(dir, "README.md"), "notes\n");
    const newest = checkBaselineDir(dir, new Date("2026-01-05T00:00:00Z"));
    assert.equal(newest.ok, true, "the newest dated file checks out");
    assert.equal(newest.date, "2026-01-05", "the newest dated file is selected");

    // A malformed newest file fails closed even when an older valid file exists.
    const malformed = path.join(ws, "malformed");
    writeBaselineFile(malformed, "2026-01-01");
    fs.writeFileSync(path.join(malformed, "2026-01-02.json"), "{ not json\n");
    const bad = checkBaselineDir(malformed, new Date("2026-01-02T00:00:00Z"));
    assert.equal(bad.ok, false, "a malformed newest file fails closed");
    assert.match(bad.message, /malformed/, "the failure says the file is malformed");
    assert.equal(runCli(["--check", "--dir", malformed]).status, 1, "the CLI agrees on the malformed newest file");
  } finally {
    rmWorkspace(ws);
  }
}

// ---- d. pure summariser, canonical text, token estimate, and the usage gate -------------------

function testPureHelpers(): void {
  const baseline = summarise(SAMPLE_RUN, "2026-01-01", "2026-01-01T00:00:00.000Z");
  assert.equal(baseline.schemaVersion, 1, "the schema version is pinned");
  assert.equal(baseline.fixtures.total, 2, "total comes from the results");
  assert.equal(baseline.fixtures.passed, 1, "passed is the passing count");
  assert.equal(baseline.fixtures.failed, 1, "failed is the remainder");
  assert.equal(baseline.fixtures.successRate, 0.5, "successRate is passed/total");
  assert.deepEqual({ ...baseline.perCategory["security"] }, { total: 1, passed: 1, failed: 0, successRate: 1 }, "security is one of one");
  assert.deepEqual({ ...baseline.perCategory["verification"] }, { total: 1, passed: 0, failed: 1, successRate: 0 }, "verification is zero of one");
  assert.equal(summarise({ total: 0, passed: 0, failed: 0, results: [] }, "2026-01-01", "x").fixtures.successRate, 0, "an empty suite is rate 0, not NaN");

  assert.equal(canonicalSummaryText(SAMPLE_RUN.results), "security/alpha=pass\nverification/beta=fail", "the canonical text is sorted and deterministic");

  assert.equal(estimateTokens(""), 0, "empty text is zero tokens");
  assert.equal(estimateTokens("abcd"), 1, "4 chars is one token");
  assert.equal(estimateTokens("abcde"), 2, "5 chars rounds up to two tokens");

  const unknown = runCli(["--bogus"]);
  assert.equal(unknown.status, 2, "an unknown flag exits 2");
  assert.match(unknown.stderr, /usage:/, "the usage is printed");
}

// ---- runner ---------------------------------------------------------------------------------

const tests: Array<[string, () => void]> = [
  ["--write records one dated file with 17/17, per-category counts and tokens", testWrite],
  ["--check fails closed on an empty or stale baseline dir", testCheckEmptyAndStale],
  ["the 7-day boundary, newest selection and malformed files behave", testCheckBoundaryNewestMalformed],
  ["summariser, canonical text, token estimate and the usage gate", testPureHelpers],
];

const restoreEnv = isolateKitEnv();
let failed = 0;
try {
  for (const [name, fn] of tests) {
    try {
      fn();
      console.log(`  OK: ${name}`);
    } catch (error) {
      failed++;
      console.error(`  FAIL: ${name}`);
      console.error(`    ${error instanceof Error ? error.message.split("\n")[0] ?? "" : String(error)}`);
    }
  }
} finally {
  restoreEnv();
}
if (failed > 0) {
  console.error(`\n[eval-baseline-smoke] ${String(failed)}/${String(tests.length)} FAILED`);
  process.exit(1);
}
console.log(`\n[eval-baseline-smoke] all ${String(tests.length)} checks passed`);
