import fs from "node:fs";
import path from "node:path";

function dataRoot(): string {
  return process.env.PI_AGENT_DATA_ROOT || process.env.PENTEST_DATA_ROOT || "/srv/data/pi-system";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The tail of a hash-chained JSONL ledger: what the next record chains from. */
export interface ChainTail {
  sequence: number;
  record_hash: string;
}

function readLastChainRecord(file: string): ChainTail {
  if (!fs.existsSync(file)) return { sequence: 0, record_hash: "" };
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
  const last = lines.at(-1);
  if (last === undefined) return { sequence: 0, record_hash: "" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(last);
  } catch (error) {
    // Fail closed: a corrupt chain tail must not silently reset the sequence.
    throw new Error(`corrupt chain record in ${file}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  // Every record appendChainedJsonl writes has a positive integer sequence and a record hash. A
  // tail without them (null, a number, a string, an array, a stray object) is corruption too:
  // reading it as "sequence 0" would re-use sequence numbers and restart the hash chain.
  if (!isRecord(parsed) || typeof parsed.sequence !== "number" || !Number.isInteger(parsed.sequence) || parsed.sequence < 1
    || typeof parsed.record_hash !== "string" || !parsed.record_hash) {
    throw new Error(`corrupt chain record in ${file}: not a chained record`);
  }
  return { sequence: parsed.sequence, record_hash: parsed.record_hash };
}

/**
 * String(value) for JSON-derived data, without the lint rule's "[object Object]" complaint:
 * objects and arrays from JSON.parse stringify exactly as String() would.
 */
function stringOf(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  return (value as { toString(): string }).toString();
}

function readJsonlTail(file: string, limit: number): Array<Record<string, unknown>> {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-limit)
    .map((line) => {
      try {
        return JSON.parse(line) as unknown;
      } catch {
        return undefined;
      }
    })
    .filter(isRecord);
}

function countJsonl(file: string): number {
  if (!fs.existsSync(file)) return 0;
  return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).length;
}

/**
 * The summary fields of a task snapshot file. The files are read from disk, so every field is
 * whatever the file held (absent fields stay as present-but-undefined keys).
 */
export interface TaskSnapshotSummary {
  task_id: unknown;
  title: unknown;
  status: unknown;
  active_step: unknown;
  next_step: unknown;
  version: unknown;
  updated_at: unknown;
}

function latestTaskSnapshots(limit: number): TaskSnapshotSummary[] {
  const tasksDir = path.join(dataRoot(), "tasks");
  if (!fs.existsSync(tasksDir)) return [];
  return fs
    .readdirSync(tasksDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(tasksDir, entry.name), "utf8")) as unknown;
      } catch {
        return undefined;
      }
    })
    .filter((task): task is Record<string, unknown> => isRecord(task) && Object.keys(task).length > 0)
    .sort((left, right) => stringOf(right.updated_at || "").localeCompare(stringOf(left.updated_at || "")))
    .slice(0, limit)
    .map((task): TaskSnapshotSummary => ({
      task_id: task.task_id,
      title: task.title,
      status: task.status,
      active_step: task.active_step,
      next_step: task.next_step,
      version: task.version,
      updated_at: task.updated_at
    }));
}

export { dataRoot, isRecord, stringOf, readJsonlTail, readLastChainRecord, countJsonl, latestTaskSnapshots };
