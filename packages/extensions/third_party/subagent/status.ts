/**
 * Subagent — run status collection, rendering, and stopping.
 *
 * Shared by `run-query.ts` (which `workflow_status` and `/workflows` read), the stop path in
 * `workflow-tools.ts`, and the `/subagents` and `/subagent-stop` commands, so every surface shows
 * the same picture: registry rows merged with the in-process live registry.
 */
import { toText } from "./config.ts";
import { readRunRegistry } from "./logging.ts";
import { listLive, processAlive, recordStop, stopAllLive, stopLive, stopRecordedRun } from "./live.ts";

// A run with no end record whose pid is gone (or that never recorded a pid and started long
// ago) died with its parent. Without this it showed "running" forever.
const NO_PID_STALE_MS = 10 * 60 * 1000;

/** A run id as the model or the operator may give it: a plain name, never a path. */
export function isValidRunId(id: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(id) && !id.includes("..");
}

export interface RunRow {
  id: string;
  agent: string;
  status: string;
  start: string;
  end: string;
  task: string;
  log: string;
  pid?: number;
  live: boolean;
  turns?: number;
  cost?: number;
  attempts?: number;
}

export function collectRuns(dir: string): RunRow[] {
  const byId = new Map<string, RunRow>();
  for (const entry of readRunRegistry(dir)) {
    const id = toText(entry.id);
    const row: RunRow = byId.get(id) ?? { id, agent: "?", status: "running", start: "", end: "", task: "", log: toText(entry.log ?? ""), live: false };
    if (entry.agent) row.agent = toText(entry.agent);
    if (entry.log) row.log = toText(entry.log);
    if (entry.event === "end") {
      row.status = toText(entry.status ?? "end");
      row.end = toText(entry.ts ?? "");
      if (entry.turns !== undefined) row.turns = Number(entry.turns);
      if (entry.cost !== undefined) row.cost = Number(entry.cost);
      if (entry.attempts !== undefined) row.attempts = Number(entry.attempts);
    } else {
      row.start = toText(entry.ts ?? row.start);
      if (entry.task) row.task = toText(entry.task);
      if (entry.pid) row.pid = Number(entry.pid);
    }
    byId.set(id, row);
  }
  for (const row of byId.values()) {
    if (row.end || row.live) continue;
    const dead = row.pid ? !processAlive(row.pid) : Date.now() - Date.parse(row.start || "") > NO_PID_STALE_MS;
    if (dead) row.status = "orphaned";
  }
  for (const child of listLive()) {
    const row = byId.get(child.id) ?? { id: child.id, agent: child.agent, status: "running", start: "", end: "", task: "", log: child.logPath, live: true };
    row.agent = child.agent;
    row.live = true;
    if (!row.end) row.status = "running";
    if (child.pid) row.pid = child.pid;
    byId.set(child.id, row);
  }
  return [...byId.values()].sort((a, b) => (a.start < b.start ? 1 : -1));
}

/**
 * Stop live children (in-process) and recorded orphans (registry pid), or list what is running.
 * Shared by the `workflow_control` tool, the `/workflows stop` command and `/subagent-stop`.
 */
export function stopTargets(dir: string, target: string | undefined): { message: string; ok: boolean } {
  const rows = collectRuns(dir);
  const running = rows.filter((r) => r.status === "running");
  if (!target) {
    return {
      message: running.length
        ? `Running subagents (${running.length}):\n\n${formatRunTable(running)}\n\nStop one with workflow_control {runId: "<id>", action: "stop"} or /workflows stop <id>; all with all: true or /workflows stop all.`
        : "No running subagents.",
      ok: true,
    };
  }
  if (target === "all") {
    const liveCount = stopAllLive();
    let orphanCount = 0;
    for (const r of running) {
      if (!r.live && r.pid && stopRecordedRun(r.pid)) {
        recordStop(dir, r.id);
        orphanCount++;
      }
    }
    return { message: `Stopped ${liveCount} live and ${orphanCount} orphaned subagent(s).`, ok: true };
  }
  if (!isValidRunId(target)) return { message: "Invalid run id.", ok: false };
  const row = rows.find((r) => r.id === target);
  if (!row) return { message: `No run "${target}".`, ok: false };
  if (row.end) return { message: `Run "${target}" already finished (${row.status}).`, ok: true };
  if (stopLive(target)) return { message: `Stop sent to running subagent ${target}.`, ok: true };
  if (row.pid && stopRecordedRun(row.pid)) {
    recordStop(dir, target);
    return { message: `Stop sent to orphaned subagent ${target} (pid ${row.pid}).`, ok: true };
  }
  return { message: `Could not stop ${target}: no live handle and no killable pid.`, ok: false };
}

/** True when a subagent registry row (live, finished or orphaned) has this id. */
export function hasSubagentRun(dir: string, id: string): boolean {
  return collectRuns(dir).some((row) => row.id === id);
}

export function formatDuration(row: RunRow): string {
  if (!row.start || !row.end) return row.status === "running" ? "running" : "—";
  const ms = Date.parse(row.end) - Date.parse(row.start);
  if (!Number.isFinite(ms) || ms < 0) return "—";
  return ms < 1000 ? `${ms}ms` : `${Math.round(ms / 1000)}s`;
}

function formatCost(row: RunRow): string {
  return row.cost && Number.isFinite(row.cost) ? `$${row.cost.toFixed(4)}` : "";
}

function formatAttempts(row: RunRow): string {
  return row.attempts && row.attempts > 1 ? `x${row.attempts}` : "";
}

export function formatRunTable(rows: RunRow[], limit = 20): string {
  const shown = rows.slice(0, Math.max(1, limit));
  return [
    "| run | agent | status | duration | turns | cost | att | live | log |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...shown.map((r) => `| \`${r.id}\` | ${r.agent} | ${r.status} | ${formatDuration(r)} | ${r.turns ?? ""} | ${formatCost(r)} | ${formatAttempts(r)} | ${r.live ? "yes" : ""} | \`${r.log}\` |`),
  ].join("\n");
}
