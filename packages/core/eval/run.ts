#!/usr/bin/env node
/**
 * Eval harness v1 (Epic 4 Sprint 4.2). Runs every fixture in packages/core/eval/fixtures.ts,
 * prints a scorecard, and exits non-zero if ANY fixture regresses. Deterministic and
 * fully offline — no model backend, no network. This is the measurement flywheel: a
 * regression in the safety boundary, verification wiring, or orchestration flow fails CI.
 *
 * Usage:
 *   node packages/core/eval/run.ts [--category security|verification|orchestration] [--json]
 *
 * `--category` with a missing value, or a value that names no registered fixture category, is
 * refused (exit 2) rather than silently running every fixture or none.
 */
import { fixtures } from "./fixtures.ts";
import { prop } from "./dynamic.ts";

/** One fixture's outcome, as printed and as emitted by --json. */
export interface FixtureResult {
  name: string;
  category: string;
  pass: boolean;
  ms: number;
  error?: string;
}

const args = process.argv.slice(2);
const asJson = args.includes("--json");

// The categories actually present in the fixtures, so a typo cannot select zero of them and pass.
const CATEGORIES: readonly string[] = [...new Set<string>(fixtures.map((f) => f.category))].sort();
const usage = `usage: node packages/core/eval/run.ts [--category ${CATEGORIES.join("|")}] [--json]`;

let categoryFilter: string | null = null;
const categoryIndex = args.indexOf("--category");
if (categoryIndex !== -1) {
  const value = args[categoryIndex + 1];
  if (value === undefined || value.startsWith("--")) {
    console.error(usage);
    process.exit(2);
  }
  if (!CATEGORIES.includes(value)) {
    console.error(`unknown category "${value}"`);
    console.error(usage);
    process.exit(2);
  }
  categoryFilter = value;
}

const selected = categoryFilter ? fixtures.filter((f) => f.category === categoryFilter) : fixtures;
if (selected.length === 0) {
  console.error("[eval] no fixtures selected — check --category filter");
  process.exit(2);
}

const results: FixtureResult[] = [];
for (const fixture of selected) {
  const start = Date.now();
  try {
    await fixture.run();
    results.push({ name: fixture.name, category: fixture.category, pass: true, ms: Date.now() - start });
  } catch (error) {
    results.push({
      name: fixture.name,
      category: fixture.category,
      pass: false,
      ms: Date.now() - start,
      error: String(prop(error, "message") || error),
    });
  }
}

const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;

if (asJson) {
  console.log(JSON.stringify({ total: results.length, passed, failed, results }, null, 2));
} else {
  console.log("\n[eval] pi-kit eval harness v1\n");
  const byCat = new Map<string, FixtureResult[]>();
  for (const r of results) {
    const group = byCat.get(r.category) ?? [];
    group.push(r);
    byCat.set(r.category, group);
  }
  for (const [cat, group] of [...byCat].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    console.log(`  ${cat}`);
    for (const r of group) {
      console.log(`    ${r.pass ? "PASS" : "FAIL"}  ${r.name} (${r.ms}ms)${r.error ? `\n          ${r.error}` : ""}`);
    }
  }
  console.log(`\n[eval] ${passed}/${results.length} fixtures passed${failed ? `, ${failed} FAILED` : ""}.`);
}

process.exit(failed > 0 ? 1 : 0);
