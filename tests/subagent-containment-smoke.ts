#!/usr/bin/env node
// Inert Node fixture only: never starts Pi or evaluates task text as code.
//
// Pins the subagent child-containment contract that a slow/exploration-heavy server depends on:
//   1. A stream-cap kill reports a distinct, honest failure — NOT the "aborted" reason that a
//      genuine operator abort uses. Before this fix a file-reading planner that streamed past the
//      cap was reported identically to a user pressing abort, which read as a mysterious
//      "Subagent was aborted".
//   2. An idle-timeout kill (opt-in via env) reports its own honest reason.
//   3. A genuine signal abort still reports stopReason "aborted".
//   4. PI_KIT_SUBAGENT_STREAM_CAP_BYTES raises the cap so more output survives.
//   5. A stream-cap kill that happens AFTER the child already streamed a real answer surfaces
//      that answer (with a truncation note) instead of discarding it behind the bare error —
//      the old behavior threw away completed work whenever the cap fired.
//   6. stdout and stderr are budgeted independently: a chatty stderr alone can't burn through
//      the cap meant for the real stdout protocol stream, and vice versa.
//   7. A wall-clock ceiling kills a child that keeps dribbling output (which defeats the
//      idle watchdog) — the backstop against a subagent that never finishes.
//   8. Detach is real: on parent cancel the call RETURNS immediately with stopReason
//      "detached" while the child keeps running in the background (previously the parent
//      still awaited the open child, so control never came back).
//   9. tool_execution_start/end (what current pi actually emits) produce live parent updates
//      naming the tool and target — the fix for a silently frozen tool call during a long
//      child tool.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { loadModule, tmpWorkspace, rmWorkspace, setEnv } from "../packages/core/eval/harness.ts";
import { installDelegation } from "../packages/core/eval/delegation.ts";
import type { SingleResult } from "../packages/extensions/third_party/subagent/types.ts";
import type { AgentConfig } from "../packages/extensions/third_party/subagent/agents.ts";
import type { RunAgentOptions } from "../packages/extensions/third_party/subagent/runner.ts";
import type * as ChildProcessModule from "../packages/extensions/third_party/subagent/child-process.ts";
import type * as ResultModule from "../packages/extensions/third_party/subagent/result.ts";

// The slice of a ChildProcess the subagent runner touches; the fixtures below fake only this.
interface FakeChild extends EventEmitter {
  stdin?: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  killed: boolean;
  kill: () => boolean;
}

// A spawner that hands the runner a FakeChild instead of a real ChildProcess.
type FakeSpawn = (cmd: string, args: string[]) => FakeChild;

/** The subagent runner as these tests drive it: every spawner is a FakeSpawn. */
interface SubagentView {
  runSingleAgent(defaultCwd: string, agents: AgentConfig[], agentName: string, task: string, cwd: string | undefined, step: number | undefined, signal: AbortSignal | undefined, onUpdate: (text: string) => void, spawnChild: FakeSpawn): Promise<SingleResult>;
  runAgent(options: Omit<RunAgentOptions, "spawnChild"> & { spawnChild: FakeSpawn }): Promise<SingleResult>;
  getResultOutput: typeof ResultModule.getResultOutput;
}

// Launches go through delegation-guard (mandatory protections + effort budget); fake children still need it in place.
const __delegation = await installDelegation();
process.on("exit", () => __delegation.cleanup());

