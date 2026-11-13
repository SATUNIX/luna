#!/usr/bin/env node
/**
 * Dated eval baseline (board PG-27). `packages/core/eval/baseline.ts` records the offline fixture
 * suite's success rate, per-category counts and a chars/4 token estimate as `baselines/YYYY-MM-DD.json`,
 * and `--check` fails closed when the newest record is missing, malformed, or older than 7 days.
 *
 * Deterministic and offline: a temp workspace holds every file this test writes. Nothing here runs the
 * eval suite itself.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isolateKitEnv, rmWorkspace, ROOT, tmpWorkspace } from "../packages/core/eval/harness.ts";
import {
  baselineAgeDays,
  checkBaselineDir,
  summarise,
  type Baseline,
  type EvalRun,
} from "../packages/core/eval/baseline.ts";

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
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr || result.error?.message || "" };
}

/** Write a schema-valid baseline file for `dir` under `date`, using the pure summariser. */
function writeBaselineFile(dir: string, date: string, run: EvalRun = SAMPLE_RUN): Baseline {
  const baseline = summarise(run, date, `${date}T00:00:00.000Z`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${date}.json`), JSON.stringify(baseline, null, 2) + "\n");
  return baseline;
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

function testFutureAndRecentDates(): void {
  const ws = tmpWorkspace("pi-eval-baseline-dates-");
  const now = new Date("2026-01-09T23:59:59Z");
  try {
    const dir = path.join(ws, "dated");
    writeBaselineFile(dir, "2026-01-01");
    assert.equal(checkBaselineDir(dir, now).ok, false, "8 days ago still fails");

    writeBaselineFile(dir, "2026-01-03");
    assert.equal(checkBaselineDir(dir, now).ok, true, "6 days ago passes");

    writeBaselineFile(dir, "2026-01-09");
    assert.equal(checkBaselineDir(dir, now).ok, true, "today passes");

    writeBaselineFile(dir, "9999-12-31");
    const future = checkBaselineDir(dir, now);
    assert.equal(future.ok, false, "a future-dated newest record fails closed");
    assert.match(future.message, /future|after today/i, "the failure explains the future date");
  } finally {
    rmWorkspace(ws);
  }
}

function testFutureWriteRefused(): void {
  const ws = tmpWorkspace("pi-eval-baseline-future-write-");
  try {
    const dir = path.join(ws, "baselines");
    const result = runCli(["--write", "--dir", dir, "--date", "9999-12-31"]);
    assert.equal(result.status, 2, `a future --date exits like an invalid date: ${result.stderr}`);
    assert.match(result.stderr, /future|after today/i, "the error explains the future date");
    assert.equal(fs.existsSync(dir), false, "a refused future write creates no output directory");
  } finally {
    rmWorkspace(ws);
  }
}

function testSymlinkedWritesRefused(): void {
  const ws = tmpWorkspace("pi-eval-baseline-links-");
  try {
    const outside = path.join(ws, "outside");
    fs.mkdirSync(outside);
    const linkedDir = path.join(ws, "linked-baselines");
    fs.symlinkSync(outside, linkedDir, "dir");
    const linkedDirResult = runCli(["--write", "--dir", linkedDir]);
    assert.equal(linkedDirResult.status, 1, `a linked output directory is refused: ${linkedDirResult.stderr}`);
    assert.match(linkedDirResult.stderr, /symbolic link/, "the linked directory error is clear");
    assert.deepEqual(fs.readdirSync(outside), [], "a linked directory leaves the outside target empty");

    const operatorRoot = path.join(ws, "operator-root");
    fs.mkdirSync(operatorRoot);
    const today = new Date().toISOString().slice(0, 10);
    fs.symlinkSync(path.join(outside, `${today}.json`), path.join(operatorRoot, `${today}.json`));
    const linkedFileResult = runCli(["--write", "--dir", operatorRoot, "--date", today]);
    assert.equal(linkedFileResult.status, 1, `a linked file below the operator root is refused: ${linkedFileResult.stderr}`);
    assert.match(linkedFileResult.stderr, /symbolic link/, "the linked file error is clear");
    assert.deepEqual(fs.readdirSync(outside), [], "a linked file leaves the outside target empty");
  } finally {
    rmWorkspace(ws);
  }
}

// ---- d. pure summariser, canonical text, token estimate, and the usage gate -------------------

function testPureHelpers(): void {
  const baseline = summarise(SAMPLE_RUN, "2026-01-01", "2026-01-01T00:00:00.000Z");
  assert.equal(baseline.fixtures.successRate, 0.5, "successRate is passed/total");
  assert.equal(summarise({ total: 0, passed: 0, failed: 0, results: [] }, "2026-01-01", "x").fixtures.successRate, 0, "an empty suite is rate 0, not NaN");

  const unknown = runCli(["--bogus"]);
  assert.equal(unknown.status, 2, "an unknown flag exits 2");
  assert.match(unknown.stderr, /usage:/, "the usage is printed");
}

// ---- runner ---------------------------------------------------------------------------------

const tests: Array<[string, () => void]> = [
  ["--check fails closed on an empty or stale baseline dir", testCheckEmptyAndStale],
  ["the 7-day boundary, newest selection and malformed files behave", testCheckBoundaryNewestMalformed],
  ["future dates fail while today and recent dates keep their freshness boundary", testFutureAndRecentDates],
  ["--write refuses a future date without creating output", testFutureWriteRefused],
  ["--write refuses linked output paths and leaves outside targets empty", testSymlinkedWritesRefused],
  ["summariser rate and the usage gate", testPureHelpers],
];

const restoreEnv = isolateKitEnv();
const testHome = tmpWorkspace("pi-eval-baseline-home-");
const previousHome = process.env.HOME;
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.HOME = testHome;
process.env.PI_CODING_AGENT_DIR = path.join(testHome, "agent");
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
  if (previousHome === undefined) Reflect.deleteProperty(process.env, "HOME");
  else process.env.HOME = previousHome;
  if (previousAgentDir === undefined) Reflect.deleteProperty(process.env, "PI_CODING_AGENT_DIR");
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmWorkspace(testHome);
  restoreEnv();
}
if (failed > 0) {
  console.error(`\n[eval-baseline-smoke] ${String(failed)}/${String(tests.length)} FAILED`);
  process.exit(1);
}
console.log(`\n[eval-baseline-smoke] all ${String(tests.length)} checks passed`);
