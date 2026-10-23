#!/usr/bin/env node
/**
 * AG-06 regression coverage: ordinary read stalls and failed-edit cycles must reach
 * escalation, not bypass it. Fully offline — no live pi, no network.
 */
import assert from "node:assert/strict";
import { loadExtension, loadModule, fakePi, tmpWorkspace, rmWorkspace, setEnv } from "../packages/core/eval/harness.ts";
import type * as ProgressGuard from "../packages/extensions/src/progress-guard/index.ts";
import type * as ContextSieve from "../packages/extensions/src/context-sieve/index.ts";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

type SmokeTest = () => Promise<void>;

interface ArmMarker {
  armed: boolean;
  at?: string;
}

async function loadGuard() {
  const register = await loadExtension("extensions/progress-guard/index.ts");
  const pi = fakePi();
  register(pi.api);
  return pi;
}

// Independent repro #1: 12 distinct reads previously produced a nudge but never
// escalated, because the stall signature embedded the live count ("stall:6",
// "stall:7", ...) so no single signature ever recurred enough to cross
// ESCALATE_AFTER.
async function testRepeatedStallEscalates() {
  const ws = tmpWorkspace("pi-kit-guard-stall-");
  const restoreMode = setEnv("PI_KIT_GUARD_MODE", "auto");
  try {
    const pi = await loadGuard();
    await pi.handlers.get("session_start")({}, { cwd: ws, ui: { notify() {} } });
    const ctx = { cwd: ws, hasUI: true, ui: { notify() {} } };

    // 12 distinct reads, each followed by a turn_end, past the default stall
    // threshold (6) — this alone would previously never escalate.
    for (let i = 0; i < 12; i++) {
      await pi.handlers.get("tool_call")({ toolName: "read", input: { path: `src/file${i}.ts` } }, ctx);
      await pi.handlers.get("turn_end")({}, ctx);
    }

    const fs = await import("node:fs");
    const path = await import("node:path");
    const escalationPath = path.join(ws, ".pi", "recovery", "escalation.json");
    assert.ok(fs.existsSync(escalationPath), "repeated stall detections must eventually escalate to recovery");
  } finally {
    restoreMode();
    rmWorkspace(ws);
  }
}

// Independent repro #2: a distinct-reads-then-failed-edit cycle, repeated, previously
// produced neither a nudge nor an escalation, because a write ATTEMPT (tool_call) reset
// progress state before the result (success or failure) was known — so a repeatedly
// failing edit looked exactly like repeated forward progress.
async function testFailedEditDoesNotResetProgress() {
  const ws = tmpWorkspace("pi-kit-guard-failedit-");
  const restoreMode = setEnv("PI_KIT_GUARD_MODE", "auto");
  try {
    const pi = await loadGuard();
    await pi.handlers.get("session_start")({}, { cwd: ws, ui: { notify() {} } });
    const ctx = { cwd: ws, hasUI: true, ui: { notify() {} } };

    // 8 cycles: enough turns to clear progress-guard's own COOLDOWN_TURNS (4) between
    // the first "stall" act and the second one that crosses ESCALATE_AFTER (2).
    for (let cycle = 0; cycle < 8; cycle++) {
      for (let i = 0; i < 5; i++) {
        await pi.handlers.get("tool_call")({ toolName: "read", input: { path: `src/f${cycle}-${i}.ts` } }, ctx);
      }
      await pi.handlers.get("tool_call")({ toolName: "edit", input: { path: "src/app.ts", new_string: "x" } }, ctx);
      // The edit FAILS - tool_result reports isError, so it must not reset progress.
      await pi.handlers.get("tool_result")({ toolName: "edit", isError: true }, ctx);
      await pi.handlers.get("turn_end")({}, ctx);
    }

    const fs = await import("node:fs");
    const path = await import("node:path");
    const escalationPath = path.join(ws, ".pi", "recovery", "escalation.json");
    assert.ok(fs.existsSync(escalationPath), "a repeated read-then-failed-edit cycle must eventually escalate");
  } finally {
    restoreMode();
    rmWorkspace(ws);
  }
}

