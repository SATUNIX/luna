#!/usr/bin/env node
/**
 * Dated offline eval baseline (board PG-27). `packages/core/eval/run.ts` measures the fixture suite
 * but writes nothing down, so no later cycle can prove its success rate moved. This module records
 * one baseline per day under `baselines/` and refuses a checkout whose newest record has gone stale.
 *
 * Usage:
 *   node packages/core/eval/baseline.ts --write [--dir <path>] [--date YYYY-MM-DD]
 *   node packages/core/eval/baseline.ts --check [--dir <path>]
 *
 * `--write` spawns `run.ts --json` as a child process (run.ts is a top-level CLI that calls
 * `process.exit`, so importing it would end this process) and summarises its payload. A failing
 * fixture makes run.ts exit 1 while still writing valid JSON to stdout, so the payload is parsed
 * rather than the status alone deciding: only exit 2, a signal/timeout, or unparseable text is an
 * error. The payload is validated with `lib/guard.ts` — no casts, no `any`.
 *
 * `--check` fails closed: no dated file, a malformed newest file, or a newest record outside the
 * MAX_AGE_DAYS (7) freshness window all exit 1. The age comes from the filename/embedded date, never the mtime: a
 * fresh `git clone` rewrites every file's mtime, so an mtime check would call a year-old baseline
 * current.
 *
 * Deterministic and offline, like the rest of the eval harness. `summarise`, `canonicalSummaryText`,
 * `estimateTokens`, `baselineAgeDays` and `checkBaselineDir` are pure (the last reads a directory
 * but takes `now` as an argument) so `tests/eval-baseline-smoke.ts` can exercise them without
 * writing to the checkout.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WORKSPACE_ROOT } from "../lib/paths.ts";
import { ensureDirSafe, writeFileSafe } from "../shared/safe-fs.ts";
import { array, boolean, literal, number, object, parseJsonAs, record, string, type Infer } from "../lib/guard.ts";

/** `run.ts` and the default `baselines/` live beside this module. */
const RUN_TS = fileURLToPath(new URL("./run.ts", import.meta.url));
const DEFAULT_DIR = fileURLToPath(new URL("./baselines/", import.meta.url));

/** A baseline older than this fails `--check`. */
export const MAX_AGE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const RUN_TIMEOUT_MS = 240_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// The repo's existing chars/4 ratio, clean-room sourced from context-sieve's own constant:
// packages/extensions/src/context-sieve/index.ts defines CHARS_PER_TOKEN = 4. The offline harness
// has no provider token usage, so `tokens` is labelled as this estimate rather than a measured cost.
const CHARS_PER_TOKEN = 4;
const TOKENS_BASIS =
  "offline chars/4 estimate (context-sieve CHARS_PER_TOKEN); the offline harness has no provider usage";

/** One fixture outcome as `run.ts --json` emits it (extra fields such as `ms` are stripped). */
const RunFixtureSchema = object({
  name: string(),
  category: string(),
  pass: boolean(),
});
const RunJsonSchema = object({
  total: number({ integer: true, min: 0 }),
  passed: number({ integer: true, min: 0 }),
  failed: number({ integer: true, min: 0 }),
  results: array(RunFixtureSchema),
});

const StatsSchema = object({
  total: number({ integer: true, min: 0 }),
  passed: number({ integer: true, min: 0 }),
  failed: number({ integer: true, min: 0 }),
  successRate: number({ min: 0, max: 1 }),
});

/** The dated baseline file's schema. It is also the reader's validation, so writer and reader cannot drift. */
export const BaselineSchema = object({
  schemaVersion: literal(1),
  date: string({ pattern: DATE_RE }),
  generatedAt: string(),
  fixtures: StatsSchema,
  perCategory: record(StatsSchema),
  tokens: number({ integer: true, min: 0 }),
  tokensBasis: string({ minLength: 1 }),
});

export type EvalRun = Infer<typeof RunJsonSchema>;
export type FixtureOutcome = Infer<typeof RunFixtureSchema>;
export type CategoryStats = Infer<typeof StatsSchema>;
export type Baseline = Infer<typeof BaselineSchema>;

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function stats(total: number, passed: number): CategoryStats {
  return { total, passed, failed: total - passed, successRate: total === 0 ? 0 : round3(passed / total) };
}

