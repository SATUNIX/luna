#!/usr/bin/env node
// Offline bounds smoke for conductor specialist children: stream cap, idle watchdog, wall-clock
// ceiling, clean exit, and abort. Fully deterministic — fake child, no pi, no network.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { loadModule } from "../packages/core/eval/harness.ts";
import type * as Conductor from "../packages/extensions/src/conductor/index.ts";
import type * as Validator from "../packages/extensions/src/conductor/validate/validator.ts";
import type { AgentConfig } from "../packages/extensions/third_party/subagent/agents.ts";
import type * as Launch from "../packages/extensions/third_party/subagent/launch.ts";

const { streamSpecialistChild, specialistBounds } = await loadModule<typeof Conductor>("extensions/conductor/index.ts");

// The bounds timers are unref'd (a real spawned child keeps the loop alive). A fake child does
// not, so hold the loop open for the duration of the assertions.
const keepalive = setInterval(() => {}, 1000);

interface FakeChild extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  killed: boolean;
  kill: () => boolean;
}

function fakeChild(): FakeChild {
  const child: FakeChild = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    killed: false,
    kill: (): boolean => { child.killed = true; queueMicrotask(() => child.emit("close", null)); return true; },
  });
  return child;
}

// 1. Defaults, overrides, and safe fallback for unusable values (never an unbounded cap).
{
  const d = specialistBounds({});
  assert.equal(d.streamCapBytes, 256 * 1024 * 1024, "default stream cap");
  assert.equal(d.idleTimeoutMs, 15 * 60 * 1000, "default idle timeout");
  assert.equal(d.maxRuntimeMs, 0, "wall-clock disabled by default");

  const o = specialistBounds({
    PI_KIT_SPECIALIST_STREAM_CAP_BYTES: "65536",
    PI_KIT_SPECIALIST_IDLE_TIMEOUT_MS: "50",
    PI_KIT_SPECIALIST_MAX_RUNTIME_MS: "500",
  });
  assert.deepEqual(o, { streamCapBytes: 65536, idleTimeoutMs: 50, maxRuntimeMs: 500 });

  const bad = specialistBounds({ PI_KIT_SPECIALIST_STREAM_CAP_BYTES: "1", PI_KIT_SPECIALIST_IDLE_TIMEOUT_MS: "-5" });
  assert.equal(bad.streamCapBytes, 256 * 1024 * 1024, "below-floor cap falls back to default");
  assert.equal(bad.idleTimeoutMs, 15 * 60 * 1000, "negative idle falls back to default");
}

// 2. A runaway child is killed at the cap and reports it.
{
  const bounds = { streamCapBytes: 64 * 1024, idleTimeoutMs: 0, maxRuntimeMs: 0 };
  const child = fakeChild();
  const p = streamSpecialistChild(child, bounds, undefined);
  child.stdout.write("x".repeat(bounds.streamCapBytes * 2));
  const r = await p;
  assert.equal(r.killed, "stream-cap", "stream cap must be reported honestly");
  assert.equal(r.code, 1);
}

// 3. A silent child is killed promptly by the idle watchdog.
{
  const bounds = { streamCapBytes: 1024 * 1024, idleTimeoutMs: 60, maxRuntimeMs: 0 };
  const child = fakeChild();
  const started = Date.now();
  const r = await streamSpecialistChild(child, bounds, undefined);
  assert.equal(r.killed, "idle-timeout");
  assert.ok(Date.now() - started < 2000, "idle kill must resolve promptly");
}

// 4. A child that keeps dribbling output (defeating the idle watchdog) is bounded by wall-clock.
{
  const bounds = { streamCapBytes: 4 * 1024 * 1024, idleTimeoutMs: 200, maxRuntimeMs: 100 };
  const child = fakeChild();
  const drip = setInterval(() => child.stdout.write("{}\n"), 20);
  try {
    const r = await streamSpecialistChild(child, bounds, undefined);
    assert.equal(r.killed, "wall-clock");
  } finally { clearInterval(drip); }
}

// 5. A clean child resolves code 0 and its message_end is captured.
{
  const bounds = { streamCapBytes: 1024 * 1024, idleTimeoutMs: 500, maxRuntimeMs: 0 };
  const child = fakeChild();
  const p = streamSpecialistChild(child, bounds, undefined);
  queueMicrotask(() => {
    child.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } }) + "\n");
    child.emit("close", 0);
  });
  const r = await p;
  assert.equal(r.killed, undefined, "a clean child is not reported as killed");
  assert.equal(r.code, 0);
  assert.equal(r.messages.length, 1);
  assert.ok(r.messages[0], "the message_end is captured");
  assert.equal(r.messages[0].role, "assistant");
}

// 7. ORC-10: child stream messages are unknown. A string content, a null part or a non-object
// message is skipped instead of throwing, and the newest assistant text part still wins.
{
  const { finalAssistantOutput } = await loadModule<typeof Validator>("extensions/conductor/validate/validator.ts");
  assert.equal(typeof finalAssistantOutput, "function", "the shared reader is exported for conductor and the validator");
  const messages: unknown[] = [
    { role: "assistant", content: [{ type: "text", text: "first" }] },
    { role: "assistant", content: "not an array" },
    { role: "assistant", content: [null, 7, { type: "text", text: 9 }] },
    "not a message",
  ];
  assert.equal(finalAssistantOutput(messages), "first");
  assert.equal(finalAssistantOutput([{ role: "assistant", content: "x" }]), "");
}

// 6. An abort signal stops the child and is reported as such.
{
  const bounds = { streamCapBytes: 1024 * 1024, idleTimeoutMs: 0, maxRuntimeMs: 0 };
  const ac = new AbortController();
  const child = fakeChild();
  const p = streamSpecialistChild(child, bounds, ac.signal);
  ac.abort();
  const r = await p;
  assert.equal(r.killed, "signal");
}

// 7. A specialist is reported read-only to delegation-guard by the subagent rule: only read, grep,
// find and ls are read tools. conductor keeps its own copy, so pin it to subagent's.
{
  const { isReadOnlySpecialist, SPECIALIST_READ_TOOLS } = await loadModule<typeof Conductor>("extensions/conductor/index.ts");
  const launch = await loadModule<typeof Launch>("vendor/subagent/launch.ts");
  assert.deepEqual([...SPECIALIST_READ_TOOLS].sort(), [...launch.READ_ONLY_TOOLS].sort(), "conductor's read-tool set equals subagent's READ_ONLY_TOOLS");
  const role = (tools: string[]): AgentConfig => ({ name: "specialist", description: "", tools, systemPrompt: "", source: "kit", filePath: "" });
  const cases: string[][] = [
    ["read"], ["read", "grep", "find", "ls"], [],
    ["read", "bash"], ["read", "powershell"], ["read", "mcp__x__search"], ["read", "web_fetch"],
    ["read", "write"], ["edit"], ["read", "subagent"], ["*"],
  ];
  for (const tools of cases) {
    assert.equal(isReadOnlySpecialist(tools), launch.isReadOnlyRole(role(tools), undefined), `specialist and subagent agree on [${tools.join(",")}]`);
  }
  assert.equal(isReadOnlySpecialist(["read", "powershell"]), false, "a specialist with powershell is not read-only");
  assert.equal(isReadOnlySpecialist(["read", "mcp__x__search"]), false, "a specialist with an MCP tool is not read-only");
  assert.equal(isReadOnlySpecialist(["read", "grep"]), true, "a specialist with only read tools is read-only");
}

console.log("[conductor-specialist-bounds-smoke] OK");
clearInterval(keepalive);