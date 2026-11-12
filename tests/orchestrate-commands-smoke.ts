#!/usr/bin/env node
/**
 * AG-02 regression coverage: docs/agent-orchestration.md documented /orchestrate-plan
 * and /orchestrate-implement-review as existing manual entry points; neither was
 * registered. O1 (2026-09): they then wrote a contribution file that the very next user
 * input cleared or replaced before the agent read it, so they had no effect. They now send
 * the directive as a user message. Fully offline — no live pi, no network.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadExtension, loadModule, fakePi, tmpWorkspace, rmWorkspace, isolateKitEnv } from "../packages/core/eval/harness.ts";
import type * as StrategyModule from "../packages/extensions/src/effort/strategy.ts";
import type * as Orchestrator from "../packages/extensions/src/orchestrator/index.ts";

type FakePi = ReturnType<typeof fakePi>;

async function loadOrchestrator(): Promise<FakePi> {
  const register = await loadExtension("extensions/orchestrator/index.ts");
  const pi = fakePi();
  register(pi.api);
  return pi;
}

async function testOrchestratePlanCommand() {
  const ws = tmpWorkspace("pi-kit-orch-plan-");
  const restore = isolateKitEnv();
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
  const restore = isolateKitEnv();
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
  const restore = isolateKitEnv();
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

const EFFORT_KEY = Symbol.for("pi-kit.effort");
const LARGE_TASK = "Implement the billing pipeline across the whole service and then integrate it with src/a.ts and src/b.ts";

/** What the input handler leaves for the next prompt under this effort registry, or null. */
async function directiveFor(report: ((signal: object) => unknown) | undefined): Promise<string | null> {
  const ws = tmpWorkspace("pi-kit-orch-directive-");
  const restore = isolateKitEnv();
  try {
    if (report) Reflect.set(globalThis, EFFORT_KEY, { strategy: { report } });
    const pi = await loadOrchestrator();
    const ctx = { cwd: ws, ui: { notify() {}, setStatus() {} } };
    await pi.handlers.get("session_start")({}, ctx);
    await pi.handlers.get("input")({ source: "interactive", text: LARGE_TASK }, ctx);
    const file = path.join(ws, ".pi", "ctx-contributions", "orchestrator.json");
    if (!fs.existsSync(file)) return null;
    const raw: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    const content: unknown = typeof raw === "object" && raw !== null ? Reflect.get(raw, "content") : undefined;
    assert.equal(typeof content, "string");
    return typeof content === "string" ? content : null;
  } finally {
    Reflect.deleteProperty(globalThis, EFFORT_KEY);
    restore();
    rmWorkspace(ws);
  }
}

async function testDirectiveComesFromThePolicy() {
  const { decide, DEFAULT_STRATEGY } = await loadModule<typeof StrategyModule>("extensions/effort/strategy.ts");
  const at = (level: number, planTool = true) => (signal: object) => decide({ trigger: "delegate", ...signal }, { level, standing: false, planTool, allowance: 8 }, DEFAULT_STRATEGY);
  const large = await directiveFor(at(3));
  assert.match(large ?? "", /workflow_run \{steps\}/, "E3 names a plan");
  assert.match(large ?? "", /directly stays allowed/, "and working directly stays allowed");
  assert.doesNotMatch(await directiveFor(at(2)) ?? "", /workflow_run/, "E2 gets the short subagent directive");
  assert.match(await directiveFor(at(2)) ?? "", /`subagent`/);
  assert.doesNotMatch(await directiveFor(at(4, false)) ?? "", /workflow_run/, "a plan tool that is not active is not named");
  assert.equal(await directiveFor(at(1)), null, "the policy's none leaves no directive");
  for (const text of [large, await directiveFor(at(2)), await directiveFor(undefined)]) {
    assert.ok(text !== null && text.length <= 600, `at most 600 chars, got ${String(text?.length)}`);
    assert.doesNotMatch(text, /\bchain\b/, "the directive no longer names chain");
    assert.match(text, /verify_completion/);
  }
}

async function testDirectiveFallsBackToOneLine() {
  const absent = await directiveFor(undefined);
  assert.ok(absent !== null && !absent.includes("\n"), "no registry: one line");
  assert.match(absent, /within any user restriction and the effort budget/);
  assert.doesNotMatch(absent, /not loaded/, "the line also serves a loaded policy, so it does not say the policy is absent");
  assert.equal(await directiveFor(() => { throw new Error("policy failed"); }), absent, "a broken policy: the same line, no throw");
  assert.equal(await directiveFor(() => null), absent, "no policy behind the registry: the same line");
  const mod = await loadModule<typeof Orchestrator>("extensions/orchestrator/index.ts");
  assert.equal(mod.directive(5).includes("\n"), false);
}

