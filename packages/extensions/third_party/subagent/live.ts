/**
 * Subagent — live child registry and operator stop control.
 *
 * Two layers of termination:
 *  - in-process: children spawned by this pi process, tracked with a terminate handle.
 *  - on-disk: the run registry records each child's pid, so a later process can stop an
 *    orphan whose parent died before the child finished.
 */
import fs from "node:fs";
import path from "node:path";
import { runRegistry } from "./run-model.ts";
import type { LiveChild } from "./types.ts";

const live = new Map<string, LiveChild>();

// Read-only view for the status bar (globalThis so extensions stay self-contained): how many children
// run right now and how many have finished, and failed, since this session started, plus how many
// workflow runs are active in the telemetry registry (run-model.ts).
const SUBAGENTS_KEY = Symbol.for("pi-kit.subagents");
let finished = 0;
let failures = 0;
(globalThis as Record<symbol, unknown>)[SUBAGENTS_KEY] = { snapshot: () => ({ live: live.size, finished, failures, workflows: runRegistry.activeCount() }) };

/** Count a settled child (called once per run, whatever its outcome). */
export function noteFinished(failed: boolean): void {
  finished++;
  if (failed) failures++;
}

export function registerLive(child: LiveChild): void {
  live.set(child.id, child);
}

export function unregisterLive(id: string): void {
  live.delete(id);
}

export function listLive(): LiveChild[] {
  return [...live.values()].sort((a, b) => a.startedAt - b.startedAt);
}

export function getLive(id: string): LiveChild | undefined {
  return live.get(id);
}

// Ask a live child to stop; runChildProcess escalates SIGTERM -> SIGKILL for us.
export function stopLive(id: string): boolean {
  const child = live.get(id);
  if (!child) return false;
  try {
    child.terminate();
    return true;
  } catch {
    return false;
  }
}

export function stopAllLive(): number {
  let stopped = 0;
  for (const child of listLive()) if (stopLive(child.id)) stopped++;
  return stopped;
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Guard against PID reuse before killing a pid read from the registry: on Linux, require
// the process to still look like our pi child. Elsewhere fall back to the registry scope.
function looksLikePiChild(pid: number): boolean {
  if (process.platform !== "linux") return true;
  try {
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ");
    return cmdline.includes("pi-coding-agent") || cmdline.includes("--mode") || cmdline.includes("cli.js");
  } catch {
    return false;
  }
}

// Stop an orphaned child by pid with SIGTERM, escalating to SIGKILL if it survives.
export function stopRecordedRun(pid: number | undefined): boolean {
  if (!pid || !processAlive(pid) || !looksLikePiChild(pid)) return false;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return false;
  }
  const escalate = setTimeout(() => {
    if (processAlive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* ignore */
      }
    }
  }, 3000);
  escalate.unref?.();
  return true;
}

// Record an operator stop in the registry (used for orphans, where no in-process runner
// will write the end record).
export function recordStop(dir: string, runId: string): void {
  try {
    fs.appendFileSync(path.join(dir, "runs.jsonl"), `${JSON.stringify({ ts: new Date().toISOString(), id: runId, event: "end", status: "stopped-by-operator" })}\n`);
  } catch {
    /* best effort */
  }
}