const ws = tmpWorkspace("pi-kit-subagent-containment-");
try {
  const module = await loadModule<SubagentView>("vendor/subagent/index.ts");
  const agents: AgentConfig[] = [{ name: "planner", description: "fixture", tools: ["read"], systemPrompt: "", source: "user", filePath: "fixture" }];

  // Build a fake child that emits `bytes` on stdout then never exits on its own, so the only
  // way the run resolves is a parent-side kill. SIGTERM/SIGKILL both close it (the real child
  // dies on SIGTERM; the escalation path is exercised separately by subagent-progress-smoke).
  function fakeChild(onSpawn: (child: FakeChild) => void): () => FakeChild {
    const child = new EventEmitter() as FakeChild;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = false;
    child.kill = () => { child.killed = true; queueMicrotask(() => child.emit("close", null)); return true; };
    return () => { queueMicrotask(() => onSpawn(child)); return child; };
  }

  async function run(task: string, signal: AbortSignal | undefined, spawnFn: FakeSpawn): Promise<SingleResult> {
    const keepalive = setInterval(() => {}, 1000);
    try {
      return await module.runSingleAgent(ws, agents, "planner", task, undefined, undefined, signal, () => {}, spawnFn);
    } finally {
      clearInterval(keepalive);
    }
  }

  // 0. Prompt integrity: the child must be launched with the task as its prompt argument.
  //    A field failure launched the child with the resolved cli.js path as its first user
  //    message, so it had no instructions and asked the operator an unrelated question.
  {
    let seenArgs: string[] = [];
    let seenStdin = "";
    const spawn = (_cmd: string, args: string[]): FakeChild => {
      seenArgs = args;
      const child = new EventEmitter() as FakeChild;
      const stdin = new PassThrough();
      child.stdin = stdin;
      stdin.setEncoding("utf8");
      stdin.on("data", (d: string) => { seenStdin += d; });
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.killed = false;
      child.kill = () => { child.killed = true; queueMicrotask(() => child.emit("close", null)); return true; };
      queueMicrotask(() => {
        child.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "end" } }) + "\n");
        child.emit("close", 0);
      });
      return child;
    };
    const task = "PROMPT-INTEGRITY-MARKER do nothing";
    await run(task, undefined, spawn);
    // The prompt travels over stdin (merged into the prompt by print mode) so a large chained
    // task can never hit the 128 KiB single-argument limit.
    assert.equal(seenStdin, `Task: ${task}`, "child must receive the task as its prompt (stdin)");
    assert.ok(!seenArgs.some((a) => typeof a === "string" && a.includes("PROMPT-INTEGRITY-MARKER")), "the task must not be passed in argv");

    // 0b. Compiled-binary host: `pi` can be a standalone bun-compiled binary, in which case
    //     `process.execPath` IS pi — not a JS runtime needing a script argument. Passing the
    //     resolved cli.js path then makes pi parse it as the first user prompt (WU-15). The
    //     argv builder must therefore only prepend the script for a real JS runtime.
    const { piChildArgv } = await loadModule<typeof ChildProcessModule>("vendor/subagent/child-process.ts");
    const cli = "/opt/pi/node_modules/@earendil-works/pi-coding-agent/dist/cli.js";
    const childArgs = ["--mode", "json", "-p", "--no-session", "Task: hi"];
    assert.deepEqual(piChildArgv(cli, childArgs, "/usr/local/bin/pi"), childArgs, "compiled pi host must not receive a cli.js script argument");
    assert.deepEqual(piChildArgv(cli, childArgs, "/usr/bin/node"), [cli, ...childArgs], "node host must receive the cli.js script argument");
    assert.deepEqual(piChildArgv(cli, childArgs, "/usr/bin/bun"), [cli, ...childArgs], "bun host must receive the cli.js script argument");
    assert.deepEqual(piChildArgv(cli, childArgs, "C:\\Program Files\\nodejs\\node.exe"), [cli, ...childArgs], "node.exe host must receive the cli.js script argument");
  }

  // 0c. Failure classification: a budget/watchdog kill must never be auto-retried. `wall-clock`
  //     previously fell through to the generic tail, so a silent kill was `transient` and the
  //     runner re-ran the task the ceiling had just stopped, contradicting SOURCE.md.
  {
    const { isFailedResult, classifyFailure } = await loadModule<typeof ResultModule>("vendor/subagent/result.ts");
    const mk = (over: Partial<SingleResult>): SingleResult => ({ agent: "planner", task: "t", exitCode: 0, messages: [], stderr: "", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 }, ...over });
    assert.equal(isFailedResult(mk({ stopReason: "wall-clock" })), true, "wall-clock must count as a failed result");
    assert.equal(classifyFailure(mk({ stopReason: "wall-clock" })), "limit", "a silent wall-clock kill is a limit");
    assert.equal(classifyFailure(mk({ stopReason: "wall-clock", finalOutput: "partial" })), "fatal", "a wall-clock kill that produced output is fatal");
    for (const reason of ["timeout", "stream-cap", "wall-clock"]) {
      assert.notEqual(classifyFailure(mk({ stopReason: reason })), "transient", `${reason} must never be auto-retried`);
    }
  }

  // 1. Stream cap: set the cap to its 64 KiB floor and stream past it. (Values below the
  // floor are clamped up, so the test writes more than the floor, not less than 1 KiB.)
  {
    const cap = 64 * 1024;
    const restore = setEnv("PI_KIT_SUBAGENT_STREAM_CAP_BYTES", String(cap));
    try {
      const r = await run("cap", undefined, fakeChild((c) => c.stdout.write("x".repeat(cap * 2))));
      assert.equal(r.stopReason, "stream-cap", "stream-cap kill must report its own honest reason");
      assert.notEqual(r.stopReason, "aborted", "stream-cap kill must not be reported as aborted");
      assert.notEqual(r.stopReason, "error", "stream-cap kill must be distinguishable from a generic error");
      assert.match(r.errorMessage ?? "", new RegExp(`output exceeded ${cap} bytes`));
      assert.match(r.errorMessage ?? "", /PI_KIT_SUBAGENT_STREAM_CAP_BYTES/);
      assert.notEqual(r.errorMessage, "Subagent was aborted");
    } finally { restore(); }
  }

  // 2. Raising the cap lets the same output through (no kill): child then closes cleanly.
  {
    const restore = setEnv("PI_KIT_SUBAGENT_STREAM_CAP_BYTES", String(1024 * 1024));
    try {
      const r = await run("under-cap", undefined, fakeChild((c) => {
        c.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "end" } }) + "\n");
        c.stdout.write("y".repeat(4096));
        c.emit("close", 0);
      }));
      assert.notEqual(r.stopReason, "error", "under-cap run must not be killed by the cap");
      assert.notEqual(r.stopReason, "aborted", "under-cap run must not be aborted");
      assert.equal(r.exitCode, 0);
    } finally { restore(); }
  }

  // 3. Idle timeout: opt in with a short window and a child that emits nothing.
  {
    const restore = setEnv("PI_KIT_SUBAGENT_IDLE_TIMEOUT_MS", "50");
    try {
      const r = await run("idle", undefined, fakeChild(() => { /* silent child, no output */ }));
      assert.equal(r.stopReason, "timeout", "idle-timeout kill must report its own honest reason");
      assert.notEqual(r.stopReason, "aborted", "idle-timeout kill must not be reported as aborted");
      assert.match(r.errorMessage ?? "", /no output for 50 ms/);
      assert.match(r.errorMessage ?? "", /PI_KIT_SUBAGENT_IDLE_TIMEOUT_MS/);
    } finally { restore(); }
  }

  // 4. Genuine signal abort still reads as "aborted" when kill-on-cancel is opted back in.
  {
    const restore = setEnv("PI_KIT_SUBAGENT_DETACH_SIGNAL", "0");
    try {
      const ac = new AbortController();
      const r = await run("abort", ac.signal, fakeChild(() => queueMicrotask(() => ac.abort())));
      assert.equal(r.stopReason, "aborted");
      assert.equal(r.errorMessage, "Subagent was aborted");
    } finally { restore(); }
  }

  // 5. A stream-cap kill after a real answer already streamed must surface that answer, not
  // just the error — the old code discarded it behind `result.errorMessage`.
  {
    const cap = 64 * 1024;
    const restore = setEnv("PI_KIT_SUBAGENT_STREAM_CAP_BYTES", String(cap));
    try {
      const r = await run("cap-with-answer", undefined, fakeChild((c) => {
        c.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "the real answer" }], stopReason: "end" } }) + "\n");
        c.stdout.write("x".repeat(cap * 2));
      }));
      assert.equal(r.stopReason, "stream-cap");
      const output = module.getResultOutput(r);
      assert.match(output, /the real answer/, "partial answer must survive a stream-cap kill");
      assert.match(output, new RegExp(`output exceeded ${cap} bytes`), "truncation must still be noted");
    } finally { restore(); }
  }

  // 6. stdout and stderr are budgeted independently: half-cap on each must not sum to a kill.
  {
    const cap = 64 * 1024;
    const restore = setEnv("PI_KIT_SUBAGENT_STREAM_CAP_BYTES", String(cap));
    try {
      const r = await run("split-streams", undefined, fakeChild((c) => {
        c.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "fine" }], stopReason: "end" } }) + "\n");
        c.stdout.write("x".repeat(cap * 0.6));
        c.stderr.write("y".repeat(cap * 0.6));
        c.emit("close", 0);
      }));
      assert.notEqual(r.stopReason, "stream-cap", "stdout and stderr each under cap must not combine into a kill");
      assert.equal(r.exitCode, 0);
    } finally { restore(); }
  }

  // 7. Wall-clock ceiling: a silent child overrides the idle watchdog only if the idle window
  // is long; here the wall-clock cap is the only bound and must fire.
  {
    const restore = setEnv("PI_KIT_SUBAGENT_MAX_RUNTIME_MS", "80");
    try {
      const r = await run("wall-clock", undefined, fakeChild(() => { /* silent child, no output */ }));
      assert.equal(r.stopReason, "wall-clock", "wall-clock kill must report its own honest reason");
      assert.notEqual(r.stopReason, "aborted");
      assert.match(r.errorMessage ?? "", /wall-clock limit/);
      assert.match(r.errorMessage ?? "", /PI_KIT_SUBAGENT_MAX_RUNTIME_MS/);
    } finally { restore(); }
  }

  // 8. Opt-in detach must actually return control: abort the parent signal while the child is
  // still open and assert the call resolves promptly as "detached" (not hung awaiting the child).
  {
    const restore = setEnv("PI_KIT_SUBAGENT_DETACH_SIGNAL", "1");
    try {
      const ac = new AbortController();
      const settled = await Promise.race([
        run("detach", ac.signal, fakeChild(() => queueMicrotask(() => ac.abort()))),
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("detach did not return control")), 2000)),
      ]);
      assert.equal(settled.stopReason, "detached", "a detached cancel must return stopReason 'detached'");
      assert.equal(settled.detached, true);
      assert.ok(settled.runId, "a detached result must carry its run id so the operator can follow it");
    } finally { restore(); }
  }

  // 8b. background: true returns immediately while the child keeps running; onSettled later
  // reports the real outcome with detached=true.
  {
    let child: FakeChild | undefined;
    let settledWith: { res: SingleResult; detached: boolean } | undefined;
    const r = await module.runAgent({
      defaultCwd: ws, agents, agentName: "planner", task: "bg", background: true,
      onSettled: (res: SingleResult, detached: boolean) => { settledWith = { res, detached }; },
      spawnChild: fakeChild((c) => { child = c; }),
    });
    assert.equal(r.detached, true, "background returns a detached result without waiting");
    // Copied to an unknown binding so the assertion does not narrow settledWith for the later checks (onSettled assigns it).
    const settledSoFar: unknown = settledWith;
    assert.equal(settledSoFar, undefined, "the child has not finished yet");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(child, "the background child must have been spawned");
    child.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "bg-done" }], stopReason: "end" } }) + "\n");
    child.emit("close", 0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(settledWith?.detached, true);
    assert.equal(settledWith?.res.finalOutput, "bg-done");
  }

  // 9. Current pi emits tool_execution_start/end; each must yield a live parent update naming
  // the tool and target, and the update must carry the run id for correlation.
  {
    const updates: string[] = [];
    const keepalive = setInterval(() => {}, 1000);
    try {
      const r = await module.runSingleAgent(ws, agents, "planner", "tools", undefined, undefined, undefined, (t: string) => updates.push(t), fakeChild((c) => {
        c.stdout.write(JSON.stringify({ type: "tool_execution_start", toolName: "read", args: { path: "src/app.ts" } }) + "\n");
        c.stdout.write(JSON.stringify({ type: "tool_execution_end", toolName: "read" }) + "\n");
        c.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "end" } }) + "\n");
        c.emit("close", 0);
      }));
      assert.equal(r.exitCode, 0);
      assert.ok(updates.some((u) => /running read/.test(u) && /src\/app\.ts/.test(u)), `tool_execution_start must produce a live update naming tool+target; got ${JSON.stringify(updates)}`);
      assert.ok(updates.some((u) => /finished read/.test(u)), "tool_execution_end must produce a live update");
      assert.ok(updates.some((u) => /run \S+/.test(u)), "at least one update must carry the run id");
    } finally { clearInterval(keepalive); }
  }

  console.log("[subagent-containment-smoke] stream-cap, cap-raise, idle-timeout, partial-output, split-stream, wall-clock, detach-returns and tool_execution updates verified");
} finally {
  rmWorkspace(ws);
}
