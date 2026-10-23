#!/usr/bin/env node
/**
 * Offline Memento eval (docs/efficiency-and-loops.md, "Measuring Memento mode"): the Wilson 95%
 * interval against published values, "inconclusive" whenever the arms' intervals overlap, both arms
 * run once per task at the same budget, overspending and malformed reports count as failures, and
 * the only thing written is one new 0600 proposal file (never the Memento opt-in).
 *
 * Deterministic and offline: fake arms, a temp HOME and PI_CODING_AGENT_DIR; the real ~/.pi is
 * never read.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT, isolateKitEnv, rmWorkspace, setEnv } from "../packages/core/eval/harness.ts";
import {
  evalRecorded,
  parseResults,
  renderProposal,
  runPairedEval,
  verdictOf,
  wilson,
  writeProposal,
  type Arm,
  type Budget,
} from "../packages/core/eval/memento.ts";

const restoreEnv = isolateKitEnv();
const SCRIPT = path.join(ROOT, "packages", "core", "eval", "memento.ts");
const BUDGET: Budget = { minutes: 60, usd: 2 };
const MODEL = "openrouter/qwen/qwen3-coder";

function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memento-eval-"));
  const agent = path.join(root, "agent");
  fs.mkdirSync(agent, { recursive: true });
  const restores = [setEnv("HOME", root), setEnv("PI_CODING_AGENT_DIR", agent)];
  return { root, agent, out: path.join(root, "out"), cleanup: () => { restores.reverse().forEach((r) => r()); rmWorkspace(root); } };
}

const tasks = (n: number): string[] => Array.from({ length: n }, (_, i) => `task-${String(i).padStart(2, "0")}`);
/** A fake arm that succeeds on the first `k` tasks, within budget. */
const firstK = (k: number): Arm => (task) => ({ success: Number(task.slice(5)) < k, minutes: 10, usd: 0.5 });

const near = (actual: number, expected: number, what: string): void =>
  assert.ok(Math.abs(actual - expected) < 5e-5, `${what}: ${actual} is not ${expected}`);

/** Every file under `dir`, relative to it. */
function filesUnder(dir: string): string[] {
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.relative(dir, path.join(e.parentPath, e.name))).sort();
}

