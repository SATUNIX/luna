// The team journal: one searchable line per autonomy cycle report. `tests/docs-smoke.ts`
// asserts that `autonomy/JOURNAL.md` agrees with the reports on the branch, so a cycle
// cannot close without a line naming its board item, outcome and decisions.
import fs from "node:fs";
import path from "node:path";
import { writeFileSafe } from "../shared/safe-fs.ts";

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
const REPORT_HEADING = /^# (.+)$/m;
const REPORT_DECISION = /autonomy\/decisions\/[\w.-]+\.md/g;
const CLOSE_OUT = "Host close-out: the worker exited before recording report.md";
const JOURNAL_HEADER = "# Team journal\n";
/** A cycle key `syncJournal` will write: directory names are untrusted, and an entry is one line. */
const SAFE_KEY = /^[\w.-]+(?:\/[\w.-]+)?$/;

/** The file's text, or null when it does not exist: one read, with no separate existence check. */
function readIfPresent(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

/** Parse entry lines; the header and blanks are ignored, and a malformed `- ` line throws. */
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

/** Every cycle report under `root`: `cycles/<run>/<NN>/report.md` and legacy `cycles/<NN>/report.md`, sorted. */
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

/** Every `autonomy/decisions/<file>.md` path the report text names and the repo actually has. */
function reportDecisions(root: string, text: string): string[] {
  const named = [...new Set([...text.matchAll(REPORT_DECISION)].map((match) => match[0]))];
  return named.filter((file) => fs.existsSync(path.join(root, file))).sort();
}

/** The report's first `# ` heading with `|` removed and whitespace collapsed, else the outcome. */
function reportSummary(text: string, outcome: string): string {
  const heading = REPORT_HEADING.exec(text)?.[1]?.replace(/\|/g, " ").replace(/\s+/g, " ").trim();
  return heading === undefined || heading === "" ? outcome : heading;
}

/** The canonical journal line for a report: the same derivation `syncJournal` writes and `checkJournal` hints. */
export function journalLineFor(root: string, key: string, text: string): string {
  const boards = reportBoards(text);
  const outcome = REPORT_OUTCOME.exec(text)?.[1]?.trim() || "successful";
  const decisions = reportDecisions(root, text);
  const line = `- ${key} | Board: ${formatBoard(boards)} | ${outcome} | ${reportSummary(text, outcome)}`;
  return decisions.length === 0 ? line : `${line} | decisions: ${decisions.join(", ")}`;
}

/** Two parsed entries are the same when every field agrees; board and decisions compare as sets. */
function sameEntry(a: JournalEntry, b: JournalEntry): boolean {
  return (
    (a.board === null) === (b.board === null) &&
    sameSet(a.board ?? [], b.board ?? []) &&
    a.outcome === b.outcome &&
    a.summary === b.summary &&
    sameSet(a.decisions, b.decisions)
  );
}

/** Failures only: a host close-out report is reported through `journalWarnings` instead. */
export function checkJournal(root: string): string[] {
  const problems: string[] = [];
  const journal = path.join(root, "autonomy", "JOURNAL.md");
  const entries = fs.existsSync(journal) ? parseJournal(fs.readFileSync(journal, "utf8")) : [];
  const byKey = new Map<string, JournalEntry>();
  for (const entry of entries) {
    const existing = byKey.get(entry.key);
    // A union merge (`autonomy/JOURNAL.md merge=union`) can duplicate a line byte-for-byte;
    // only a repeat whose content disagrees is a real conflict.
    if (existing === undefined) byKey.set(entry.key, entry);
    else if (!sameEntry(existing, entry)) problems.push(`conflicting journal entries: ${entry.key}`);
  }

  const cycles = path.join(root, "autonomy", "cycles");
  for (const entry of byKey.values()) {
    const dir = path.join(cycles, ...entry.key.split("/"));
    if (!fs.existsSync(dir)) problems.push(`journal entry has no cycle directory: ${entry.key}`);
    else if (!fs.existsSync(path.join(dir, "report.md"))) problems.push(`journal entry has no report: ${entry.key}`);
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
      problems.push(`report with no journal entry: ${key}; add: ${journalLineFor(root, key, text)}`);
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
    const linked = new Set([...byKey.values()].flatMap((entry) => entry.decisions));
    for (const file of fs.readdirSync(decisionsDir).filter((name) => name.endsWith(".md")).sort()) {
      const relative = path.posix.join("autonomy", "decisions", file);
      const text = fs.readFileSync(path.join(decisionsDir, file), "utf8");
      if (!/^Board: (.+)$/m.test(text)) problems.push(`decision file has no Board line: ${relative}`);
      if (!linked.has(relative)) problems.push(`decision file is not linked by any journal entry: ${relative}`);
    }
  }
  return problems;
}

/**
 * Append a journal line for every cycle report that has none, deriving it with `journalLineFor`.
 * Existing content is preserved (the file is created with the standard header when absent), a
 * host close-out report is skipped, and the keys written are returned in report order. Idempotent:
 * a second call finds every report already present and returns `[]`.
 *
 * The journal is read once and replaced through `writeFileSafe` under `root`, so a committed
 * symbolic link at `autonomy/` or `autonomy/JOURNAL.md` is refused instead of followed. A cycle
 * directory whose name could not be one journal key (whitespace, a line break, a `|`) throws
 * before anything is written.
 */
export function syncJournal(root: string): string[] {
  const journal = path.join(root, "autonomy", "JOURNAL.md");
  const current = readIfPresent(journal);
  const known = new Set(parseJournal(current ?? "").map((entry) => entry.key));
  const written: string[] = [];
  for (const { key, report } of cycleReports(root)) {
    if (known.has(key)) continue;
    const text = fs.readFileSync(report, "utf8");
    if (text.includes(CLOSE_OUT)) continue;
    if (!SAFE_KEY.test(key)) throw new Error(`cycle directory name cannot be a journal key: ${JSON.stringify(key)}`);
    known.add(key);
    written.push(journalLineFor(root, key, text));
  }
  if (written.length === 0) return [];
  let content = current ?? JOURNAL_HEADER;
  if (!content.endsWith("\n")) content += "\n";
  content += written.map((line) => `${line}\n`).join("");
  writeFileSafe(journal, content, current === null ? { root, mode: 0o644 } : { root });
  return written;
}

/** Warnings only: host close-out reports need no journal entry, but each is named here. */
export function journalWarnings(root: string): string[] {
  return cycleReports(root)
    .filter(({ report }) => fs.readFileSync(report, "utf8").includes(CLOSE_OUT))
    .map(({ key }) => `host close-out report (no journal entry required): ${key}`);
}
