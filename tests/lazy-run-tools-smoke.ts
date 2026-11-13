#!/usr/bin/env node
// workflow_status and workflow_control are registered inactive and wake when a run starts, so a
// session that never starts one does not carry their text in every request.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fakePi, isolateKitEnv, loadModule, type FakePiApi } from "../packages/core/eval/harness.ts";
import type { RunRegistry } from "../packages/extensions/third_party/subagent/run-model.ts";

type ToolControlApi = FakePiApi & { setActiveTools(names: string[]): void };
// The subagent extension as pi loads it: its default export registers every tool, and the same
// module instance owns the run registry the tools listen to.
interface SubagentModule {
  default(pi: ToolControlApi): void;
  runRegistry: RunRegistry;
}

const restore = isolateKitEnv();
const mod = await loadModule<SubagentModule>("vendor/subagent/index.ts");

// A pi whose active tool set the test can read, as pi 1.x exposes it.
function piWithToolControl(): { api: ToolControlApi; pi: ReturnType<typeof fakePi>; active: () => string[] } {
  const pi = fakePi();
  let active = ["read", "bash", "subagent"];
  const api: ToolControlApi = { ...pi.api, getActiveTools: () => [...active], setActiveTools: (names) => (active = names) };
  mod.default(api);
  return { api, pi, active: () => active };
}

const woken = (active: string[]): boolean => active.includes("workflow_status") && active.includes("workflow_control");

{
  const { pi, active } = piWithToolControl();
  assert.equal(pi.tools.get("workflow_status").defaultActive, false, "workflow_status registers inactive");
  assert.equal(pi.tools.get("workflow_control").defaultActive, false, "workflow_control registers inactive");
  assert.notEqual(pi.tools.get("workflow_run").defaultActive, false, "the tool that starts a run stays active");
  assert.ok(!woken(active()), "nothing is woken before a run");

  await pi.handlers.get("tool_call")({ toolName: "subagent", input: { agent: "scout", task: "x" } }, {});
  assert.ok(!woken(active()), "a foreground subagent call does not wake them");
  await pi.handlers.get("tool_call")({ toolName: "subagent", input: { agent: "scout", task: "x", background: true } }, {});
  assert.ok(woken(active()), "a background subagent does");
}
{
  const { pi, active } = piWithToolControl();
  await pi.handlers.get("tool_call")({ toolName: "workflow_run", input: { name: "x" } }, {});
  assert.ok(woken(active()), "workflow_run wakes them");
}
{
  const { active } = piWithToolControl();
  mod.runRegistry.start("lazy-run-tools-smoke", "yaml", "x");
  assert.ok(woken(active()), "a run an operator command starts wakes them");
}
{
  // An autonomous run never reaches the run registry: a session that starts beside a live one wakes the tools.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "lazy-autonomy-"));
  const prior = process.env.PI_AUTONOMY_HOME;
  process.env.PI_AUTONOMY_HOME = home;
  const id = "2026-01-02T00-00-00-000Z-autonomy-lazy01";
  const dir = path.join(home, id);
  fs.mkdirSync(dir, { recursive: true });
  const state = { schemaVersion: 1, template: "implement", status: "running", phase: "work", startedAt: "2026-01-02T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z", usage: { usd: 0 }, budget: { totalUsd: 10 }, tasks: [] };
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(state));
  const idle = piWithToolControl();
  await idle.pi.handlers.get("before_agent_start")({}, { cwd: home });
  assert.ok(!woken(idle.active()), "a run with no supervisor lock is not live, so nothing wakes");
  const beat = new Date().toISOString();
  fs.writeFileSync(path.join(dir, "supervisor.lock"), JSON.stringify({ schemaVersion: 1, pid: process.pid, startTime: null, host: os.hostname(), token: "t", acquiredAt: beat, heartbeatAt: beat }));
  await idle.pi.handlers.get("before_agent_start")({}, { cwd: home });
  assert.ok(woken(idle.active()), "a live autonomous run wakes the tools at the next prompt");
  if (prior === undefined) delete process.env.PI_AUTONOMY_HOME;
  else process.env.PI_AUTONOMY_HOME = prior;
  fs.rmSync(home, { recursive: true, force: true });
}
{
  // A pi without tool control (older pi) leaves the tools as registered and never throws.
  const pi = fakePi();
  mod.default(pi.api as ToolControlApi);
  await pi.handlers.get("tool_call")({ toolName: "workflow_run", input: {} }, {});
}
restore();
console.log("[lazy-run-tools-smoke] the run tools are inactive until a run starts");
