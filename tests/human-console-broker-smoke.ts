#!/usr/bin/env node
// Offline broker/approval smoke. Child processes are injected; no model or network is used.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadExtension, loadModule, fakePi, setEnv, tmpWorkspace, rmWorkspace, isolateKitEnv, textOf } from "../packages/core/eval/harness.ts";
import { getEventListeners } from "node:events";
import { type Infer, isRecord, object, optional, parseJsonAs, string } from "../packages/core/lib/guard.ts";
import type * as HumanConsole from "../packages/extensions/src/human-console/index.ts";
import { answerPending, startConsole } from "./console-answer.ts";
import { initTheme } from "@earendil-works/pi-coding-agent";

type FakePi = ReturnType<typeof fakePi>;
/** The fields of a broker pending-request file this smoke reads back (a question has no body). */
const BrokerRequestFile = object({ id: string(), kind: string(), body: optional(string()) });
type BrokerRequestFile = Infer<typeof BrokerRequestFile>;

const wait = (ms = 25): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms));
/** `details.outcome` of an ask_human result, or undefined when the result carries none. */
function outcomeOf(result: unknown): unknown { return isRecord(result) && isRecord(result.details) ? result.details.outcome : undefined; }
/** `details.answer` of an ask_human result, exactly as the tool returned it. */
function answerOf(result: unknown): unknown { return isRecord(result) && isRecord(result.details) ? result.details.answer : undefined; }
/** The dialog factory `ctx.ui.custom` receives, as far as this smoke drives it. */
type DialogFactory = (tui: unknown, theme: unknown, keybindings: unknown, done: (value: string | undefined) => void) => unknown;
interface EditorCard { prefill: string; done: (value: string | undefined) => void }
const TUI_STUB = { requestRender() {}, terminal: { rows: 24, columns: 80 } };
/** The text in the real editor a card built, read through its private field. */
function editorText(component: unknown): string {
  const editor: unknown = typeof component === "object" && component !== null ? Reflect.get(component, "editor") : undefined;
  const getText: unknown = typeof editor === "object" && editor !== null ? Reflect.get(editor, "getText") : undefined;
  if (typeof getText !== "function") throw new Error("the card is not the real multiline editor");
  const text: unknown = Reflect.apply(getText, editor, []);
  if (typeof text !== "string") throw new Error("the editor's text is not a string");
  return text;
}
/** A UI whose custom dialog is the card; `onCard` plays the operator and may leave it open. `closed` counts cards the extension closed. */
function tuiEditor(onCard: (card: EditorCard) => void): { custom: (factory: DialogFactory) => Promise<string | undefined>; closed: () => number } {
  let closed = 0;
  return {
    closed: () => closed,
    custom: (factory) => new Promise((resolve) => {
      const done = (value: string | undefined) => { closed++; resolve(value); };
      const component = factory(TUI_STUB, {}, {}, done);
      onCard({ prefill: editorText(component), done });
    }),
  };
}
async function waitForPendingFile(ws: string): Promise<string> {
  const dir = path.join(ws, "console", "pending");
  for (let i = 0; i < 100; i++) {
    if (fs.existsSync(dir)) {
      const name = fs.readdirSync(dir).find((f) => f.endsWith(".json"));
      if (name) return name;
    }
    await wait(10);
  }
  throw new Error("no broker request appeared");
}
async function resolvePending(ws: string, approved: boolean, answer: string | null = null): Promise<BrokerRequestFile> {
  const pending = path.join(ws, "console", "pending");
  for (let i = 0; i < 80; i++) {
    if (fs.existsSync(pending) && fs.readdirSync(pending).length) {
      const file = fs.readdirSync(pending).sort((a, b) => fs.statSync(path.join(pending, b)).mtimeMs - fs.statSync(path.join(pending, a)).mtimeMs)[0]; assert.ok(file, "a pending broker request file"); const req = parseJsonAs(BrokerRequestFile, fs.readFileSync(path.join(pending, file), "utf8"));
      fs.mkdirSync(path.join(ws, "console", "resolved"), { recursive: true });
      answerPending(path.join(ws, "console"), req.id, { approved, answer });
      return req;
    }
    await wait();
  }
  throw new Error("no broker request appeared");
}
function clearPending(ws: string): void { fs.rmSync(path.join(ws, "console", "pending"), { recursive: true, force: true }); }
async function firewall(_ws: string, auto: boolean, judge: string | null): Promise<FakePi> {
  const register = await loadExtension("extensions/tool-firewall/index.ts"); const pi = fakePi();
  // In-process judge stub: null = no judge available.
  register(pi.api, { complete: judge === null ? null : async () => judge });
  setEnv("PI_KIT_AUTO_MODE", auto ? "1" : "0");
  return pi;
}
async function run() {
  const restoreIsolation = isolateKitEnv();
  const ws = tmpWorkspace("pi-kit-human-console-");
  const restores = [restoreIsolation, setEnv("HOME", path.join(ws, "home")), setEnv("PI_CODING_AGENT_DIR", path.join(ws, "agent")), setEnv("PI_KIT_HUMAN_CONSOLE_DIR", path.join(ws, "console")), setEnv("PI_KIT_HUMAN_CONSOLE_TIMEOUT_MS", "40"), setEnv("PI_KIT_FIREWALL_AUDIT_LOG", path.join(ws, "audit.jsonl"))];
  startConsole(); // the console creates the answer key; requesters never do
  // Broker poll timers are unref'd in production; keep this isolated smoke process alive
  // while it awaits a broker resolution/timeout.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    // deny and allow never create a broker request or child call.
    let pi = await firewall(ws, true, '{"verdict":"allow","reason":"ok"}');
    const call = (name: string, input: Record<string, unknown>) => pi.handlers.get("tool_call")({ toolName: name, input }, { hasUI: false, ui: {}, cwd: ws });
    assert.equal((await call("bash", { command: "dd if=/dev/zero of=/dev/sda" }))?.block, true);
    assert.equal(await call("read", { path: "x" }), undefined);
    assert.ok(!fs.existsSync(path.join(ws, "console", "pending")), "allow/deny must not broker");

    // Auto disabled: ask uses broker and accepts its resolution, then times out fail-closed.
    pi = await firewall(ws, false, null); const allowed = callUnknown(pi, ws); const request = await resolvePending(ws, true); assert.equal(request.kind, "approval"); assert.equal(await allowed, undefined);
    assert.ok(!fs.existsSync(path.join(ws, "console", "pending", `${request.id}.json`)), "resolved broker request must remove its pending file");
    assert.ok(!fs.existsSync(path.join(ws, "console", "resolved", `${request.id}.json`)), "resolved broker answer file must be removed once the request settles");
    const timedOutCall = callUnknown(pi, ws);
    const brokerPending = path.join(ws, "console", "pending");
    let timedOutFile: string | undefined;
    for (let i = 0; i < 50 && !timedOutFile; i++) {
      await wait(10);
      if (fs.existsSync(brokerPending) && fs.readdirSync(brokerPending).length) timedOutFile = fs.readdirSync(brokerPending)[0];
    }
    assert.ok(timedOutFile, "timed-out broker request was written before it expired");
    assert.equal((await timedOutCall)?.block, true, "unanswered approval must time out denied");
    assert.ok(!fs.existsSync(path.join(brokerPending, timedOutFile)), "timed-out broker request must remove its pending file");

    // An aborted turn must cancel a brokered approval immediately, not at its deadline.
    // Regression: the broker read the abort signal from the event (which has none) instead of
    // ctx, so an aborted broker poll only ended when PI_KIT_HUMAN_CONSOLE_TIMEOUT_MS expired.
    const restoreBrokerTimeout = setEnv("PI_KIT_HUMAN_CONSOLE_TIMEOUT_MS", "5000");
    try {
      const ac = new AbortController(); ac.abort();
      const abortedCall = pi.handlers.get("tool_call")({ toolName: "unknown_ask", input: { x: ++unknownSeq } }, { hasUI: false, ui: {}, cwd: ws, signal: ac.signal });
      const settled = await Promise.race([abortedCall, wait(1500).then(() => { throw new Error("aborted broker call did not settle before its 5s deadline"); })]);
      assert.equal(settled?.block, true, "an aborted broker call must be denied");
    } finally { restoreBrokerTimeout(); }

    // Judge allow bypasses the broker; a judge block tells the agent without brokering;
    // a malformed or missing judge falls back to the broker.
    pi = await firewall(ws, true, '{"verdict":"allow","reason":"fits task"}'); assert.equal(await callMedium(pi, ws), undefined); clearPending(ws);
    pi = await firewall(ws, true, '{"verdict":"block","reason":"unexpected side effect"}'); const denied = await callMedium(pi, ws); assert.equal(denied?.block, true); assert.match(denied?.reason as string, /unexpected side effect/); assert.ok(!fs.existsSync(path.join(ws, "console", "pending")) || !fs.readdirSync(path.join(ws, "console", "pending")).length, "a judge block must not broker"); clearPending(ws);
    pi = await firewall(ws, true, "not-json"); const fallback = callMedium(pi, ws); const flagged = await resolvePending(ws, true); assert.match(flagged.body ?? "", /judge unavailable/); assert.equal(await fallback, undefined); clearPending(ws);
    pi = await firewall(ws, true, null); const noJudge = callMedium(pi, ws); await resolvePending(ws, true); assert.equal(await noJudge, undefined); clearPending(ws);

    // A judge cannot authorise an unknown identity: it still needs a brokered operator answer.
    pi = await firewall(ws, true, '{"verdict":"allow","reason":"looks harmless"}');
    const unknown = callUnknown(pi, ws);
    const unknownRequest = await resolvePending(ws, false);
    assert.match(unknownRequest.body ?? "", /unknown tool/);
    assert.equal((await unknown)?.block, true);
    clearPending(ws);

    // ask_human direct UI, broker round-trip, and clear timeout all work.
    const human = await loadExtension("extensions/human-console/index.ts"); const hpi = fakePi(); human(hpi.api);
    const direct = await hpi.tools.get("ask_human").execute("1", { question: "Proceed?", options: ["yes"] }, undefined, undefined, { cwd: ws, hasUI: true, ui: { select: async () => "yes" } }); assert.match(textOf(direct), /yes/);
    const remote = hpi.tools.get("ask_human").execute("2", { question: "Choose" }, undefined, undefined, { cwd: ws, hasUI: false, ui: {} }); const answered = await resolvePending(ws, true, "answer"); const answeredFile = path.join(ws, "console", "resolved", `${answered.id}.json`); assert.ok(fs.existsSync(answeredFile), "the console wrote the broker answer file"); assert.match(textOf(await remote), /answer/); assert.ok(!fs.existsSync(answeredFile), "the resolved broker answer file must be removed once the request settles");
    const none = await hpi.tools.get("ask_human").execute("3", { question: "Wait", timeoutMs: 1 }, undefined, undefined, { cwd: ws, hasUI: false, ui: {} }); assert.match(textOf(none), /No human answered in time/);
    const abort = new AbortController(); const hung = hpi.tools.get("ask_human").execute("4", { question: "Abort me" }, abort.signal, undefined, { cwd: ws, hasUI: true, ui: { input: () => new Promise(() => {}) } }); abort.abort(); assert.match(textOf(await Promise.race([hung, wait(100).then(() => { throw new Error("aborted prompt hung"); })])), /No human answered in time/);
    const timedOut = hpi.tools.get("ask_human").execute("5", { question: "Time out", timeoutMs: 1 }, undefined, undefined, { cwd: ws, hasUI: true, ui: { input: () => new Promise(() => {}) } }); assert.match(textOf(await Promise.race([timedOut, wait(100).then(() => { throw new Error("timed-out prompt hung"); })])), /No human answered in time/);

    // Regression (S11): every way an ask_human can end has its own `details.outcome` and text. On
    // the base source a dismissed card and a timed-out card both read "No human answered in time."
    // and nothing distinguished a blank answer or an unavailable console from an answer. The cases
    // are collected so one run reports every outcome that is still wrong.
    {
      const failures: string[] = [];
      initTheme(); // the multiline cards build pi's real editor, which draws with the theme
      const outcomeCase = async (name: string, body: () => Promise<void>): Promise<void> => {
        try { await body(); } catch (error) { failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`); }
      };
      await outcomeCase("dismissed is not an answer", async () => {
        const dismissed = await hpi.tools.get("ask_human").execute("o1", { question: "Proceed?", options: ["yes"] }, undefined, undefined, { cwd: ws, hasUI: true, ui: { select: async () => undefined } });
        assert.equal(outcomeOf(dismissed), "dismissed", "Esc/cancel on a card is dismissed");
        assert.equal(answerOf(dismissed), null, "a dismissed question has no answer");
        assert.match(textOf(dismissed), /the question was dismissed without an answer/);
      });
      await outcomeCase("timeout is distinct from dismissed", async () => {
        const dismissed = await hpi.tools.get("ask_human").execute("o2a", { question: "Proceed?", options: ["yes"] }, undefined, undefined, { cwd: ws, hasUI: true, ui: { select: async () => undefined } });
        const expired = await hpi.tools.get("ask_human").execute("o2b", { question: "Proceed?", options: ["yes"], timeoutMs: 1 }, undefined, undefined, { cwd: ws, hasUI: true, ui: { select: () => new Promise(() => {}) } });
        assert.equal(outcomeOf(expired), "timeout");
        assert.notEqual(textOf(expired), textOf(dismissed), "a timeout must not read as a dismissal");
        assert.match(textOf(expired), /the question timed out/);
      });
      await outcomeCase("a blank typed answer is re-asked once with its draft", async () => {
        const calls: Array<string | undefined> = [];
        const asked = await hpi.tools.get("ask_human").execute("o3", { question: "Explain" }, undefined, undefined, { cwd: ws, hasUI: true, mode: "tui", ui: tuiEditor((card) => { calls.push(card.prefill); card.done(calls.length === 1 ? "   " : "the real answer"); }) });
        assert.equal(calls.length, 2, "a whitespace-only typed answer is asked exactly once more");
        assert.equal(calls[1], "   ", "the second card keeps the typed draft");
        assert.equal(outcomeOf(asked), "answered");
        assert.equal(answerOf(asked), "the real answer");
        assert.match(textOf(asked), /Human answer: the real answer/);
      });
      await outcomeCase("a question still blank after one re-ask is dismissed", async () => {
        let cards = 0;
        const asked = await hpi.tools.get("ask_human").execute("o4", { question: "Explain" }, undefined, undefined, { cwd: ws, hasUI: true, mode: "tui", ui: tuiEditor((card) => { cards++; card.done("  "); }) });
        assert.equal(cards, 2, "a blank answer never asks a third time");
        assert.equal(outcomeOf(asked), "dismissed");
        assert.equal(answerOf(asked), null);
        assert.match(textOf(asked), /the question was dismissed without an answer/);
      });
      await outcomeCase("multi-line free text is an answer", async () => {
        const asked = await hpi.tools.get("ask_human").execute("o5", { question: "Explain" }, undefined, undefined, { cwd: ws, hasUI: true, mode: "tui", ui: tuiEditor((card) => card.done("line one\nline two")) });
        assert.equal(outcomeOf(asked), "answered");
        assert.equal(answerOf(asked), "line one\nline two");
      });
      await outcomeCase("a multiline card that times out is closed by the extension", async () => {
        const ui = tuiEditor(() => {});
        const asked = await hpi.tools.get("ask_human").execute("o5a", { question: "Explain", timeoutMs: 30 }, undefined, undefined, { cwd: ws, hasUI: true, mode: "tui", ui });
        assert.equal(outcomeOf(asked), "timeout");
        assert.equal(ui.closed(), 1, "no dialog is left open past its deadline");
      });
      await outcomeCase("a multiline card that is aborted is closed by the extension", async () => {
        const controller = new AbortController();
        const ui = tuiEditor(() => { setTimeout(() => controller.abort(), 5); });
        const asked = await hpi.tools.get("ask_human").execute("o5b", { question: "Explain", timeoutMs: 5000 }, controller.signal, undefined, { cwd: ws, hasUI: true, mode: "tui", ui });
        assert.equal(outcomeOf(asked), "aborted");
        assert.equal(ui.closed(), 1, "no dialog is left open after an abort");
      });
      await outcomeCase("a multiline card the operator cancels is dismissed", async () => {
        const asked = await hpi.tools.get("ask_human").execute("o5c", { question: "Explain", timeoutMs: 5000 }, undefined, undefined, { cwd: ws, hasUI: true, mode: "tui", ui: tuiEditor((card) => card.done(undefined)) });
        assert.equal(outcomeOf(asked), "dismissed");
      });
      await outcomeCase("outside the terminal a card has a deadline pi honours", async () => {
        const seen: Array<{ timeout?: number; signal?: AbortSignal }> = [];
        const controller = new AbortController();
        const asked = await hpi.tools.get("ask_human").execute("o5d", { question: "Explain", timeoutMs: 5000 }, controller.signal, undefined, { cwd: ws, hasUI: true, mode: "rpc", ui: {
          editor: () => { throw new Error("ctx.ui.editor has no deadline"); },
          input: async (_title: string, _placeholder: string, options: { timeout?: number; signal?: AbortSignal }) => { seen.push(options); return "typed"; },
        } });
        assert.equal(outcomeOf(asked), "answered");
        assert.ok((seen[0]?.timeout ?? 0) > 0, "the card carries what is left of the time");
        assert.equal(seen[0]?.signal, controller.signal, "the card carries the turn's signal");
      });
      await outcomeCase("an abort leaves aborted and no pending file", async () => {
        const controller = new AbortController();
        const asked = hpi.tools.get("ask_human").execute("o6", { question: "Abort the brokered question", timeoutMs: 5000 }, controller.signal, undefined, { cwd: ws, hasUI: false, ui: {} });
        const pending = await waitForPendingFile(ws);
        controller.abort();
        const result = await asked;
        assert.equal(outcomeOf(result), "aborted");
        assert.equal(answerOf(result), null);
        assert.match(textOf(result), /the turn was aborted/);
        assert.ok(!fs.existsSync(path.join(ws, "console", "pending", pending)), "an aborted request leaves no pending file");
        assert.ok(!fs.existsSync(path.join(ws, "console", "resolved", pending)), "an aborted request leaves no resolved file");
      });
      await outcomeCase("no console key is unavailable", async () => {
        const restoreAgentDir = setEnv("PI_CODING_AGENT_DIR", path.join(ws, "agent-without-a-console-key"));
        try {
          const asked = await hpi.tools.get("ask_human").execute("o7", { question: "Anybody?", timeoutMs: 1000 }, undefined, undefined, { cwd: ws, hasUI: false, ui: {} });
          assert.equal(outcomeOf(asked), "unavailable");
          assert.match(textOf(asked), /the human console is unavailable/);
        } finally { restoreAgentDir(); }
      });
      await outcomeCase("a refused console write is unavailable, not a crash", async () => {
        const blocked = path.join(ws, "blocked-console-root");
        fs.writeFileSync(blocked, "not a directory");
        const restoreConsoleDir = setEnv("PI_KIT_HUMAN_CONSOLE_DIR", blocked);
        try {
          const asked = await hpi.tools.get("ask_human").execute("o8", { question: "Anybody?", timeoutMs: 1000 }, undefined, undefined, { cwd: ws, hasUI: false, ui: {} });
          assert.equal(outcomeOf(asked), "unavailable");
          assert.match(textOf(asked), /the human console is unavailable/);
        } finally { restoreConsoleDir(); fs.rmSync(blocked, { force: true }); }
      });
      await outcomeCase("a symlinked workspace console is unavailable and writes nothing", async () => {
        const linked = path.join(ws, "linked-workspace");
        const target = path.join(ws, "link-target");
        fs.mkdirSync(path.join(linked, ".pi"), { recursive: true });
        fs.mkdirSync(target);
        fs.symlinkSync(target, path.join(linked, ".pi", "human-console"));
        const restoreConsoleDir = setEnv("PI_KIT_HUMAN_CONSOLE_DIR", path.join(linked, ".pi", "human-console"));
        try {
          const asked = await hpi.tools.get("ask_human").execute("o9", { question: "Anybody?", timeoutMs: 1000 }, undefined, undefined, { cwd: ws, hasUI: false, ui: {} });
          assert.equal(outcomeOf(asked), "unavailable");
          assert.deepEqual(fs.readdirSync(target), [], "the broker wrote nothing through the link");
          const fw = await firewall(ws, true, null);
          const refused = await callMedium(fw, ws);
          assert.equal(refused?.block, true, "the firewall refuses an approval it cannot file");
          assert.deepEqual(fs.readdirSync(target), [], "the firewall wrote nothing through the link");
        } finally { restoreConsoleDir(); fs.rmSync(linked, { recursive: true, force: true }); fs.rmSync(target, { recursive: true, force: true }); }
      });
      assert.deepEqual(failures, [], `ask_human outcomes:\n${failures.join("\n")}`);
    }

    // Regression: the broker's poll sleep must remove its abort listener on the normal timer
    // path. On the pre-fix source every unanswered poll added one listener to the tool signal
    // (at 1 Hz for the default 900s timeout => ~900 leaked listeners).
    {
      const { brokerRequest } = await loadModule<typeof HumanConsole>("extensions/human-console/index.ts");
      const ac = new AbortController();
      const leakId = `leak-${Date.now()}`;
      const result = await brokerRequest(ws, { id: leakId, timeoutMs: 30 }, ac.signal);
      assert.equal(result.timedOut, true, "an unanswered broker request must report timedOut");
      assert.equal(getEventListeners(ac.signal, "abort").length, 0, "brokerRequest must not leak abort listeners after a normal (non-aborted) poll sleep");
    }

    // An approval with choices is a menu; "Deny and tell" also collects a note for the agent.
    for (const [picked, approved, note] of [["Allow for this session: root on srv02: writes system paths", true, null], ["Deny and tell the agent why…", false, "wrong host"]]) {
      const pend = path.join(ws, "console", "pending"); fs.mkdirSync(pend, { recursive: true });
      const id = `menu-${approved ? "allow" : "deny"}`;
      const choices = ["Allow once", "Allow for this session: root on srv02: writes system paths", "Deny", "Deny and tell the agent why…"];
      fs.writeFileSync(path.join(pend, `${id}.json`), JSON.stringify({ id, kind: "approval", createdAt: new Date().toISOString(), title: "Approve tool call? (subagent)", body: "HIGH · bash · x", choices, timeoutMs: 1000 }));
      let header = "";
      await hpi.handlers.get("session_start")({}, { cwd: ws, hasUI: true, ui: { select: async (h: string, opts: string[]) => { header = h; assert.deepEqual(opts, choices); return picked; }, input: async () => "wrong host", confirm: async () => { throw new Error("menu requests must not fall back to confirm"); } } });
      await wait(60);
      const res: unknown = JSON.parse(fs.readFileSync(path.join(ws, "console", "resolved", `${id}.json`), "utf8"));
      assert.ok(isRecord(res), "the resolved menu answer is a JSON object");
      assert.equal(res.approved, approved); assert.equal(res.answer, picked); assert.equal(res.note, note);
      assert.match(header, /^Approve tool call\? \(subagent\)\nHIGH · bash · x$/);
    }

    // Content-provided ids are never allowed to escape the resolved directory.
    const pending = path.join(ws, "console", "pending"); fs.mkdirSync(pending, { recursive: true });
    fs.writeFileSync(path.join(pending, "malicious.json"), JSON.stringify({ id: "../../../evil", kind: "approval", timeoutMs: 1 }));
    await hpi.handlers.get("session_start")({}, { cwd: ws, hasUI: true, ui: { confirm: async () => true } }); await wait(30);
    assert.ok(fs.existsSync(path.join(pending, "malicious.json.invalid")), "unsafe pending id must be quarantined");
    assert.ok(!fs.existsSync(path.join(ws, "evil.json")), "unsafe id must not write outside resolved");

    // Regression: an unrecognised kind must be quarantined, not re-read every poll forever.
    // Previously processOne returned without removing the file (the finally only cleared the
    // in-memory processing set), so it lingered and was re-processed on every tick.
    fs.writeFileSync(path.join(pending, "unknown-kind.json"), JSON.stringify({ id: "unknown-kind", kind: "not-a-kind", timeoutMs: 1 }));
    await hpi.handlers.get("session_start")({}, { cwd: ws, hasUI: true, ui: { confirm: async () => true } }); await wait(30);
    assert.ok(fs.existsSync(path.join(pending, "unknown-kind.json.invalid")), "unrecognised kind must be quarantined");
    assert.ok(!fs.existsSync(path.join(pending, "unknown-kind.json")), "unrecognised kind must not stay pending");
    assert.ok(!fs.existsSync(path.join(ws, "console", "resolved", "unknown-kind.json")), "unrecognised kind must not produce a resolved file");

    // Regression: malformed JSON must be quarantined, not re-read every poll forever.
    // Previously the parse error returned without removing the file, so the watcher
    // re-read it on every tick.
    fs.writeFileSync(path.join(pending, "broken-json.json"), "{ not json");
    await hpi.handlers.get("session_start")({}, { cwd: ws, hasUI: true, ui: { confirm: async () => true } }); await wait(30);
    assert.ok(fs.existsSync(path.join(pending, "broken-json.json.invalid")), "malformed JSON must be quarantined");
    assert.ok(!fs.existsSync(path.join(pending, "broken-json.json")), "malformed JSON must not stay pending");
    assert.ok(!fs.existsSync(path.join(ws, "console", "resolved", "broken-json.json")), "malformed JSON must not produce a resolved file");

    // Regression: the deliberate `.invalid` quarantine must stay bounded. A repetitive
    // malformed/foreign producer would otherwise grow the pending directory without bound.
    const { MAX_INVALID_QUARANTINE } = await loadModule<typeof HumanConsole>("extensions/human-console/index.ts");
    const quarantineCount = MAX_INVALID_QUARANTINE + 5;
    for (let i = 0; i < quarantineCount; i++) {
      const file = path.join(pending, `quarantine-${i}.json.invalid`);
      fs.writeFileSync(file, "x");
      const t = Date.now() / 1000 + i;
      fs.utimesSync(file, t, t); // strictly increasing mtime makes the eviction order deterministic
    }
    await hpi.handlers.get("session_start")({}, { cwd: ws, hasUI: true, ui: { confirm: async () => true } });
    await wait(30);
    const remainingInvalid = fs.readdirSync(pending).filter((f) => f.endsWith(".invalid"));
    assert.equal(remainingInvalid.length, MAX_INVALID_QUARANTINE, "pruneInvalid must cap the .invalid quarantine at MAX_INVALID_QUARANTINE (the test fails if the pruneInvalid call is removed)");
    assert.ok(!fs.existsSync(path.join(pending, "quarantine-0.json.invalid")), "the oldest quarantined file must be evicted once the cap is exceeded");
    assert.ok(fs.existsSync(path.join(pending, `quarantine-${quarantineCount - 1}.json.invalid`)), "the newest quarantined file must be retained");

    // Regression: a pending file removed during the approval await must not crash the host.
    // Previously processOne's unguarded fs.unlinkSync threw ENOENT as an unhandled rejection
    // (void processOne(...) with no catch), which exits the pi process.
    const raceId = "race-removed-mid-approval";
    const raceFile = path.join(pending, `${raceId}.json`);
    fs.writeFileSync(raceFile, JSON.stringify({ id: raceId, kind: "approval", createdAt: new Date().toISOString(), title: "race", body: "race", timeoutMs: 1000 }));
    const raceCtx = { cwd: ws, hasUI: true, ui: { confirm: async () => { try { fs.unlinkSync(raceFile); } catch { /* simulate concurrent resolver */ } return true; } } };
    hpi.handlers.get("session_start")({}, raceCtx);
    await wait(80);
    assert.ok(fs.existsSync(path.join(ws, "console", "resolved", `${raceId}.json`)), "approval must still resolve when the pending file is removed concurrently");

    // Regression: a late answer after the requester's deadline must not recreate an orphan
    // resolved file (brokerRequest already unlinked both files when it gave up) and must drop
    // the stale pending file instead of re-answering it on every poll.
    const lateId = "late-answer-orphan";
    const lateFile = path.join(pending, `${lateId}.json`);
    fs.writeFileSync(lateFile, JSON.stringify({ id: lateId, kind: "approval", title: "late", body: "late", timeoutMs: 1000, createdAt: new Date(Date.now() - 5000).toISOString() }));
    await hpi.handlers.get("session_start")({}, { cwd: ws, hasUI: true, ui: { confirm: async () => true } });
    await wait(60);
    assert.ok(!fs.existsSync(path.join(ws, "console", "resolved", `${lateId}.json`)), "a late answer after the requester's deadline must not create an orphan resolved file");
    assert.ok(!fs.existsSync(lateFile), "the late pending file must be removed, not re-answered forever");

    // Regression: an unusable pending path (a regular file where the pending directory
    // belongs) must never escape the 1 Hz watcher as an uncaught exception that kills pi.
    // Pre-fix, ensure() threw EEXIST and readdirSync threw ENOTDIR inside the timer callback.
    {
      const pendingPath = path.join(ws, "console", "pending");
      fs.rmSync(pendingPath, { recursive: true, force: true });
      fs.writeFileSync(pendingPath, "not a directory");
      const uncaught: Error[] = [];
      const collect = (error: Error): void => { uncaught.push(error); };
      const scanFailures: string[] = [];
      const originalError = console.error;
      console.error = (...args: unknown[]) => { scanFailures.push(args.map(String).join(" ")); };
      process.on("uncaughtException", collect);
      try {
        await hpi.handlers.get("session_start")({}, { cwd: ws, hasUI: true, ui: { confirm: async () => true } });
        await wait(2300); // hold the bad path across >2 poll ticks so a per-tick reporter would log repeatedly
        assert.equal(uncaught.length, 0, `the watcher must tolerate an unusable pending path, saw: ${uncaught.map((e) => e?.message || String(e)).join("; ")}`);
        const failureLines = scanFailures.filter((message) => message.includes("pending scan failed"));
        assert.ok(failureLines.length <= 1, `a pending-scan failure must be reported once per distinct error, saw ${failureLines.length}: ${failureLines.join(" | ")}`);
      } finally {
        process.removeListener("uncaughtException", collect);
        fs.rmSync(pendingPath, { recursive: true, force: true });
        console.error = originalError;
      }
    }

    // Once the path is a directory again, the watcher must still resolve a valid request and
    // log exactly one recovery line for the failure reported above.
    {
      const pendingPath = path.join(ws, "console", "pending");
      fs.mkdirSync(pendingPath, { recursive: true });
      const recovered: string[] = [];
      const originalError = console.error;
      console.error = (...args: unknown[]) => { recovered.push(args.map(String).join(" ")); };
      try {
        const recoverId = "recover-after-unusable-pending";
        fs.writeFileSync(path.join(pendingPath, `${recoverId}.json`), JSON.stringify({ id: recoverId, kind: "approval", createdAt: new Date().toISOString(), title: "recover", body: "recover", timeoutMs: 5000 }));
        await hpi.handlers.get("session_start")({}, { cwd: ws, hasUI: true, ui: { confirm: async () => true } });
        const resolvedFile = path.join(ws, "console", "resolved", `${recoverId}.json`);
        let resolved = false;
        for (let i = 0; i < 40 && !resolved; i++) { await wait(50); resolved = fs.existsSync(resolvedFile); }
        assert.ok(resolved, "the watcher must keep resolving requests once the pending path is usable again");
        const recoveryLines = recovered.filter((message) => message.includes("pending scan recovered"));
        assert.equal(recoveryLines.length, 1, `exactly one pending-scan recovery line must be logged, saw ${recoveryLines.length}: ${recoveryLines.join(" | ")}`);
      } finally { console.error = originalError; }
    }
    console.log("[human-console-broker-smoke] OK");
  } finally { clearInterval(keepAlive); for (const restore of restores.reverse()) restore(); rmWorkspace(ws); }
}
// A fresh input per call: judge verdicts are cached per action for the session.
let unknownSeq = 0;
function callUnknown(pi: FakePi, ws: string) { return pi.handlers.get("tool_call")({ toolName: "unknown_ask", input: { x: ++unknownSeq } }, { hasUI: false, ui: {}, cwd: ws }); }
function callMedium(pi: FakePi, ws: string) { return pi.handlers.get("tool_call")({ toolName: "bash", input: { command: `npm install broker-fixture-${++unknownSeq}` } }, { hasUI: false, ui: {}, cwd: ws }); }
await run();
