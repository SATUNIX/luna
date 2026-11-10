#!/usr/bin/env node
// Inert Node fixture only: never starts Pi or evaluates task text as code.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { loadModule, fakePi, tmpWorkspace, rmWorkspace, setEnv, textOf } from "../packages/core/eval/harness.ts";
import { installDelegation } from "../packages/core/eval/delegation.ts";
import { array, object, parseJsonAs, string } from "../packages/core/lib/guard.ts";

interface AgentFixture {
  name: string;
  description: string;
  tools: string[];
  systemPrompt: string;
  source: string;
  filePath: string;
}

interface SubagentResult {
  exitCode: number;
  stopReason?: string;
  messages: Array<{ content: Array<{ text: string }> }>;
}

// Stand-in for the ChildProcess surface the runner touches.
interface FakeChild extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin?: PassThrough;
  killed: boolean;
  pid?: number;
  kill: (signal?: string) => boolean;
}

interface AbortSignalLike {
  aborted: boolean;
  addEventListener: (type: string) => void;
  removeEventListener: (type: string) => void;
}

type SpawnLike = (exe: string, args: string[], options: SpawnOptions) => ChildProcess | FakeChild;

interface SubagentModule {
  runSingleAgent(
    defaultCwd: string,
    agents: AgentFixture[],
    agentName: string,
    task: string,
    cwd: string | undefined,
    step: number | undefined,
    signal: AbortSignal | AbortSignalLike | undefined,
    onUpdate?: (text: string) => void,
    spawnChild?: SpawnLike,
  ): Promise<SubagentResult>;
  default(api: unknown): void;
}

