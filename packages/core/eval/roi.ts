/**
 * Token ROI (V5-04): tokens and USD per passed task, per profile, so a change that cuts tokens can be
 * judged by what it costs per completed task rather than per request.
 *
 * A task is one unit of work with a pass/fail outcome and the provider usage it consumed:
 *   - an autonomous-run cycle (`--from-runs <state home>...`): passed when it merged; its usage is every
 *     metered request in the run's ledgers (`meter/usage.jsonl` from the relay, `meter/manager.jsonl` from
 *     the host's manager and review calls) whose `cycle` field names it, or, for rows written before the
 *     ledger carried attribution, whose time falls between the cycle's `startedAt` and `endedAt`. A cycle
 *     with no metered request and no cost did no work and is skipped. Rows in no cycle are counted as
 *     unattributed and left out of every task;
 *   - a live evaluation case (`--from-live <out dir>`, packages/core/eval/live): passed when its outcome
 *     is `passed` (`pending_review` is neither); its usage is `usageSummary.observed`.
 * Token fields: `input` is uncached prompt tokens (plus cache writes), `cached` is cache reads, `output`
 * is completion tokens. The relay records prompt tokens without a cache split, so a run's `cached` is
 * null (unknown), not zero. A row without usable usage (non-200, aborted) adds nothing and is counted.
 *
 * `npm run eval:roi` prints the table from the committed fixtures (`roi/*.json`) offline and fails when
 * it differs from `roi-baseline.json`; `--write-baseline` records it. `--from-runs` and `--from-live`
 * read recorded evidence instead, `--write-fixture <file>` saves it as a fixture. Running a live
 * evaluation needs a model and is the operator's command (docs/efficiency-and-loops.md).
 * tests/eval-roi-smoke.ts pins the arithmetic and both readers.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { array, boolean, isRecord, literal, nullable, number, object, optional, parseJson, parseJsonAs, record, string, type Infer } from "../lib/guard.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURE_DIR = path.join(HERE, "roi");
export const BASELINE_PATH = path.join(HERE, "roi-baseline.json");

const Usage = { input: nullable(number()), cached: nullable(number()), output: nullable(number()), usd: nullable(number()) };
export const RoiTaskSchema = object({
  id: string(),
  profile: string(),
  /** true passed, false failed, null not decided (a report pending review). */
  passed: nullable(boolean()),
  ...Usage,
  /** Spend by role (worker, manager, review), when the evidence names it. */
  roles: optional(record(object(Usage))),
});
export type RoiTask = Infer<typeof RoiTaskSchema>;
export const RoiFixtureSchema = object({ schemaVersion: literal(1), source: string(), tasks: array(RoiTaskSchema), unattributed: optional(object(Usage)) });
export type RoiFixture = Infer<typeof RoiFixtureSchema>;

export type RoiRow = {
  profile: string;
  tasks: number;
  passed: number;
  undecided: number;
  passRate: number | null;
  input: number | null;
  cached: number | null;
  output: number | null;
  usd: number | null;
  /** input + cached + output (the known parts) per passed task; null when nothing passed. */
  tokensPerPass: number | null;
  usdPerPass: number | null;
};

const round = (value: number, places: number): number => Number(value.toFixed(places));
/** The sum of the known values, or null when none is known. */
function sum(values: readonly (number | null)[]): number | null {
  const known = values.filter((v): v is number => v !== null);
  return known.length ? known.reduce((a, b) => a + b, 0) : null;
}

