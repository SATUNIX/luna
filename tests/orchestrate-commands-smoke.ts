#!/usr/bin/env node
/**
 * AG-02 regression coverage: docs/agent-orchestration.md documented /orchestrate-plan
 * and /orchestrate-implement-review as existing manual entry points; neither was
 * registered. O1 (2026-09): they then wrote a contribution file that the very next user
 * input cleared or replaced before the agent read it, so they had no effect. They now send
 * the directive as a user message. Fully offline — no live pi, no network.
 */
import assert from "node:assert/strict";
import { loadExtension, fakePi, tmpWorkspace, rmWorkspace, setEnv } from "../packages/core/eval/harness.ts";

type FakePi = ReturnType<typeof fakePi>;

async function loadOrchestrator(): Promise<FakePi> {
  const register = await loadExtension("extensions/orchestrator/index.ts");
  const pi = fakePi();
  register(pi.api);
  return pi;
}

async function testOrchestratePlanCommand() {
  const ws = tmpWorkspace("pi-kit-orch-plan-");
  const restore = setEnv("PI_KIT_ORCH_DISABLE", undefined);
  try {
    const pi = await loadOrchestrator();
    assert.ok(pi.commands.has("orchestrate-plan"), "/orchestrate-plan must be registered");
    const ctx = { cwd: ws, ui: { notify() {}, setStatus() {} } };
    await pi.handlers.get("session_start")({}, ctx);
    await pi.commands.get("orchestrate-plan").handler("add rate limiting to the API", ctx);

    assert.equal(pi.steers.length, 1, "/orchestrate-plan must send its directive as a message");
    const [steer] = pi.steers;
    assert.ok(steer && typeof steer.message === "string", "the directive is a text message");
    const content = steer.message;
    assert.match(content, /plan only/i);
    assert.match(content, /add rate limiting to the API/);
    assert.doesNotMatch(content, /\bimplementer\b/i, "plan-only must not instruct implementation");
  } finally {
    restore();
    rmWorkspace(ws);
  }
}

async function testOrchestrateImplementReviewCommand() {
  const ws = tmpWorkspace("pi-kit-orch-impl-");
  const restore = setEnv("PI_KIT_ORCH_DISABLE", undefined);
  try {
    const pi = await loadOrchestrator();
    assert.ok(pi.commands.has("orchestrate-implement-review"), "/orchestrate-implement-review must be registered");
    const ctx = { cwd: ws, ui: { notify() {}, setStatus() {} } };
    await pi.handlers.get("session_start")({}, ctx);
    await pi.commands.get("orchestrate-implement-review").handler("fix the flaky auth test", ctx);

    assert.equal(pi.steers.length, 1, "/orchestrate-implement-review must send its directive as a message");
    const [steer] = pi.steers;
    assert.ok(steer && typeof steer.message === "string", "the directive is a text message");
    const content = steer.message;
    assert.match(content, /planner.*implementer.*reviewer/is);
    assert.match(content, /fix the flaky auth test/);
  } finally {
    restore();
    rmWorkspace(ws);
  }
}

async function testMissingTaskArgumentRejected() {
  const ws = tmpWorkspace("pi-kit-orch-noargs-");
  const restore = setEnv("PI_KIT_ORCH_DISABLE", undefined);
  try {
    const pi = await loadOrchestrator();
    const notes: Array<[message: string, level: string]> = [];
    const ctx = { cwd: ws, ui: { notify: (m: string, lvl: string) => notes.push([m, lvl]), setStatus() {} } };
    await pi.handlers.get("session_start")({}, ctx);
    await pi.commands.get("orchestrate-plan").handler("", ctx);
    assert.ok(notes.some(([, lvl]) => lvl === "error"), "an empty task argument must be rejected with an error notice");
    assert.equal(pi.steers.length, 0, "nothing must be sent without a task");
  } finally {
    restore();
    rmWorkspace(ws);
  }
}

const tests: Array<[name: string, fn: () => Promise<void>]> = [
  ["/orchestrate-plan queues a plan-only delegation", testOrchestratePlanCommand],
  ["/orchestrate-implement-review queues the full loop", testOrchestrateImplementReviewCommand],
  ["a missing task argument is rejected, not silently accepted", testMissingTaskArgumentRejected],
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
  console.error(`\n[orchestrate-commands-smoke] ${failed}/${tests.length} FAILED`);
  process.exit(1);
}
console.log(`\n[orchestrate-commands-smoke] all ${tests.length} checks passed`);
