/**
 * Runs whose process is gone. A SIGKILL, a closed terminal or a crash leaves a run's state file
 * saying "running" for ever, so the list lies and nothing offers the resume. At session start this
 * marks such runs interrupted (resumable with `workflow_run {resume}`) and reports them once.
 *
 * "Owner-less" reuses `queryRuns`: not live in this process, a script or YAML run, and still
 * "running". A run records its process in owner.json; it is owner-less only when that pid is gone.
 * A run from before owner.json existed has no owner to ask, so it falls back to `STALE_MS` of quiet.
 * An autonomous run has its own supervisor lock and is not touched here.
 */
import fs from "node:fs";
import path from "node:path";
import { queryRuns, type QueryOptions } from "./run-query.ts";
import { loadState, runsRoot, saveState, writePrivate } from "./workflow.ts";

export const STALE_MS = 5 * 60_000;

/**
 * The pid a run recorded in owner.json when it started writing, or undefined for a run from before
 * that file existed. A run whose recorded process is still alive is never touched, however quiet:
 * one agent step can run far longer than any mtime window.
 */
function ownerPid(dir: string): number | undefined {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(path.join(dir, "owner.json"), "utf8"));
    const pid = typeof raw === "object" && raw !== null ? (raw as { pid?: unknown }).pid : undefined;
    return typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const RUN_FILES = ["state.json", "run.json", "journal.jsonl"];

/** The newest mtime among a run's own files, or 0 when it has none. */
function lastTouched(dir: string): number {
  let newest = 0;
  for (const name of RUN_FILES) {
    try {
      newest = Math.max(newest, fs.statSync(path.join(dir, name)).mtimeMs);
    } catch {
      /* the file does not exist for this format */
    }
  }
  return newest;
}

function markScript(dir: string): boolean {
  try {
    const file = path.join(dir, "run.json");
    const raw: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
    writePrivate(file, `${JSON.stringify({ ...raw, status: "interrupted", updatedAt: new Date().toISOString() }, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

/** Marks every owner-less running run interrupted and returns their ids. Never throws. */
export function interruptOrphanedRuns(cwd: string, opts: QueryOptions & { now?: number } = {}): string[] {
  const now = opts.now ?? Date.now();
  const marked: string[] = [];
  try {
    for (const run of queryRuns(cwd, opts)) {
      if (run.live || run.status !== "running" || (run.format !== "yaml" && run.format !== "script") || !run.dir) continue;
      const owner = ownerPid(run.dir);
      if (owner !== undefined) {
        if (owner === process.pid || pidAlive(owner)) continue; // a live owner: quiet is not dead
      } else if (now - lastTouched(run.dir) < STALE_MS) continue; // no owner record: the quiet-time heuristic
      let done = false;
      if (run.format === "script") done = markScript(run.dir);
      else {
        const state = loadState(cwd, run.id);
        if (state?.status === "running") {
          state.status = "interrupted";
          saveState(path.join(runsRoot(cwd), run.id), state);
          done = true;
        }
      }
      if (done) marked.push(run.id);
    }
  } catch {
    /* a scan that cannot read the runs reports none */
  }
  return marked;
}

/** The one notice for the runs just marked, with how to resume each. */
export function interruptedNotice(ids: readonly string[]): string {
  const shown = ids.slice(0, 5).join(", ");
  return `${ids.length} workflow run(s) were left running by a process that is gone and are now marked interrupted: ${shown}${ids.length > 5 ? ", ..." : ""}. Resume one with workflow_run {resume: "<id>"} or /workflows resume <id>.`;
}