/** The deterministic text a baseline's token estimate is taken from: one sorted `category/name=pass|fail` per line. */
export function canonicalSummaryText(results: readonly FixtureOutcome[]): string {
  return results
    .map((r) => `${r.category}/${r.name}=${r.pass ? "pass" : "fail"}`)
    .sort()
    .join("\n");
}

/** `ceil(text.length / 4)`, the repo's chars/4 token estimate. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Build a baseline from a validated `run.ts --json` payload. Pure: date and clock are arguments. */
export function summarise(run: EvalRun, date: string, generatedAt: string): Baseline {
  const results = run.results;
  const total = results.length;
  const passed = results.filter((r) => r.pass).length;
  const byCategory = new Map<string, { total: number; passed: number }>();
  for (const r of results) {
    const entry = byCategory.get(r.category) ?? { total: 0, passed: 0 };
    entry.total += 1;
    if (r.pass) entry.passed += 1;
    byCategory.set(r.category, entry);
  }
  const perCategory: Record<string, CategoryStats> = {};
  for (const [category, entry] of byCategory) perCategory[category] = stats(entry.total, entry.passed);
  return {
    schemaVersion: 1,
    date,
    generatedAt,
    fixtures: stats(total, passed),
    perCategory,
    tokens: estimateTokens(canonicalSummaryText(results)),
    tokensBasis: TOKENS_BASIS,
  };
}

/** Whole UTC calendar days from `date` (`YYYY-MM-DD`) to `now`. Same day is 0, `now` one day later is 1. */
export function baselineAgeDays(date: string, now: Date): number {
  const dateMs = Date.parse(`${date}T00:00:00Z`);
  const nowMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.floor((nowMs - dateMs) / DAY_MS);
}

export interface BaselineCheck {
  readonly ok: boolean;
  /** The newest dated file's date, or null when none exists. */
  readonly date: string | null;
  readonly ageDays: number | null;
  readonly message: string;
}

const DATED_FILE = /^\d{4}-\d{2}-\d{2}\.json$/;

/**
 * Judge the newest dated baseline in `dir` against `now`. Fails closed: no dated file, a malformed
 * newest file, a filename/embedded date mismatch, or an age outside 0..MAX_AGE_DAYS all return ok:false.
 * A non-matching file (e.g. a README.md) is ignored. Never reads an mtime.
 */
