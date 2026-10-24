// Offline Pi 0.76 contract checks; no model calls or real secrets.
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import fs from "node:fs";
import path from "node:path";
// eslint-disable-next-line no-restricted-imports -- evaluates a method body from the installed, pinned pi runtime (not untrusted input) to test against it
import vm from "node:vm";
import { loadExtension, fakePi, tmpWorkspace, rmWorkspace, setEnv, ROOT } from "../packages/core/eval/harness.ts";
import { boolean, number, object, optional, parseJsonAs, string, unknownValue } from "../packages/core/lib/guard.ts";

interface Theme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

interface FooterComponent {
  render(width: number): string[];
}

// The pinned runtime's setExtensionFooter body, invoked with `this` bound to a mode stand-in.
type SetExtensionFooter = (this: unknown, factory: unknown, theme: Theme) => void;

interface StatusUpdate {
  key: string;
  value: string | undefined;
}

interface SessionEntry {
  type: string;
  message: object;
}

interface SmokeCtx {
  cwd: string;
  hasUI: boolean;
  model: { id: string; provider: string };
  getContextUsage: () => { tokens: number; percent: number; contextWindow: number };
  sessionManager: { getEntries?: () => SessionEntry[]; getSessionId?: () => string };
  ui: {
    theme: Theme;
    setWidget(): void;
    setWorkingMessage(): void;
    setFooter(factory: unknown): void;
    setStatus(key: string, value: string | undefined): void;
    notify(message: string): void;
  };
}

/** The trace-ledger record fields this smoke reads (identifiers are only compared, so left unknown). */
const TraceRecord = object({
  target: optional(string()),
  targetRedacted: boolean(),
  targetTruncated: boolean(),
  sessionId: unknownValue(),
  toolCallId: unknownValue(),
  runId: unknownValue(),
  eventId: unknownValue(),
  sequence: number(),
  processId: number(),
  retention: string(),
  lostEntries: optional(number()),
});

