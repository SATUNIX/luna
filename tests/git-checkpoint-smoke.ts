#!/usr/bin/env node
/**
 * H-04 regression coverage: git-checkpoint must not clear restore points before a later
 * fork can use them. Fully offline — `pi.exec` is stubbed, no real git process spawned,
 * no live pi, no network.
 */
import assert from "node:assert/strict";
import { loadExtension, fakePi } from "../packages/core/eval/harness.ts";

// The harness's fake pi, plus the stash ref the stubbed `git stash apply` last applied.
type CheckpointPi = ReturnType<typeof fakePi> & { __applied?: string | undefined };
type TestCase = [name: string, fn: () => Promise<void>];

async function loadCheckpoint(): Promise<CheckpointPi> {
  const register = await loadExtension("vendor/git-checkpoint/index.ts");
  const pi = fakePi();
  register(pi.api);
  return pi;
}

function stubExec(pi: CheckpointPi, stashRef: string): void {
  pi.api.exec = async (command: string, args: string[]) => {
    if (command === "git" && args[0] === "stash" && args[1] === "create") {
      return { stdout: `${stashRef}\n`, stderr: "", code: 0 };
    }
    if (command === "git" && args[0] === "stash" && args[1] === "apply") {
      pi.__applied = args[2];
      return { stdout: "", stderr: "", code: 0 };
    }
    return { stdout: "", stderr: "", code: 0 };
  };
}

// Independent-repro shape: tool_result -> turn_start -> agent_end -> session_before_fork.
// Previously agent_end wiped the checkpoint before session_before_fork could read it, so
// only `git stash create` ever ran, never `git stash apply`.
async function testCheckpointSurvivesPastAgentEnd() {
  const pi = await loadCheckpoint();
  stubExec(pi, "abc123stash");
  const ctx = { hasUI: true, ui: { select: async () => "Yes, restore code to that point", notify() {} } };

  await pi.handlers.get("session_start")({}, ctx);
  await pi.handlers.get("tool_result")({}, { sessionManager: { getLeafEntry: () => ({ id: "entry-1" }) } });
  await pi.handlers.get("turn_start")({}, ctx);
  await pi.handlers.find("agent_end")?.({}, ctx); // no-op if not registered - that's the fix

  await pi.handlers.get("session_before_fork")({ entryId: "entry-1" }, ctx);
  assert.equal(pi.__applied, "abc123stash", "the checkpoint recorded before agent_end must still be usable by session_before_fork");
}

// A fresh session must not see a prior session's checkpoints (reset point moved from
// agent_end to session_start).
async function testFreshSessionClearsOldCheckpoints() {
  const pi = await loadCheckpoint();
  stubExec(pi, "stale-ref");
  const ctx = { hasUI: true, ui: { select: async () => "Yes, restore code to that point", notify() {} } };

  await pi.handlers.get("session_start")({}, ctx);
  await pi.handlers.get("tool_result")({}, { sessionManager: { getLeafEntry: () => ({ id: "entry-old" }) } });
  await pi.handlers.get("turn_start")({}, ctx);

  // New session begins (e.g. /new) - old checkpoints must not leak into it.
  await pi.handlers.get("session_start")({}, ctx);
  await pi.handlers.get("session_before_fork")({ entryId: "entry-old" }, ctx);
  assert.equal(pi.__applied, undefined, "a checkpoint from a prior session must not be restorable in a new one");
}

// Bounded growth: recording more than the cap must evict the oldest, not grow forever.
async function testCheckpointsAreBounded() {
  const pi = await loadCheckpoint();
  stubExec(pi, "ref");
  const ctx = { hasUI: false, ui: { notify() {} } };
  await pi.handlers.get("session_start")({}, ctx);

  for (let i = 0; i < 25; i++) {
    await pi.handlers.get("tool_result")({}, { sessionManager: { getLeafEntry: () => ({ id: `entry-${i}` }) } });
    await pi.handlers.get("turn_start")({}, ctx);
  }

  const uiCtx = { hasUI: true, ui: { select: async () => "Yes, restore code to that point", notify() {} } };
  await pi.handlers.get("session_before_fork")({ entryId: "entry-0" }, uiCtx);
  assert.equal(pi.__applied, undefined, "the oldest checkpoint must have been evicted past the cap");

  await pi.handlers.get("session_before_fork")({ entryId: "entry-24" }, uiCtx);
  assert.equal(pi.__applied, "ref", "the most recent checkpoint must still be present");
}

const tests: TestCase[] = [
  ["a checkpoint survives agent_end and is usable by session_before_fork", testCheckpointSurvivesPastAgentEnd],
  ["a fresh session clears prior checkpoints", testFreshSessionClearsOldCheckpoints],
  ["checkpoints are bounded (oldest evicted past the cap)", testCheckpointsAreBounded],
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
  console.error(`\n[git-checkpoint-smoke] ${failed}/${tests.length} FAILED`);
  process.exit(1);
}
console.log(`\n[git-checkpoint-smoke] all ${tests.length} checks passed`);