export function checkBaselineDir(dir: string, now: Date): BaselineCheck {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    names = [];
  }
  const newest = names.filter((name) => DATED_FILE.test(name)).sort().at(-1);
  if (newest === undefined) {
    return {
      ok: false,
      date: null,
      ageDays: null,
      message: `no dated eval baseline in ${dir}; run "node packages/core/eval/baseline.ts --write"`,
    };
  }
  const date = newest.slice(0, 10);
  let baseline: Baseline;
  try {
    baseline = parseJsonAs(BaselineSchema, fs.readFileSync(path.join(dir, newest), "utf8"), newest);
  } catch (error) {
    return {
      ok: false,
      date,
      ageDays: null,
      message: `${newest} is malformed and the check fails closed (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  if (baseline.date !== date) {
    return {
      ok: false,
      date,
      ageDays: null,
      message: `${newest} records date ${baseline.date}, not the filename date ${date}; the check fails closed`,
    };
  }
  const ageDays = baselineAgeDays(date, now);
  if (ageDays < 0) {
    return {
      ok: false,
      date,
      ageDays,
      message: `newest eval baseline ${newest} is dated after today (UTC); the check fails closed`,
    };
  }
  if (ageDays > MAX_AGE_DAYS) {
    return {
      ok: false,
      date,
      ageDays,
      message: `newest eval baseline ${newest} is ${String(ageDays)} days old, older than the ${String(MAX_AGE_DAYS)}-day freshness window`,
    };
  }
  return { ok: true, date, ageDays, message: `eval baseline ${newest} is ${String(ageDays)} day(s) old, within ${String(MAX_AGE_DAYS)} days` };
}

/** Run the fixture suite and return its validated JSON payload. Throws on exit 2, a signal, or bad output. */
function runEvalJson(): EvalRun {
  const result = spawnSync(process.execPath, [RUN_TS, "--json"], { cwd: WORKSPACE_ROOT, encoding: "utf8", timeout: RUN_TIMEOUT_MS });
  if (result.error) throw new Error(`could not run ${RUN_TS}: ${result.error.message}`, { cause: result.error });
  const status = result.status;
  // A failing fixture exits 1 but still writes valid JSON; any other non-zero status is an error.
  if (status !== 0 && status !== 1) throw new Error(`eval run --json exited ${String(status)}`);
  return parseJsonAs(RunJsonSchema, result.stdout, "eval run --json output");
}

function todayUtc(now: Date): string {
  return now.toISOString().slice(0, 10);
}

interface ParsedArgs {
  readonly mode: "write" | "check";
  readonly dir: string | undefined;
  readonly date: string | undefined;
}

type ParseResult = { readonly ok: true; readonly value: ParsedArgs } | { readonly ok: false; readonly message: string };

const USAGE =
  "usage: node packages/core/eval/baseline.ts --write [--dir <path>] [--date YYYY-MM-DD] | --check [--dir <path>]";

function parseArgs(argv: readonly string[]): ParseResult {
  let mode: "write" | "check" | undefined;
  let dir: string | undefined;
  let date: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--write" || arg === "--check") {
      if (mode !== undefined) return { ok: false, message: "only one of --write or --check may be given" };
      mode = arg === "--write" ? "write" : "check";
    } else if (arg === "--dir" || arg === "--date") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) return { ok: false, message: `${arg} needs a value` };
      i += 1;
      if (arg === "--dir") dir = value;
      else date = value;
    } else {
      return { ok: false, message: `unknown argument "${arg ?? ""}"` };
    }
  }
  if (mode === undefined) return { ok: false, message: "expected --write or --check" };
  if (mode === "check" && date !== undefined) return { ok: false, message: "--date is only meaningful with --write" };
  return { ok: true, value: { mode, dir, date } };
}

/** Run the CLI for `argv`, returning the process exit code. */
export function main(argv: readonly string[] = process.argv.slice(2)): number {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    console.error(`[eval-baseline] ${parsed.message}`);
    console.error(USAGE);
    return 2;
  }
  const { mode, dir, date } = parsed.value;
  const targetDir = dir ?? DEFAULT_DIR;

  if (mode === "write") {
    const now = new Date();
    const baselineDate = date ?? todayUtc(now);
    if (!DATE_RE.test(baselineDate)) {
      console.error(`[eval-baseline] invalid --date "${baselineDate}" (expected YYYY-MM-DD)`);
      console.error(USAGE);
      return 2;
    }
    if (baselineDate > todayUtc(now)) {
      console.error(`[eval-baseline] invalid --date "${baselineDate}" (after today UTC)`);
      console.error(USAGE);
      return 2;
    }
    try {
      const writeRoot = dir === undefined ? WORKSPACE_ROOT : path.dirname(path.resolve(targetDir));
      ensureDirSafe(targetDir, { root: writeRoot });
      const baseline = BaselineSchema.parse(summarise(runEvalJson(), baselineDate, new Date().toISOString()));
      const file = path.join(targetDir, `${baselineDate}.json`);
      writeFileSafe(file, JSON.stringify(baseline, null, 2) + "\n", { root: writeRoot, mode: 0o644 });
      console.log(
        `[eval-baseline] wrote ${file}: ${String(baseline.fixtures.passed)}/${String(baseline.fixtures.total)} passed ` +
          `(${String(baseline.fixtures.successRate)}), ${String(Object.keys(baseline.perCategory).length)} categories, ~${String(baseline.tokens)} tokens`,
      );
      return 0;
    } catch (error) {
      console.error(`[eval-baseline] ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }

  const check = checkBaselineDir(targetDir, new Date());
  if (!check.ok) {
    console.error(`[eval-baseline] ${check.message}`);
    return 1;
  }
  console.log(`[eval-baseline] ${check.message}`);
  return 0;
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) process.exit(main());
