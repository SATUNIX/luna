#!/usr/bin/env node
/**
 * Derive the team-journal line for every cycle report that lacks one (PG-20).
 *
 * Why this exists: `checkJournal` fails hard when a report has no `autonomy/JOURNAL.md`
 * entry, and a stream that merges another run's report from `integration/luna` went red
 * until someone hand-wrote that run's line (cycles 02, 03 and 04 each did). Running this
 * script derives the canonical line from the report instead, so the gate still fails on a
 * genuinely missing entry but the entry is never hand-written.
 *
 * Usage:
 *   node packages/core/journal.ts           # derive and append any missing lines
 *   node packages/core/journal.ts --check   # report problems, exiting 1 on any
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JOURNAL_HEADER, checkJournal, missingJournalLines } from "./lib/journal.ts";
import { writeFileSafe } from "./shared/safe-fs.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The file's text, or null when it does not exist: one read, with no separate existence check. */
function readIfPresent(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Append a journal line for every cycle report that has none (`missingJournalLines`). Existing
 * content is preserved, the file is created with the standard header when absent, and the lines
 * written are returned in report order. Idempotent: a second call returns `[]`.
 *
 * The journal is read once and replaced through `writeFileSafe` under `root`, so a committed
 * symbolic link at `autonomy/` or `autonomy/JOURNAL.md` is refused instead of followed.
 */
export function syncJournal(root: string): string[] {
  const journal = path.join(root, "autonomy", "JOURNAL.md");
  const current = readIfPresent(journal);
  const written = missingJournalLines(root, current);
  if (written.length === 0) return [];
  let content = current ?? JOURNAL_HEADER;
  if (!content.endsWith("\n")) content += "\n";
  content += written.map((line) => `${line}\n`).join("");
  writeFileSafe(journal, content, current === null ? { root, mode: 0o644 } : { root });
  return written;
}

function main(): void {
  if (process.argv.slice(2).includes("--check")) {
    const problems = checkJournal(ROOT);
    if (problems.length > 0) {
      for (const problem of problems) console.error(problem);
      process.exit(1);
    }
    console.log("journal: every report has a journal entry");
    return;
  }
  const written = syncJournal(ROOT);
  if (written.length === 0) console.log("journal: every report has a journal entry");
  else for (const line of written) console.log(line);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