// A genuinely successful write must still clear the stall/oscillation state (no
// regression from the AG-06 fix — only the FAILURE path changed).
async function testSuccessfulWriteStillResetsProgress() {
  const ws = tmpWorkspace("pi-kit-guard-success-");
  try {
    const pi = await loadGuard();
    await pi.handlers.get("session_start")({}, { cwd: ws, ui: { notify() {} } });
    const ctx = { cwd: ws, hasUI: false, ui: { notify() {} } };

    for (let i = 0; i < 8; i++) {
      await pi.handlers.get("tool_call")({ toolName: "read", input: { path: `src/f${i}.ts` } }, ctx);
    }
    await pi.handlers.get("tool_call")({ toolName: "edit", input: { path: "src/app.ts", new_string: "x" } }, ctx);
    await pi.handlers.get("tool_result")({ toolName: "edit", isError: false }, ctx);

    // Immediately after a successful edit, a single further turn_end must not fire the
    // stall signal (the counter was reset).
    const fs = await import("node:fs");
    const path = await import("node:path");
    await pi.handlers.get("turn_end")({}, ctx);
    assert.ok(!fs.existsSync(path.join(ws, ".pi", "recovery", "escalation.json")), "a successful write must still clear the stall counter");
  } finally {
    rmWorkspace(ws);
  }
}

// WU-11 (a): the escalation marker is written once per detection episode. A consumer that
// deletes the marker (e.g. recovery-orchestrator) must not be re-escalated on every following
// stuck turn of the same episode; only a new episode (progress reset by a successful write)
// may write a fresh marker.
async function testEscalationMarkerWrittenOncePerEpisode() {
  const ws = tmpWorkspace("pi-kit-guard-marker-");
  const restoreMode = setEnv("PI_KIT_GUARD_MODE", "auto");
  const fs = await import("node:fs");
  const path = await import("node:path");
  const markerPath = path.join(ws, ".pi", "recovery", "escalation.json");
  try {
    const pi = await loadGuard();
    await pi.handlers.get("session_start")({}, { cwd: ws, ui: { notify() {} } });
    const ctx = { cwd: ws, hasUI: false, ui: { notify() {} } };

    // 11 reads each followed by a turn_end: enough for two "stall" detections to cross
    // ESCALATE_AFTER (2) and write the marker.
    const stall = async (prefix: string): Promise<void> => {
      for (let i = 0; i < 11; i++) {
        await pi.handlers.get("tool_call")({ toolName: "read", input: { path: `${prefix}${i}.ts` } }, ctx);
        await pi.handlers.get("turn_end")({}, ctx);
      }
    };

    await stall("src/a");
    assert.ok(fs.existsSync(markerPath), "recurring stall must write the recovery marker");

    // The consumer deletes the marker; further stuck turns in the SAME episode must not
    // immediately re-write it.
    fs.rmSync(markerPath, { force: true });
    for (let i = 0; i < 3; i++) await pi.handlers.get("turn_end")({}, ctx);
    assert.ok(
      !fs.existsSync(markerPath),
      "a consumed marker must not be re-written within the same detection episode",
    );

    // A confirmed-successful write starts a new episode and clears the one-per-episode guard.
    await pi.handlers.get("tool_call")({ toolName: "edit", input: { path: "src/app.ts", new_string: "x" } }, ctx);
    await pi.handlers.get("tool_result")({ toolName: "edit", isError: false }, ctx);
    assert.ok(!fs.existsSync(markerPath), "a successful write must clear the stale marker");

    await stall("src/b");
    assert.ok(fs.existsSync(markerPath), "a new episode must be able to escalate again");
  } finally {
    restoreMode();
    rmWorkspace(ws);
  }
}

// WU-11 (b): a legacy (or corrupted) marker with a missing/unparseable `at` heartbeat is
// expired, so it cannot pin auto mode forever; only a parseable `at` within TTL stays armed.
async function testLegacyMarkerWithoutHeartbeatIsExpired() {
  const ws = tmpWorkspace("pi-kit-guard-armed-");
  const restoreMode = setEnv("PI_KIT_GUARD_MODE", undefined);
  const restoreTtl = setEnv("PI_KIT_LOOP_ARM_TTL_MS", "5000");
  const fs = await import("node:fs");
  const path = await import("node:path");
  const markerPath = path.join(ws, ".pi", "autonomous-loop.armed.json");
  const arm = (marker: ArmMarker): void => fs.writeFileSync(markerPath, JSON.stringify(marker), "utf8");
  try {
    const mod = await loadModule<typeof ProgressGuard>("extensions/progress-guard/index.ts");
    assert.equal(typeof mod.autonomousArmed, "function", "autonomousArmed must be exported");
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });

    assert.equal(mod.resolveMode(ws, null), "suggest", "no marker -> suggest");

    arm({ armed: true });
    assert.equal(mod.resolveMode(ws, null), "suggest", "legacy marker with no `at` must be expired");

    arm({ armed: true, at: "not-a-date" });
    assert.equal(mod.resolveMode(ws, null), "suggest", "unparseable `at` must be expired");

    arm({ armed: true, at: new Date(Date.now() - 60_000).toISOString() });
    assert.equal(mod.resolveMode(ws, null), "suggest", "a marker older than the TTL must be expired");

    arm({ armed: true, at: new Date().toISOString() });
    assert.equal(mod.resolveMode(ws, null), "auto", "a fresh heartbeat within the TTL stays armed");

    arm({ armed: false, at: new Date().toISOString() });
    assert.equal(mod.resolveMode(ws, null), "suggest", "armed:false is never armed");
  } finally {
    restoreTtl();
    restoreMode();
    rmWorkspace(ws);
  }
}

