#!/usr/bin/env node
// Inert Node fixture only: never starts Pi or evaluates task text as code.
//
// Pins the subagent observability/recovery contract:
//   1. Every run writes a log file and returns its path on the result.
//   2. The log contains the child stream, stderr, and a lifecycle end marker.
//   3. Stored message text is bounded while the full stream stays in the log.
//   4. The run registry records start+end, and `subagent_status` lists/tails by id.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { loadModule, fakePi, tmpWorkspace, rmWorkspace, isolateKitEnv, textOf } from "../packages/core/eval/harness.ts";
import { installDelegation } from "../packages/core/eval/delegation.ts";
import type * as Subagent from "../packages/extensions/third_party/subagent/index.ts";
import type { AgentConfig } from "../packages/extensions/third_party/subagent/agents.ts";
import type { SingleResult } from "../packages/extensions/third_party/subagent/types.ts";

// The slice of a ChildProcess the subagent runner touches; the fixture below fakes only this.
interface FakeChild extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  killed: boolean;
  kill: () => boolean;
}

// The subagent module as this test drives it: registered against the harness's fakePi() api, and
// runSingleAgent given a spawn double that returns the fake child above.
type SubagentModule = Omit<typeof Subagent, "default" | "runSingleAgent"> & {
  default: (pi: ReturnType<typeof fakePi>["api"]) => void;
  runSingleAgent: (
    defaultCwd: string, agents: AgentConfig[], agentName: string, task: string, cwd: string | undefined, step: number | undefined,
    signal: AbortSignal | undefined, onUpdate: ((text: string) => void) | undefined, spawnChild: () => FakeChild,
  ) => Promise<SingleResult>;
};

// One line of .pi/subagent/runs.jsonl.
interface RunRecord {
  event: string;
  status?: string;
}

// Launches go through delegation-guard (mandatory protections + effort budget); fake children still need it in place.
const __delegation = await installDelegation();
process.on("exit", () => __delegation.cleanup());

