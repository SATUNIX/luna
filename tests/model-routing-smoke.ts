#!/usr/bin/env node
/**
 * AG-01 regression coverage: orchestrator must be the real producer of a task-difficulty
 * classification, the shipped kit roles carry no model override (and are no longer copied
 * into projects), and the subagent model policy must choose either the active parent model
 * or role frontmatter.
 * Fully offline — no live pi, no network.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROOT, loadExtension, loadModule, fakePi, tmpWorkspace, rmWorkspace, setEnv, isolateKitEnv } from "../packages/core/eval/harness.ts";
import { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { installDelegation } from "../packages/core/eval/delegation.ts";
import { number, object, parseJsonAs, string } from "../packages/core/lib/guard.ts";
import type { AgentConfig } from "../packages/extensions/third_party/subagent/agents.ts";
import type * as Subagent from "../packages/extensions/third_party/subagent/index.ts";

/** The part of .pi/task-classification.json these checks read. */
const Classification = object({ taskType: string(), score: number() });

// Launches go through delegation-guard (mandatory protections + effort budget); fake children still need it in place.
const __delegation = await installDelegation();
process.on("exit", () => __delegation.cleanup());

async function loadOrchestrator(): Promise<ReturnType<typeof fakePi>> {
  const register = await loadExtension("extensions/orchestrator/index.ts");
  const pi = fakePi();
  register(pi.api);
  return pi;
}

// orchestrator must write .pi/task-classification.json on every non-trivial input -
// the real signal provider-router now consumes (previously nothing ever wrote a
// task_type at all).
async function testOrchestratorWritesClassification(): Promise<void> {
  const ws = tmpWorkspace("pi-kit-classify-");
  const restore = setEnv("PI_KIT_ORCH_DISABLE", undefined);
  try {
    const pi = await loadOrchestrator();
    const ctx = { cwd: ws, ui: { notify() {}, setStatus() {} } };
    await pi.handlers.get("session_start")({}, ctx);

    await pi.handlers.get("input")(
      { source: "interactive", text: "Implement a new authentication system across multiple services and refactor the whole billing module thoroughly." },
      ctx,
    );
    const classFile = path.join(ws, ".pi", "task-classification.json");
    assert.ok(fs.existsSync(classFile), "a complex input must write a classification file");
    const complex = parseJsonAs(Classification, fs.readFileSync(classFile, "utf8"));
    assert.equal(complex.taskType, "complex");
    assert.ok(complex.score >= 3);

    await pi.handlers.get("input")({ source: "interactive", text: "hi there, quick question for you" }, ctx);
    const simple = parseJsonAs(Classification, fs.readFileSync(classFile, "utf8"));
    assert.equal(simple.taskType, "simple", "a trivial-scoring input must reclassify as simple, not leave the stale complex verdict");
  } finally {
    restore();
    rmWorkspace(ws);
  }
}

async function testRoleAgentsHaveNoInjectedModel(): Promise<void> {
  const ws = tmpWorkspace("pi-kit-rolemodel-");
  const restoreDisable = setEnv("PI_KIT_ORCH_DISABLE", undefined);
  try {
    const pi = await loadOrchestrator();
    await pi.handlers.get("session_start")({}, { cwd: ws, ui: { notify() {} } });
    assert.ok(!fs.existsSync(path.join(ws, ".pi", "agents")), "orchestrator must not copy roles into the project");

    const planner = fs.readFileSync(path.join(ROOT, "packages", "kit", "agents", "planner.md"), "utf8");
    assert.doesNotMatch(planner, /^model:/m, "orchestrator must not inject a model override");

    // Frontmatter integrity: name/description/tools must survive untouched.
    assert.match(planner, /^name: planner$/m);
    assert.match(planner, /^tools:/m);
  } finally {
    restoreDisable();
    rmWorkspace(ws);
  }
}

async function testSubagentModelPolicy(): Promise<void> {
  const ws = tmpWorkspace("pi-kit-subagent-model-");
  try {
    const subagent = await loadModule<typeof Subagent>("vendor/subagent/index.ts");
    const role: AgentConfig[] = [{ name: "planner", description: "x", model: "gemma4:latest", systemPrompt: "", source: "user", filePath: "x" }];
    const launches: (readonly string[])[] = [];
    const spawnChild = (_exe: string, args: readonly string[]) => {
      launches.push(args);
      // An unspawned ChildProcess (an EventEmitter with no OS process) typed as spawn's result.
      const child = Object.assign(new ChildProcess(), { stdout: new PassThrough(), stderr: new PassThrough() });
      queueMicrotask(() => child.emit("close", 0));
      return child;
    };
    await subagent.runSingleAgent(ws, role, "planner", "task", undefined, undefined, undefined, undefined, spawnChild, "ollama/qwen3.8-uncensored", true);
    const [inherited] = launches;
    assert.ok(inherited, "the first run launched a child");
    assert.deepEqual(inherited.slice(inherited.indexOf("--model"), inherited.indexOf("--model") + 2), ["--model", "ollama/qwen3.8-uncensored"]);
    await subagent.runSingleAgent(ws, role, "planner", "task", undefined, undefined, undefined, undefined, spawnChild, "ollama/qwen3.8-uncensored", false);
    const roleLaunch = launches[1];
    assert.ok(roleLaunch, "the second run launched a child");
    assert.deepEqual(roleLaunch.slice(roleLaunch.indexOf("--model"), roleLaunch.indexOf("--model") + 2), ["--model", "gemma4:latest"]);

  } finally {
    rmWorkspace(ws);
  }
}

