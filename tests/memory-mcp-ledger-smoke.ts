#!/usr/bin/env node
/**
 * Memory-mcp ledger reader regression: malformed or non-object JSONL records must
 * be skipped rather than crashing recovery reads. Fully offline, SDK-free.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dataRoot, parseCliJson, readJsonlTail, readLastChainRecord } from "../packages/container/mcp-servers/memory-mcp/ledger.ts";

function tmpRoot(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function withDataRoot<T>(fn: (root: string) => T): T {
  const root = tmpRoot("pi-kit-memory-mcp-ledger-");
  const previous = process.env.PI_KIT_MEMORY_MCP_DATA_ROOT;
  process.env.PI_KIT_MEMORY_MCP_DATA_ROOT = root;
  try {
    return fn(root);
  } finally {
    if (previous === undefined) delete process.env.PI_KIT_MEMORY_MCP_DATA_ROOT;
    else process.env.PI_KIT_MEMORY_MCP_DATA_ROOT = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testReadJsonlTailSkipsBadElements() {
  withDataRoot((root) => {
    const file = path.join(root, "trace", "trace.jsonl");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const first = { sequence: 1, record_hash: "a" };
    const second = { sequence: 2, record_hash: "b" };
    fs.writeFileSync(
      file,
      ["null", "[1]", "0", "{ not json", JSON.stringify(first), JSON.stringify(second)].join("\n") + "\n",
    );

    const records = readJsonlTail(file, 10);
    assert.deepEqual(records, [first, second], "only valid objects must survive, malformed and non-object lines skipped");
    assert.equal(dataRoot(), root, "dataRoot must honour PI_KIT_MEMORY_MCP_DATA_ROOT");
  });
}

function testReadJsonlTailMissingFile() {
  withDataRoot((root) => {
    assert.deepEqual(readJsonlTail(path.join(root, "trace", "missing.jsonl"), 5), [], "missing file must yield []");
  });
}

function testParseCliJson() {
  assert.deepEqual(parseCliJson(undefined), {}, "undefined params default to an empty object");
  assert.deepEqual(parseCliJson(""), {}, "empty params default to an empty object");
  assert.deepEqual(parseCliJson('{"topic":"x"}'), { topic: "x" }, "objects round-trip");
  assert.throws(() => parseCliJson("{oops"), /invalid --call params JSON/, "malformed JSON throws a clean error");
  for (const nonObject of ["null", "42", "[]"]) {
    assert.throws(() => parseCliJson(nonObject), /invalid --call params JSON/, `${nonObject} must be rejected`);
  }
}

function testReadLastChainRecordFailsClosed(): void {
  withDataRoot((root) => {
    const file = path.join(root, "trace/trace.jsonl");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    assert.deepEqual(readLastChainRecord(file), { sequence: 0, record_hash: "" }, "a missing ledger starts the chain");
    fs.writeFileSync(file, "\n");
    assert.deepEqual(readLastChainRecord(file), { sequence: 0, record_hash: "" }, "an empty ledger starts the chain");
    const healthy = `${JSON.stringify({ sequence: 3, record_hash: "abc" })}\n`;
    fs.writeFileSync(file, healthy);
    assert.deepEqual(readLastChainRecord(file), { sequence: 3, record_hash: "abc" });
    // Invalid JSON, and valid JSON that is not a chained record: none may restart the chain at 0.
    for (const tail of ["CORRUPT-NOT-JSON", "null", "5", "\"x\"", "[]", "{}", "{\"sequence\":\"7\",\"record_hash\":\"h\"}",
      "{\"sequence\":0,\"record_hash\":\"h\"}", "{\"sequence\":1.5,\"record_hash\":\"h\"}", "{\"sequence\":4,\"record_hash\":\"\"}"]) {
      fs.writeFileSync(file, `${healthy}${tail}\n`);
      assert.throws(() => readLastChainRecord(file), /corrupt chain record/, `tail ${tail} must be refused`);
    }
  });
}

const tests: Array<[string, () => void | Promise<void>]> = [
  ["parseCliJson accepts objects and rejects malformed/non-object params", testParseCliJson],
  ["readJsonlTail skips malformed and non-object JSONL elements", testReadJsonlTailSkipsBadElements],
  ["readJsonlTail returns an empty list for a missing file", testReadJsonlTailMissingFile],
  ["readLastChainRecord refuses a corrupt or non-chained tail instead of restarting at 0", testReadLastChainRecordFailsClosed],
];

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`  OK: ${name}`);
  } catch (error) {
    failed++;
    console.error(`  FAIL: ${name}`);
    console.error(`    ${error instanceof Error ? error.stack || error.message : String(error)}`);
  }
}

if (failed > 0) {
  console.error(`\n[memory-mcp-ledger-smoke] ${failed}/${tests.length} FAILED`);
  process.exit(1);
}
console.log(`\n[memory-mcp-ledger-smoke] all ${tests.length} checks passed`);