/** One row per profile, sorted by name. Everything a failed task spent counts against the passed ones. */
export function roiTable(tasks: readonly RoiTask[]): RoiRow[] {
  const profiles = [...new Set(tasks.map((t) => t.profile))].sort();
  return profiles.map((profile) => {
    const mine = tasks.filter((t) => t.profile === profile);
    const passed = mine.filter((t) => t.passed === true).length;
    const undecided = mine.filter((t) => t.passed === null).length;
    const decided = mine.length - undecided;
    const input = sum(mine.map((t) => t.input));
    const cached = sum(mine.map((t) => t.cached));
    const output = sum(mine.map((t) => t.output));
    const usd = sum(mine.map((t) => t.usd));
    const tokens = sum([input, cached, output]);
    return {
      profile,
      tasks: mine.length,
      passed,
      undecided,
      passRate: decided ? round(passed / decided, 4) : null,
      input,
      cached,
      output,
      usd: usd === null ? null : round(usd, 6),
      tokensPerPass: passed && tokens !== null ? Math.round(tokens / passed) : null,
      usdPerPass: passed && usd !== null ? round(usd / passed, 6) : null,
    };
  });
}

// --- autonomous runs -----------------------------------------------------------------------------

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const readJsonl = (file: string): unknown[] => {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).flatMap((l) => {
    try { return [parseJson(l)]; } catch { return []; }
  });
};

type Meter = { at: number; cycle: number | null; role: string; input: number | null; output: number | null; usd: number | null };
const emptyUsage = (): { input: number | null; cached: number | null; output: number | null; usd: number | null } => ({ input: null, cached: null, output: null, usd: null });
const add = (a: number | null, b: number | null): number | null => (b === null ? a : (a ?? 0) + b);

/** The cycles of one autonomous run as tasks, and the usage no cycle accounts for. */
export function tasksFromRun(stateHome: string, profile = "long-horizon"): { tasks: RoiTask[]; unattributed: RoiFixture["unattributed"]; skipped: number } {
  const run = path.basename(path.resolve(stateHome));
  const rows: Meter[] = [];
  for (const [file, role] of [["usage.jsonl", "worker"], ["manager.jsonl", "manager"]] as const) {
    for (const row of readJsonl(path.join(stateHome, "meter", file))) {
      if (!isRecord(row) || typeof row.at !== "string") continue;
      const at = Date.parse(row.at);
      if (!Number.isFinite(at)) continue;
      rows.push({
        at,
        cycle: typeof row.cycle === "number" ? row.cycle : null,
        role: typeof row.role === "string" ? row.role : role,
        input: finite(row.promptTokens) ? row.promptTokens : null,
        output: finite(row.completionTokens) ? row.completionTokens : null,
        usd: finite(row.costUsd) ? row.costUsd : null,
      });
    }
  }
  const stepsDir = path.join(stateHome, "steps");
  const cycles = (fs.existsSync(stepsDir) ? fs.readdirSync(stepsDir).sort() : []).flatMap((step) => {
    const file = path.join(stepsDir, step, "cycle.json");
    if (!fs.existsSync(file)) return [];
    const c = parseJson(fs.readFileSync(file, "utf8"));
    if (!isRecord(c) || typeof c.n !== "number") return [];
    const start = typeof c.startedAt === "string" ? Date.parse(c.startedAt) : Number.NaN;
    const end = typeof c.endedAt === "string" ? Date.parse(c.endedAt) : Number.NaN;
    return [{ n: c.n, merged: c.merged === true, start, end }];
  });
  const owner = (r: Meter): number | null => {
    if (r.cycle !== null) return cycles.some((c) => c.n === r.cycle) ? r.cycle : null;
    return cycles.find((c) => Number.isFinite(c.start) && Number.isFinite(c.end) && r.at >= c.start && r.at <= c.end)?.n ?? null;
  };
  const unattributed = emptyUsage();
  const byCycle = new Map<number, Meter[]>();
  for (const r of rows) {
    const n = owner(r);
    if (n === null) {
      unattributed.input = add(unattributed.input, r.input);
      unattributed.output = add(unattributed.output, r.output);
      unattributed.usd = add(unattributed.usd, r.usd);
      continue;
    }
    byCycle.set(n, [...(byCycle.get(n) ?? []), r]);
  }
  let skipped = 0;
  const tasks = cycles.flatMap((c): RoiTask[] => {
    const mine = byCycle.get(c.n) ?? [];
    if (!mine.some((r) => r.input !== null || r.output !== null || (r.usd ?? 0) > 0)) { skipped++; return []; }
    const roles: Record<string, { input: number | null; cached: number | null; output: number | null; usd: number | null }> = {};
    for (const r of mine) {
      const u = roles[r.role] ?? emptyUsage();
      u.input = add(u.input, r.input);
      u.output = add(u.output, r.output);
      u.usd = add(u.usd, r.usd);
      roles[r.role] = u;
    }
    const usd = sum(mine.map((r) => r.usd));
    return [{
      id: `${run}#${String(c.n)}`,
      profile,
      passed: c.merged,
      input: sum(mine.map((r) => r.input)),
      cached: null,
      output: sum(mine.map((r) => r.output)),
      usd: usd === null ? null : round(usd, 6),
      roles: Object.fromEntries(Object.entries(roles).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, { ...v, usd: v.usd === null ? null : round(v.usd, 6) }])),
    }];
  });
  return { tasks, unattributed: { ...unattributed, usd: unattributed.usd === null ? null : round(unattributed.usd, 6) }, skipped };
}

