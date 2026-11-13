#!/usr/bin/env node
/**
 * The ASCII cat (custom-footer/cat.ts): the explicit state priority, tool-error classification,
 * and the wiring in the status bar (the working indicator follows the resolved state and is
 * restored after a run, results play once in the footer on a timer that clears itself, `/footer cat
 * off` is honoured and persisted). Deterministic: pure functions plus a fake pi API; no model runs.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type * as CatModule from "../packages/extensions/third_party/custom-footer/cat.ts";
import { boolean, isRecord, object, parseJsonAs } from "../packages/core/lib/guard.ts";
import { loadExtension, loadModule, fakePi, isolateKitEnv, setEnv, tmpWorkspace, rmWorkspace } from "../packages/core/eval/harness.ts";

interface WorkingIndicator {
  frames: string[];
  intervalMs?: number;
}

interface CatView {
  text: string;
  label?: string;
}

/** The test hooks custom-footer hangs on the pi API as `__footerDebug`. */
interface FooterDebug {
  catState(): string;
  catTimerActive(): boolean;
  state(): { cat?: CatView };
}

interface Note {
  m: string;
  l: string;
}

const restoreEnv = isolateKitEnv();
const cat = await loadModule<typeof CatModule>("vendor/custom-footer/cat.ts");
const registerFooter = await loadExtension("vendor/custom-footer/index.ts");
const plain = { fg: (_c: string, s: string) => s, bold: (s: string) => s };

async function session(over: Record<string, unknown> = {}) {
  const agent = tmpWorkspace("pi-kit-cat-agent-");
  const workspace = tmpWorkspace("pi-kit-cat-ws-");
  const restore = setEnv("PI_CODING_AGENT_DIR", agent);
  const pi = fakePi();
  registerFooter(pi.api);
  const indicators: Array<WorkingIndicator | undefined> = [];
  const ctx = {
    cwd: workspace, hasUI: true, model: { id: "m" }, getContextUsage: () => ({ percent: 5, tokens: 5, contextWindow: 100 }),
    sessionManager: { getEntries: () => [], getSessionName: () => undefined },
    ui: { theme: plain, setFooter() {}, setWidget() {}, setWorkingMessage() {}, setWorkingIndicator: (o?: WorkingIndicator) => indicators.push(o), notify() {} },
    ...over,
  };
  await pi.handlers.get("session_start")({}, ctx);
  const fire = (name: string, event: object = {}) => pi.handlers.get(name)(event, ctx);
  const done = async () => { await fire("session_shutdown"); restore(); rmWorkspace(agent); rmWorkspace(workspace); };
  // The footer adds __footerDebug to the fake API at registration, so it is not on the harness type.
  const debug: unknown = Reflect.get(pi.api, "__footerDebug");
  assert.ok(isFooterDebug(debug), "the footer hangs its test hooks on the API");
  return { pi, ctx, fire, indicators, agent, done, debug };
}

function isFooterDebug(value: unknown): value is FooterDebug {
  return isRecord(value) && typeof value.catState === "function" && typeof value.catTimerActive === "function" && typeof value.state === "function";
}

/** ui.json as `/footer cat` persists it. */
const UiFile = object({ cat: boolean() });

