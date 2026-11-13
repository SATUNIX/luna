#!/usr/bin/env node
/**
 * Usage ledger: each model request is recorded as the provider reported it, /usage answers where the
 * tokens went, and a cache-hit collapse raises a status warning. Offline: fake pi, no model.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fakePi, isolateKitEnv, loadExtension, rmWorkspace, tmpWorkspace } from "../packages/core/eval/harness.ts";
import { isRecord } from "../packages/core/lib/guard.ts";

isolateKitEnv();

const assistant = (u: { input: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: number }, stopReason = "stop") => ({
  role: "assistant", model: "m1", stopReason,
  usage: { input: u.input, output: u.output ?? 10, cacheRead: u.cacheRead ?? 0, cacheWrite: u.cacheWrite ?? 0, totalTokens: 0, cost: { total: u.cost ?? 0 } },
});

const ws = tmpWorkspace("pi-kit-usage-");
try {
  const register = await loadExtension("extensions/trace-ledger/index.ts");
  const pi = fakePi();
  register(pi.api);
  const notices: string[] = [];
  const status = new Map<string, string | undefined>();
  const ctx = { cwd: ws, hasUI: true, ui: { notify: (m: string) => notices.push(m), setStatus: (k: string, v: string | undefined) => status.set(k, v) } };
  await pi.handlers.get("session_start")({}, ctx);

  // A tool returns 5,000 characters, then the next request carries it.
  await pi.handlers.get("tool_result")({ toolName: "bash", input: { command: "cat big.log" }, isError: false, content: [{ type: "text", text: "x".repeat(5000) }] }, ctx);
  await pi.handlers.get("message_end")({ message: assistant({ input: 500, cacheRead: 4000, cost: 0.02 }) }, ctx);
  assert.equal(status.get("trace-ledger-cache"), undefined, "a healthy cache raises no warning");
  await pi.handlers.get("message_end")({ message: assistant({ input: 5000, cacheRead: 100, cost: 0.08 }) }, ctx);
  assert.match(status.get("trace-ledger-cache") ?? "", /cache/, "a collapsed hit rate raises a status warning");
  await pi.handlers.get("message_end")({ message: assistant({ input: 300, output: 40 }, "aborted") }, ctx);
  await pi.handlers.get("message_end")({ message: { role: "user", content: "hi" } }, ctx);

  const lines = fs.readFileSync(path.join(ws, ".pi", "trace.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as unknown);
  const usage = lines.filter((l) => isRecord(l) && l.kind === "usage");
  assert.equal(usage.length, 3, "one record per assistant request, none for the user message");
  const first = usage[0];
  assert.ok(isRecord(first) && isRecord(first.resultChars));
  assert.equal(first.resultChars.bash, 5000, "the first request is charged the tool result it carried");
  assert.equal(first.costSource, "reported");
  const last = usage[2];
  assert.ok(isRecord(last));
  assert.equal(last.costSource, "unpriced", "no price is recorded as unpriced, not as free");

  await pi.commands.get("usage")?.handler("", ctx);
  const report = notices.at(-1) ?? "";
  assert.match(report, /3 request/);
  assert.match(report, /bash 5000/, "the largest result is attributed to its tool");
  assert.match(report, /aborted or failed requests: 340 tokens/, "tokens spent on an aborted request are counted");

  await pi.commands.get("trace")?.handler("", ctx);
  assert.doesNotMatch(notices.at(-1) ?? "", /corrupt/, "usage records are not corrupt records to /trace");
  console.log("[usage-ledger-smoke] all checks passed");
} finally {
  rmWorkspace(ws);
}