const tests: Record<string, () => void | Promise<void>> = {
  "Wilson 95% interval matches published values (Newcombe 1998, Table I) and textbook cases"() {
    const known: readonly [number, number, number, number][] = [
      [81, 263, 0.2553, 0.3662],
      [15, 148, 0.0624, 0.1605],
      [0, 20, 0, 0.1611],
      [1, 29, 0.0061, 0.1718],
      [0, 10, 0, 0.2775],
      [1, 10, 0.0179, 0.4042],
      [5, 10, 0.2366, 0.7634],
      [10, 10, 0.7225, 1],
    ];
    for (const [s, n, low, high] of known) {
      const ci = wilson(s, n);
      near(ci.low, low, `${s}/${n} low`);
      near(ci.high, high, `${s}/${n} high`);
      near(ci.rate, s / n, `${s}/${n} rate`);
    }
  },
  "Wilson edge cases: no trials is [0, 1]; impossible counts throw"() {
    assert.deepEqual(wilson(0, 0), { rate: 0, low: 0, high: 1 });
    assert.throws(() => wilson(3, 2), RangeError);
    assert.throws(() => wilson(-1, 2), RangeError);
    assert.throws(() => wilson(1.5, 4), RangeError);
  },
  "the reported Memento results are both inconclusive at 95% (3/13 vs 14/22, 10/21 vs 10/29)"() {
    assert.equal(verdictOf(wilson(3, 13), wilson(14, 22)), "inconclusive");
    assert.equal(verdictOf(wilson(10, 21), wilson(10, 29)), "inconclusive");
    // Separated intervals decide, in either direction.
    assert.equal(verdictOf(wilson(4, 20), wilson(18, 20)), "generations");
    assert.equal(verdictOf(wilson(18, 20), wilson(4, 20)), "single");
  },
  async "fake arms: generations clearly ahead gives a generations verdict with the right intervals"() {
    const report = await runPairedEval({ model: MODEL, tasks: tasks(20), budget: BUDGET, single: firstK(4), generations: firstK(18) });
    assert.equal(report.verdict, "generations");
    assert.equal(report.arms.single.successes, 4);
    assert.equal(report.arms.generations.successes, 18);
    near(report.arms.single.interval.high, 0.416, "4/20 high");
    near(report.arms.generations.interval.low, 0.699, "18/20 low");
    assert.deepEqual(report.pairs, { both: 4, singleOnly: 0, generationsOnly: 14, neither: 2 });
  },
  async "fake arms: overlapping intervals are inconclusive even when one arm has more successes"() {
    const report = await runPairedEval({ model: MODEL, tasks: tasks(20), budget: BUDGET, single: firstK(10), generations: firstK(14) });
    assert.equal(report.verdict, "inconclusive");
    const single = await runPairedEval({ model: MODEL, tasks: tasks(20), budget: BUDGET, single: firstK(18), generations: firstK(4) });
    assert.equal(single.verdict, "single");
  },
  async "both arms run once per task, at the same budget, alternating which goes first"() {
    const calls: string[] = [];
    const seen: Budget[] = [];
    const arm = (name: string): Arm => (task, budget) => {
      calls.push(`${task}:${name}`);
      seen.push(budget);
      assert.ok(Object.isFrozen(budget), "the arm gets a frozen budget");
      return { success: true, minutes: 1, usd: 0 };
    };
    await runPairedEval({ model: MODEL, tasks: tasks(3), budget: BUDGET, single: arm("s"), generations: arm("g") });
    assert.deepEqual(calls, ["task-00:s", "task-00:g", "task-01:g", "task-01:s", "task-02:s", "task-02:g"]);
    for (const b of seen) assert.deepEqual(b, BUDGET);
  },
  async "overspending and malformed reports count as failures, separately tallied"() {
    const generations: Arm = (task) => {
      if (task === "task-00") return { success: true, minutes: 61, usd: 0.1 };
      if (task === "task-01") return { success: true, minutes: 5, usd: 2.01 };
      if (task === "task-02") return { success: "yes", minutes: 5, usd: 0 };
      if (task === "task-03") throw new Error("arm crashed");
      if (task === "task-04") return "passed";
      return { success: true, minutes: 60, usd: 2 };
    };
    const report = await runPairedEval({ model: MODEL, tasks: tasks(6), budget: BUDGET, single: firstK(0), generations });
    assert.equal(report.arms.generations.successes, 1, "only the in-budget, well-formed success counts");
    assert.equal(report.arms.generations.overBudget, 2);
    assert.equal(report.arms.generations.invalid, 3);
    assert.equal(report.arms.generations.n, 6);
  },
  async "bad inputs are refused before any arm runs"() {
    let ran = 0;
    const arm: Arm = () => { ran++; return { success: true, minutes: 0, usd: 0 }; };
    await assert.rejects(runPairedEval({ model: MODEL, tasks: [], budget: BUDGET, single: arm, generations: arm }), /no tasks/);
    await assert.rejects(runPairedEval({ model: "a/b\nc", tasks: tasks(1), budget: BUDGET, single: arm, generations: arm }), /model/);
    await assert.rejects(runPairedEval({ model: MODEL, tasks: tasks(1), budget: { minutes: 0, usd: 1 }, single: arm, generations: arm }), /minutes/);
    await assert.rejects(runPairedEval({ model: MODEL, tasks: tasks(1), budget: { minutes: 5, usd: -1 }, single: arm, generations: arm }), /budget\.usd/);
    assert.equal(ran, 0);
  },
  async "the proposal is one new 0600 file; the Memento opt-in is never written"() {
    const w = world();
    try {
      const report = await runPairedEval({ model: MODEL, tasks: tasks(20), budget: BUDGET, single: firstK(4), generations: firstK(18) });
      const now = new Date("2026-10-23T01:02:03.456Z");
      const file = writeProposal(w.out, report, now);
      assert.equal(path.basename(file), "memento-eval-openrouter_qwen_qwen3-coder-20261023T010203Z.md");
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      assert.equal(fs.statSync(w.out).mode & 0o777, 0o700);
      assert.deepEqual(filesUnder(w.root), [path.relative(w.root, file)], "nothing else is written, under the agent dir or anywhere");
      assert.equal(fs.existsSync(path.join(w.agent, "pi-kit", "autonomy.json")), false);
      const text = fs.readFileSync(file, "utf8");
      assert.equal(text, renderProposal(report, now));
      assert.match(text, /changes no configuration/);
      assert.match(text, /Verdict: \*\*generations\*\*/);
      assert.match(text, /`\/effort memento on openrouter\/qwen\/qwen3-coder`/);
      assert.match(text, /\| generations \| 18\/20 \| 90\.0% \| 69\.9% to 97\.2% \| 0 \| 0 \|/);
      assert.throws(() => writeProposal(w.out, report, now), /EEXIST/, "an existing proposal is never overwritten");
      const inconclusive = renderProposal({ ...report, verdict: "inconclusive" }, now);
      assert.match(inconclusive, /inconclusive\. Proposal: leave Memento mode off/);
    } finally { w.cleanup(); }
  },
  async "recorded results: parsed with guards, replayed as arms; duplicates and malformed files refused"() {
    const pairs = tasks(4).map((task, i) => ({ task, single: { success: i === 0, minutes: 30, usd: 1 }, generations: { success: true, minutes: 59, usd: 1.9 } }));
    const report = await evalRecorded(parseResults(JSON.stringify({ model: MODEL, budget: BUDGET, pairs })));
    assert.equal(report.arms.single.successes, 1);
    assert.equal(report.arms.generations.successes, 4);
    assert.equal(report.verdict, "inconclusive", "4 pairs are too few to separate 1/4 from 4/4");
    await assert.rejects(evalRecorded(parseResults(JSON.stringify({ model: MODEL, budget: BUDGET, pairs: [pairs[0], pairs[0]] }))), /unique/);
    assert.throws(() => parseResults(JSON.stringify({ model: MODEL, budget: BUDGET, pairs: [{ task: "x", single: { success: 1, minutes: 0, usd: 0 } }] })), /results\.pairs\[0\]/);
    assert.throws(() => parseResults("{not json"));
  },
  "CLI: writes the proposal from a results file, and exits non-zero without writing on bad input"() {
    const w = world();
    try {
      const results = path.join(w.root, "results.json");
      const pairs = tasks(20).map((task, i) => ({ task, single: { success: i < 4, minutes: 20, usd: 1 }, generations: { success: i < 18, minutes: 50, usd: 1.5 } }));
      fs.writeFileSync(results, JSON.stringify({ model: MODEL, budget: BUDGET, pairs }));
      const env = { ...process.env, HOME: w.root, PI_CODING_AGENT_DIR: w.agent };
      const ok = spawnSync(process.execPath, [SCRIPT, "--results", results, "--out", w.out], { env, encoding: "utf8" });
      assert.equal(ok.status, 0, ok.stderr);
      assert.match(ok.stdout, /verdict generations; proposal written to /);
      assert.equal(fs.readdirSync(w.out).length, 1);
      fs.writeFileSync(results, JSON.stringify({ model: MODEL, budget: BUDGET, pairs: "none" }));
      const bad = spawnSync(process.execPath, [SCRIPT, "--results", results, "--out", path.join(w.root, "out2")], { env, encoding: "utf8" });
      assert.equal(bad.status, 1);
      assert.match(bad.stderr, /results\.pairs/);
      assert.equal(fs.existsSync(path.join(w.root, "out2")), false);
      const usage = spawnSync(process.execPath, [SCRIPT], { env, encoding: "utf8" });
      assert.equal(usage.status, 2);
      assert.equal(fs.existsSync(path.join(w.agent, "pi-kit")), false, "the CLI never touches the agent dir");
    } finally { w.cleanup(); }
  },
};

let failed = 0;
for (const [name, fn] of Object.entries(tests)) {
  try {
    await fn();
    console.log(`  OK: ${name}`);
  } catch (error: unknown) {
    failed++;
    console.error(`  FAIL: ${name}\n    ${String((error instanceof Error && error.stack) || error)}`);
  }
}
restoreEnv();
if (failed) {
  console.error(`\n[memento-eval-smoke] ${failed} check(s) failed`);
  process.exit(1);
}
console.log(`\n[memento-eval-smoke] all ${Object.keys(tests).length} checks passed`);
