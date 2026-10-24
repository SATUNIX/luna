#!/usr/bin/env node
/**
 * Offline Memento eval (docs/efficiency-and-loops.md, "Measuring Memento mode"). Pairs a
 * single-attempt arm with a generations arm on the same tasks at the same budget (minutes and
 * dollars), puts a Wilson 95% interval on each arm's success rate, calls the result "inconclusive"
 * when the intervals overlap, and writes one proposal file. It never changes the opt-in
 * (`<agent dir>/pi-kit/autonomy.json`) or any other configuration: acting on a proposal is the
 * operator's `/effort memento on`.
 *
 * Arms are functions, so tests drive it with fake arms (tests/memento-eval-smoke.ts). The CLI
 * replays a recorded results file; it launches no model and touches no network:
 *
 *   node packages/core/eval/memento.ts --results <results.json> --out <dir>
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { array, boolean, number, object, parseJsonAs, safeParse, string, type Infer } from "../lib/guard.ts";

/** z for a two-sided 95% interval. */
export const Z95 = 1.959963984540054;

export interface Interval {
  /** successes / n (0 when n is 0). */
  readonly rate: number;
  readonly low: number;
  readonly high: number;
}

/** The Wilson score interval for `successes` out of `n` trials. With no trials it is [0, 1]. */
export function wilson(successes: number, n: number, z: number = Z95): Interval {
  if (!Number.isInteger(n) || n < 0 || !Number.isInteger(successes) || successes < 0 || successes > n) {
    throw new RangeError(`wilson: need integers 0 <= successes <= n, got ${successes}/${n}`);
  }
  if (n === 0) return { rate: 0, low: 0, high: 1 };
  const p = successes / n;
  const z2 = z * z;
  const centre = (p + z2 / (2 * n)) / (1 + z2 / n);
  const half = (z / (1 + z2 / n)) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return { rate: p, low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

/** True when the two closed intervals share at least one point. */
export const overlaps = (a: Interval, b: Interval): boolean => a.low <= b.high && b.low <= a.high;

const BudgetSchema = object({ minutes: number({ min: 0 }), usd: number({ min: 0 }) });
export type Budget = Infer<typeof BudgetSchema>;

const OutcomeSchema = object({ success: boolean(), minutes: number({ min: 0 }), usd: number({ min: 0 }) });
/** What one arm reports for one task. Arms are untrusted: their reports are parsed, never cast. */
export type Outcome = Infer<typeof OutcomeSchema>;

/** A `provider/model` id; it names the proposal file, so it is limited to plain characters. */
const ModelSchema = string({ pattern: /^[A-Za-z0-9._:/-]{1,200}$/ });

export type ArmName = "single" | "generations";
/** One arm: given a task id and the budget both arms share, it reports an outcome. */
export type Arm = (task: string, budget: Budget) => unknown;

export interface ArmSummary {
  readonly n: number;
  readonly successes: number;
  /** Outcomes that spent more than the budget: counted as failures. */
  readonly overBudget: number;
  /** Reports that did not parse, or arms that threw: counted as failures. */
  readonly invalid: number;
  readonly interval: Interval;
}

export type Verdict = "generations" | "single" | "inconclusive";

export interface EvalReport {
  readonly model: string;
  readonly budget: Budget;
  readonly tasks: number;
  readonly arms: Readonly<Record<ArmName, ArmSummary>>;
  /** Paired counts: both succeeded, only one did, neither did. */
  readonly pairs: { readonly both: number; readonly singleOnly: number; readonly generationsOnly: number; readonly neither: number };
  readonly verdict: Verdict;
}

export interface EvalInput {
  readonly model: string;
  readonly tasks: readonly string[];
  readonly budget: Budget;
  readonly single: Arm;
  readonly generations: Arm;
}

type Scored = { success: boolean; overBudget: boolean; invalid: boolean };

async function score(arm: Arm, task: string, budget: Budget): Promise<Scored> {
  let raw: unknown;
  try {
    raw = await arm(task, Object.freeze({ ...budget }));
  } catch {
    return { success: false, overBudget: false, invalid: true };
  }
  const parsed = safeParse(OutcomeSchema, raw, "outcome");
  if (!parsed.ok) return { success: false, overBudget: false, invalid: true };
  const over = parsed.value.minutes > budget.minutes || parsed.value.usd > budget.usd;
  return { success: parsed.value.success && !over, overBudget: over, invalid: false };
}

function summarise(rows: readonly Scored[]): ArmSummary {
  const successes = rows.filter((r) => r.success).length;
  return {
    n: rows.length,
    successes,
    overBudget: rows.filter((r) => r.overBudget).length,
    invalid: rows.filter((r) => r.invalid).length,
    interval: wilson(successes, rows.length),
  };
}

/** The verdict: an arm wins only when its whole interval lies above the other's. */
export function verdictOf(single: Interval, generations: Interval): Verdict {
  if (overlaps(single, generations)) return "inconclusive";
  return generations.low > single.high ? "generations" : "single";
}

/**
 * Runs both arms once per task with the same budget (each gets its own frozen copy), alternating
 * which arm goes first so neither always runs on a warm machine. Arms run one at a time.
 */
export async function runPairedEval(input: EvalInput): Promise<EvalReport> {
  const model = ModelSchema.parse(input.model, "model");
  const budget = BudgetSchema.parse(input.budget, "budget");
  if (budget.minutes <= 0) throw new RangeError("budget.minutes must be above 0");
  if (input.tasks.length === 0) throw new RangeError("no tasks to evaluate");
  const single: Scored[] = [];
  const gens: Scored[] = [];
  for (const [i, task] of input.tasks.entries()) {
    if (i % 2 === 0) {
      single.push(await score(input.single, task, budget));
      gens.push(await score(input.generations, task, budget));
    } else {
      gens.push(await score(input.generations, task, budget));
      single.push(await score(input.single, task, budget));
    }
  }
  const pairs = { both: 0, singleOnly: 0, generationsOnly: 0, neither: 0 };
  single.forEach((s, i) => {
    const g = gens[i]?.success === true;
    if (s.success && g) pairs.both++;
    else if (s.success) pairs.singleOnly++;
    else if (g) pairs.generationsOnly++;
    else pairs.neither++;
  });
  const arms = { single: summarise(single), generations: summarise(gens) };
  return { model, budget, tasks: input.tasks.length, arms, pairs, verdict: verdictOf(arms.single.interval, arms.generations.interval) };
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;

/** The proposal as Markdown. It proposes; it changes nothing. */
export function renderProposal(report: EvalReport, now: Date = new Date()): string {
  const row = (name: string, a: ArmSummary): string =>
    `| ${name} | ${a.successes}/${a.n} | ${pct(a.interval.rate)} | ${pct(a.interval.low)} to ${pct(a.interval.high)} | ${a.overBudget} | ${a.invalid} |`;
  const { model } = report;
  const recommendation =
    report.verdict === "generations"
      ? `Generations did better at the same budget. Proposal: opt \`${model}\` in with \`/effort memento on ${model}\`.`
      : report.verdict === "single"
        ? `Single attempts did better at the same budget. Proposal: leave Memento mode off for \`${model}\`.`
        : `The intervals overlap, so the result is inconclusive. Proposal: leave Memento mode off for \`${model}\` and run more paired tasks.`;
  return [
    `# Memento eval proposal: ${model}`,
    "",
    `Written ${now.toISOString()} by packages/core/eval/memento.ts. This file changes no configuration.`,
    "",
    `Budget per task and arm: ${report.budget.minutes} minutes, $${report.budget.usd}. Paired tasks: ${report.tasks}.`,
    "",
    "| Arm | Successes | Rate | Wilson 95% CI | Over budget | Invalid |",
    "|---|---|---|---|---|---|",
    row("single attempt", report.arms.single),
    row("generations", report.arms.generations),
    "",
    `Paired: both ${report.pairs.both}, single only ${report.pairs.singleOnly}, generations only ${report.pairs.generationsOnly}, neither ${report.pairs.neither}.`,
    "",
    `Verdict: **${report.verdict}**. ${recommendation}`,
    "",
  ].join("\n");
}

/**
 * Writes the proposal into `outDir` (created 0700) as a new 0600 file and returns its path. It never
 * overwrites: an existing file of the same name is an error.
 */
export function writeProposal(outDir: string, report: EvalReport, now: Date = new Date()): string {
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const slug = report.model.replace(/[^A-Za-z0-9._-]+/g, "_");
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const file = path.join(outDir, `memento-eval-${slug}-${stamp}.md`);
  fs.writeFileSync(file, renderProposal(report, now), { flag: "wx", mode: 0o600 });
  return file;
}

const ResultsSchema = object({
  model: ModelSchema,
  budget: BudgetSchema,
  pairs: array(object({ task: string({ minLength: 1, maxLength: 200 }), single: OutcomeSchema, generations: OutcomeSchema }), { maxItems: 10_000 }),
});
export type RecordedResults = Infer<typeof ResultsSchema>;

/** Parses a recorded results file's text (untrusted) into its typed form. */
export const parseResults = (text: string): RecordedResults => parseJsonAs(ResultsSchema, text, "results");

/** Replays recorded results as the two arms, so recorded and live evals score the same way. */
export async function evalRecorded(results: RecordedResults): Promise<EvalReport> {
  const byTask = new Map(results.pairs.map((p) => [p.task, p]));
  if (byTask.size !== results.pairs.length) throw new RangeError("results: task ids must be unique");
  return runPairedEval({
    model: results.model,
    budget: results.budget,
    tasks: results.pairs.map((p) => p.task),
    single: (task) => byTask.get(task)?.single,
    generations: (task) => byTask.get(task)?.generations,
  });
}

function flag(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(args: readonly string[]): Promise<number> {
  const resultsPath = flag(args, "--results");
  const outDir = flag(args, "--out");
  if (!resultsPath || !outDir) {
    console.error("usage: node packages/core/eval/memento.ts --results <results.json> --out <dir>");
    return 2;
  }
  const report = await evalRecorded(parseResults(fs.readFileSync(resultsPath, "utf8")));
  const file = writeProposal(outDir, report);
  console.log(`[memento-eval] verdict ${report.verdict}; proposal written to ${file}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(`[memento-eval] ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    },
  );
}
