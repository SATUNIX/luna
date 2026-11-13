#!/usr/bin/env node
/**
 * herdr extension: a no-op outside herdr; inside it, attention events become herdr:blocked plus a
 * notification request. The herdr socket is stubbed; no live herdr is touched. Offline.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readAgentStates } from "../packages/core/shared/agent-state.ts";
import { loadExtension, fakePi, setEnv, isolateKitEnv } from "../packages/core/eval/harness.ts";

const restoreIsolation = isolateKitEnv();
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "luna-herdr-state-"));
const mod = await loadExtension<(pi: unknown, send: (socket: string, request: unknown) => Promise<boolean>, stateDir: string) => void>("extensions/herdr/index.ts");

function setup(env: Record<string, string | undefined>) {
  const restores = Object.entries({ HERDR_ENV: undefined, HERDR_PANE_ID: undefined, HERDR_SOCKET_PATH: undefined, ...env }).map(([k, v]) => setEnv(k, v));
  const sent: Array<{ socket: string; request: { method: string; params: { title: string; body: string; sound: string } } }> = [];
  const pi = fakePi();
  const blocked: unknown[] = [];
  pi.api.events.on("herdr:blocked", (d) => blocked.push(d));
  mod(pi.api, async (socket, request) => (sent.push({ socket, request: request as never }), true), stateDir);
  return { pi, sent, blocked, done: () => restores.reverse().forEach((r) => r()) };
}
const inHerdr = { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_SOCKET_PATH: "/tmp/herdr-test.sock" };

try {
  const outside = setup({});
  outside.pi.api.events.emit("luna:attention", { kind: "approval", active: true, label: "x" });
  assert.deepEqual([outside.sent, outside.blocked], [[], []], "outside herdr nothing is sent");
  outside.done();

  const child = setup({ ...inHerdr, PI_SUBAGENT_CHILD: "1" });
  child.pi.api.events.emit("luna:attention", { kind: "approval", active: true, label: "x" });
  assert.equal(child.sent.length, 0, "a subagent child never notifies");
  child.done();

  const off = setup({ ...inHerdr, PI_KIT_HERDR: "off" });
  off.pi.api.events.emit("luna:attention", { kind: "approval", active: true, label: "x" });
  assert.equal(off.sent.length, 0, "PI_KIT_HERDR=off disables it");
  off.done();

  const h = setup(inHerdr);
  h.pi.api.events.emit("luna:attention", { kind: "approval", active: true, label: "approve bash\u001b[31m" });
  assert.deepEqual(h.blocked, [{ active: true, label: "approve bash [31m" }], "a blocking ask is bridged, control characters removed");
  assert.equal(h.sent[0]?.socket, "/tmp/herdr-test.sock");
  assert.equal(h.sent[0]?.request.method, "notification.show");
  assert.equal(h.sent[0]?.request.params.sound, "request");
  assert.deepEqual(readAgentStates(stateDir).map((a) => [a.state, a.waitingFor]), [["blocked", "approve bash [31m"]], "a pending approval is written as blocked, with what it waits for");
  h.pi.api.events.emit("luna:attention", { kind: "approval", active: false, label: "" });
  assert.deepEqual(readAgentStates(stateDir).map((a) => [a.state, a.waitingFor]), [["working", undefined]], "answering it returns the agent to working");
  assert.equal(h.blocked.length, 2, "closing the ask clears blocked");
  assert.equal(h.sent.length, 1, "closing the ask sends no notification");
  h.pi.api.events.emit("luna:attention", { kind: "failed", label: "npm test failed" });
  assert.equal(h.sent[1]?.request.params.body, "npm test failed", "a notice notifies without blocking");
  assert.equal(h.blocked.length, 2);

  const realNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    await h.pi.handlers.get("agent_start")({}, {});
    now += 5_000;
    await h.pi.handlers.get("agent_end")({}, {});
    assert.equal(h.sent.length, 2, "a short run stays quiet");
    await h.pi.handlers.get("agent_start")({}, {});
    now += 60_000;
    await h.pi.handlers.get("agent_end")({}, {});
    assert.equal(h.sent[2]?.request.params.sound, "done", "a long run notifies when it ends");
    await h.pi.handlers.get("agent_start")({}, {});
    now += 60_000;
    await h.pi.handlers.get("agent_end")({ messages: [{ role: "assistant", stopReason: "aborted" }] }, {});
    assert.equal(h.sent.length, 3, "an aborted long run does not notify");
  } finally {
    Date.now = realNow;
  }
  await h.pi.handlers.get("message_end")({ message: { role: "assistant", content: [{ type: "text", text: "the key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEF" }] } }, {});
  await h.pi.handlers.get("agent_end")({ messages: [{ role: "assistant", stopReason: "aborted" }] }, {});
  assert.doesNotMatch(String(readAgentStates(stateDir)[0]?.tail), /sk-ant-api03-abcdefghijklmnop/, "the state-file tail is redacted");
  h.done();
  const afterRun = readAgentStates(stateDir);
  assert.equal(afterRun.length, 1, "one file per agent");
  assert.equal(afterRun[0]?.state, "stopped", "an aborted run is recorded as stopped");

  // A fresh session sits idle at the prompt (done, not working); a ceiling park survives the abort that follows it.
  const fresh = setup(inHerdr);
  await fresh.pi.handlers.get("session_start")({}, { cwd: "/tmp" });
  assert.equal(readAgentStates(stateDir)[0]?.state, "done", "an idle new session is not reported as working");
  await fresh.pi.handlers.get("agent_start")({}, {});
  assert.equal(readAgentStates(stateDir)[0]?.state, "working");
  fresh.pi.api.events.emit("luna:parked", { reason: "used 2 of the 2 turns allowed" });
  assert.equal(readAgentStates(stateDir)[0]?.state, "parked", "a park is reported");
  await fresh.pi.handlers.get("agent_end")({ messages: [{ role: "assistant", stopReason: "aborted" }] }, {});
  assert.equal(readAgentStates(stateDir)[0]?.state, "parked", "the abort that follows a park does not turn it into stopped");
  await fresh.pi.handlers.get("agent_start")({}, {});
  assert.equal(readAgentStates(stateDir)[0]?.state, "working", "the next run clears it");
  fresh.done();

  // A host without an event bus must not break loading.
  const bare = fakePi();
  const restoreBare = setEnv("HERDR_ENV", "1"), r2 = setEnv("HERDR_PANE_ID", "w1:p1"), r3 = setEnv("HERDR_SOCKET_PATH", "/tmp/herdr-test.sock");
  try { assert.doesNotThrow(() => mod({ ...bare.api, events: undefined }, async () => true, stateDir)); } finally { r3(); r2(); restoreBare(); }
} finally {
  restoreIsolation();
}
fs.rmSync(stateDir, { recursive: true, force: true });
console.log("herdr-smoke: OK");