const restoreIsolation = isolateKitEnv();
const ws = tmpWorkspace("pi-kit-subagent-observability-");
try {
  const module = await loadModule<SubagentModule>("vendor/subagent/index.ts");
  const agents: AgentConfig[] = [{ name: "scout", description: "fixture", tools: ["read"], systemPrompt: "", source: "user", filePath: "fixture" }];

  function fakeChild(onSpawn: (child: FakeChild) => void): () => FakeChild {
    const child = new EventEmitter() as FakeChild;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = false;
    child.kill = () => { child.killed = true; queueMicrotask(() => child.emit("close", 0)); return true; };
    return () => { queueMicrotask(() => onSpawn(child)); return child; };
  }

  const big = "A".repeat(300 * 1024);
  const result = await module.runSingleAgent(ws, agents, "scout", "logtest", undefined, undefined, undefined, undefined,
    fakeChild((child) => {
      child.stderr.write("npm warn fixture\n");
      child.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: big }], stopReason: "end" } }) + "\n");
      child.emit("close", 0);
    }));

  // 1. log path returned + file exists
  assert.equal(result.exitCode, 0);
  assert.ok(result.logPath, "result must carry a logPath");
  assert.ok(fs.existsSync(result.logPath), "log file must exist");

  // 2. log content: child stream, stderr, lifecycle
  const log = fs.readFileSync(result.logPath, "utf8");
  assert.match(log, /# agent=scout/);
  assert.match(log, /# task=logtest/);
  assert.match(log, /"role":"assistant"/, "raw child JSONL must be in the log");
  assert.match(log, /\[stderr\] npm warn fixture/, "stderr must be in the log");
  assert.match(log, /# end status=end/, "lifecycle end marker must be in the log");

  // 3. bounded in-memory text, full stream still in the log
  const content = result.messages.at(-1)?.content;
  assert.ok(Array.isArray(content), "the last stored message must carry a part list");
  const stored = content[0]?.text;
  assert.ok(stored !== undefined, "the last stored message must carry text");
  assert.ok(stored.length < big.length, "stored message text must be bounded");
  assert.match(stored, /stored message truncated/);
  assert.ok(log.length >= big.length, "run log must retain the full stream");
  // ...but the full final answer is preserved for chain mode and success output.
  assert.equal(result.finalOutput, big, "finalOutput must hold the complete final answer");

  // 4. registry + subagent_status
  const registry = path.join(ws, ".pi", "subagent", "runs.jsonl");
  assert.ok(fs.existsSync(registry), "run registry must exist");
  const records = fs.readFileSync(registry, "utf8").trim().split("\n").map((l) => JSON.parse(l) as RunRecord);
  assert.ok(records.some((r) => r.event === "start"), "registry must record start");
  assert.ok(records.some((r) => r.event === "end" && r.status === "end"), "registry must record end");

  const runId = path.basename(result.logPath).replace(/\.log$/, "");
  const pi = fakePi();
  module.default(pi.api);
  const listed = await pi.tools.get("subagent_status").execute("s", {}, undefined, undefined, { cwd: ws });
  assert.match(textOf(listed), /scout/);
  assert.match(textOf(listed), new RegExp(runId));
  const tailed = await pi.tools.get("subagent_status").execute("s", { id: runId, tail: 5 }, undefined, undefined, { cwd: ws });
  assert.match(textOf(tailed), /# end status=end/);

  // 5. a model-supplied run id cannot traverse out of the state dir
  const traversal = await pi.tools.get("subagent_status").execute("s", { id: "../../etc/passwd" }, undefined, undefined, { cwd: ws });
  assert.equal(traversal.isError, true, "path-traversal id must be rejected");
  assert.match(textOf(traversal), /Invalid run id/);

  // 6. a parallel batch where every task fails is surfaced as an error (0/N is a failure)
  const parallel = await pi.tools.get("subagent").execute("p", { tasks: [{ agent: "nonexistent-role-xyz", task: "x" }] }, undefined, undefined, { cwd: ws, hasUI: false, ui: {} });
  assert.equal(parallel.isError, true, "0/N parallel batch must be an error");
  assert.match(textOf(parallel), /0\/1 succeeded/);

  // 7. stop control: a live child can be stopped via the subagent_stop tool, and the run
  //    reports stopReason "stopped" rather than a generic abort.
  const runningPromise = module.runSingleAgent(ws, agents, "scout", "long-running", undefined, undefined, undefined, undefined,
    fakeChild(() => { /* never closes on its own; only the stop kills it */ }));
  const runningList = await pi.tools.get("subagent_stop").execute("stop-list", {}, undefined, undefined, { cwd: ws });
  assert.match(textOf(runningList), /Running subagents \(1\)/);
  const stopped = await pi.tools.get("subagent_stop").execute("stop-all", { all: true }, undefined, undefined, { cwd: ws });
  assert.match(textOf(stopped), /Stopped 1 live/);
  const stoppedResult = await runningPromise;
  assert.equal(stoppedResult.stopReason, "stopped");
  assert.match(module.getResultOutput(stoppedResult), /Stopped by operator/);

  // 8. commands are registered and /subagents reports a check-in
  assert.ok(pi.commands.has("subagents"), "subagents command must be registered");
  assert.ok(pi.commands.has("subagent-stop"), "subagent-stop command must be registered");
  const notices: string[] = [];
  await pi.commands.get("subagents").handler("", { cwd: ws, ui: { notify: (m: string) => notices.push(m) } });
  assert.ok(notices.some((n) => /subagents/.test(n) && /total/.test(n)), "/subagents must report a run summary");

  console.log("[subagent-observability-smoke] run logs, bounded messages, registry, subagent_status, subagent_stop and commands verified");
} finally {
  restoreIsolation();
  rmWorkspace(ws);
}
