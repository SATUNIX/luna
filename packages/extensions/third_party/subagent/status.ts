/**
 * Subagent — run status collection and rendering.
 *
 * Shared by the `subagent_status` / `subagent_stop` tools and the `/subagents` and
 * `/subagent-stop` commands, so every surface shows the same picture: registry rows merged
 * with the in-process live registry.
 */
import { toText } from "./config.ts";
import { readRunRegistry } from "./logging.ts";
import { listLive, processAlive } from "./live.ts";

// A run with no end record whose pid is gone (or that never recorded a pid and started long
// ago) died with its parent. Without this it showed "running" forever.
const NO_PID_STALE_MS = 10 * 60 * 1000;

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
