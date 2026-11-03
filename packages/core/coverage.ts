#!/usr/bin/env node
/**
 * Measure statement-line, branch and function coverage of the whole check suite.
 *
 * Runs `node packages/core/check-all.ts` (any arguments are passed on, such as `--skip=`) with
 * NODE_V8_COVERAGE set, so every Node process the suite starts writes V8's precise block coverage,
 * then summarises it for the code under `packages/` (tests and dependencies are not counted). No
 * coverage dependency: the V8 data is read directly.
 *
 * How the numbers are counted:
 *   - test infrastructure (packages/core/eval, any tests/ folder) is not counted;
 *   - a script is a file V8 ran: a `.ts` file Node ran directly (type stripping keeps every
 *     offset), or a module the eval harness transpiled into node_modules/.cache/pi-kit-eval, which
 *     is attributed to its source file and measured as transpiled (marked "(transpiled)");
 *   - a line is a non-blank line that is not only a comment; it is covered when the innermost V8
 *     range at its first character ran at least once in any process;
 *   - a branch is a V8 block range (a branch arm, a loop body, a short-circuit operand, the code
 *     after a return); a function is a V8 function range. Each is covered when it ran at least once.
 * Files no test loads are not listed (V8 reports only what a process loaded), so the totals cover
 * the code the suite reaches; the summary also counts the `.ts` files under packages/ it never saw.
 *
 * Exit status is check-all's. The summary is printed, written to `coverage/summary.md` and
 * `coverage/summary.json`, and appended to $GITHUB_STEP_SUMMARY when that is set.
 *
 * Usage:
 *   npm run coverage                       # run every check under coverage
 *   npm run coverage -- --skip=eval        # check-all arguments pass through
 *   node packages/core/coverage.ts --report <dir>   # summarise an existing NODE_V8_COVERAGE dir
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord, parseJson } from "./lib/guard.ts";
import { WORKSPACE_ROOT } from "./lib/paths.ts";

const ROOT = WORKSPACE_ROOT;
const CACHE_DIR = path.join(ROOT, "node_modules", ".cache", "pi-kit-eval");
const OUT_DIR = path.join(ROOT, "coverage");
/** The cache directory as written and as V8 reports it (node_modules may be a link). */
const CACHE_DIRS = new Set([CACHE_DIR, ...(fs.existsSync(CACHE_DIR) ? [fs.realpathSync(CACHE_DIR)] : [])]);

interface Range { start: number; end: number; count: number }
interface FnCoverage { ranges: Range[]; isBlockCoverage: boolean }

/** Coverage of one script text, merged over every process that ran it. */
interface ScriptCoverage {
  label: string;
  lines: Map<number, boolean>; // line index -> covered
  branches: Map<string, boolean>; // "start:end" -> covered
  functions: Map<string, boolean>; // "start:end" -> covered
}

export interface Totals { covered: number; total: number }
export interface FileSummary { file: string; lines: Totals; branches: Totals; functions: Totals }
export interface CoverageSummary { files: FileSummary[]; lines: Totals; branches: Totals; functions: Totals; unseen: string[]; linesWithUnseen: Totals }

function readRanges(value: unknown): Range[] {
  if (!Array.isArray(value)) return [];
  const out: Range[] = [];
  for (const r of value) {
    if (isRecord(r) && typeof r.startOffset === "number" && typeof r.endOffset === "number" && typeof r.count === "number") out.push({ start: r.startOffset, end: r.endOffset, count: r.count });
  }
  return out;
}

function readFunctions(value: unknown): FnCoverage[] {
  if (!Array.isArray(value)) return [];
  const out: FnCoverage[] = [];
  for (const f of value) if (isRecord(f)) out.push({ ranges: readRanges(f.ranges), isBlockCoverage: f.isBlockCoverage === true });
  return out;
}

/** Every `.ts` source under packages/ (not node_modules), keyed by the harness's flat cache name. */
function sourcesByCacheName(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
        const rel = path.relative(ROOT, p).split(path.sep).join("/");
        out.set(rel.replace(/[\\/:]/g, "_").replace(/\.ts$/, ".mjs"), rel);
      }
    }
  };
  walk(path.join(ROOT, "packages"));
  return out;
}