const tests = {
  priorityBeatsRecency() {
    assert.equal(cat.resolveCatState([]), "idle");
    assert.equal(cat.resolveCatState(["streaming", "thinking"]), "thinking");
    assert.equal(cat.resolveCatState(["streaming", "tool"]), "tool");
    assert.equal(cat.resolveCatState(["tool", "waiting_for_user"]), "waiting_for_user", "an approval prompt outranks a running tool");
    assert.equal(cat.resolveCatState(["waiting_for_user", "error"]), "error");
    assert.equal(cat.resolveCatState(["success", "idle"]), "success");
  },

  toolErrorsAreClassified() {
    assert.equal(cat.classifyToolError({ content: [{ type: "text", text: "Blocked by policy: rm -rf" }] }), "denied");
    assert.equal(cat.classifyToolError({ content: [{ text: "Permission denied" }] }), "denied");
    assert.equal(cat.classifyToolError({ content: [{ text: "ENOENT: no such file" }] }), "warning");
    assert.equal(cat.classifyToolError(undefined), "warning");
    assert.equal(cat.classifyToolError(null), "warning");
    assert.equal(cat.classifyToolError("exit 2"), "warning");
  },

  async workingIndicatorFollowsTheResolvedState() {
    const s = await session();
    try {
      await s.fire("agent_start");
      assert.equal(s.debug.catState(), "thinking", "a run starts out thinking");
      const n = s.indicators.length;
      await s.fire("message_update", { assistantMessageEvent: { type: "thinking_delta", delta: "hm" } });
      assert.equal(s.indicators.length, n, "the same state does not reset the indicator");
      await s.fire("message_update", { assistantMessageEvent: { type: "text_delta", delta: "hello" } });
      assert.equal(s.debug.catState(), "streaming");
      await s.fire("tool_execution_start", { toolName: "bash", args: { command: "ls" } });
      assert.equal(s.debug.catState(), "tool");
      await s.fire("ui_prompt_start", { kind: "confirm" });
      assert.equal(s.debug.catState(), "waiting_for_user");
      await s.fire("ui_prompt_end", { kind: "confirm" });
      assert.equal(s.debug.catState(), "tool");
      await s.fire("tool_execution_end", { toolName: "bash", isError: false, result: {} });
      await s.fire("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
      assert.equal(s.indicators.at(-1), undefined, "pi's own spinner is restored after the run");
      assert.equal(s.debug.catState(), "success", "a finished run shows success");
      assert.equal(s.debug.catTimerActive(), true, "the result is played through on a short timer");
    } finally { await s.done(); }
  },

  async failuresAndCancellationsSettleAsResults() {
    const s = await session();
    try {
      await s.fire("agent_start");
      await s.fire("tool_execution_start", { toolName: "bash", args: {} });
      await s.fire("tool_execution_end", { toolName: "bash", isError: true, result: { content: [{ text: "Blocked by policy" }] } });
      assert.equal(s.debug.catState(), "denied", "a refusal outranks the running thinking state");
      await s.fire("agent_end", { messages: [{ role: "assistant", stopReason: "error" }] });
      assert.equal(s.debug.catState(), "error", "error outranks the earlier denial");
      await s.fire("agent_start");
      await s.fire("agent_end", { messages: [{ role: "assistant", stopReason: "aborted" }] });
      assert.equal(s.debug.catState(), "cancelled");
      await s.fire("agent_start");
      assert.equal(s.debug.catState(), "thinking", "a new request clears the old result");
      await s.fire("agent_end", { messages: [] });
    } finally { await s.done(); }
  },

  async deniedHoldsAgainstLaterResults() {
    const s = await session();
    try {
      await s.fire("agent_start");
      await s.fire("tool_execution_end", { toolName: "bash", isError: true, result: { content: [{ text: "Blocked by policy" }] } });
      assert.equal(s.debug.catState(), "denied", "a refusal outranks the running thinking state");
      await s.fire("session_compact_failed", {});
      assert.equal(s.debug.catState(), "denied", "a later warning does not hide the denial");
      await s.fire("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
      assert.equal(s.debug.catState(), "denied", "a later success does not hide the denial");
      assert.equal(s.debug.catTimerActive(), true, "the held denial still has a footer timer to clear it");
    } finally { await s.done(); }
  },

  async compactionReadsAsCrunching() {
    const s = await session();
    try {
      await s.fire("session_before_compact", {});
      assert.equal(s.debug.catState(), "crunching");
      await s.fire("session_compact_failed", {});
      assert.equal(s.debug.catState(), "warning", "a failed compaction is a recoverable warning");
    } finally { await s.done(); }
  },

  async nothingStaysRunningAndNoUiIsSafe() {
    const s = await session();
    await s.fire("agent_start");
    await s.fire("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
    assert.equal(s.debug.catTimerActive(), true);
    await s.fire("session_shutdown");
    assert.equal(s.debug.catTimerActive(), false, "shutdown clears the cat timer");
    await s.done();
    // no setWorkingIndicator in this pi: the cat degrades to the footer alone
    const old = await session({ ui: { theme: plain, setFooter() {}, setWidget() {}, setWorkingMessage() {}, notify() {} } });
    try {
      await old.fire("agent_start");
      await old.fire("tool_execution_start", { toolName: "read", args: {} });
      await old.fire("agent_end", { messages: [] });
    } finally { await old.done(); }
    const headless = await session({ hasUI: false, ui: undefined });
    try {
      await headless.fire("agent_start");
      await headless.fire("agent_end", { messages: [] });
      assert.equal(headless.debug.catState(), "success", "headless sessions still resolve a state without touching a UI");
    } finally { await headless.done(); }
  },

  async commandTogglesPersistsAndRejects() {
    const notes: Note[] = [];
    const s = await session({ ui: { theme: plain, setFooter() {}, setWidget() {}, setWorkingMessage() {}, setWorkingIndicator() {}, notify: (m: string, l: string) => notes.push({ m, l }) } });
    try {
      const h = s.pi.commands.get("footer").handler;
      const file = path.join(s.agent, "pi-kit", "ui.json");
      await h(["cat", "off"], s.ctx);
      assert.equal(parseJsonAs(UiFile, fs.readFileSync(file, "utf8")).cat, false);
      await s.fire("agent_start");
      assert.equal(s.debug.state().cat, undefined, "off shows no cat");
      await s.fire("agent_end", { messages: [] });
      assert.equal(s.debug.catTimerActive(), false, "off arms no timer");
      const before = fs.readFileSync(file, "utf8");
      await h(["cat", "maybe"], s.ctx);
      assert.equal(fs.readFileSync(file, "utf8"), before, "an invalid argument changes nothing");
      assert.equal(notes.at(-1)?.l, "error");
      await h(["cat", "on"], s.ctx);
      assert.equal(parseJsonAs(UiFile, fs.readFileSync(file, "utf8")).cat, true);
    } finally { await s.done(); }
  },
};

let failed = 0;
for (const [name, fn] of Object.entries(tests)) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${name}\n${err instanceof Error ? err.stack : String(err)}`);
  }
}
restoreEnv();
console.log(`cat-status-smoke: ${failed ? `${failed}/${Object.keys(tests).length} failed` : `${Object.keys(tests).length}/${Object.keys(tests).length} passed`}`);
process.exit(failed ? 1 : 0);
