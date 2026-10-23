/**
 * Subagent — run logs and the run registry.
 *
 * Every run writes a human-tailable log (`<id>.log`) plus start/end records in
 * `runs.jsonl`. All of this is best-effort: a logging failure must never fail the run.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_MAX_RUN_LOGS, isRecord, MAX_LOG_BYTES, MAX_REGISTRY_RUNS, SUBAGENT_STATE_DIRNAME, toText } from "./config.ts";
import type { RunLog } from "./types.ts";

export function subagentStateDir(cwd: string): string {
  const override = process.env.PI_KIT_SUBAGENT_STATE_DIR;
  return override?.trim() ? path.resolve(cwd, override.trim()) : path.join(cwd, SUBAGENT_STATE_DIRNAME);
}

function nowIso(): string {
  return new Date().toISOString();
}

// Best-effort cleanup so `.pi/subagent` cannot grow without bound. Keeps the newest N logs.
export function pruneRunLogs(dir: string, keep: number = DEFAULT_MAX_RUN_LOGS): void {
  try {
    const logs = fs.readdirSync(dir).filter((name) => name.endsWith(".log")).map((name) => {
      const file = path.join(dir, name);
      let mtime = 0;
      try {
        mtime = fs.statSync(file).mtimeMs;
      } catch {
        /* ignore */
      }
      return { name, file, mtime };
    }).sort((a, b) => b.mtime - a.mtime);
    for (const stale of logs.slice(keep)) {
      try {
        fs.unlinkSync(stale.file);
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
  compactRegistry(dir);
}

// Keep runs.jsonl bounded: retain every record belonging to the newest MAX_REGISTRY_RUNS run
// ids, dropping older ones. Written via tmp+rename so a concurrent reader never sees a partial
// file; a record appended by another process between read and rename can be lost, which is
// acceptable for a best-effort status registry (the run's own log is untouched).
export function compactRegistry(dir: string, keepRuns: number = MAX_REGISTRY_RUNS): void {
  const file = path.join(dir, "runs.jsonl");
  try {
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
    const order: string[] = [];
    const seen = new Set<string>();
    const ids = lines.map((line) => {
      try {
        const parsed: unknown = JSON.parse(line);
        const id = toText((isRecord(parsed) ? parsed.id : undefined) ?? "");
        if (id && !seen.has(id)) {
          seen.add(id);
          order.push(id);
        }
        return id;
      } catch {
        return "";
      }
    });
    if (order.length <= keepRuns) return;
    const keep = new Set(order.slice(-keepRuns));
    const kept = lines.filter((_line, i) => keep.has(ids[i] ?? ""));
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${kept.join("\n")}\n`);
    fs.renameSync(tmp, file);
  } catch {
    /* best effort */
  }
}

// A run log the operator can `tail -f` while the child works, plus a start/end record in
// runs.jsonl.
export function createRunLog(cwd: string, agentName: string, task: string, depth: number): RunLog {
  const dir = subagentStateDir(cwd);
  // The random suffix matters: parallel runs of one role start in the same millisecond, and a
  // shared id merged their logs and registry rows and overwrote the first child's live stop
  // handle (making it unstoppable).
  const id = `${nowIso().replace(/[:.]/g, "-")}-${agentName.replace(/[^\w-]+/g, "_")}-${crypto.randomBytes(3).toString("hex")}`;
  const logPath = path.join(dir, `${id}.log`);
  const registryPath = path.join(dir, "runs.jsonl");
  let bytes = 0;
  let truncated = false;
  let closed = false;
  try {
    fs.mkdirSync(dir, { recursive: true });
    pruneRunLogs(dir);
  } catch {
    /* best effort */
  }
  const write = (line: string) => {
    if (truncated) return;
    try {
      const text = line.endsWith("\n") ? line : `${line}\n`;
      bytes += Buffer.byteLength(text, "utf8");
      if (bytes > MAX_LOG_BYTES) {
        truncated = true;
        fs.appendFileSync(logPath, "[log truncated: MAX_LOG_BYTES reached]\n");
        return;
      }
      fs.appendFileSync(logPath, text);
    } catch {
      /* best effort */
    }
  };
  const record = (event: string, detail?: Record<string, unknown>) => {
    try {
      fs.appendFileSync(registryPath, `${JSON.stringify({ ts: nowIso(), id, event, agent: agentName, depth, log: logPath, ...detail })}\n`);
    } catch {
      /* best effort */
    }
  };
  write(`# subagent run ${id}`);
  write(`# agent=${agentName} depth=${depth} cwd=${cwd}`);
  write(`# task=${task.slice(0, 500)}`);
  record("start", { task: task.slice(0, 200) });
  return {
    id,
    logPath,
    write,
    attachPid(pid) {
      if (!pid) return;
      write(`# pid=${pid}`);
      try {
        fs.appendFileSync(registryPath, `${JSON.stringify({ ts: nowIso(), id, event: "spawn", pid, agent: agentName })}\n`);
      } catch {
        /* best effort */
      }
    },
    close(status, detail) {
      if (closed) return;
      closed = true;
      write(`# end status=${status}`);
      record("end", { status, ...detail });
    },
  };
}

// Parse the best-effort run registry; a corrupt line must not break status reporting.
export function readRunRegistry(dir: string): Array<Record<string, unknown>> {
  const file = path.join(dir, "runs.jsonl");
  if (!fs.existsSync(file)) return [];
  try {
    return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => {
      try {
        const entry: unknown = JSON.parse(line);
        return isRecord(entry) ? entry : null;
      } catch {
        return null;
      }
    }).filter((entry) => entry !== null);
  } catch {
    return [];
  }
}