/** The repository file a coverage URL is counted as, or null when it is not counted. */
export function attribute(url: string, cacheNames: ReadonlyMap<string, string>): { label: string; file: string } | null {
  if (!url.startsWith("file://")) return null;
  let file: string;
  try {
    file = fileURLToPath(url.replace(/\?.*$/, ""));
  } catch {
    return null;
  }
  if (CACHE_DIRS.has(path.dirname(file))) {
    const source = cacheNames.get(path.basename(file));
    return source === undefined ? null : { label: `${source} (transpiled)`, file };
  }
  const rel = path.relative(ROOT, file).split(path.sep).join("/");
  if (rel.startsWith("..") || path.isAbsolute(rel) || !rel.startsWith("packages/") || rel.includes("/node_modules/") || !/\.(?:ts|mjs|js)$/.test(rel)) return null;
  if (rel.startsWith("packages/web-ui/public/")) return null; // browser code, compiled from packages/web-ui/src
  if (rel.startsWith("packages/core/eval/") || rel.includes("/tests/")) return null; // test infrastructure, not the code under test
  return { label: rel, file };
}

/** Character offsets where each line starts. */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

/** For each counted line, the offset of its first code character; blank and comment-only lines are skipped. */
function codeLines(text: string): Map<number, number> {
  const out = new Map<number, number>();
  const starts = lineStarts(text);
  let inBlockComment = false;
  for (let line = 0; line < starts.length; line++) {
    const start = starts[line] ?? 0;
    const end = starts[line + 1] ?? text.length;
    const body = text.slice(start, end);
    const trimmed = body.trim();
    if (inBlockComment) {
      if (trimmed.includes("*/")) inBlockComment = false;
      continue;
    }
    if (trimmed === "" || trimmed.startsWith("//")) continue;
    if (trimmed.startsWith("/*")) {
      if (!trimmed.includes("*/")) inBlockComment = true;
      continue;
    }
    out.set(line, start + (body.length - body.trimStart().length));
  }
  return out;
}

/** Execution count at each offset: later ranges of a function are nested inside earlier ones and override them. */
function offsetCounts(length: number, functions: readonly FnCoverage[]): Int32Array {
  const counts = new Int32Array(length).fill(-1);
  // Outer ranges first: V8 lists a function's own range first, then its blocks; functions come in
  // source order, nested functions after their parent, so applying in order leaves the innermost.
  const all: Range[] = [];
  for (const fn of functions) all.push(...fn.ranges);
  all.sort((a, b) => a.start - b.start || b.end - a.end);
  for (const r of all) counts.fill(r.count, Math.max(0, r.start), Math.min(length, r.end));
  return counts;
}

function mergeScript(into: ScriptCoverage, text: string, functions: readonly FnCoverage[]): void {
  const counts = offsetCounts(text.length, functions);
  for (const [line, offset] of codeLines(text)) {
    const ran = (counts[offset] ?? -1) > 0;
    into.lines.set(line, (into.lines.get(line) ?? false) || ran);
  }
  for (const [i, fn] of functions.entries()) {
    const [own, ...blocks] = fn.ranges;
    if (own && i > 0) {
      // Entry 0 is the module itself; every other entry is a function.
      const key = `${own.start}:${own.end}`;
      into.functions.set(key, (into.functions.get(key) ?? false) || own.count > 0);
    }
    if (!fn.isBlockCoverage) continue;
    for (const b of blocks) {
      const key = `${b.start}:${b.end}`;
      into.branches.set(key, (into.branches.get(key) ?? false) || b.count > 0);
    }
  }
}

const tally = (m: ReadonlyMap<string | number, boolean>): Totals => {
  let covered = 0;
  for (const v of m.values()) if (v) covered++;
  return { covered, total: m.size };
};
const add = (a: Totals, b: Totals): Totals => ({ covered: a.covered + b.covered, total: a.total + b.total });
export const percent = (t: Totals): string => (t.total === 0 ? "n/a" : `${((100 * t.covered) / t.total).toFixed(1)}%`);