// --- live evaluation -----------------------------------------------------------------------------

const prop = (v: unknown, key: string): unknown => (isRecord(v) ? v[key] : undefined);
const num = (v: unknown): number | null => (finite(v) ? v : null);

/** The cases of one live evaluation run (its `summary.json` and `runtime.json`) as tasks. */
export function tasksFromLive(outDir: string): RoiTask[] {
  const runtime = parseJson(fs.readFileSync(path.join(outDir, "runtime.json"), "utf8"));
  const variant = prop(runtime, "variant");
  const profile = typeof variant === "string" ? `live:${variant}` : "live";
  const summary = parseJson(fs.readFileSync(path.join(outDir, "summary.json"), "utf8"));
  if (!Array.isArray(summary)) throw new Error(`${path.join(outDir, "summary.json")} is not a list of case results`);
  return summary.flatMap((c): RoiTask[] => {
    const name = prop(c, "name");
    if (typeof name !== "string") return [];
    const outcome = prop(c, "outcome");
    const observed = prop(prop(c, "usageSummary"), "observed");
    const cost = prop(prop(c, "usageSummary"), "cost");
    const input = num(prop(observed, "input"));
    const cacheWrite = num(prop(observed, "cacheWrite"));
    return [{
      id: name,
      profile,
      passed: outcome === "passed" ? true : outcome === "pending_review" ? null : false,
      input: input === null && cacheWrite === null ? null : (input ?? 0) + (cacheWrite ?? 0),
      cached: num(prop(observed, "cacheRead")),
      output: num(prop(observed, "output")),
      usd: num(prop(cost, "observedTotal")),
    }];
  });
}

// --- files and the command -------------------------------------------------------------------------

export function readFixtures(dir: string = FIXTURE_DIR): RoiFixture[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort()
    .map((f) => parseJsonAs(RoiFixtureSchema, fs.readFileSync(path.join(dir, f), "utf8"), f));
}

export const RoiBaselineSchema = object({ schemaVersion: literal(1), sources: array(string()), rows: array(object({
  profile: string(), tasks: number(), passed: number(), undecided: number(), passRate: nullable(number()),
  input: nullable(number()), cached: nullable(number()), output: nullable(number()), usd: nullable(number()),
  tokensPerPass: nullable(number()), usdPerPass: nullable(number()),
})) });
export type RoiBaseline = Infer<typeof RoiBaselineSchema>;

export function baselineFor(fixtures: readonly RoiFixture[]): RoiBaseline {
  return { schemaVersion: 1, sources: fixtures.map((f) => f.source), rows: roiTable(fixtures.flatMap((f) => f.tasks)) };
}

const show = (v: number | null, digits = 0): string => (v === null ? "-" : digits ? v.toFixed(digits) : String(v));

