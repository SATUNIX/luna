#!/usr/bin/env node
/**
 * H-06 regression coverage (partial): the recovery report must be grounded in real
 * recorded action history, not a 100%-blank template. Fully offline — no live pi.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadExtension, loadModule, fakePi, tmpWorkspace, rmWorkspace } from "../packages/core/eval/harness.ts";

async function testReportIncludesRealTraceData() {
  const ws = tmpWorkspace("pi-kit-recovery-ground-");
  try {
    fs.mkdirSync(path.join(ws, ".pi"), { recursive: true });
    const lines = [
      JSON.stringify({ kind: "call", tool: "read", target: "src/app.ts", status: undefined }),
      JSON.stringify({ kind: "result", tool: "read", target: "src/app.ts", status: "ok" }),
      JSON.stringify({ kind: "call", tool: "grep", target: "TODO", status: undefined }),
      JSON.stringify({ kind: "result", tool: "grep", target: "TODO", status: "error" }),
      JSON.stringify({ kind: "call", tool: "read", target: "src/app.ts", status: undefined }),
      JSON.stringify({ kind: "result", tool: "read", target: "src/app.ts", status: "ok" }),
    ];
    fs.writeFileSync(path.join(ws, ".pi", "trace.jsonl"), lines.join("\n") + "\n");

    const register = await loadExtension("extensions/recovery-orchestrator/index.ts");
    const pi = fakePi();
    register(pi.api);
    await pi.handlers.get("session_start")({}, { cwd: ws, ui: { notify() {} } });
    fs.mkdirSync(path.join(ws, ".pi", "recovery"), { recursive: true });
    fs.writeFileSync(
      path.join(ws, ".pi", "recovery", "escalation.json"),
      JSON.stringify({ signature: "repeat:xyz", reason: "repeated action", count: 3, at: new Date().toISOString() }),
    );
    await pi.handlers.get("turn_end")({}, { cwd: ws, ui: { notify() {} } });

    const reports = fs.readdirSync(path.join(ws, ".pi", "recovery")).filter((f) => f.endsWith(".md"));
    assert.equal(reports.length, 1, "recovery must write exactly one report");
    const [reportName] = reports;
    assert.ok(reportName !== undefined, "recovery must write exactly one report");
    const report = fs.readFileSync(path.join(ws, ".pi", "recovery", reportName), "utf8");

    assert.match(report, /Recorded action history \(real, from trace-ledger/, "report must have a real-data grounding section");
    assert.match(report, /read \(2×\)/, "report must reflect the actual tool-call counts from trace.jsonl");
    assert.match(report, /1 result\(s\) recorded as error/, "report must reflect the actual error count from trace.jsonl");
    assert.doesNotMatch(report, /- scout 1: fill/i, "must not fabricate scout findings that never ran");
  } finally {
    rmWorkspace(ws);
  }
}

// REL-11: trace lines are read through a field guard, so a non-string tool or target (a foreign
// or corrupt writer) is dropped instead of reaching the report as "[object Object]" or a number.
async function testReportDropsMistypedTraceFields() {
  const ws = tmpWorkspace("pi-kit-recovery-typed-");
  try {
    fs.mkdirSync(path.join(ws, ".pi", "recovery"), { recursive: true });
    const lines = [
      JSON.stringify({ kind: "call", tool: { name: "read" }, target: "src/a.ts" }),
      JSON.stringify({ kind: "call", tool: 7, target: "src/b.ts" }),
      JSON.stringify({ kind: "call", tool: "read", target: { path: "src/c.ts" } }),
      JSON.stringify({ kind: "call", tool: "read", target: "src/d.ts" }),
    ];
    fs.writeFileSync(path.join(ws, ".pi", "trace.jsonl"), lines.join("\n") + "\n");
    const register = await loadExtension("extensions/recovery-orchestrator/index.ts");
    const pi = fakePi();
    register(pi.api);
    await pi.handlers.get("session_start")({}, { cwd: ws, ui: { notify() {} } });
    fs.writeFileSync(
      path.join(ws, ".pi", "recovery", "escalation.json"),
      JSON.stringify({ signature: "repeat:typed", reason: "repeated action", count: 3, at: new Date().toISOString() }),
    );
    await pi.handlers.get("turn_end")({}, { cwd: ws, ui: { notify() {} } });
    const [reportName] = fs.readdirSync(path.join(ws, ".pi", "recovery")).filter((f) => f.endsWith(".md"));
    assert.ok(reportName !== undefined, "recovery must write a report");
    const report = fs.readFileSync(path.join(ws, ".pi", "recovery", reportName), "utf8");
    assert.doesNotMatch(report, /\[object Object\]/, "an object tool or target must not reach the report");
    assert.match(report, /- 2 tool calls in the trace window/, "only the calls with a string tool count");
    assert.match(report, /Most-called tools: read \(2×\)\./, "a numeric tool is not counted as a tool name");
  } finally {
    rmWorkspace(ws);
  }
}

async function testReportHandlesMissingTraceGracefully() {
  const ws = tmpWorkspace("pi-kit-recovery-notrace-");
  try {
    const register = await loadExtension("extensions/recovery-orchestrator/index.ts");
    const pi = fakePi();
    register(pi.api);
    await pi.handlers.get("session_start")({}, { cwd: ws, ui: { notify() {} } });
    fs.mkdirSync(path.join(ws, ".pi", "recovery"), { recursive: true });
    fs.writeFileSync(
      path.join(ws, ".pi", "recovery", "escalation.json"),
      JSON.stringify({ signature: "stall", reason: "read stall", count: 2, at: new Date().toISOString() }),
    );
    await pi.handlers.get("turn_end")({}, { cwd: ws, ui: { notify() {} } });

    const reports = fs.readdirSync(path.join(ws, ".pi", "recovery")).filter((f) => f.endsWith(".md"));
    const [reportName] = reports;
    assert.ok(reportName !== undefined, "recovery must write a report");
    const report = fs.readFileSync(path.join(ws, ".pi", "recovery", reportName), "utf8");
    assert.match(report, /no trace-ledger data available/, "must degrade gracefully with no trace.jsonl present");
  } finally {
    rmWorkspace(ws);
  }
}


function writeEscalation(ws: string, signature: string): void {
  fs.mkdirSync(path.join(ws, ".pi", "recovery"), { recursive: true });
  fs.writeFileSync(
    path.join(ws, ".pi", "recovery", "escalation.json"),
    JSON.stringify({ signature, reason: "read stall", count: 2, at: new Date().toISOString() }),
  );
}

function readSteer(ws: string): string {
  const raw: unknown = JSON.parse(fs.readFileSync(path.join(ws, ".pi", "ctx-contributions", "recovery-orchestrator.json"), "utf8"));
  assert.ok(typeof raw === "object" && raw !== null && "content" in raw && typeof raw.content === "string", "contribution must carry string content");
  return raw.content;
}

// REL-3: separate stall episodes, each resolved by a successful write, must not add up to the cap.
async function testProgressResetsAttemptCap() {
  const ws = tmpWorkspace("pi-kit-recovery-cap-");
  try {
    const register = await loadExtension("extensions/recovery-orchestrator/index.ts");
    const pi = fakePi();
    register(pi.api);
    const ctx = { cwd: ws, ui: { notify() {}, setStatus() {} } };
    await pi.handlers.get("session_start")({}, ctx);
    for (let episode = 1; episode <= 3; episode++) {
      writeEscalation(ws, "stall");
      await pi.handlers.get("turn_end")({}, ctx);
      const steer = readSteer(ws);
      assert.match(steer, /attempt 1\//, `episode ${episode} must enter recovery as attempt 1, got: ${steer.split("\n")[0]}`);
      assert.doesNotMatch(steer, /give up gracefully/, `episode ${episode} must not hit the cap`);
      await pi.handlers.get("tool_result")({ toolName: "write", isError: false, input: { path: "src/fix.ts" } }, ctx);
    }
    const recoveryFiles = fs.readdirSync(path.join(ws, ".pi", "recovery"));
    assert.equal(recoveryFiles.filter((f) => f.startsWith("blocked-")).length, 0, "no blocked disposition after resolved episodes");
    // Each episode restarts at attempt 1 but gets its own report, never a previous episode's.
    assert.deepEqual(recoveryFiles.filter((f) => f.endsWith("-stall.md")).sort(), ["1-stall.md", "2-stall.md", "3-stall.md"], "one fresh report per episode");

    // A failed write is not progress: within one episode the cap still applies.
    writeEscalation(ws, "stall");
    await pi.handlers.get("turn_end")({}, ctx);
    await pi.handlers.get("tool_result")({ toolName: "write", isError: true }, ctx);
    await pi.handlers.get("tool_result")({ toolName: "read", isError: false }, ctx);
    writeEscalation(ws, "stall");
    await pi.handlers.get("turn_end")({}, ctx);
    assert.match(readSteer(ws), /attempt 2\//, "a second escalation without progress is attempt 2");
    writeEscalation(ws, "stall");
    await pi.handlers.get("turn_end")({}, ctx);
    assert.match(readSteer(ws), /give up gracefully/, "the third escalation without progress hits the cap");
  } finally {
    rmWorkspace(ws);
  }
}

// REL-3: the steer asks the model to fill in the recovery report; writes under .pi/ (that
// report) and writes naming no path are not progress, so the cap is still reached.
async function testRecoveryBookkeepingDoesNotResetCap() {
  const ws = tmpWorkspace("pi-kit-recovery-cap-report-");
  try {
    const register = await loadExtension("extensions/recovery-orchestrator/index.ts");
    const pi = fakePi();
    register(pi.api);
    const ctx = { cwd: ws, ui: { notify() {}, setStatus() {} } };
    await pi.handlers.get("session_start")({}, ctx);
    const seen: string[] = [];
    for (let round = 1; round <= 3; round++) {
      writeEscalation(ws, "stall");
      await pi.handlers.get("turn_end")({}, ctx);
      const steer = readSteer(ws);
      seen.push(/give up gracefully/.test(steer) ? "cap" : (steer.match(/attempt \d+\//)?.[0] ?? "?"));
      const report = steer.match(/recovery report at `([^`]+)`/)?.[1];
      await pi.handlers.get("tool_result")({ toolName: "edit", isError: false, input: { path: report ?? ".pi/recovery/1-stall.md" } }, ctx);
      await pi.handlers.get("tool_result")({ toolName: "write", isError: false, input: { file_path: path.join(ws, ".pi", "notes.md") } }, ctx);
      await pi.handlers.get("tool_result")({ toolName: "write", isError: false }, ctx);
    }
    assert.deepEqual(seen, ["attempt 1/", "attempt 2/", "cap"], "report-only writes must not reset the attempt count");
    assert.equal(fs.readdirSync(path.join(ws, ".pi", "recovery")).filter((f) => f.startsWith("blocked-")).length, 1, "the cap emits a blocked disposition");
  } finally {
    rmWorkspace(ws);
  }
}

// REL-4: the steer is read by the model, which can only call tools; it must not ask for
// operator-only slash commands, and every tool it names must be one the kit registers.
async function testSteerNamesOnlyModelCallableActions() {
  const ws = tmpWorkspace("pi-kit-recovery-steer-");
  try {
    const register = await loadExtension("extensions/recovery-orchestrator/index.ts");
    const pi = fakePi();
    register(pi.api);
    const ctx = { cwd: ws, ui: { notify() {} } };
    await pi.handlers.get("session_start")({}, ctx);
    writeEscalation(ws, "stall");
    await pi.handlers.get("turn_end")({}, ctx);
    const steer = readSteer(ws);
    assert.doesNotMatch(steer, /`\/[a-z]/, "the steer must not name a slash command");
    assert.doesNotMatch(steer, /\/fork|\/verify/, "the steer must not ask for /fork or /verify");
    const registered = new Set<string>();
    for (const rel of ["packages/extensions/src", "packages/extensions/third_party"]) {
      for (const dir of fs.readdirSync(rel)) {
        const file = path.join(rel, dir, "extension.json");
        if (!fs.existsSync(file)) continue;
        const manifest: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
        const tools = typeof manifest === "object" && manifest !== null && "registers" in manifest && typeof manifest.registers === "object" && manifest.registers !== null && "tools" in manifest.registers ? manifest.registers.tools : [];
        if (Array.isArray(tools)) for (const t of tools) if (typeof t === "string") registered.add(t);
      }
    }
    const named = [...steer.matchAll(/the `([a-z_]+)`\s+tool/g)].map((m) => m[1]);
    assert.ok(named.includes("subagent") && named.includes("verify_completion"), `steer must name the subagent and verify_completion tools, named: ${named.join(", ")}`);
    for (const t of named) assert.ok(t !== undefined && registered.has(t), `steer names tool '${t}', which no extension registers`);
  } finally {
    rmWorkspace(ws);
  }
}

// REL-5: the escalation marker belongs to one session. A child or a second session in the
// same cwd must neither delete it on its own session_start nor enter recovery for it.
async function testEscalationMarkerIsSessionScoped() {
  const ws = tmpWorkspace("pi-kit-recovery-scoped-");
  const ctx = (id: string) => ({ cwd: ws, hasUI: false, sessionManager: { getSessionId: () => id }, ui: { notify() {}, setStatus() {} } });
  try {
    // The parent's progress-guard escalates a recurring read stall.
    const guard = fakePi();
    (await loadExtension("extensions/progress-guard/index.ts"))(guard.api);
    await guard.handlers.get("session_start")({}, ctx("parent-A"));
    for (let i = 0; i < 12; i++) {
      await guard.handlers.get("tool_call")({ toolName: "read", input: { path: `src/f${i}.ts` } }, ctx("parent-A"));
      await guard.handlers.get("turn_end")({}, ctx("parent-A"));
    }
    const parentMarker = path.join(ws, ".pi", "recovery", "sessions", "parent-A", "escalation.json");
    assert.ok(fs.existsSync(parentMarker), "progress-guard writes the marker under its own session");
    assert.ok(!fs.existsSync(path.join(ws, ".pi", "recovery", "escalation.json")), "a session marker must not land at the legacy flat path");

    // A child session starts in the same cwd and runs a turn: it must leave the marker alone.
    const register = await loadExtension("extensions/recovery-orchestrator/index.ts");
    const child = fakePi();
    register(child.api);
    await child.handlers.get("session_start")({}, ctx("child-B"));
    await child.handlers.get("turn_end")({}, ctx("child-B"));
    assert.ok(fs.existsSync(parentMarker), "a child's session_start and turn_end must not consume the parent's marker");
    assert.ok(!fs.existsSync(path.join(ws, ".pi", "ctx-contributions", "sessions", "child-B", "recovery-orchestrator.json")), "the child must not enter recovery for the parent's stall");

    // The owning session consumes its own marker.
    const parent = fakePi();
    register(parent.api);
    await parent.handlers.get("session_start")({}, ctx("parent-A"));
    // session_start clears only this session's marker; re-arm it as progress-guard would mid-session.
    assert.ok(!fs.existsSync(parentMarker), "a fresh session_start clears its own marker");
    fs.mkdirSync(path.dirname(parentMarker), { recursive: true });
    fs.writeFileSync(parentMarker, JSON.stringify({ signature: "stall", reason: "read stall", count: 2, at: new Date().toISOString(), sessionId: "parent-A" }));
    await parent.handlers.get("turn_end")({}, ctx("parent-A"));
    assert.ok(fs.existsSync(path.join(ws, ".pi", "ctx-contributions", "sessions", "parent-A", "recovery-orchestrator.json")), "the owner enters recovery for its own marker");
    assert.ok(!fs.existsSync(parentMarker), "the owner consumes its marker");

    // A legacy flat marker is still read by a session without an id, never by one with an id.
    const flat = path.join(ws, ".pi", "recovery", "escalation.json");
    fs.writeFileSync(flat, JSON.stringify({ signature: "legacy", reason: "x", count: 1, at: new Date().toISOString() }));
    const mod = await loadModule<{ planRecovery: (cwd: string, attempts: Map<string, number>, sessionId?: string) => { action: string } }>("extensions/recovery-orchestrator/index.ts");
    assert.equal(mod.planRecovery(ws, new Map(), "other-C").action, "none", "a session with an id ignores the legacy flat marker");
    assert.equal(mod.planRecovery(ws, new Map(), undefined).action, "enter", "a session without an id still reads the legacy flat marker");
    // A flat marker that names another session is never acted on.
    fs.writeFileSync(flat, JSON.stringify({ signature: "foreign", reason: "x", count: 1, at: new Date().toISOString(), sessionId: "parent-A" }));
    assert.equal(mod.planRecovery(ws, new Map(), undefined).action, "none", "a marker naming another session is ignored");
  } finally {
    rmWorkspace(ws);
  }
}

// EFF-6: recovery reads only a bounded tail of .pi/trace.jsonl, never the whole file, and reaches
// into the rotated .pi/trace.jsonl.1 when the live file holds fewer than its 30-entry window.
async function testTraceReadIsBoundedTail() {
  const ws = tmpWorkspace("pi-kit-recovery-tail-");
  const realRead = fs.readFileSync;
  const wholeReads: string[] = [];
  try {
    fs.mkdirSync(path.join(ws, ".pi"), { recursive: true });
    const trace = path.join(ws, ".pi", "trace.jsonl");
    const pad = JSON.stringify({ kind: "call", tool: "ls", target: "x".repeat(900) }) + "\n";
    const recent = [
      JSON.stringify({ kind: "call", tool: "grep", target: "TODO" }),
      JSON.stringify({ kind: "result", tool: "grep", target: "TODO", status: "error" }),
    ].join("\n") + "\n";
    // About 6 MiB of older history, then the recent entries.
    fs.writeFileSync(trace, pad.repeat(Math.ceil((6 * 1024 * 1024) / pad.length)) + recent.repeat(15));
    const spy = (...args: Parameters<typeof fs.readFileSync>): string | Buffer => {
      const [file] = args;
      if (typeof file === "string" && file.endsWith("trace.jsonl")) wholeReads.push(file);
      return realRead(...args);
    };
    Object.defineProperty(fs, "readFileSync", { value: spy, configurable: true, writable: true });
    const register = await loadExtension("extensions/recovery-orchestrator/index.ts");
    const pi = fakePi();
    register(pi.api);
    await pi.handlers.get("session_start")({}, { cwd: ws, ui: { notify() {} } });
    writeEscalation(ws, "tail:one");
    await pi.handlers.get("turn_end")({}, { cwd: ws, ui: { notify() {} } });
    Object.defineProperty(fs, "readFileSync", { value: realRead, configurable: true, writable: true });
    assert.deepEqual(wholeReads, [], "recovery must not read the whole trace.jsonl");
    const reportName = fs.readdirSync(path.join(ws, ".pi", "recovery")).find((f) => f.endsWith(".md"));
    assert.ok(reportName !== undefined, "recovery must write a report");
    const report = fs.readFileSync(path.join(ws, ".pi", "recovery", reportName), "utf8");
    assert.match(report, /- 15 tool calls in the trace window, 15 result\(s\) recorded as error/, "the window is the last 30 entries");

    // Just after a rotation the live file is short: the window is filled from trace.jsonl.1.
    const ws2 = tmpWorkspace("pi-kit-recovery-rotated-");
    try {
      fs.mkdirSync(path.join(ws2, ".pi"), { recursive: true });
      fs.writeFileSync(path.join(ws2, ".pi", "trace.jsonl.1"), recent.repeat(15));
      fs.writeFileSync(path.join(ws2, ".pi", "trace.jsonl"), JSON.stringify({ kind: "call", tool: "read", target: "a.ts" }) + "\n");
      const pi2 = fakePi();
      register(pi2.api);
      await pi2.handlers.get("session_start")({}, { cwd: ws2, ui: { notify() {} } });
      writeEscalation(ws2, "tail:two");
      await pi2.handlers.get("turn_end")({}, { cwd: ws2, ui: { notify() {} } });
      const name2 = fs.readdirSync(path.join(ws2, ".pi", "recovery")).find((f) => f.endsWith(".md"));
      assert.ok(name2 !== undefined, "recovery must write a report");
      const report2 = fs.readFileSync(path.join(ws2, ".pi", "recovery", name2), "utf8");
      assert.match(report2, /- 15 tool calls in the trace window, 15 result\(s\) recorded as error/, "the last 29 entries of .1 plus 1 live");
      assert.match(report2, /read:a\.ts/, "the newest live entry is last");
    } finally {
      rmWorkspace(ws2);
    }
  } finally {
    Object.defineProperty(fs, "readFileSync", { value: realRead, configurable: true, writable: true });
    rmWorkspace(ws);
  }
}

const tests: Array<[string, () => Promise<void>]> = [
  ["recovery reads a bounded tail of trace.jsonl, then trace.jsonl.1 (EFF-6)", testTraceReadIsBoundedTail],
  ["the escalation marker is scoped to its session (REL-5)", testEscalationMarkerIsSessionScoped],
  ["recovery report is grounded in real trace-ledger data", testReportIncludesRealTraceData],
  ["recovery report degrades gracefully with no trace data", testReportHandlesMissingTraceGracefully],
  ["recovery report drops trace fields of the wrong type (REL-11)", testReportDropsMistypedTraceFields],
  ["a successful write resets the recovery attempt cap (REL-3)", testProgressResetsAttemptCap],
  ["writes to the recovery report do not reset the attempt cap (REL-3)", testRecoveryBookkeepingDoesNotResetCap],
  ["the recovery steer names only model-callable tools, no slash commands (REL-4)", testSteerNamesOnlyModelCallableActions],
];

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`  OK: ${name}`);
  } catch (error) {
    failed++;
    console.error(`  FAIL: ${name}`);
    console.error(`    ${error instanceof Error ? error.stack || error.message : String(error)}`);
  }
}

if (failed > 0) {
  console.error(`\n[recovery-grounding-smoke] ${failed}/${tests.length} FAILED`);
  process.exit(1);
}
console.log(`\n[recovery-grounding-smoke] all ${tests.length} checks passed`);