interface SpawnLaunch {
  exe: string;
  args: string[];
  options: SpawnOptions;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Launches go through delegation-guard (mandatory protections + effort budget); fake children still need it in place.
const __delegation = await installDelegation();
process.on("exit", () => __delegation.cleanup());

const ws = tmpWorkspace("pi-kit-subagent-progress-");
try {
  const module = await loadModule<SubagentModule>("vendor/subagent/index.ts");
  const fixture = path.join(ws, "inert-child.mjs");
  // The inert child echoes its argv and the prompt it read from stdin (print mode merges piped
  // stdin into the prompt; the task travels there so it is never bounded by MAX_ARG_STRLEN).
  fs.writeFileSync(fixture, `let stdin = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", (d) => { stdin += d; }); process.stdin.on("end", () => { for (const text of ["working", JSON.stringify({ argv: process.argv.slice(2), stdin })]) console.log(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text}],stopReason:"end"}})); });`);
  const agents: AgentFixture[] = [{ name: "scout", description: "fixture", tools: ["read"], systemPrompt: "", source: "user", filePath: "fixture" }];
  const task = 'literal "quotes" & | %NAME% $(inert) `data`\nnext line';
  const updates: string[] = [];
  let launch: SpawnLaunch | undefined;
  const result = await module.runSingleAgent(ws, agents, "scout", task, undefined, undefined, undefined, text => updates.push(text), (exe: string, args: string[], options: SpawnOptions) => {
    launch = { exe, args, options };
    return spawn(exe, [fixture, ...args.slice(1)], options);
  });
  assert.equal(result.exitCode, 0);
  assert.ok(launch);
  assert.equal(launch.exe, process.execPath);
  assert.equal(launch.options.shell, false);
  const [entry] = launch.args;
  assert.ok(entry !== undefined, "the launch has an entry script");
  assert.match(entry, /cli\.js$/);
  const last = result.messages.at(-1);
  assert.ok(last);
  const [echo] = last.content;
  assert.ok(echo, "the child's last message has content");
  const echoed = parseJsonAs(object({ stdin: string(), argv: array(string()) }), echo.text);
  assert.equal(echoed.stdin, `Task: ${task}`, "the task reaches the child verbatim over stdin");
  assert.ok(!echoed.argv.some((a: string) => a.includes("literal")), "the task is never passed as an argv string");
  assert.ok(echoed.argv.includes("--no-extensions"), "children run with extension discovery disabled");
  assert.equal(updates.length, 2);
  // Kill-on-cancel is the default; pin it explicitly so these assertions never depend on the env.
  const restoreDetach = setEnv("PI_KIT_SUBAGENT_DETACH_SIGNAL", "0");
  try {
    const abort = new AbortController(); abort.abort();
    const pre = await module.runSingleAgent(ws, agents, "scout", "never launch", undefined, undefined, abort.signal, undefined, () => { throw new Error("must not spawn"); });
    assert.equal(pre.stopReason, "aborted");
    const during = new AbortController();
    const kills: Array<string | undefined> = [];
    const child = new EventEmitter() as FakeChild; child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.killed = false;
    child.kill = (signal?: string) => { kills.push(signal); child.killed = true; if (signal === "SIGKILL") queueMicrotask(() => child.emit("close", null)); return true; };
    const running = module.runSingleAgent(ws, agents, "scout", "cancel", undefined, undefined, during.signal, undefined, () => { queueMicrotask(() => during.abort()); return child; });
    const keepalive = setInterval(() => {}, 1000);
    try { assert.equal((await running).stopReason, "aborted"); } finally { clearInterval(keepalive); }
    assert.deepEqual(kills, ["SIGTERM", "SIGKILL"]);
  } finally { restoreDetach(); }
  // Detach-signal path is opt-in (PI_KIT_SUBAGENT_DETACH_SIGNAL=1); the runner must remove its
  // abort listener when the child finishes normally too, not only when abort fires (B-091).
  // A counting signal makes the leak, which an anonymous {once:true} listener hides, visible.
  const restoreDetachOn = setEnv("PI_KIT_SUBAGENT_DETACH_SIGNAL", "1");
  try {
    let added = 0;
    let removed = 0;
    const detachSignal: AbortSignalLike = {
      aborted: false,
      addEventListener: (type: string) => { if (type === "abort") added++; },
      removeEventListener: (type: string) => { if (type === "abort") removed++; },
    };
    const result = await module.runSingleAgent(ws, agents, "scout", "detach fixture", undefined, undefined, detachSignal, undefined, () => {
      const child = new EventEmitter() as FakeChild;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      child.killed = false;
      child.pid = 4242;
      child.kill = () => true;
      setTimeout(() => child.emit("close", 0), 5);
      return child;
    });
    assert.equal(result.exitCode, 0, "detach run completes normally");
    assert.equal(added, 1, "runner subscribes to the abort signal exactly once");
    assert.equal(removed, added, `abort listener leaked: added=${added} removed=${removed}`);
  } finally { restoreDetachOn(); }
  // N5: an idle watchdog that only counts bytes kills a child in the middle of a long tool call
  // (a build, a slow test run) that is working correctly. The child already streams
  // `tool_execution_start` / `tool_execution_end`, so the watchdog must pause for the life of
  // every open call — nested and parallel calls included — and rearm once the last one ends.
  const fakeIdleChild = () => {
    const child = new EventEmitter() as FakeChild;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = false;
    const kills: Array<string | undefined> = [];
    child.kill = (signal?: string) => { kills.push(signal); child.killed = true; queueMicrotask(() => child.emit("close", null)); return true; };
    return { child, kills };
  };
  const jsonLine = (payload: Record<string, unknown>) => JSON.stringify(payload) + "\n";
  const toolStart = (id: string) => jsonLine({ type: "tool_execution_start", toolCallId: id, toolName: "bash", args: {} });
  const toolEnd = (id: string) => jsonLine({ type: "tool_execution_end", toolCallId: id, toolName: "bash", isError: false });

  // A run whose limit never fires would hang the smoke instead of failing it; the race keeps a
  // ref'd timer on the loop and throws if the run does not settle.
  const settledWithin = <T>(run: Promise<T>, ms: number, label: string): Promise<T> =>
    Promise.race([run, sleep(ms).then(() => { throw new Error(`${label} did not settle within ${ms} ms`); })]);

  // (a) an open tool call, (b) nested calls, (c) a child with no tool event at all, (d) stderr
  // during an open call, (e) an id-less event and (f) a line that only quotes the event name: the
  // watchdog pauses for an open call, rearms after the last end, and still fires outside one.
  const restoreIdleShort = setEnv("PI_KIT_SUBAGENT_IDLE_TIMEOUT_MS", "200");
  const restoreRetries = setEnv("PI_KIT_SUBAGENT_RETRIES", "0");
  try {
    const paused = fakeIdleChild();
    const pausedRun = module.runSingleAgent(ws, agents, "scout", "tool pause", undefined, undefined, undefined, undefined, () => {
      paused.child.stdout.write(toolStart("t1"));
      return paused.child;
    });
    await sleep(600);
    assert.equal(paused.child.killed, false, "the idle watchdog must not kill a child whose tool is still running");
    paused.child.stdout.write(toolEnd("t1"));
    paused.child.emit("close", 0);
    const pausedResult = await pausedRun;
    assert.equal(pausedResult.exitCode, 0);
    assert.notEqual(pausedResult.stopReason, "timeout");

    const nested = fakeIdleChild();
    const nestedRun = module.runSingleAgent(ws, agents, "scout", "nested tools", undefined, undefined, undefined, undefined, () => {
      nested.child.stdout.write(toolStart("outer") + toolStart("inner"));
      return nested.child;
    });
    await sleep(600);
    assert.equal(nested.child.killed, false, "two open tool calls hold the watchdog");
    nested.child.stdout.write(toolEnd("inner"));
    await sleep(600);
    assert.equal(nested.child.killed, false, "one open tool call still holds the watchdog");
    nested.child.stdout.write(toolEnd("outer"));
    assert.equal((await settledWithin(nestedRun, 3000, "idle timeout")).stopReason, "timeout", "silence outside any tool call is still a stall");
    assert.ok(nested.kills.includes("SIGTERM"));

    const silent = fakeIdleChild();
    const silentRun = module.runSingleAgent(ws, agents, "scout", "no tool event", undefined, undefined, undefined, undefined, () => silent.child);
    assert.equal((await settledWithin(silentRun, 3000, "idle timeout")).stopReason, "timeout", "a child that never emits anything is still a stall");

    // The cases above use six of the eight scouts one request allows (the ceiling itself, so it
    // cannot be raised here), so the rest start a fresh request scope.
    await __delegation.newTurn();

    // (d) stderr rearms the watchdog on its own path; a warning printed while a tool is open must
    // not restart it either.
    const stderrChild = fakeIdleChild();
    const stderrRun = module.runSingleAgent(ws, agents, "scout", "stderr during tool", undefined, undefined, undefined, undefined, () => {
      stderrChild.child.stdout.write(toolStart("t1"));
      return stderrChild.child;
    });
    await sleep(150);
    stderrChild.child.stderr.write("warn\n");
    await sleep(600);
    assert.equal(stderrChild.child.killed, false, "stderr during an open tool call must not rearm the idle watchdog");
    stderrChild.child.stdout.write(toolEnd("t1"));
    stderrChild.child.emit("close", 0);
    assert.equal((await stderrRun).exitCode, 0);

    // (e) an event with no id falls back to a count: it holds the watchdog, and its matching end
    // releases it.
    const unnamed = fakeIdleChild();
    const unnamedRun = module.runSingleAgent(ws, agents, "scout", "unnamed tool", undefined, undefined, undefined, undefined, () => {
      unnamed.child.stdout.write(jsonLine({ type: "tool_execution_start" }));
      return unnamed.child;
    });
    await sleep(600);
    assert.equal(unnamed.child.killed, false, "an id-less tool call still holds the watchdog");
    unnamed.child.stdout.write(jsonLine({ type: "tool_execution_end" }));
    assert.equal((await settledWithin(unnamedRun, 3000, "idle timeout")).stopReason, "timeout", "the matching id-less end re-arms the watchdog");

    // (f) only a top-level `type` of exactly the event name counts: a message that merely carries
    // the string, or a bare JSON string, must not close an open call.
    const lookalike = fakeIdleChild();
    const lookalikeRun = module.runSingleAgent(ws, agents, "scout", "lookalike line", undefined, undefined, undefined, undefined, () => {
      lookalike.child.stdout.write(toolStart("t1"));
      return lookalike.child;
    });
    await sleep(50);
    lookalike.child.stdout.write(jsonLine({ type: "message_end", toolCallId: "t1", text: "tool_execution_end", note: { x: "tool_execution_end" } }));
    lookalike.child.stdout.write(JSON.stringify("tool_execution_end") + "\n");
    await sleep(600);
    assert.equal(lookalike.child.killed, false, "a line that only quotes the event name must not close an open call");
    lookalike.child.stdout.write(toolEnd("t1"));
    lookalike.child.emit("close", 0);
    assert.equal((await lookalikeRun).exitCode, 0);

    await __delegation.newTurn();

    // (f2) a blank id is no id: pi could send it for parallel calls, and one Set entry would let the
    // first end rearm the watchdog while the second call still runs. Blank and missing ids are one
    // counted key, so two starts need two ends.
    const blank = fakeIdleChild();
    const blankRun = module.runSingleAgent(ws, agents, "scout", "blank ids", undefined, undefined, undefined, undefined, () => {
      blank.child.stdout.write(jsonLine({ type: "tool_execution_start", toolCallId: "" }) + jsonLine({ type: "tool_execution_start", toolCallId: "" }));
      return blank.child;
    });
    await sleep(50);
    blank.child.stdout.write(jsonLine({ type: "tool_execution_end", toolCallId: "" }));
    await sleep(600);
    assert.equal(blank.child.killed, false, "a second call with a blank id still holds the watchdog after the first ends");
    // A missing id is the same key, so it closes the second call.
    blank.child.stdout.write(jsonLine({ type: "tool_execution_end" }));
    assert.equal((await settledWithin(blankRun, 3000, "idle timeout")).stopReason, "timeout", "the last end rearms the watchdog");
  } finally {
    restoreIdleShort();
    restoreRetries();
  }

  // (f3) a limit above 2^31-1 ms must not overflow setTimeout, which would fire at once.
  for (const [name, off] of [["PI_KIT_SUBAGENT_IDLE_TIMEOUT_MS", "PI_KIT_SUBAGENT_MAX_RUNTIME_MS"], ["PI_KIT_SUBAGENT_MAX_RUNTIME_MS", "PI_KIT_SUBAGENT_IDLE_TIMEOUT_MS"]] as const) {
    await __delegation.newTurn();
    const restoreHuge = setEnv(name, "3000000000");
    const restoreOff = setEnv(off, "0");
    const restoreRetriesHuge = setEnv("PI_KIT_SUBAGENT_RETRIES", "0");
    try {
      const huge = fakeIdleChild();
      const hugeRun = module.runSingleAgent(ws, agents, "scout", "huge limit", undefined, undefined, undefined, undefined, () => huge.child);
      await sleep(150);
      assert.equal(huge.child.killed, false, `${name} above the timer limit must not fire at once`);
      huge.child.emit("close", 0);
      await hugeRun;
    } finally {
      restoreHuge();
      restoreOff();
      restoreRetriesHuge();
    }
  }

  // (g) the wall-clock ceiling is independent of tool activity.
  const restoreIdleOff = setEnv("PI_KIT_SUBAGENT_IDLE_TIMEOUT_MS", "0");
  const restoreWallShort = setEnv("PI_KIT_SUBAGENT_MAX_RUNTIME_MS", "200");
  const restoreRetriesB = setEnv("PI_KIT_SUBAGENT_RETRIES", "0");
  try {
    const walled = fakeIdleChild();
    const walledRun = module.runSingleAgent(ws, agents, "scout", "wall during tool", undefined, undefined, undefined, undefined, () => {
      walled.child.stdout.write(toolStart("t1"));
      return walled.child;
    });
    assert.equal((await settledWithin(walledRun, 3000, "wall-clock kill")).stopReason, "wall-clock");
  } finally {
    restoreIdleOff();
    restoreWallShort();
    restoreRetriesB();
  }

  // (h) tracking the tool stream must not let an unterminated line past the stream cap.
  const restoreCap = setEnv("PI_KIT_SUBAGENT_STREAM_CAP_BYTES", String(64 * 1024));
  const restoreIdleLong = setEnv("PI_KIT_SUBAGENT_IDLE_TIMEOUT_MS", "60000");
  const restoreWallOff = setEnv("PI_KIT_SUBAGENT_MAX_RUNTIME_MS", "0");
  const restoreRetriesC = setEnv("PI_KIT_SUBAGENT_RETRIES", "0");
  try {
    const capped = fakeIdleChild();
    const cappedRun = module.runSingleAgent(ws, agents, "scout", "line cap", undefined, undefined, undefined, undefined, () => {
      capped.child.stdout.write(toolStart("t1") + "x".repeat(70 * 1024));
      return capped.child;
    });
    assert.equal((await settledWithin(cappedRun, 3000, "stream-cap kill")).stopReason, "stream-cap");
  } finally {
    restoreCap();
    restoreIdleLong();
    restoreWallOff();
    restoreRetriesC();
  }
  fs.mkdirSync(path.join(ws, ".pi", "agents"), { recursive: true });
  fs.writeFileSync(path.join(ws, ".pi", "agents", "scout.md"), "---\nname: scout\ndescription: fixture\ntools: read\n---\nscout\n");
  const pi = fakePi(); module.default(pi.api);
  for (const hasUI of [false, true]) {
    let prompted = 0;
    const blocked = await pi.tools.get("subagent").execute("trust", { agent: "scout", task: "fixture", agentScope: "project", confirmProjectAgents: false }, undefined, undefined, { cwd: ws, hasUI, ui: { confirm: async () => { prompted++; return false; } } });
    assert.match(textOf(blocked), /Blocked|Canceled/);
    assert.equal(prompted, hasUI ? 1 : 0);
  }
  console.log("[subagent-progress-smoke] argv fidelity, streaming, pre-abort, escalation and trust checks passed");
} finally { rmWorkspace(ws); }