// EFF-5: a loop inside ONE run must be nudged inside that run. The contribution file is read by
// context-sieve only when the next prompt starts, so before the fix the model never saw the nudge
// or the checkpoint while it kept looping. This drives pi's real agent loop with a scripted model
// that reads the same file six times in one prompt, and checks what the model was sent.
async function testNudgeReachesTheLoopingRun() {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const home = tmpWorkspace("pi-kit-guard-inrun-home-");
  const cwd = tmpWorkspace("pi-kit-guard-inrun-cwd-");
  const agentDir = path.join(home, "agent");
  const restore = [setEnv("HOME", home), setEnv("PI_CODING_AGENT_DIR", agentDir), setEnv("PI_KIT_GUARD_MODE", "auto")];
  let dispose = (): void => undefined;
  try {
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(cwd, "a.txt"), "hello\n");
    const guard = (await loadModule<typeof ProgressGuard>("extensions/progress-guard/index.ts")).default;
    const sieve = (await loadModule<typeof ContextSieve>("extensions/context-sieve/index.ts")).default;
    const faux = fauxProvider();
    const runtime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
    runtime.registerNativeProvider(faux.provider);
    const requests: string[] = [];
    const step = (n: number): FauxResponseFactory => (context) => {
      requests.push(JSON.stringify(context.messages));
      return n < 6 ? fauxAssistantMessage(fauxToolCall("read", { path: "a.txt" }), { stopReason: "toolUse" }) : fauxAssistantMessage("done");
    };
    faux.setResponses([0, 1, 2, 3, 4, 5, 6].map(step));
    const settingsManager = SettingsManager.inMemory();
    const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true, extensionFactories: [sieve, guard] });
    await resourceLoader.reload();
    const { session } = await createAgentSession({ cwd, agentDir, modelRuntime: runtime, model: faux.getModel(), tools: ["read"], resourceLoader, settingsManager, sessionManager: SessionManager.inMemory(cwd) });
    dispose = () => { session.dispose(); };
    await session.prompt("read a.txt");

    assert.equal(requests.length, 7, "the scripted run makes seven model requests");
    const loop = /progress-guard: possible loop/;
    const checkpoint = /progress-guard: review \/ delegate checkpoint/;
    // Three identical reads (PI_KIT_GUARD_REPEAT default 3) fire after the third turn.
    for (let i = 0; i < 3; i++) assert.doesNotMatch(requests[i] ?? "", loop, `request ${i} precedes the loop`);
    assert.match(requests[3] ?? "", loop, "the nudge reaches the next model request of the same run");
    assert.match(requests[4] ?? "", checkpoint, "the review/delegate checkpoint reaches the same run on the first escalation");
    const delivered = session.sessionManager.getBranch().filter((e) => e.type === "custom_message" && e.customType === "progress-guard");
    assert.ok(delivered.length <= 3, `in-run delivery stays debounced by the cooldown (got ${delivered.length} in 7 turns)`);
  } finally {
    dispose();
    for (const r of restore.reverse()) r();
    rmWorkspace(cwd);
    rmWorkspace(home);
  }
}

const tests: Array<[string, SmokeTest]> = [
  ["repeated read-stalls eventually escalate (stable signature)", testRepeatedStallEscalates],
  ["a repeatedly-failing edit does not reset progress tracking", testFailedEditDoesNotResetProgress],
  ["a successful write still resets progress tracking", testSuccessfulWriteStillResetsProgress],
  ["the escalation marker is written once per detection episode", testEscalationMarkerWrittenOncePerEpisode],
  ["a legacy arm marker without a heartbeat is expired", testLegacyMarkerWithoutHeartbeatIsExpired],
  ["the loop nudge and checkpoint reach the model inside the looping run", testNudgeReachesTheLoopingRun],
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
  console.error(`\n[progress-guard-agsix-smoke] ${failed}/${tests.length} FAILED`);
  process.exit(1);
}
console.log(`\n[progress-guard-agsix-smoke] all ${tests.length} checks passed`);
