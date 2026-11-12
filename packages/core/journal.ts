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
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkJournal, syncJournal } from "./lib/journal.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

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