const restoreIsolation = isolateKitEnv();
// ORC-9: the classification is scoped per session. Session B (or a child) in the same cwd
// must route on its own score, never on session A's.
async function testClassificationIsSessionScoped(): Promise<void> {
  const ws = tmpWorkspace("pi-kit-classify-scoped-");
  const policy = path.join(ws, "policy.json");
  fs.writeFileSync(policy, JSON.stringify({ hot_path_model: "p/small", strong_model: "p/strong", trigger_task_types: ["complex"] }));
  const restorePolicy = setEnv("PI_KIT_ROUTING_POLICY", policy);
  const restoreDisable = setEnv("PI_KIT_ORCH_DISABLE", undefined);
  const ctx = (id: string) => ({ cwd: ws, sessionManager: { getSessionId: () => id }, ui: { notify() {}, setStatus() {} } });
  const models = [{ provider: "p", id: "small" }, { provider: "p", id: "strong" }];
  const modelRegistry = {
    find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
    getAll: () => models,
  };
  try {
    const orch = await loadOrchestrator();
    await orch.handlers.get("session_start")({}, ctx("sess-A"));
    await orch.handlers.get("input")(
      { source: "interactive", text: "Implement a new authentication system across multiple services and refactor the whole billing module thoroughly." },
      ctx("sess-A"),
    );
    const scoped = path.join(ws, ".pi", "task-classification", "sessions", "sess-A.json");
    assert.equal(parseJsonAs(Classification, fs.readFileSync(scoped, "utf8")).taskType, "complex", "the score is written under the session");
    assert.ok(!fs.existsSync(path.join(ws, ".pi", "task-classification.json")), "a session score must not land at the legacy flat path");

    const register = await loadExtension("extensions/provider-router/index.ts");
    const router = fakePi();
    register(router.api);
    await router.handlers.get("session_start")({}, ctx("sess-B"));
    await router.handlers.get("before_agent_start")({}, { ...ctx("sess-B"), modelRegistry });
    assert.equal(router.modelSelections.at(-1)?.id, "small", "session B must not route on session A's complex score");
    await router.handlers.get("before_agent_start")({}, { ...ctx("sess-A"), modelRegistry });
    assert.equal(router.modelSelections.at(-1)?.id, "strong", "session A routes on its own score");
  } finally {
    restorePolicy();
    restoreDisable();
    rmWorkspace(ws);
  }
}

// EFF-8: a policy naming its models with non-strings is refused at load, so routing stays off
// instead of throwing a TypeError from before_agent_start on every prompt.
async function testMalformedPolicyIsRefused(): Promise<void> {
  const ws = tmpWorkspace("pi-kit-policy-malformed-");
  const policy = path.join(ws, "policy.json");
  fs.writeFileSync(policy, JSON.stringify({ hot_path_model: 1, strong_model: 2 }));
  const restorePolicy = setEnv("PI_KIT_ROUTING_POLICY", policy);
  const ctx = { cwd: ws, sessionManager: { getSessionId: () => "sess-M" }, ui: { notify() {}, setStatus() {} } };
  const modelRegistry = { find: () => undefined, getAll: () => [] };
  try {
    const register = await loadExtension("extensions/provider-router/index.ts");
    const router = fakePi();
    register(router.api);
    await router.handlers.get("session_start")({}, ctx);
    await router.handlers.get("before_agent_start")({}, { ...ctx, modelRegistry });
    assert.equal(router.modelSelections.length, 0, "a malformed policy must leave the model alone");
  } finally {
    restorePolicy();
    rmWorkspace(ws);
  }
}

const tests: Array<[string, () => Promise<void>]> = [
  ["a policy with non-string model names is refused (EFF-8)", testMalformedPolicyIsRefused],
  ["the task classification is scoped to its session (ORC-9)", testClassificationIsSessionScoped],
  ["orchestrator writes a real task classification on every input", testOrchestratorWritesClassification],
  ["kit roles carry no model and are not copied into projects", testRoleAgentsHaveNoInjectedModel],
  ["subagent model policy inherits or uses role models", testSubagentModelPolicy],
];

let failed = 0;
try {
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  OK: ${name}`);
    } catch (error: unknown) {
      failed++;
      console.error(`  FAIL: ${name}`);
      console.error(`    ${error instanceof Error ? error.stack || error.message : String(error)}`);
    }
  }
} finally {
  restoreIsolation();
}
if (failed > 0) {
  console.error(`\n[model-routing-smoke] ${failed}/${tests.length} FAILED`);
  process.exit(1);
}
console.log(`\n[model-routing-smoke] all ${tests.length} checks passed`);
