#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-memory-mcp-"));
const env = { ...process.env, PI_KIT_MEMORY_MCP_DATA_ROOT: root };
const here = path.dirname(fileURLToPath(import.meta.url));

const MemoryRecord = z.looseObject({ memory_id: z.string(), tags: z.array(z.string()) });
const TaskRecord = z.looseObject({ task_id: z.string(), status: z.string(), version: z.number() });
const ChainRecord = z.looseObject({ sequence: z.number(), record_hash: z.string(), previous_hash: z.string() });
const TraceEvent = z.looseObject({ payload: z.looseObject({ i: z.number() }) });

/** Runs one `--call` and parses its stdout with the schema the tool's result must satisfy. */
function call<S extends z.ZodType>(name: string, params: Record<string, unknown>, schema: S): z.output<S> {
  const stdout = execFileSync(process.execPath, ["./index.ts", "--call", name, JSON.stringify(params)], {
    cwd: here,
    env,
    encoding: "utf8"
  });
  return schema.parse(JSON.parse(stdout));
}

try {
  for (const name of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
    assert.throws(
      () => execFileSync(process.execPath, ["./index.ts", "--call", name, "{}"], { cwd: here, env, encoding: "utf8", stdio: "pipe" }),
      (error) => error instanceof Error && "stderr" in error && String(error.stderr).includes(`unknown tool: ${name}`),
      `--call ${name} must be refused as an unknown tool`
    );
  }

  // `--call` params are only checked to be an object: a field of the wrong type is refused, not
  // converted to text (an array topic used to be stored as its joined string).
  const refusals: [string, Record<string, unknown>, string][] = [
    ["memory_store", { topic: ["auth"], content: "x" }, "topic must be a string"],
    ["memory_store", { topic: "auth", content: { text: "x" } }, "content must be a string"],
    ["memory_search", { query: "x", limit: "5" }, "limit must be an integer"],
    ["task_create", { task_id: 123, title: "t" }, "task_id must be a string"],
    ["checkpoint_append", { task_id: "t", blockers: [{}] }, "blockers must be a string"]
  ];
  for (const [name, params, message] of refusals) {
    assert.throws(
      () => execFileSync(process.execPath, ["./index.ts", "--call", name, JSON.stringify(params)], { cwd: here, env, encoding: "utf8", stdio: "pipe" }),
      (error) => error instanceof Error && "stderr" in error && String(error.stderr).includes(message),
      `--call ${name} ${JSON.stringify(params)} must be refused with "${message}"`
    );
  }

  const stored = call("memory_store", { topic: "auth", content: "Use passkeys for admin authentication", tags: ["security"] }, MemoryRecord);
  assert.match(stored.memory_id, /^MEM-/);

  const search = call("memory_search", { query: "passkeys", limit: 5 }, z.looseObject({ results: z.array(MemoryRecord) }));
  assert.equal(search.results.length, 1);
  assert.equal(search.results[0]?.memory_id, stored.memory_id);

  const updated = call("memory_update", { memory_id: stored.memory_id, tags: ["security", "identity"] }, MemoryRecord);
  assert.deepEqual(updated.tags, ["security", "identity"]);

  const task = call("task_create", { task_id: "smoke-task", title: "Smoke task", status: "candidate" }, TaskRecord);
  assert.equal(task.status, "candidate");

  const active = call("task_state_update", { task_id: "smoke-task", status: "active", active_step: "Run server smoke" }, TaskRecord);
  assert.equal(active.version, 2);
  assert.equal(active.status, "active");

  const read = call("task_state_read", { task_id: "smoke-task" }, z.looseObject({ task: TaskRecord }));
  assert.equal(read.task.task_id, "smoke-task");

  const done = call("task_complete", { task_id: "smoke-task", notes: "validated" }, TaskRecord);
  assert.equal(done.status, "done");

  const checkpoint = call("checkpoint_append", { task_id: "smoke-task", summary: "Checkpoint smoke" }, ChainRecord);
  assert.equal(checkpoint.sequence, 1);

  for (let i = 0; i < 12; i++) {
    call("trace_append", { event_type: "smoke", payload: { i } }, ChainRecord);
  }
  const trace = call("trace_tail", { limit: 10 }, z.looseObject({ events: z.array(TraceEvent) }));
  assert.equal(trace.events.length, 10);
  assert.equal(trace.events[0]?.payload.i, 2);

  const traceFile = path.join(root, "trace", "trace.jsonl");
  const lines = fs.readFileSync(traceFile, "utf8").trim().split(/\r?\n/).map((line) => ChainRecord.parse(JSON.parse(line)));
  for (const [i, line] of lines.entries()) {
    if (i > 0) assert.equal(line.previous_hash, lines[i - 1]?.record_hash);
  }

  const summary = call("state_summary", { max_items: 3 }, z.looseObject({ counts: z.looseObject({ memories: z.number(), tasks: z.number() }) }));
  assert.equal(summary.counts.memories, 1);
  assert.equal(summary.counts.tasks, 1);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.error("Memory MCP smoke checks passed");