export function formatTable(rows: readonly RoiRow[]): string {
  const head = ["profile", "tasks", "passed", "pass rate", "input", "cached", "output", "USD", "tokens/pass", "USD/pass"];
  const body = rows.map((r) => [r.profile, String(r.tasks), String(r.passed), r.passRate === null ? "-" : `${(r.passRate * 100).toFixed(1)}%`,
    show(r.input), show(r.cached), show(r.output), show(r.usd, 4), show(r.tokensPerPass), show(r.usdPerPass, 4)]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => (b[i] ?? "").length)));
  return [head, ...body].map((cols) => cols.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ").trimEnd()).join("\n");
}

const USAGE = "usage: eval:roi [--json] [--write-baseline] | --from-runs <state home>... [--profile <name>] | --from-live <out dir> [--write-fixture <file> --source <text>]";

export function main(argv: readonly string[], log: (line: string) => void = console.log): number {
  const has = (flag: string) => argv.includes(flag);
  const valuesOf = (flag: string): string[] => {
    const i = argv.indexOf(flag);
    if (i < 0) return [];
    const out: string[] = [];
    for (let j = i + 1; j < argv.length && !(argv[j] ?? "").startsWith("--"); j++) out.push(argv[j] ?? "");
    return out;
  };
  const one = (flag: string): string | undefined => valuesOf(flag)[0];
  if (has("--help")) { log(USAGE); return 0; }
  const runs = valuesOf("--from-runs");
  const live = one("--from-live");
  if (runs.length || live !== undefined) {
    const tasks: RoiTask[] = [];
    const unattributed = emptyUsage();
    for (const home of runs) {
      const r = tasksFromRun(home, one("--profile") ?? "long-horizon");
      tasks.push(...r.tasks);
      unattributed.input = add(unattributed.input, r.unattributed?.input ?? null);
      unattributed.output = add(unattributed.output, r.unattributed?.output ?? null);
      unattributed.usd = add(unattributed.usd, r.unattributed?.usd ?? null);
      if (r.skipped) log(`${path.basename(path.resolve(home))}: ${String(r.skipped)} cycle(s) with no metered work skipped`);
    }
    if (live !== undefined) tasks.push(...tasksFromLive(live));
    const out = one("--write-fixture");
    if (out !== undefined) {
      const fixture: RoiFixture = { schemaVersion: 1, source: one("--source") ?? "recorded evidence", tasks, ...(runs.length ? { unattributed: { ...unattributed, usd: unattributed.usd === null ? null : round(unattributed.usd, 6) } } : {}) };
      fs.writeFileSync(out, `${JSON.stringify(fixture, null, 2)}\n`);
      log(`wrote ${out} (${String(tasks.length)} task(s))`);
    }
    if (runs.length && unattributed.usd !== null) log(`unattributed (in no cycle): ${show(unattributed.input)} input, ${show(unattributed.output)} output tokens, $${show(unattributed.usd, 4)}`);
    log(has("--json") ? JSON.stringify(roiTable(tasks), null, 2) : formatTable(roiTable(tasks)));
    return 0;
  }
  const fixtures = readFixtures();
  if (fixtures.length === 0) { log(`no fixtures in ${FIXTURE_DIR}`); return 2; }
  const baseline = baselineFor(fixtures);
  if (has("--write-baseline")) {
    fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
    log(`wrote ${path.relative(process.cwd(), BASELINE_PATH)}`);
  }
  log(has("--json") ? JSON.stringify(baseline, null, 2) : `${formatTable(baseline.rows)}\n\nsources: ${baseline.sources.join("; ")}`);
  if (!fs.existsSync(BASELINE_PATH)) { log("no roi-baseline.json; record one with --write-baseline"); return 1; }
  const recorded = parseJsonAs(RoiBaselineSchema, fs.readFileSync(BASELINE_PATH, "utf8"), "roi-baseline.json");
  if (JSON.stringify(recorded) !== JSON.stringify(baseline)) {
    log("roi-baseline.json differs from the fixtures: record a deliberate change with --write-baseline");
    return 1;
  }
  return 0;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