const ws = tmpWorkspace("pi-observability-contracts-");
try {
  fs.mkdirSync(path.join(ws, ".pi-kit"));
  fs.writeFileSync(path.join(ws, ".pi-kit/costs.json"), "{}");
  const pi = fakePi();
  (await loadExtension("vendor/custom-footer/index.ts"))(pi.api);
  const runtime = fs.readFileSync(path.join(ROOT, "node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js"), "utf8");
  const method = runtime.match(/ {4}setExtensionFooter\(factory\) \{([\s\S]*?)\n {4}\}\n {4}\/\*\*/);
  assert.ok(method, "test requires actual pinned runtime footer method");
  // Exercise the *pinned runtime's* real footer method rather than a mock, so a runtime
  // change that breaks the contract fails here. Evaluated in a fresh vm context: the body
  // only needs its two parameters and `this`, and this keeps it out of this module's scope
  // (a plain Function constructor would inherit it).
  const setExtensionFooter = vm.runInNewContext(`(function (factory, theme) {${method[1]}})`, {}) as SetExtensionFooter;
  const plain: Theme = { fg: (_c, s) => s, bold: (s) => s };
  const footer: object = { builtin: true };
  const children = new Set<object>([footer]);
  const statuses: StatusUpdate[] = [];
  const notifications: string[] = [];
  const extStatuses = new Map([["trace-ledger", "trace-ledger: lost=0"]]);
  const footerData = { getGitBranch: () => "main", getExtensionStatuses: () => extStatuses, onBranchChange: () => () => {} };
  // pi >=0.85 mounts the footer inside a dedicated footerContainer; older runtimes swapped
  // it directly on ui. Both shapes share the same `children` set so the assertions hold.
  const footerContainer = { clear() { children.clear(); }, addChild(x: object) { children.add(x); }, removeChild(x: object) { children.delete(x); } };
  const mode = { footer, footerContainer, footerDataProvider: footerData, ui: { removeChild(x: object) { children.delete(x); }, addChild(x: object) { children.add(x); }, requestRender() {} } };
  // Whatever the runtime mounted in place of the built-in footer is the status bar component.
  const custom = () => [...children].find((c) => c !== footer) as FooterComponent;
  let entries: SessionEntry[] = [];
  const restoreAgentDir = setEnv("PI_CODING_AGENT_DIR", path.join(ws, "agent"));
  const ctx: SmokeCtx = { cwd: ws, hasUI: true, model: { id: "synthetic", provider: "local" }, getContextUsage: () => ({ tokens: 42000, percent: 70, contextWindow: 60000 }),
    sessionManager: { getEntries: () => entries },
    ui: { theme: plain, setWidget() {}, setWorkingMessage() {}, setFooter(factory) { setExtensionFooter.call(mode, factory, plain); }, setStatus(key, value) { statuses.push({ key, value }); }, notify(message) { notifications.push(message); } } };
  await pi.handlers.get("session_start")({}, ctx);
  assert.equal(children.has(footer), false, "the status bar replaces the built-in footer");
  assert.equal(children.size, 1, "exactly one footer component is attached");
  const usage = { role: "assistant", usage: { input: 1000, output: 500, cacheRead: 200, cacheWrite: 0, totalTokens: 1700 } };
  entries.push({ type: "message", message: usage });
  const event = { type: "turn_end", turnIndex: 0, message: usage, toolResults: [] };
  await pi.handlers.get("turn_end")(event, ctx);
  await pi.handlers.get("turn_end")(event, ctx); // duplicate delivery of same message
  // The default bar is two lines (identity, context); the session totals live in the heavy
  // layout, which is what this contract check reads.
  const deflt = custom().render(140);
  assert.ok(deflt[0] !== undefined && deflt[1] !== undefined, "the default bar has an identity line and a context line");
  assert.match(deflt[1], /ctx .*70% 18k free/, deflt[1]);
  assert.match(deflt[0], /synthetic/);
  assert.match(deflt[0], /on main/);
  assert.match(deflt[1], /trace-ledger lost=0/, "extension statuses render as chips");
  await pi.commands.get("footer").handler("heavy", ctx);
  const lines = custom().render(140);
  assert.match(lines.join("\n"), /session ↑1\.0k ↓500 ⟲200/, lines.join("\n"));
  // ANSI colour escapes are stripped before measuring width.
  assert.ok([...deflt, ...lines].every((l) => stripVTControlCharacters(l).length <= 140), "lines fit the width");
  await pi.commands.get("footer").handler("", ctx); // hidden, but accounting continues
  assert.equal(children.has(footer), true, "/footer restores the built-in footer");
  entries.push({ type: "message", message: { ...usage } });
  await pi.handlers.get("turn_end")({ ...event, message: { ...usage } }, ctx);
  await pi.commands.get("footer").handler("", ctx);
  assert.equal(children.has(footer), false);
  assert.match(custom().render(140).join("\n"), /↑2\.0k ↓1\.0k/);
  await pi.commands.get("footer").handler("reload", ctx);
  assert.match(custom().render(140).join("\n"), /↑2\.0k/, "refresh must not recount context or usage");
  entries.push({ type: "message", message: { role: "assistant" } });
  await pi.handlers.get("turn_end")({ message: { role: "assistant" } }, ctx);
  assert.match(custom().render(140).join("\n"), /partial/);
  entries = [];
  await pi.handlers.get("session_start")({}, ctx);
  assert.match(custom().render(140).join("\n"), /↑0 ↓0/, "a new session shows its own totals");
  const broken: Theme = { fg: () => { throw new Error("theme broke"); }, bold: (s) => s };
  mode.footer = custom();
  setExtensionFooter.call(mode, null, plain);
  ctx.ui.setFooter = (factory) => setExtensionFooter.call(mode, factory, broken);
  await pi.commands.get("footer").handler("off", ctx);
  await pi.commands.get("footer").handler("on", ctx);
  const [fallbackLine] = custom().render(100);
  assert.ok(fallbackLine !== undefined, "a broken theme still renders a line");
  assert.match(fallbackLine, /status bar error \(theme broke\)/, "a render error falls back to one plain line");
  ctx.ui.setFooter = (factory) => setExtensionFooter.call(mode, factory, plain);
  restoreAgentDir();

  const trace = fakePi();
  const trace2 = fakePi();
  const registerTrace = await loadExtension("extensions/trace-ledger/index.ts");
  registerTrace(trace.api); registerTrace(trace2.api);
  ctx.sessionManager = { getSessionId: () => "synthetic-session" };
  await trace.handlers.get("session_start")({}, ctx);
  await trace2.handlers.get("session_start")({}, ctx);
  const tool = { toolName: "bash", toolCallId: "call-1", input: { command: "curl --token=CANARY_ONLY --url https://user:CANARY_ONLY@example.invalid/ " + "x".repeat(250) } };
  await trace.handlers.get("tool_call")(tool, ctx);
  await trace.handlers.get("tool_result")({ ...tool, isError: false }, ctx);
  await trace2.handlers.get("tool_call")(tool, ctx);
  const ledger = path.join(ws, ".pi/trace.jsonl");
  const raw = fs.readFileSync(ledger, "utf8");
  let records = raw.trim().split("\n").map((line) => parseJsonAs(TraceRecord, line));
  assert.ok(records[0] && records[1] && records[2], "three trace records were written");
  assert.equal(raw.includes("CANARY_ONLY"), false, "accepted synthetic credentials must be redacted before writing");
  assert.equal(records[0].targetRedacted, true);
  assert.equal(records[0].targetTruncated, true);
  assert.match(records[0].target ?? "", /\[truncated\]/);
  assert.equal(records[0].sessionId, "synthetic-session");
  assert.equal(records[0].toolCallId, records[1].toolCallId);
  assert.equal(records[0].runId, records[1].runId);
  assert.notEqual(records[0].runId, records[2].runId);
  assert.notEqual(records[0].eventId, records[1].eventId);
  assert.equal(records[1].sequence, records[0].sequence + 1);
  assert.equal(records[0].processId, process.pid);
  assert.equal(records[0].retention, "append-only/rotated-at-4MiB");

  // Replace just the synthetic ledger with a directory to force append failure.
  fs.renameSync(ledger, ledger + ".saved");
  fs.mkdirSync(ledger);
  await trace.handlers.get("tool_call")({ ...tool, toolCallId: "lost-call" }, ctx);
  assert.ok(notifications.some((text) => /collection failed; lost=1/.test(text)));
  assert.ok(statuses.some(({ value }) => /collection failed; lost=1/.test(value ?? "")));
  fs.rmdirSync(ledger);
  await trace.handlers.get("tool_call")({ ...tool, toolCallId: "after-loss" }, ctx);
  records = fs.readFileSync(ledger, "utf8").trim().split("\n").map((line) => parseJsonAs(TraceRecord, line));
  assert.ok(records[0], "a record was written after the loss");
  assert.equal(records[0].lostEntries, 1, "loss persists in subsequent durable evidence");
  assert.equal(records[0].sequence, 4, "sequence gap identifies missing record");
  fs.appendFileSync(ledger, "{invalid\n");
  await trace.commands.get("trace").handler("", ctx);
  // The contract is that corruption is surfaced rather than reported as "no activity".
  // Two paths satisfy it and both are acceptable here: the summary line reports the
  // skipped corrupt line(s) when other records still parse, and an error notice is
  // emitted when the file cannot be summarised at all. Pinning this to one exact string
  // is what let the check drift while it was not running in CI.
  const corruptNotice = notifications.find((text) => /corrupt/.test(text));
  assert.ok(corruptNotice, "corruption must not look like no activity");
  assert.ok(
    !notifications.some((text) => /no actions recorded yet/.test(text)),
    "a corrupt ledger with records must not be reported as empty",
  );
  console.log("[observability-contracts] footer contract, usage, retention identity, redaction, collector failure and corrupt-record checks passed");
} finally {
  rmWorkspace(ws);
}
