#!/usr/bin/env node
/**
 * Paperwork budget (PG-19). A cycle's own documentation is capped at 60 lines across
 * `plan.md`, `report.md`, `review.md` and `verify.md`, plus exactly one `JOURNAL.md` line. The
 * cycle-11 paperwork was 245 lines, and the same prose also pushed the merge-review diff budget
 * and `smoke:docs` over their limits, so the budget is checked here instead of trusted.
 *
 * Usage:
 *   node packages/core/paperwork-budget.ts <cycle-dir>
 *   node packages/core/paperwork-budget.ts <cycle-dir> --max-lines=40
 *   node packages/core/paperwork-budget.ts <cycle-dir> --journal=autonomy/JOURNAL.md --run=luna-core-01 --cycle=12
 *
 * Exit 1 when the total exceeds the cap or the journal line count is not exactly one, 2 on bad
 * arguments. The per-file breakdown always prints so an overrun names the file that caused it.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The reviewed cap. The original board evidence (658 trunk lines, 518 cycle/proposal docs) and
 * cycle 11's 245 lines motivate it; a cycle needs room for what it changed, not for restating it. */
export const DEFAULT_PAPERWORK_MAX_LINES = 60;

/** The four documents one cycle may write. `report.md` and `verify.md` are required by the charter;
 * a missing file counts zero lines rather than failing the budget. */
export const PAPERWORK_FILES = ["plan.md", "report.md", "review.md", "verify.md"] as const;

export interface PaperworkFileLines {
  readonly name: string;
  readonly lines: number;
}

export interface PaperworkJournal {
  readonly expected: number;
  readonly found: number;
  readonly ok: boolean;
}

export interface PaperworkBudget {
  readonly ok: boolean;
  readonly total: number;
  readonly max: number;
  readonly overBy: number;
  readonly files: readonly PaperworkFileLines[];
  readonly journal: PaperworkJournal | null;
  readonly problems: readonly string[];
}

export interface PaperworkBudgetInput {
  readonly dir: string;
  readonly maxLines?: number | undefined;
  readonly journal?: string | undefined;
  readonly run?: string | undefined;
  readonly cycle?: string | undefined;
}

function countLines(file: string): number {
  if (!fs.existsSync(file)) return 0;
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines.length;
}

/** Count the cycle paperwork and (when a journal, run and cycle are given) its journal lines. */
export function checkPaperworkBudget(input: PaperworkBudgetInput): PaperworkBudget {
  const max = input.maxLines ?? DEFAULT_PAPERWORK_MAX_LINES;
  const files = PAPERWORK_FILES.map((name) => ({ name, lines: countLines(path.join(input.dir, name)) }));
  const total = files.reduce((sum, file) => sum + file.lines, 0);
  const problems: string[] = [];
  if (total > max) problems.push(`${total} lines of cycle paperwork exceeds the ${max}-line cap by ${total - max}`);

  let journal: PaperworkJournal | null = null;
  if (input.journal !== undefined && input.run !== undefined && input.cycle !== undefined) {
    const marker = `- ${input.run}/${input.cycle} |`;
    const found = fs.existsSync(input.journal)
      ? fs.readFileSync(input.journal, "utf8").split(/\r?\n/).filter((line) => line.startsWith(marker)).length
      : 0;
    journal = { expected: 1, found, ok: found === 1 };
    if (found !== 1) problems.push(`expected exactly one JOURNAL.md line starting with '${marker}', found ${found}`);
  }

  return { ok: problems.length === 0, total, max, overBy: Math.max(0, total - max), files, journal, problems };
}

function usage(): string {
  return "usage: node packages/core/paperwork-budget.ts <cycle-dir> [--max-lines=N] [--journal=FILE --run=NAME --cycle=NN]";
}

function option(argv: readonly string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const at = argv.indexOf(`--${name}`);
  if (at >= 0) return argv[at + 1];
  const inline = argv.find((arg) => arg.startsWith(prefix));
  return inline?.slice(prefix.length);
}

export function main(argv: readonly string[]): number {
  const optionNames = new Set(["--max-lines", "--journal", "--run", "--cycle"]);
  const positional = argv.filter((arg, i) => !arg.startsWith("--") && !optionNames.has(argv[i - 1] ?? ""));
  const dir = positional[0];
  if (dir === undefined) {
    console.error(usage());
    return 2;
  }
  const rawMax = option(argv, "max-lines");
  const maxLines = rawMax === undefined ? DEFAULT_PAPERWORK_MAX_LINES : Number(rawMax);
  if (!Number.isInteger(maxLines) || maxLines < 1) {
    console.error(`paperwork-budget: --max-lines must be a positive integer, got ${rawMax ?? ""}`);
    return 2;
  }
  const result = checkPaperworkBudget({
    dir,
    maxLines,
    journal: option(argv, "journal"),
    run: option(argv, "run"),
    cycle: option(argv, "cycle"),
  });
  for (const file of result.files) console.log(`  ${file.name}: ${file.lines}`);
  const journal = result.journal === null ? "" : `; journal lines: ${result.journal.found}`;
  console.log(`[paperwork-budget] ${result.total}/${result.max} lines${journal}`);
  for (const problem of result.problems) console.error(`  FAIL: ${problem}`);
  if (!result.ok) return 1;
  console.log("[paperwork-budget] OK");
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
