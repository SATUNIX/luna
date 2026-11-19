#!/usr/bin/env node
/**
 * eval:roi (packages/core/eval/roi.ts): tokens and USD per passed task.
 *   - the table: failed tasks' spend counts against the passed ones, undecided tasks are left out of the
 *     pass rate, unknown token fields stay null (not zero), nothing passed gives null per-pass figures;
 *   - an autonomous run's ledgers: a row's `cycle` field wins, older rows go by the cycle's time window,
 *     a row in no cycle is unattributed, a non-200 row adds nothing, spend is split by role, a cycle with
 *     no metered work is skipped;
 *   - a live evaluation's summary: outcome, cache reads and writes, observed cost;
 *   - the committed fixtures reproduce roi-baseline.json.
 * Hermetic: synthetic state homes and live output in a temporary directory.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { main, roiTable, tasksFromLive, tasksFromRun, type RoiTask } from "../packages/core/eval/roi.ts";

const task = (id: string, passed: boolean | null, input: number | null, output: number | null, usd: number | null, profile = "p"): RoiTask => ({ id, profile, passed, input, cached: null, output, usd });

// The arithmetic.
{
  const [row] = roiTable([task("a", true, 1000, 100, 0.5), task("b", false, 3000, 300, 1.5), task("c", null, 500, 50, 0.25), task("d", true, null, 10, null)]);
  assert.ok(row);
  assert.deepEqual(
    { tasks: row.tasks, passed: row.passed, undecided: row.undecided, passRate: row.passRate, input: row.input, cached: row.cached, output: row.output, usd: row.usd },
    { tasks: 4, passed: 2, undecided: 1, passRate: 0.6667, input: 4500, cached: null, output: 460, usd: 2.25 },
  );
  assert.equal(row.tokensPerPass, Math.round((4500 + 460) / 2), "every task's tokens over the passed count");
  assert.equal(row.usdPerPass, 1.125);
  const [none] = roiTable([task("x", false, 10, 1, 0.1)]);
  assert.ok(none);
  assert.equal(none.tokensPerPass, null, "nothing passed: no per-pass figure");
  assert.equal(none.usdPerPass, null);
  assert.deepEqual(roiTable([task("a", true, 1, 1, 1, "z"), task("b", true, 1, 1, 1, "a")]).map((r) => r.profile), ["a", "z"], "one row per profile, sorted");
  console.log("  OK: per-pass arithmetic, undecided tasks, unknown fields and empty passes");
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-roi-"));
try {
  // An autonomous run's state home.
  const home = path.join(work, "run-a");
  const write = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true }); fs.writeFileSync(path.join(home, rel), text); };
  const jsonl = (rows: object[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  write("steps/01/cycle.json", JSON.stringify({ n: 1, merged: true, startedAt: "2026-01-01T00:00:00Z", endedAt: "2026-01-01T01:00:00Z" }));
  write("steps/02/cycle.json", JSON.stringify({ n: 2, merged: false, startedAt: "2026-01-01T02:00:00Z", endedAt: "2026-01-01T03:00:00Z" }));
  write("steps/03/cycle.json", JSON.stringify({ n: 3, merged: false, startedAt: "2026-01-01T04:00:00Z", endedAt: "2026-01-01T05:00:00Z" }));
  write("meter/usage.jsonl", jsonl([
    { at: "2026-01-01T00:10:00Z", promptTokens: 100, completionTokens: 10, costUsd: 0.01 },
    { at: "2026-01-01T00:20:00Z", status: 500, costUsd: 0 },
    // attributed by field: counts for cycle 2 although its time is in cycle 1's window
    { at: "2026-01-01T00:30:00Z", cycle: 2, role: "review", promptTokens: 40, completionTokens: 4, costUsd: 0.004 },
    { at: "2026-01-01T02:30:00Z", promptTokens: 200, completionTokens: 20, costUsd: 0.02 },
    { at: "2026-01-01T01:30:00Z", promptTokens: 999, completionTokens: 99, costUsd: 0.5 },
  ]) + "not json\n");
  write("meter/manager.jsonl", jsonl([{ at: "2026-01-01T00:40:00Z", costUsd: 0.003 }]));
  const r = tasksFromRun(home, "long-horizon");
  assert.equal(r.skipped, 1, "cycle 3 did no metered work");
  assert.deepEqual(r.unattributed, { input: 999, cached: null, output: 99, usd: 0.5 }, "a row in no cycle is unattributed");
  assert.deepEqual(r.tasks, [
    { id: "run-a#1", profile: "long-horizon", passed: true, input: 100, cached: null, output: 10, usd: 0.013,
      roles: { manager: { input: null, cached: null, output: null, usd: 0.003 }, worker: { input: 100, cached: null, output: 10, usd: 0.01 } } },
    { id: "run-a#2", profile: "long-horizon", passed: false, input: 240, cached: null, output: 24, usd: 0.024,
      roles: { review: { input: 40, cached: null, output: 4, usd: 0.004 }, worker: { input: 200, cached: null, output: 20, usd: 0.02 } } },
  ]);
  console.log("  OK: run ledgers: attribution by field then by window, roles, unattributed and skipped cycles");

  // A live evaluation's output.
  const live = path.join(work, "live");
  fs.mkdirSync(live);
  fs.writeFileSync(path.join(live, "runtime.json"), JSON.stringify({ variant: "lite" }));
  fs.writeFileSync(path.join(live, "summary.json"), JSON.stringify([
    { name: "hello", outcome: "passed", usageSummary: { observed: { input: 10, output: 5, cacheRead: 100, cacheWrite: 20 }, cost: { observedTotal: 0.002 } } },
    { name: "coding", outcome: "failed", usageSummary: { observed: { input: null, output: 7, cacheRead: null, cacheWrite: null }, cost: { observedTotal: null } } },
    { name: "cyber", outcome: "pending_review", usageSummary: { observed: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, cost: { observedTotal: 0.001 } } },
  ]));
  assert.deepEqual(tasksFromLive(live), [
    { id: "hello", profile: "live:lite", passed: true, input: 30, cached: 100, output: 5, usd: 0.002 },
    { id: "coding", profile: "live:lite", passed: false, input: null, cached: null, output: 7, usd: null },
    { id: "cyber", profile: "live:lite", passed: null, input: 1, cached: 0, output: 1, usd: 0.001 },
  ]);
  console.log("  OK: live summary: outcomes, cache reads and writes, observed cost");

  // The command: recorded evidence prints a table; the committed fixtures match the baseline.
  const lines: string[] = [];
  assert.equal(main(["--from-runs", home, "--from-live", live, "--json"], (l) => lines.push(l)), 0);
  assert.match(lines.join("\n"), /"profile": "live:lite"/);
  const out: string[] = [];
  assert.equal(main([], (l) => out.push(l)), 0, `the committed fixtures reproduce roi-baseline.json:\n${out.join("\n")}`);
  assert.match(out.join("\n"), /tokens\/pass/);
  console.log("  OK: the command reads recorded evidence, and the fixtures reproduce the baseline");
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
console.log("[eval-roi-smoke] OK");
