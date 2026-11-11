#!/usr/bin/env node
/**
 * Paperwork budget (board PG-19). `packages/core/paperwork-budget.ts` caps a cycle's own
 * `plan.md`/`report.md`/`review.md`/`verify.md` at 60 lines and requires exactly one `JOURNAL.md`
 * line for the cycle. Cycle 11 wrote 245 lines, and the same prose pushed the merge-review diff
 * budget and `smoke:docs` over their limits, so this is checked instead of trusted.
 *
 * Deterministic and offline: temp directories only, the CLI runs under the same node binary, and
 * `check:all --list` is read (not run) to prove the new script is wired.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkPaperworkBudget,
  DEFAULT_PAPERWORK_MAX_LINES,
  PAPERWORK_FILES,
} from "../packages/core/paperwork-budget.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "packages", "core", "paperwork-budget.ts");
const CHECK_ALL = path.join(ROOT, "packages", "core", "check-all.ts");

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: "utf8", timeout: 60_000 });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** A cycle directory whose four documents each hold `lines` text lines. */
function writeCycle(dir: string, lines: number): void {
  fs.mkdirSync(dir, { recursive: true });
  for (const name of PAPERWORK_FILES) fs.writeFileSync(path.join(dir, name), Array.from({ length: lines }, (_, i) => `line ${String(i + 1)}`).join("\n") + "\n");
}

function writeJournal(file: string, lines: string[]): void {
  fs.writeFileSync(file, ["- luna-core-01/11 | Board: none | successful | earlier cycle", ...lines, "- luna-ux-01/01 | Board: none | successful | other run"].join("\n") + "\n");
}

function scratch(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "paperwork-budget-"));
}

const tests: Array<[string, () => void]> = [
  ["120 lines fails with a per-file breakdown, 40 lines passes", () => {
    assert.equal(DEFAULT_PAPERWORK_MAX_LINES, 60, "the reviewed cap is 60 lines");
    const root = scratch();
    try {
      const over = path.join(root, "over");
      writeCycle(over, 30);
      const failed = checkPaperworkBudget({ dir: over });
      assert.equal(failed.ok, false, "120 lines is over the cap");
      assert.equal(failed.total, 120);
      assert.equal(failed.overBy, 60);
      assert.deepEqual(failed.files, [
        { name: "plan.md", lines: 30 },
        { name: "report.md", lines: 30 },
        { name: "review.md", lines: 30 },
        { name: "verify.md", lines: 30 },
      ]);
      assert.match(failed.problems.join("\n"), /120 lines .* exceeds the 60-line cap by 60/, "the failure names the total and the overrun");

      const under = path.join(root, "under");
      writeCycle(under, 10);
      const passed = checkPaperworkBudget({ dir: under });
      assert.equal(passed.ok, true, "40 lines is inside the cap");
      assert.equal(passed.total, 40);
      assert.equal(passed.overBy, 0);
      assert.deepEqual(passed.problems, []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }],

  ["the CLI exits 1 on an overrun and prints every file, then 0 under the cap", () => {
    const root = scratch();
    try {
      const over = path.join(root, "over");
      writeCycle(over, 30);
      const failed = runCli([over]);
      assert.equal(failed.status, 1, "an overrun is a non-zero exit");
      assert.match(failed.stdout, /plan\.md: 30/);
      assert.match(failed.stdout, /report\.md: 30/);
      assert.match(failed.stdout, /\[paperwork-budget\] 120\/60 lines/);
      assert.match(failed.stderr, /exceeds the 60-line cap by 60/);

      const under = path.join(root, "under");
      writeCycle(under, 10);
      const passed = runCli([under]);
      assert.equal(passed.status, 0, "40 lines exits 0");
      assert.match(passed.stdout, /\[paperwork-budget\] 40\/60 lines/);
      assert.match(passed.stdout, /\[paperwork-budget\] OK/);
      assert.equal(passed.stderr, "");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }],

  ["--max-lines lowers the cap and a bad value exits 2", () => {
    const root = scratch();
    try {
      const dir = path.join(root, "cycle");
      writeCycle(dir, 10);
      const tight = runCli([dir, "--max-lines=20"]);
      assert.equal(tight.status, 1, "40 lines is over a 20-line cap");
      assert.match(tight.stderr, /exceeds the 20-line cap by 20/);
      const bad = runCli([dir, "--max-lines=0"]);
      assert.equal(bad.status, 2, "a non-positive cap is a usage error");
      assert.match(bad.stderr, /--max-lines must be a positive integer/);
      const noDir = runCli([]);
      assert.equal(noDir.status, 2, "a missing directory is a usage error");
      assert.match(noDir.stderr, /usage: node packages\/core\/paperwork-budget\.ts/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }],

  ["exactly one journal line for the cycle is required", () => {
    const root = scratch();
    try {
      const dir = path.join(root, "cycle");
      writeCycle(dir, 10);
      const journal = path.join(root, "JOURNAL.md");
      const line = "- luna-core-01/12 | Board: PG-19 | successful | test";
      writeJournal(journal, [line]);
      assert.equal(checkPaperworkBudget({ dir, journal, run: "luna-core-01", cycle: "12" }).ok, true, "one line is enough");
      assert.equal(runCli([dir, `--journal=${journal}`, "--run=luna-core-01", "--cycle=12"]).status, 0);

      writeJournal(journal, []);
      const missing = checkPaperworkBudget({ dir, journal, run: "luna-core-01", cycle: "12" });
      assert.equal(missing.ok, false, "a missing line fails");
      assert.match(missing.problems.join("\n"), /expected exactly one JOURNAL\.md line/);

      writeJournal(journal, [line, line]);
      assert.equal(checkPaperworkBudget({ dir, journal, run: "luna-core-01", cycle: "12" }).ok, false, "two lines fail");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }],

  ["check:all --list picks up smoke:paperwork-budget", () => {
    const listed = spawnSync(process.execPath, [CHECK_ALL, "--list"], { cwd: ROOT, encoding: "utf8", timeout: 60_000 });
    assert.equal(listed.status, 0, "check:all --list exits 0");
    assert.match(listed.stdout ?? "", /^smoke:paperwork-budget$/m, "the new script is enumerated as a check");
  }],
];

let failed = 0;
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
if (failed > 0) {
  console.error(`\n[paperwork-budget-smoke] ${String(failed)}/${String(tests.length)} FAILED`);
  process.exit(1);
}
console.log(`\n[paperwork-budget-smoke] all ${String(tests.length)} checks passed`);