function contribution(ws: string): string {
  const raw: unknown = JSON.parse(fs.readFileSync(path.join(ws, ".pi", "ctx-contributions", "orchestrator.json"), "utf8"));
  const content: unknown = typeof raw === "object" && raw !== null ? Reflect.get(raw, "content") : undefined;
  return typeof content === "string" ? content : "";
}

async function testForcedOnOutlastsThePolicy() {
  const { decide, DEFAULT_STRATEGY } = await loadModule<typeof StrategyModule>("extensions/effort/strategy.ts");
  const ws = tmpWorkspace("pi-kit-orch-forced-");
  const restore = isolateKitEnv();
  try {
    // E1 with effort loaded: the policy is there and says none.
    const report = (signal: object) => decide({ trigger: "delegate", ...signal }, { level: 1, standing: false, planTool: false, allowance: 0 }, DEFAULT_STRATEGY);
    Reflect.set(globalThis, EFFORT_KEY, { strategy: { report } });
    const pi = await loadOrchestrator();
    const ctx = { cwd: ws, ui: { notify() {}, setStatus() {} } };
    await pi.handlers.get("session_start")({}, ctx);
    await pi.commands.get("orchestrate").handler("on", ctx);
    assert.match(contribution(ws), /`subagent`/, "/orchestrate on is the operator's word");
    assert.doesNotMatch(contribution(ws), /not loaded/, "and the line is true with the policy loaded");
    await pi.handlers.get("input")({ source: "interactive", text: LARGE_TASK }, ctx);
    assert.match(contribution(ws), /`subagent`/, "the input path keeps it too");
    assert.doesNotMatch(contribution(ws), /not loaded/);
  } finally {
    Reflect.deleteProperty(globalThis, EFFORT_KEY);
    restore();
    rmWorkspace(ws);
  }
}

async function testPolicyOwnsTheThreshold() {
  const { decide, DEFAULT_STRATEGY } = await loadModule<typeof StrategyModule>("extensions/effort/strategy.ts");
  const run = async (delegateScore: number, text: string) => {
    const ws = tmpWorkspace("pi-kit-orch-threshold-");
    const restore = isolateKitEnv();
    const notes: string[] = [];
    try {
      const strategy = { ...DEFAULT_STRATEGY, delegateScore };
      Reflect.set(globalThis, EFFORT_KEY, { strategy: {
        report: (signal: object) => decide({ trigger: "delegate", ...signal }, { level: 3, standing: false, planTool: true, allowance: 8 }, strategy),
        config: () => strategy,
      } });
      const pi = await loadOrchestrator();
      const ctx = { cwd: ws, ui: { notify(msg: string) { notes.push(msg); }, setStatus() {} } };
      await pi.handlers.get("session_start")({}, ctx);
      await pi.handlers.get("input")({ source: "interactive", text }, ctx);
      const classification: unknown = JSON.parse(fs.readFileSync(path.join(ws, ".pi", "task-classification.json"), "utf8"));
      assert.ok(typeof classification === "object" && classification !== null, "the classification is an object");
      const taskType: unknown = Reflect.get(classification, "taskType");
      await pi.commands.get("orchestrate").handler("status", ctx);
      const steered = fs.existsSync(path.join(ws, ".pi", "ctx-contributions", "orchestrator.json"));
      await pi.commands.get("orchestrate").handler("auto", ctx);
      await pi.commands.get("orchestrate").handler("on", ctx);
      return { steered, taskType, forced: contribution(ws), notes };
    } finally {
      Reflect.deleteProperty(globalThis, EFFORT_KEY);
      restore();
      rmWorkspace(ws);
    }
  };
  const lowered = await run(2, "implement the parser");
  assert.equal(lowered.steered, true, "delegateScore 2 gives a score 2 task a directive");
  assert.equal(lowered.taskType, "complex", "and provider-router routes the task the directive went to");
  assert.match(lowered.notes.join("\n"), /threshold 2/, "/orchestrate reports the policy's number");
  assert.equal((await run(3, "implement the parser")).steered, false, "and at 3 the same task gets none");
  const raised = await run(5, "implement the parser");
  assert.match(raised.forced, /complexity: 5/, "/orchestrate on forces the policy's number, or the policy would say none");
  assert.match(raised.forced, /workflow_run/, "so the policy's own text arrives");
  const under = await run(5, "implement the full parser");
  assert.equal(under.steered, false, "delegateScore 5 gives a score 3 task no directive");
  assert.equal(under.taskType, "simple", "and provider-router does not route it as complex");
}

const tests: Array<[name: string, fn: () => Promise<void>]> = [
  ["the delegation directive comes from the policy, in at most 600 chars, without chain", testDirectiveComesFromThePolicy],
  ["without the policy the directive is one line and nothing throws", testDirectiveFallsBackToOneLine],
  ["/orchestrate on stands where the policy says none, in a line that is true there", testForcedOnOutlastsThePolicy],
  ["strategy.delegateScore is the one threshold", testPolicyOwnsTheThreshold],
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
