#!/usr/bin/env node
/**
 * Evidence retention regression: long sessions and session startup must never
 * truncate the shared ledger; past 4 MiB it is rotated to trace.jsonl.1. Fully offline — no live pi, no network.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadExtension, loadModule, fakePi, tmpWorkspace, rmWorkspace } from "../packages/core/eval/harness.ts";
import type * as TraceLedger from "../packages/extensions/src/trace-ledger/index.ts";

async function testLedgerRetainsEvidence() {
  const ws = tmpWorkspace("pi-kit-trace-bound-");
  try {
    const register = await loadExtension("extensions/trace-ledger/index.ts");
    const pi = fakePi();
    register(pi.api);
    const ctx = { cwd: ws, hasUI: false, ui: { notify() {} } };
    await pi.handlers.get("session_start")({}, ctx);

    const ledgerPath = path.join(ws, ".pi", "trace.jsonl");

    // Simulate many turns, each with a couple of tool calls - past the former 500-line
    // trim - all within a single, uninterrupted session (no session_start in between).
    for (let i = 0; i < 300; i++) {
      await pi.handlers.get("tool_call")({ toolName: "read", input: { path: `src/f${i}.ts` } }, ctx);
      await pi.handlers.get("tool_result")({ toolName: "read", input: { path: `src/f${i}.ts` }, isError: false }, ctx);
      await pi.handlers.get("turn_end")({}, ctx);
    }

    const lineCount = fs.readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean).length;
    assert.equal(lineCount, 600, "all shared evidence must be retained");
    await pi.handlers.get("session_start")({}, ctx);
    assert.equal(fs.readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean).length, 600, "new sessions must not delete prior evidence");
  } finally {
    rmWorkspace(ws);
  }
}

async function testTraceSkipsNonObjectRecords() {
  const ws = tmpWorkspace("pi-kit-trace-corrupt-");
  try {
    const register = await loadExtension("extensions/trace-ledger/index.ts");
    const pi = fakePi();
    register(pi.api);
    const notices: string[] = [];
    const ctx = { cwd: ws, hasUI: true, ui: { notify: (msg: string) => notices.push(msg) } };
    await pi.handlers.get("session_start")({}, ctx);

    const ledgerPath = path.join(ws, ".pi", "trace.jsonl");
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    // Syntactically valid JSON that is not a plain object: null and 0.
    fs.writeFileSync(
      ledgerPath,
      ["null", "0", JSON.stringify({ kind: "call", tool: "read", target: "src/a.ts" })].join("\n") + "\n",
    );

    const command = pi.commands.get("trace");
    assert.ok(command, "trace command must be registered");
    await command.handler("", ctx);

    const summary = notices.join("\n");
    assert.ok(summary.includes("tool calls: 1"), `summary must count the valid record, got: ${summary}`);
    assert.ok(summary.includes("2 corrupt line(s) skipped"), `summary must report corrupt lines, got: ${summary}`);
  } finally {
    rmWorkspace(ws);
  }
}

// EFF-8: a record of the wrong shape (no string tool, a non-string target, an unknown kind) is
// counted as corrupt, the same as a parse failure, instead of throwing inside /trace.
async function testTraceSkipsMisshapenRecords() {
  const ws = tmpWorkspace("pi-kit-trace-shape-");
  try {
    const register = await loadExtension("extensions/trace-ledger/index.ts");
    const pi = fakePi();
    register(pi.api);
    const notices: string[] = [];
    const ctx = { cwd: ws, hasUI: true, ui: { notify: (msg: string) => notices.push(msg) } };
    await pi.handlers.get("session_start")({}, ctx);
    const ledgerPath = path.join(ws, ".pi", "trace.jsonl");
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    fs.writeFileSync(ledgerPath, [
      JSON.stringify({ kind: "call", target: "x" }),
      JSON.stringify({ kind: "call", tool: "read", target: 7 }),
      JSON.stringify({ kind: "teleport", tool: "read" }),
      JSON.stringify({ kind: "call", tool: "read", target: "src/a.ts" }),
    ].join("\n") + "\n");
    const command = pi.commands.get("trace");
    assert.ok(command, "trace command must be registered");
    await command.handler("", ctx);
    const summary = notices.join("\n");
    assert.ok(summary.includes("tool calls: 1"), `summary must count the valid record, got: ${summary}`);
    assert.ok(summary.includes("3 corrupt line(s) skipped"), `summary must report misshapen lines as corrupt, got: ${summary}`);
  } finally {
    rmWorkspace(ws);
  }
}

// EFF-2: the target is redacted from a bounded slice with linear patterns, so a long command costs
// no more than a short one, and the stored target is still redacted and reports the full length.
async function testTargetRedactionIsBounded() {
  const { targetOf } = await loadModule<typeof TraceLedger>("extensions/trace-ledger/index.ts");
  for (const unit of ["xtoken", "x_token", "a", "token ", "--token=\""]) {
    const command = "echo " + unit.repeat(Math.ceil((200 * 1024) / unit.length));
    const t0 = performance.now();
    const t = targetOf({ command });
    const ms = performance.now() - t0;
    assert.ok(ms < 200, `targetOf on 200 KB of ${JSON.stringify(unit)} took ${Math.round(ms)} ms`);
    assert.equal(t.targetOriginalLength, command.length);
    assert.equal(t.targetTruncated, true);
  }
  const cases: [string, string][] = [
    ["GH_TOKEN=ghp_abcdefghijklmnop curl x", "GH_TOKEN=[REDACTED] curl x"],
    ["mysql --password=hunter2 --token abcdef", "mysql --password=[REDACTED] --token [REDACTED]"],
    ["foo --api-key 'abc def' bar", "foo --api-key [REDACTED] bar"],
    ["curl https://u:pw@example.com/x", "curl https://[REDACTED]@example.com/x"],
  ];
  for (const [command, want] of cases) assert.equal(targetOf({ command }).target, want, command);
  // A secret that starts inside the stored 200 characters and runs past the scan slice is redacted.
  const long = targetOf({ command: "x".repeat(150) + " TOKEN=" + "s".repeat(5000) });
  const longTarget = long.target ?? "";
  assert.ok(longTarget.includes("TOKEN=[REDACTED]") && !longTarget.includes("sss"), longTarget);
  assert.equal(long.targetRedacted, true);

  // Through the hooks: a 200 KB adversarial command is logged quickly, before and after the call.
  const ws = tmpWorkspace("pi-kit-trace-redos-");
  try {
    const register = await loadExtension("extensions/trace-ledger/index.ts");
    const pi = fakePi();
    register(pi.api);
    const ctx = { cwd: ws, hasUI: false, ui: { notify() {} } };
    await pi.handlers.get("session_start")({}, ctx);
    const input = { command: "echo " + "xtoken".repeat(35_000) };
    const t0 = performance.now();
    await pi.handlers.get("tool_call")({ toolName: "bash", input }, ctx);
    await pi.handlers.get("tool_result")({ toolName: "bash", input, isError: false }, ctx);
    const ms = performance.now() - t0;
    assert.ok(ms < 400, `tool_call + tool_result on a 200 KB command took ${Math.round(ms)} ms`);
  } finally {
    rmWorkspace(ws);
  }
}

// EFF-6: past 4 MiB the ledger is renamed to trace.jsonl.1 (one old copy) before the next append,
// so the live file stays bounded and the previous history is kept, not deleted.
async function testLedgerRotatesAtFourMiB() {
  const ws = tmpWorkspace("pi-kit-trace-rotate-");
  try {
    const register = await loadExtension("extensions/trace-ledger/index.ts");
    const pi = fakePi();
    register(pi.api);
    const ctx = { cwd: ws, hasUI: false, ui: { notify() {} } };
    await pi.handlers.get("session_start")({}, ctx);
    const ledgerPath = path.join(ws, ".pi", "trace.jsonl");
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    const old = JSON.stringify({ kind: "call", tool: "ls", target: "old" }) + "\n";
    const oldText = old.repeat(Math.ceil((4 * 1024 * 1024 + 1) / old.length));
    fs.writeFileSync(ledgerPath, oldText);
    fs.writeFileSync(ledgerPath + ".1", "older\n");
    await pi.handlers.get("tool_call")({ toolName: "read", input: { path: "src/new.ts" } }, ctx);
    assert.equal(fs.readFileSync(ledgerPath + ".1", "utf8"), oldText, "the full ledger moves to trace.jsonl.1 unchanged");
    const live = fs.readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean);
    assert.equal(live.length, 1, "the live ledger restarts with the new entry");
    assert.match(live[0] ?? "", /src\/new\.ts/);
    await pi.handlers.get("tool_result")({ toolName: "read", input: { path: "src/new.ts" }, isError: false }, ctx);
    assert.equal(fs.readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean).length, 2, "a small ledger is not rotated again");
    assert.equal(fs.readFileSync(ledgerPath + ".1", "utf8"), oldText);
  } finally {
    rmWorkspace(ws);
  }
}

const tests: Array<[string, () => Promise<void>]> = [
  ["the ledger rotates to trace.jsonl.1 past 4 MiB (EFF-6)", testLedgerRotatesAtFourMiB],
  ["the ledger preserves long-session evidence and prior-session records", testLedgerRetainsEvidence],
  ["the /trace summary skips non-object records and counts valid ones", testTraceSkipsNonObjectRecords],
  ["target redaction is bounded and linear on 200 KB adversarial commands", testTargetRedactionIsBounded],
  ["/trace counts misshapen records as corrupt instead of throwing (EFF-8)", testTraceSkipsMisshapenRecords],
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
  console.error(`\n[trace-ledger-bound-smoke] ${failed}/${tests.length} FAILED`);
  process.exit(1);
}
console.log(`\n[trace-ledger-bound-smoke] all ${tests.length} checks passed`);
