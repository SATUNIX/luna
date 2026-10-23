import fs from "node:fs";
import path from "node:path";

function dataRoot(): string {
  return process.env.PI_KIT_MEMORY_MCP_DATA_ROOT
    || process.env.PI_AGENT_DATA_ROOT
    || path.join(process.cwd(), ".pi", "memory-mcp");
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

function parseCliJson(raw: string | undefined): Record<string, unknown> {
  if (raw === undefined || raw === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`invalid --call params JSON: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (!isRecord(parsed)) {
    throw new Error("invalid --call params JSON: expected a JSON object");
  }
  return parsed;
}

export { dataRoot, isRecord, stringOf, parseCliJson, readJsonlTail, readLastChainRecord };