/** Summarises every coverage-*.json in `dir`. */
export function summarise(dir: string): CoverageSummary {
  const cacheNames = sourcesByCacheName();
  const scripts = new Map<string, ScriptCoverage>(); // file path -> merged coverage
  const texts = new Map<string, string | null>();
  for (const name of fs.readdirSync(dir).filter((n) => n.startsWith("coverage-") && n.endsWith(".json")).sort()) {
    let raw: unknown;
    try {
      raw = parseJson(fs.readFileSync(path.join(dir, name), "utf8"));
    } catch {
      continue; // a process killed mid-write leaves a partial file; the rest still count
    }
    if (!isRecord(raw) || !Array.isArray(raw.result)) continue;
    for (const entry of raw.result) {
      if (!isRecord(entry) || typeof entry.url !== "string") continue;
      const where = attribute(entry.url, cacheNames);
      if (!where) continue;
      if (!texts.has(where.file)) {
        try {
          texts.set(where.file, fs.readFileSync(where.file, "utf8"));
        } catch {
          texts.set(where.file, null);
        }
      }
      const text = texts.get(where.file);
      if (text === null || text === undefined) continue;
      let script = scripts.get(where.file);
      if (!script) {
        script = { label: where.label, lines: new Map(), branches: new Map(), functions: new Map() };
        scripts.set(where.file, script);
      }
      mergeScript(script, text, readFunctions(entry.functions));
    }
  }
  const files: FileSummary[] = [...scripts.values()]
    .map((s) => ({ file: s.label, lines: tally(s.lines), branches: tally(s.branches), functions: tally(s.functions) }))
    .sort((a, b) => a.file.localeCompare(b.file));
  const zero: Totals = { covered: 0, total: 0 };
  const seen = new Set(files.map((f) => f.file.replace(/ \(transpiled\)$/, "")));
  const unseen = [...new Set(cacheNames.values())].filter((rel) => !seen.has(rel) && !rel.includes("/tests/") && !rel.startsWith("packages/core/eval/") && !rel.startsWith("packages/web-ui/public/")).sort();
  const lines = files.reduce((t, f) => add(t, f.lines), zero);
  let unseenLines = 0;
  for (const rel of unseen) unseenLines += codeLines(fs.readFileSync(path.join(ROOT, rel), "utf8")).size;
  return {
    files,
    lines,
    linesWithUnseen: { covered: lines.covered, total: lines.total + unseenLines },
    branches: files.reduce((t, f) => add(t, f.branches), zero),
    functions: files.reduce((t, f) => add(t, f.functions), zero),
    unseen,
  };
}

export function markdown(s: CoverageSummary): string {
  const least = [...s.files].filter((f) => f.lines.total >= 20).sort((a, b) => a.lines.covered / a.lines.total - b.lines.covered / b.lines.total).slice(0, 15);
  return [
    "## Test coverage (`npm run coverage`)",
    "",
    "| | Covered | Total | Coverage |",
    "|---|---:|---:|---:|",
    `| Lines | ${s.lines.covered} | ${s.lines.total} | ${percent(s.lines)} |`,
    `| Branches | ${s.branches.covered} | ${s.branches.total} | ${percent(s.branches)} |`,
    `| Functions | ${s.functions.covered} | ${s.functions.total} | ${percent(s.functions)} |`,
    `| Lines, counting never-loaded files as uncovered | ${s.linesWithUnseen.covered} | ${s.linesWithUnseen.total} | ${percent(s.linesWithUnseen)} |`,
    "",
    `${s.files.length} scripts under \`packages/\` measured; ${s.unseen.length} \`.ts\` files under \`packages/\` were never loaded by a check and are not in the totals.`,
    "",
    "Least-covered scripts (at least 20 lines):",
    "",
    "| Script | Lines | Branches |",
    "|---|---:|---:|",
    ...least.map((f) => `| \`${f.file}\` | ${percent(f.lines)} | ${percent(f.branches)} |`),
    "",
  ].join("\n");
}

function report(dir: string): void {
  const summary = summarise(dir);
  const md = markdown(summary);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, "summary.md"), md);
  fs.writeFileSync(path.join(OUT_DIR, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  const stepSummary = process.env.GITHUB_STEP_SUMMARY;
  if (stepSummary) fs.appendFileSync(stepSummary, `${md}\n`);
  console.log(`\n${md}`);
  console.log(`[coverage] lines ${percent(summary.lines)}, branches ${percent(summary.branches)}, functions ${percent(summary.functions)} (coverage/summary.md)`);
}

function main(argv: readonly string[]): number {
  if (argv[0] === "--report") {
    const dir = argv[1];
    if (dir === undefined) {
      console.error("coverage: --report needs a directory");
      return 2;
    }
    report(dir);
    return 0;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-coverage-"));
  try {
    const run = spawnSync(process.execPath, [path.join(ROOT, "packages", "core", "check-all.ts"), ...argv], {
      cwd: ROOT,
      stdio: "inherit",
      env: { ...process.env, NODE_V8_COVERAGE: dir },
    });
    report(dir);
    if (run.error) {
      console.error(`coverage: could not run check-all: ${run.error.message}`);
      return 1;
    }
    return run.status ?? 1;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
