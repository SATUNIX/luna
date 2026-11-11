// The team journal: one searchable line per autonomy cycle report. `tests/docs-smoke.ts`
// asserts that `autonomy/JOURNAL.md` agrees with the reports on the branch, so a cycle
// cannot close without a line naming its board item, outcome and decisions.
import fs from "node:fs";
import path from "node:path";

export interface JournalEntry {
  key: string;
  /** The board IDs the cycle worked, or null for `Board: none`. */
  board: string[] | null;
  outcome: string;
  summary: string;
  /** Repo-relative paths under autonomy/decisions/, in the order written. */
  decisions: string[];
}

export interface CycleReport {
  /** `<run>/<NN>`, or `<NN>` for the legacy layout. */
  key: string;
  /** Empty for the legacy layout. */
  run: string;
  nn: string;
  /** Absolute path to the report file. */
  report: string;
}

const ENTRY = /^- (\S+) \| Board: (.+?) \| (.+?) \| (.+?)(?: \| decisions: (.+))?$/;
const REPORT_BOARD = /^Board: (.+?) (done|progress|blocked) - /gm;
const REPORT_OUTCOME = /^Outcome: (.+)$/m;
const CLOSE_OUT = "Host close-out: the worker exited before recording report.md";

/**
 * Parse journal entry lines (`- <key> | Board: ... | <outcome> | <summary> [| decisions: ...]`).
 * The header and blank lines are ignored. A line that starts with `- ` but does not match the
 * grammar throws, so a typo cannot silently hide an entry.
 */
export function parseJournal(text: string): JournalEntry[] {
  const entries: JournalEntry[] = [];
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    if (!raw.startsWith("- ")) continue;
    const match = ENTRY.exec(raw);
    const key = match?.[1];
    const board = match?.[2];
    const outcome = match?.[3];
    const summary = match?.[4];
    if (match === null || key === undefined || board === undefined || outcome === undefined || summary === undefined) {
      throw new Error(`autonomy/JOURNAL.md:${index + 1}: not a journal entry: ${raw}`);
    }
    const decisions = match[5];
    entries.push({
      key,
      board: board === "none" ? null : board.split(",").map((id) => id.trim()).filter((id) => id !== ""),
      outcome: outcome.trim(),
      summary: summary.trim(),
      decisions: decisions === undefined ? [] : decisions.split(",").map((file) => file.trim()).filter((file) => file !== ""),
    });
  }
  return entries;
}

/** Every cycle report under `root`: `autonomy/cycles/<run>/<NN>/report.md` and legacy `autonomy/cycles/<NN>/report.md`, sorted by key. */
export function cycleReports(root: string): CycleReport[] {
  const cycles = path.join(root, "autonomy", "cycles");
  if (!fs.existsSync(cycles)) return [];
  const reports: CycleReport[] = [];
  for (const run of fs.readdirSync(cycles, { withFileTypes: true })) {
    if (!run.isDirectory()) continue;
    const runDir = path.join(cycles, run.name);
    const legacy = path.join(runDir, "report.md");
    if (fs.statSync(legacy, { throwIfNoEntry: false })?.isFile() === true) {
      reports.push({ key: run.name, run: "", nn: run.name, report: legacy });
      continue;
    }
    for (const cycle of fs.readdirSync(runDir, { withFileTypes: true })) {
      if (!cycle.isDirectory()) continue;
      const report = path.join(runDir, cycle.name, "report.md");
      if (fs.statSync(report, { throwIfNoEntry: false })?.isFile() === true) {
        reports.push({ key: `${run.name}/${cycle.name}`, run: run.name, nn: cycle.name, report });
      }
    }
  }
  return reports.sort((a, b) => a.key.localeCompare(b.key));
}

function reportBoards(text: string): string[] {
  return [...text.matchAll(REPORT_BOARD)].map((match) => match[1] ?? "").filter((id) => id !== "");
}

function sameSet(a: string[], b: string[]): boolean {
  return [...new Set(a)].sort().join("\u0000") === [...new Set(b)].sort().join("\u0000");
}

function formatBoard(board: string[] | null): string {
  return board === null || board.length === 0 ? "none" : board.join(", ");
}

/** Failures only: a host close-out report is reported through `journalWarnings` instead. */
export function checkJournal(root: string): string[] {
  const problems: string[] = [];
  const journal = path.join(root, "autonomy", "JOURNAL.md");
  const entries = fs.existsSync(journal) ? parseJournal(fs.readFileSync(journal, "utf8")) : [];
  const byKey = new Map<string, JournalEntry>();
  for (const entry of entries) {
    if (byKey.has(entry.key)) problems.push(`duplicate journal entry: ${entry.key}`);
    else byKey.set(entry.key, entry);
  }

  const cycles = path.join(root, "autonomy", "cycles");
  for (const entry of entries) {
    const dir = path.join(cycles, ...entry.key.split("/"));
    if (!fs.existsSync(dir)) problems.push(`journal entry has no cycle directory: ${entry.key}`);
    for (const file of entry.decisions) {
      if (!fs.existsSync(path.join(root, file))) {
        problems.push(`journal entry ${entry.key} links a missing decisions file: ${file}`);
      }
    }
  }

  for (const { key, report } of cycleReports(root)) {
    const text = fs.readFileSync(report, "utf8");
    if (text.includes(CLOSE_OUT)) continue;
    const entry = byKey.get(key);
    if (entry === undefined) {
      const boards = reportBoards(text);
      const outcome = REPORT_OUTCOME.exec(text)?.[1]?.trim() ?? "successful";
      problems.push(
        `report with no journal entry: ${key}; add: - ${key} | Board: ${formatBoard(boards)} | ${outcome} | <summary>`,
      );
      continue;
    }
    const reported = reportBoards(text);
    if (!sameSet(reported, entry.board ?? [])) {
      problems.push(
        `journal entry ${key} board mismatch: entry says ${formatBoard(entry.board)}; report has ${formatBoard(reported)}`,
      );
    }
  }

  const decisionsDir = path.join(root, "autonomy", "decisions");
  if (fs.existsSync(decisionsDir)) {
    const linked = new Set(entries.flatMap((entry) => entry.decisions));
    for (const file of fs.readdirSync(decisionsDir).filter((name) => name.endsWith(".md")).sort()) {
      const relative = path.posix.join("autonomy", "decisions", file);
      const text = fs.readFileSync(path.join(decisionsDir, file), "utf8");
      if (!/^Board: (.+)$/m.test(text)) problems.push(`decision file has no Board line: ${relative}`);
      if (!linked.has(relative)) problems.push(`decision file is not linked by any journal entry: ${relative}`);
    }
  }
  return problems;
}

/** Warnings only: host close-out reports need no journal entry, but each is named here. */
export function journalWarnings(root: string): string[] {
  return cycleReports(root)
    .filter(({ report }) => fs.readFileSync(report, "utf8").includes(CLOSE_OUT))
    .map(({ key }) => `host close-out report (no journal entry required): ${key}`);
}
