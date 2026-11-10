#!/usr/bin/env node
/**
 * One decision policy (DESIGN §4). `decide()` turns a signal into one move and its text; effort adds
 * only the card's epoch state. Every row of the table is pinned here, then G6 through the real
 * progress-guard and recovery-orchestrator: writes no longer clear attempts, so a cosmetic edit
 * cannot reset the cap, while a passing board, a user turn or a quiet stretch does. Then the card,
 * the prompt at tiers below the triggers, and the `strategy` block in both validators.
 *
 * Deterministic and offline: fake pi, temp HOME and PI_CODING_AGENT_DIR, no model.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fakePi, isolateKitEnv, loadExtension, loadModule, rmWorkspace, setEnv, tmpWorkspace } from "../packages/core/eval/harness.ts";
import { loadEffortPolicy, validateEffortPolicy } from "../packages/core/lib/effort.ts";
import type * as EffortModule from "../packages/extensions/src/effort/index.ts";
import type { EffortRegistry } from "../packages/extensions/src/effort/index.ts";
import type * as PolicyModule from "../packages/extensions/src/effort/policy.ts";
import type * as StrategyModule from "../packages/extensions/src/effort/strategy.ts";
import type { Signal, StrategyConfig } from "../packages/extensions/src/effort/strategy.ts";
import type * as PlanModule from "../packages/extensions/third_party/subagent/plan.ts";
import type * as AgentsModule from "../packages/extensions/third_party/subagent/agents.ts";

type FakePi = ReturnType<typeof fakePi>;
type EffortView = Omit<typeof EffortModule, "default"> & { default: (api: FakePi["api"] & { appendEntry: (t: string, d?: unknown) => void; setActiveTools: (names: string[]) => void }) => void };

const restoreEnv = isolateKitEnv();
const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-strategy-"));
const restores = [setEnv("HOME", path.join(root, "home")), setEnv("PI_CODING_AGENT_DIR", path.join(root, "agent"))];
fs.mkdirSync(path.join(root, "home"), { recursive: true });

const loadStrategy = (): Promise<typeof StrategyModule> => loadModule("extensions/effort/strategy.ts");
const CONFIG: StrategyConfig = { planMinTier: 5, splitMinTier: 3, delegateScore: 3, reviewLines: 400, stallAfter: 2, quietTurns: 20, maxAttempts: 2, expandDepth: 3 };
const repoFile = (rel: string): string => fs.readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

// ---- DESIGN §4, row by row ------------------------------------------------------------------

interface Row { name: string; signal: Signal; level: number; standing?: boolean; planTool?: boolean; allowance?: number; move: string; steer: RegExp | null; card: boolean }

const ROWS: Row[] = [
  { name: "plan at E5 with the plan tool", signal: { trigger: "plan" }, level: 5, move: "plan", steer: /workflow_run/, card: true },
  { name: "plan in standing mode below E5", signal: { trigger: "plan" }, level: 4, standing: true, move: "plan", steer: /workflow_run/, card: true },
  { name: "plan below E5", signal: { trigger: "plan" }, level: 4, move: "none", steer: null, card: false },
  { name: "plan without the plan tool", signal: { trigger: "plan" }, level: 5, planTool: false, move: "none", steer: null, card: false },
  { name: "delegate at E3", signal: { trigger: "delegate", score: 3 }, level: 3, move: "plan", steer: /workflow_run \{steps\}/, card: false },
  { name: "delegate at E2", signal: { trigger: "delegate", score: 3 }, level: 2, move: "plan", steer: /`subagent`/, card: false },
  { name: "delegate at E3 without the plan tool", signal: { trigger: "delegate", score: 5 }, level: 3, planTool: false, move: "plan", steer: /`subagent`/, card: false },
  { name: "delegate at E1", signal: { trigger: "delegate", score: 9 }, level: 1, move: "none", steer: null, card: false },
  { name: "delegate under the score", signal: { trigger: "delegate", score: 2 }, level: 3, move: "none", steer: null, card: false },
  { name: "review of a large diff at E3", signal: { trigger: "review", changedLines: 400 }, level: 3, move: "plan", steer: /review-changes/, card: false },
  { name: "review of a smaller diff", signal: { trigger: "review", changedLines: 399 }, level: 3, move: "none", steer: null, card: false },
  { name: "review of a large diff at E2", signal: { trigger: "review", changedLines: 4000 }, level: 2, move: "none", steer: null, card: false },
  { name: "first stall detection", signal: { trigger: "stall", signature: "stall", detections: 1 }, level: 3, move: "reorient", steer: /different next action/, card: false },
  { name: "recurring stall", signal: { trigger: "stall", signature: "stall", detections: 2 }, level: 3, move: "angle", steer: /change approach/, card: false },
  { name: "recovery attempt 1", signal: { trigger: "stall", signature: "stall", attempt: 1 }, level: 5, move: "angle", steer: null, card: false },
  { name: "recovery attempt 2 at E3", signal: { trigger: "stall", signature: "stall", attempt: 2 }, level: 3, move: "split", steer: /expand: true/, card: true },
  { name: "recovery attempt 2 at E2", signal: { trigger: "stall", signature: "stall", attempt: 2 }, level: 2, move: "angle", steer: null, card: false },
  { name: "recovery attempt 2 without the plan tool", signal: { trigger: "stall", signature: "stall", attempt: 2 }, level: 4, planTool: false, move: "angle", steer: null, card: false },
  { name: "recovery attempt 2 where an expand step does not fit", signal: { trigger: "stall", signature: "stall", attempt: 2 }, level: 3, allowance: 1, move: "angle", steer: null, card: false },
  { name: "recovery past the cap", signal: { trigger: "stall", signature: "stall", attempt: 3 }, level: 5, move: "human", steer: null, card: false },
  { name: "first verify FAIL", signal: { trigger: "verify-fail", repeatFail: false }, level: 5, move: "none", steer: null, card: false },
  { name: "repeat verify FAIL at E3", signal: { trigger: "verify-fail", repeatFail: true }, level: 3, move: "split", steer: /expand: true/, card: true },
  { name: "repeat verify FAIL at E2", signal: { trigger: "verify-fail", repeatFail: true }, level: 2, move: "none", steer: null, card: false },
  { name: "bare /boost", signal: { trigger: "boost" }, level: 1, move: "angle", steer: /goal/, card: false },
];

async function testEveryRow(): Promise<void> {
  const { decide } = await loadStrategy();
  for (const row of ROWS) {
    const decision = decide(row.signal, { level: row.level, standing: row.standing ?? false, planTool: row.planTool ?? true, allowance: row.allowance ?? 8 }, CONFIG);
    assert.equal(decision.move, row.move, row.name);
    assert.equal(decision.card, row.card, `${row.name}: card`);
    if (row.steer) assert.match(decision.steer ?? "", row.steer, `${row.name}: steer`);
    else assert.equal(decision.steer, null, `${row.name}: no steer`);
  }
}

/** The rule on `split`, and what S8e learned about `expand`, for every tier at every attempt. */
async function testSplitRules(): Promise<void> {
  const { decide, EXPAND_STEP_AGENTS } = await loadStrategy();
  assert.equal(EXPAND_STEP_AGENTS, 2, "an expand step counts as 2 agents (docs/workflows.md)");
  for (const level of [1, 2, 3, 4, 5]) {
    for (const attempt of [1, 2]) {
      const { move } = decide({ trigger: "stall", attempt }, { level, standing: false, planTool: true, allowance: 64 }, CONFIG);
      assert.equal(move, attempt === 2 && level >= 3 ? "split" : "angle", `E${String(level)} attempt ${String(attempt)}`);
    }
  }
  // The policy can lower splitMinTier, but E2's allowance still cannot hold an expand step.
  const lowered = { ...CONFIG, splitMinTier: 2 };
  assert.equal(decide({ trigger: "stall", attempt: 2 }, { level: 2, standing: false, planTool: true, allowance: 1 }, lowered).move, "angle");
  assert.equal(decide({ trigger: "stall", attempt: 2 }, { level: 2, standing: false, planTool: true, allowance: 2 }, lowered).move, "split");
  // The cap wins over the rung: with one attempt allowed, attempt 2 is the human's.
  assert.equal(decide({ trigger: "stall", attempt: 2 }, { level: 5, standing: false, planTool: true, allowance: 64 }, { ...CONFIG, maxAttempts: 1 }).move, "human");
  // More attempts never repeat the rung: counters only rise, and split is attempt 2.
  assert.equal(decide({ trigger: "stall", attempt: 3 }, { level: 5, standing: false, planTool: true, allowance: 64 }, { ...CONFIG, maxAttempts: 3 }).move, "angle");
  const steer = decide({ trigger: "stall", attempt: 2 }, { level: 3, standing: false, planTool: true, allowance: 8 }, CONFIG).steer ?? "";
  assert.match(steer, /read-only/, "the steer says a read-only planner cannot expand into writers");
}

async function testMovesChangeNoAuthority(): Promise<void> {
  const { decide } = await loadStrategy();
  const inputs = { level: 3, standing: false, planTool: true, allowance: 8 };
  const snapshot = JSON.stringify([inputs, CONFIG]);
  for (const row of ROWS) decide(row.signal, inputs, CONFIG);
  assert.equal(JSON.stringify([inputs, CONFIG]), snapshot, "decide changes nothing it is given");
  for (const name of ["strategy.ts"]) {
    const source = repoFile(`packages/extensions/src/effort/${name}`);
    assert.doesNotMatch(source, /from "node:|process\.|globalThis|Date\.now|Math\.random/, "strategy.ts is pure");
  }
  const dirs = fs.readdirSync(new URL("../packages/extensions/src/", import.meta.url));
  const callers = dirs.filter((dir) => {
    const file = `packages/extensions/src/${dir}/index.ts`;
    return fs.existsSync(new URL(`../${file}`, import.meta.url)) && /\.setRecoveryActive\?*\.?\(/.test(repoFile(file)) && dir !== "effort";
  });
  assert.deepEqual(callers, ["recovery-orchestrator"], "recoveryOn is reached only through recovery-orchestrator");
  assert.doesNotMatch(repoFile("packages/extensions/src/effort/strategy.ts"), /setRecoveryActive/);
}

async function testEnvironmentStillRules(): Promise<void> {
  const { strategyConfig } = await loadStrategy();
  assert.deepEqual(strategyConfig(CONFIG, {}), CONFIG, "no environment: the policy's numbers");
  const set = strategyConfig(CONFIG, { PI_KIT_GUARD_ESCALATE: "5", PI_KIT_RECOVERY_MAX_ATTEMPTS: "4", PI_KIT_ORCH_THRESHOLD: "6" });
  assert.deepEqual([set.stallAfter, set.maxAttempts, set.delegateScore], [5, 4, 6]);
  const junk = strategyConfig(CONFIG, { PI_KIT_GUARD_ESCALATE: "soon", PI_KIT_RECOVERY_MAX_ATTEMPTS: "0", PI_KIT_ORCH_THRESHOLD: "-1" });
  assert.deepEqual(junk, CONFIG, "a value that is no positive number is ignored, as today");
}

// ---- G6, through the real extensions --------------------------------------------------------

interface Stuck { guard: FakePi; recovery: FakePi; ws: string; ctx: { cwd: string; hasUI: boolean; ui: { notify(): void; setStatus(): void } } }

/** The part of pi's event bus the extensions use, keeping channels and honouring the off it returns. */
function sharedBus(): { emit(channel: string, data: unknown): void; on(channel: string, listen: (data: unknown) => void): () => void; count(channel: string): number } {
  const channels = new Map<string, Set<(data: unknown) => void>>();
  return {
    emit: (channel, data) => { for (const listen of [...channels.get(channel) ?? []]) listen(data); },
    on: (channel, listen) => {
      const set = channels.get(channel) ?? new Set();
      channels.set(channel, set);
      const once = (data: unknown): void => { listen(data); };
      set.add(once);
      return () => { set.delete(once); };
    },
    count: (channel) => channels.get(channel)?.size ?? 0,
  };
}

async function stuck(prefix: string, events?: ReturnType<typeof sharedBus>): Promise<Stuck> {
  const ws = tmpWorkspace(prefix);
  const ctx = { cwd: ws, hasUI: false, ui: { notify() {}, setStatus() {} } };
  const guard = fakePi();
  (await loadExtension("extensions/progress-guard/index.ts"))({ ...guard.api, ...(events ? { events } : {}) });
  const recovery = fakePi();
  (await loadExtension("extensions/recovery-orchestrator/index.ts"))({ ...recovery.api, ...(events ? { events } : {}) });
  await guard.handlers.get("session_start")({}, ctx);
  await recovery.handlers.get("session_start")({}, ctx);
  return { guard, recovery, ws, ctx };
}

/** `reads` turns of reading: from ten reads on, each turn fires the guard's stall signal. */
async function stall(s: Stuck, reads = 12): Promise<void> {
  for (let i = 0; i < reads; i++) {
    await s.guard.handlers.get("tool_call")({ toolName: "read", input: { path: `src/f${String(i)}.ts` } }, s.ctx);
    await s.guard.handlers.get("turn_end")({ entries: [] }, s.ctx);
    await s.recovery.handlers.get("turn_end")({ entries: [] }, s.ctx);
  }
}

async function edit(s: Stuck, file = "src/fix.ts"): Promise<void> {
  const event = { toolName: "edit", isError: false, input: { path: file } };
  await s.guard.handlers.get("tool_result")(event, s.ctx);
  // Delivered as pi does, to every listener: a recovery that still cleared on a write would show here.
  if (s.recovery.handlers.has("tool_result")) await s.recovery.handlers.get("tool_result")(event, s.ctx);
}

const quietTurns = async (s: Stuck, turns: number): Promise<void> => {
  for (let i = 0; i < turns; i++) await s.recovery.handlers.get("turn_end")({ entries: [] }, s.ctx);
};

const steerOf = (ws: string): string => fs.readFileSync(path.join(ws, ".pi", "ctx-contributions", "recovery-orchestrator.json"), "utf8");
const blocked = (ws: string): number => fs.readdirSync(path.join(ws, ".pi", "recovery")).filter((f) => f.startsWith("blocked-")).length;

function board(ws: string, verdicts: Record<string, { pass: boolean; at: string }>): void {
  fs.mkdirSync(path.join(ws, ".pi"), { recursive: true });
  fs.writeFileSync(path.join(ws, ".pi", "verdicts.json"), JSON.stringify({ verdicts }));
}

async function testEditThenRestallKeepsTheCap(): Promise<void> {
  const s = await stuck("pi-strategy-g6-");
  try {
    await stall(s);
    assert.match(steerOf(s.ws), /attempt 1\//);
    await edit(s);
    await stall(s);
    assert.match(steerOf(s.ws), /attempt 2\//, "an edit outside .pi then a re-stall within 20 turns stays attempt 2");
    await edit(s);
    await stall(s);
    assert.match(steerOf(s.ws), /give up gracefully/, "a cosmetic edit does not save the third stall from the cap");
    assert.equal(blocked(s.ws), 1);
  } finally {
    rmWorkspace(s.ws);
  }
}

async function testFiringStallIsNotQuiet(): Promise<void> {
  const s = await stuck("pi-strategy-firing-", sharedBus());
  try {
    await stall(s);
    assert.match(steerOf(s.ws), /attempt 1\//);
    await stall(s, 25); // 25 turns that all fire: the same stall, however long it runs
    await edit(s);
    await stall(s);
    assert.match(steerOf(s.ws), /attempt 2\//, "a stall still firing after 20 turns keeps its attempts");
  } finally {
    rmWorkspace(s.ws);
  }
}

async function testReloadLeavesNoListener(): Promise<void> {
  const bus = sharedBus();
  const REASSESS = "pi-kit:recovery-reassess";
  const s = await stuck("pi-strategy-reload-", bus);
  try {
    await s.recovery.handlers.get("session_start")({}, s.ctx);
    assert.equal(bus.count(REASSESS), 1, "a second session_start replaces the listener");
    assert.equal(bus.count("pi-kit:stall-seen"), 1);
    await s.guard.commands.get("boost").handler("", s.ctx);
    await s.guard.commands.get("boost").handler("", s.ctx);
    assert.match(steerOf(s.ws), /attempt 2\//, "the old instance has spent both attempts");

    await s.recovery.handlers.get("session_shutdown")({}, s.ctx);
    assert.equal(bus.count(REASSESS), 0, "shutdown leaves nothing on a bus that survives /reload");
    assert.equal(bus.count("pi-kit:stall-seen"), 0);

    const reloaded = fakePi();
    (await loadExtension("extensions/recovery-orchestrator/index.ts"))({ ...reloaded.api, events: bus });
    await reloaded.handlers.get("session_start")({}, s.ctx);
    await s.guard.commands.get("boost").handler("", s.ctx);
    assert.match(steerOf(s.ws), /attempt 1\//, "the new instance takes /boost with its own count");
    assert.equal(blocked(s.ws), 0, "the old instance's spent attempts stop no loop");
  } finally {
    rmWorkspace(s.ws);
  }
}

async function testSpacedStallsDoNotCap(): Promise<void> {
  const s = await stuck("pi-strategy-spaced-");
  try {
    for (let episode = 0; episode < 4; episode++) {
      await stall(s);
      assert.match(steerOf(s.ws), /attempt 1\//, `stall ${String(episode)} after 20 quiet turns is a new start`);
      await edit(s);
      await quietTurns(s, 20);
    }
    assert.equal(blocked(s.ws), 0, "a long autonomous turn with spaced stalls does not cap");
  } finally {
    rmWorkspace(s.ws);
  }
}

async function testUserTurnClearsAttempts(): Promise<void> {
  const s = await stuck("pi-strategy-user-");
  try {
    await stall(s);
    await edit(s);
    await s.recovery.handlers.get("input")({ source: "extension", text: "Continue" }, s.ctx);
    await stall(s);
    assert.match(steerOf(s.ws), /attempt 2\//, "a loop's own Continue is not a user turn");
    await s.recovery.handlers.get("input")({ source: "interactive", text: "/boost" }, s.ctx);
    await edit(s);
    await stall(s);
    assert.match(steerOf(s.ws), /give up gracefully/, "a slash command is not a user turn");
    await s.recovery.handlers.get("input")({ source: "interactive", text: "try the other module" }, s.ctx);
    await edit(s);
    await stall(s);
    assert.match(steerOf(s.ws), /attempt 1\//, "your message starts the count again");
  } finally {
    rmWorkspace(s.ws);
  }
}

async function testBoardPassClearsAttempts(): Promise<void> {
  const s = await stuck("pi-strategy-board-");
  try {
    const long = new Date(Date.now() - 60_000).toISOString();
    // Each of these fails to clear: passing before the attempt, only an untrusted PASS, one FAIL
    // beside a PASS, and an empty board.
    board(s.ws, { verify: { pass: true, at: long } });
    await stall(s);
    assert.match(steerOf(s.ws), /attempt 1\//);
    await edit(s);
    await stall(s);
    assert.match(steerOf(s.ws), /attempt 2\//, "a board that passed before the attempt says nothing about it");
    board(s.ws, { reviewer: { pass: true, at: new Date(Date.now() + 1000).toISOString() } });
    await edit(s);
    await stall(s);
    assert.match(steerOf(s.ws), /give up gracefully/, "a PASS from an untrusted source does not clear attempts");
  } finally {
    rmWorkspace(s.ws);
  }
  const t = await stuck("pi-strategy-board-pass-");
  try {
    await stall(t);
    await edit(t);
    await new Promise((resolve) => setTimeout(resolve, 5));
    board(t.ws, { verify: { pass: true, at: new Date().toISOString() }, tests: { pass: false, at: new Date().toISOString() } });
    await stall(t);
    assert.match(steerOf(t.ws), /attempt 2\//, "one failing source means the board does not pass");
    await edit(t);
    await new Promise((resolve) => setTimeout(resolve, 5));
    board(t.ws, { verify: { pass: true, at: new Date().toISOString() } });
    await stall(t);
    assert.match(steerOf(t.ws), /attempt 1\//, "a trusted PASS after the attempt clears it");
  } finally {
    rmWorkspace(t.ws);
  }
}

async function testWritesStillStopTheNudge(): Promise<void> {
  const s = await stuck("pi-strategy-reset-");
  try {
    await stall(s, 8);
    await edit(s);
    await s.guard.handlers.get("turn_end")({ entries: [] }, s.ctx);
    assert.ok(!fs.existsSync(path.join(s.ws, ".pi", "recovery", "escalation.json")), "the guard's own counters still reset on a write");
  } finally {
    rmWorkspace(s.ws);
  }
}

// ---- effort: the card and the prompt --------------------------------------------------------

const registry = (): EffortRegistry => (globalThis as Record<symbol, unknown>)[Symbol.for("pi-kit.effort")] as EffortRegistry;
const ALL_TOOLS = ["read", "bash", "write", "edit", "subagent", "workflow_run", "workflow"];

async function bootEffort(tier: string, tools: string[] = ALL_TOOLS): Promise<{ pi: FakePi; ctx: object; done: () => void }> {
  const mod: EffortView = await loadModule("extensions/effort/index.ts");
  const pin = setEnv("PI_KIT_EFFORT", tier);
  const pi = fakePi();
  let active = [...tools];
  mod.default({ ...pi.api, getActiveTools: () => [...active], setActiveTools: (names: string[]) => { active = [...names]; }, appendEntry: () => {} });
  const ctx = { hasUI: true, cwd: root, ui: { notify() {}, setStatus() {}, select: (_title: string, options: string[]) => Promise.resolve(options[1]) }, abort() {} };
  await pi.handlers.get("session_start")({ reason: "startup" }, ctx);
  return { pi, ctx, done: pin };
}

const userTurn = async (pi: FakePi, ctx: object, messageType: string = "user") => pi.handlers.get("before_agent_start")({ systemPrompt: "BASE", messageType, message: { customType: "x" } }, ctx);
const hiddenText = (result: { message?: { content?: unknown } } | undefined): string => (typeof result?.message?.content === "string" ? result.message.content : "");

async function testCardOncePerEpoch(): Promise<void> {
  const { pi, ctx, done } = await bootEffort("exhaustive");
  try {
    const first = await userTurn(pi, ctx);
    assert.match(first?.systemPrompt ?? "", /workflow_run/, "one sentence in the effort block");
    assert.match(hiddenText(first), /Workflow plans/, "the card arrives once");
    const again = [];
    for (let i = 0; i < 19; i++) again.push(await userTurn(pi, ctx));
    assert.equal(again.filter((r) => hiddenText(r).includes("Workflow plans")).length, 0, "once across 20 turns");
    assert.ok(again.every((r) => /workflow_run/.test(r?.systemPrompt ?? "")), "the per-turn sentence stays");
    await pi.handlers.get("session_compact")({}, ctx);
    assert.match(hiddenText(await userTurn(pi, ctx)), /Workflow plans/, "again after a compaction");
    assert.equal(hiddenText(await userTurn(pi, ctx)), "", "and then not again");
    const wake = await userTurn(pi, ctx, "custom");
    assert.doesNotMatch(wake?.systemPrompt ?? "", /workflow_run \{steps\}/, "the plan trigger is a user message");
  } finally {
    done();
  }
}

async function testCardJoinsTheReminder(): Promise<void> {
  const { pi, ctx, done } = await bootEffort("exhaustive");
  try {
    await pi.commands.get("effort").handler("ultracode", ctx);
    const result = await userTurn(pi, ctx);
    const text = hiddenText(result);
    assert.match(text, /ultracode standing mode is on/, "the standing reminder");
    assert.match(text, /Workflow plans/, "and the card, in the one message");
    assert.equal(hiddenText(await userTurn(pi, ctx)).includes("Workflow plans"), false);
  } finally {
    done();
  }
}

async function testCardNeverInAChild(): Promise<void> {
  const child = setEnv("PI_KIT_INTERNAL_CHILD", "1");
  const { pi, ctx, done } = await bootEffort("exhaustive");
  try {
    const result = await userTurn(pi, ctx);
    assert.equal(result?.message, undefined, "no card in a child");
    assert.doesNotMatch(result?.systemPrompt ?? "", /workflow_run \{steps\}/, "no plan sentence in a child");
    for (const row of ROWS) assert.deepEqual(registry().strategy.report(row.signal), { move: "none", steer: null, card: false }, `child: ${row.name}`);
  } finally {
    done();
    child();
  }
}

async function testLowerTiersAreByteIdentical(): Promise<void> {
  const policyMod: typeof PolicyModule = await loadModule("extensions/effort/policy.ts");
  const policy = policyMod.loadPolicy();
  for (const tier of ["minimal", "focused", "standard", "thorough"]) {
    const { pi, ctx, done } = await bootEffort(tier);
    try {
      const result = await userTurn(pi, ctx);
      assert.equal(result?.systemPrompt, policyMod.withEffortBlock("BASE", policyMod.renderPrompt(policy, tier)), `${tier}: nothing added at none`);
      assert.equal(result?.message, undefined, `${tier}: no message`);
    } finally {
      done();
    }
  }
}

/** Mid-run the card waits for the next prompt, in the one message slot: a split reaches it. */
async function testSplitQueuesTheCard(): Promise<void> {
  const { pi, ctx, done } = await bootEffort("standard");
  try {
    const decision = registry().strategy.report({ trigger: "stall", signature: "stall", attempt: 2 });
    assert.equal(decision?.move, "split");
    assert.equal(decision?.card, true);
    assert.deepEqual(registry().strategy.report({ trigger: "verify-fail", repeatFail: true }), { ...decision, card: false }, "seen this epoch");
    assert.match(hiddenText(await userTurn(pi, ctx)), /Workflow plans/);
    assert.equal(hiddenText(await userTurn(pi, ctx)), "", "delivered once");
  } finally {
    done();
  }
}

async function testRegistryTakesTierFromEffort(): Promise<void> {
  const { done } = await bootEffort("focused");
  try {
    assert.equal(registry().strategy.report({ trigger: "stall", attempt: 2 })?.move, "angle", "E2 stays on scouts: tier comes from effort");
    assert.equal(registry().strategy.config().expandDepth, 3, "one block, extended");
  } finally {
    done();
  }
  const hidden = await bootEffort("thorough", ["read", "subagent"]);
  try {
    assert.equal(registry().strategy.report({ trigger: "stall", attempt: 2 })?.move, "angle", "tool activity comes from effort");
    assert.match(registry().strategy.report({ trigger: "delegate", score: 4 })?.steer ?? "", /`subagent`/);
  } finally {
    hidden.done();
  }
}

/** What a recovery entry does under the real policy: the rung, the card, and recovery's own limits. */
async function testRecoveryFollowsThePolicy(): Promise<void> {
  const setup = async (tier: string, env: Array<() => void> = []): Promise<{ s: Stuck; pi: FakePi; ctx: object; end: () => Promise<void> }> => {
    const { pi, ctx, done } = await bootEffort(tier);
    const s = await stuck(`pi-strategy-rungs-${tier}-`);
    return { s, pi, ctx, end: async () => { await pi.handlers.get("session_shutdown")({}, ctx); done(); for (const r of env) r(); rmWorkspace(s.ws); } };
  };
  const mark = (ws: string): void => {
    fs.mkdirSync(path.join(ws, ".pi", "recovery"), { recursive: true });
    fs.writeFileSync(path.join(ws, ".pi", "recovery", "escalation.json"), JSON.stringify({ signature: "stall", reason: "stuck", count: 2, at: new Date().toISOString() }));
  };
  const enter = async (s: Stuck): Promise<void> => {
    mark(s.ws);
    await s.recovery.handlers.get("turn_end")({ entries: [] }, s.ctx);
  };

  const e3 = await setup("standard");
  try {
    await enter(e3.s);
    assert.match(steerOf(e3.s.ws), /Fan out 3 fresh scouts/, "attempt 1 is scouts, no later than before");
    await enter(e3.s);
    const steer = steerOf(e3.s.ws);
    assert.match(steer, /attempt 2\/2/);
    assert.match(steer, /expand: true/, "attempt 2 at E3 splits");
    assert.doesNotMatch(steer, /Fan out/);
    assert.match(steer, /recovery report at/, "the report stays");
    assert.match(hiddenText(await userTurn(e3.pi, e3.ctx)), /Workflow plans/, "the card follows at the next prompt");
    await enter(e3.s);
    assert.match(steerOf(e3.s.ws), /give up gracefully/, "past the cap: the human");
    assert.equal(blocked(e3.s.ws), 1);
  } finally {
    await e3.end();
  }

  const e2 = await setup("focused");
  try {
    await enter(e2.s);
    await enter(e2.s);
    assert.match(steerOf(e2.s.ws), /attempt 2\/2[\s\S]*Fan out 3 fresh scouts/, "E2 stays on scouts");
  } finally {
    await e2.end();
  }

  const more = await setup("standard", [setEnv("PI_KIT_RECOVERY_MAX_ATTEMPTS", "3")]);
  try {
    await enter(more.s);
    await enter(more.s);
    await enter(more.s);
    assert.match(steerOf(more.s.ws), /attempt 3\/3[\s\S]*Fan out/, "the operator's cap rules, and the split does not repeat");
  } finally {
    await more.end();
  }
}

/** The card is a plan a model may copy: its example compiles, and it says what S8e found. */
async function testCardText(): Promise<void> {
  const text = repoFile("packages/extensions/src/effort/policy/workflow-card.md");
  assert.ok(text.length < 1200, `the card is under 1,200 chars (got ${String(text.length)})`);
  assert.match(text, /skills/, "the card names skills");
  assert.match(text, /fail/, "the card names failure");
  assert.match(text, /pass|PASS/, "and success");
  assert.match(text, /gate/, "a gate");
  assert.match(text, /max_loops/, "with bounded retries");
  assert.match(text, /expand/, "the card teaches expand");
  assert.match(text, /one step, one file and one check/, "and the direct rule");
  assert.match(text, /read-only/, "a read-only planner cannot expand into writers");
  assert.match(text, /2 agents/, "an expand step costs 2");
  assert.match(text, /E3/, "so it does not fit E2");
  assert.match(text, /gate cannot go back over/, "a gate cannot rewind over an expand step");
  const example = /^\{"steps".*$/m.exec(text)?.[0];
  assert.ok(example, "the card has one example");
  const plan: typeof PlanModule = await loadModule("vendor/subagent/plan.ts");
  const agents: typeof AgentsModule = await loadModule("vendor/subagent/agents.ts");
  const parsed: unknown = JSON.parse(example);
  const steps: unknown = typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "steps") : undefined;
  const compiled = plan.compilePlan(steps, agents.discoverAgents(root, "both").agents);
  assert.ok(compiled.ok, `the card's example compiles: ${compiled.ok ? "" : JSON.stringify(compiled.errors)}`);
}

/** E5 and standing mode teach plans as resources, and S13 removed the per-call rule. */
async function testTierTexts(): Promise<void> {
  const exhaustive = repoFile("packages/extensions/src/effort/policy/exhaustive.md");
  assert.match(exhaustive, /workflow_run/, "E5 names the plan tool");
  assert.match(exhaustive, /plan/, "E5 says to plan");
  assert.match(exhaustive, /one step, one file and one check/, "E5 states the trivial rule");
  assert.match(exhaustive, /direct/, "and that such a task is done directly");
  assert.doesNotMatch(repoFile("packages/extensions/src/effort/policy/standing.md"), /per-call rule/, "S13 removed the tool text the per-call rule described");
}

/** The skill leads with plans, the script API lives in its reference file, and S13's names are gone. */
async function testTeachingSkills(): Promise<void> {
  const skill = repoFile("packages/kit/skills/workflow-authoring/SKILL.md");
  assert.match(skill, /^---\nname: workflow-authoring\n/, "the skill keeps its frontmatter");
  assert.match(skill, /disable-model-invocation: true/, "and stays hidden unless named");
  const plan = skill.indexOf("workflow_run");
  const scripts = skill.indexOf("## Script workflows");
  assert.ok(plan >= 0, "the skill teaches inline plans");
  assert.ok(scripts > plan, "plans come before the script section");
  assert.match(skill, /references\/scripts\.md/, "the script API is in the reference file");
  const reference = repoFile("packages/kit/skills/workflow-authoring/references/scripts.md");
  for (const word of ["agent(", "parallel(", "pipeline(", "scriptPath", "resumeFromRunId"]) assert.ok(reference.includes(word), `the reference covers ${word}`);
  const orchestration = repoFile("packages/kit/skills/agent-orchestration/SKILL.md");
  assert.doesNotMatch(orchestration, /delegator|subagent_status|subagent_stop|\/subagents/);
  assert.doesNotMatch(orchestration, /chain:/);
  assert.match(orchestration, /workflow-authoring/);
}

// ---- the strategy block in both validators ---------------------------------------------------

async function testBothValidators(): Promise<void> {
  const policyMod: typeof PolicyModule = await loadModule("extensions/effort/policy.ts");
  const dir = policyMod.policyDir();
  const raw: unknown = JSON.parse(fs.readFileSync(path.join(dir, "effort.json"), "utf8"));
  assert.ok(typeof raw === "object" && raw !== null);
  const shipped = policyMod.loadPolicy();
  assert.deepEqual(shipped.strategy, CONFIG, "the shipped numbers are DESIGN §4's");
  assert.deepEqual(loadEffortPolicy().strategy, shipped.strategy, "the two readers agree");
  const problems = (strategy: unknown): [string[], string[]] => {
    const policy = { ...raw, strategy };
    const pick = (list: string[]): string[] => list.filter((p) => p.includes("strategy"));
    return [pick(validateEffortPolicy(policy, dir)), pick(policyMod.validatePolicy(policy, dir))];
  };
  assert.deepEqual(problems(undefined), [[], []], "the block may be left out");
  assert.deepEqual(problems(CONFIG), [[], []]);
  const bad: unknown[] = [
    "fast",
    {},
    { ...CONFIG, planMinTier: 0 },
    { ...CONFIG, planMinTier: 6 },
    { ...CONFIG, splitMinTier: 1.5 },
    { ...CONFIG, delegateScore: 0 },
    { ...CONFIG, reviewLines: "many" },
    { ...CONFIG, stallAfter: -1 },
    { ...CONFIG, quietTurns: 0 },
    { ...CONFIG, maxAttempts: null },
    { ...CONFIG, expandDepth: 0 },
  ];
  for (const strategy of bad) {
    const [core, runtime] = problems(strategy);
    assert.ok(core.length > 0, `toolchain refuses ${JSON.stringify(strategy)}`);
    assert.deepEqual(core, runtime, `the two validators say the same about ${JSON.stringify(strategy)}`);
  }
}

const tests: Array<[string, () => Promise<void>]> = [
  ["every row of DESIGN §4", testEveryRow],
  ["split only at attempt 2, level 3 or above, with an allowance that holds an expand step", testSplitRules],
  ["decide is pure and no move touches authority", testMovesChangeNoAuthority],
  ["PI_KIT_GUARD_ESCALATE, PI_KIT_RECOVERY_MAX_ATTEMPTS and PI_KIT_ORCH_THRESHOLD still rule", testEnvironmentStillRules],
  ["G6: an edit outside .pi then a re-stall within 20 turns keeps the cap", testEditThenRestallKeepsTheCap],
  ["a stall that keeps firing is not a quiet stretch", testFiringStallIsNotQuiet],
  ["/reload leaves no listener on the bus, and the old instance takes no /boost", testReloadLeavesNoListener],
  ["a long autonomous turn with spaced stalls does not cap", testSpacedStallsDoNotCap],
  ["a user turn clears attempts; a loop's Continue and a slash command do not", testUserTurnClearsAttempts],
  ["a real board pass clears attempts; a stale, untrusted or mixed board does not", testBoardPassClearsAttempts],
  ["a write still resets the guard's own detection", testWritesStillStopTheNudge],
  ["the card comes once across 20 turns and again after session_compact", testCardOncePerEpoch],
  ["the card joins the standing reminder in one message", testCardJoinsTheReminder],
  ["never in a child: no card, and every report is none", testCardNeverInAChild],
  ["below the triggers the prompt is byte-identical", testLowerTiersAreByteIdentical],
  ["a split queues the card for the next prompt", testSplitQueuesTheCard],
  ["tier and tool activity come from effort, never the caller", testRegistryTakesTierFromEffort],
  ["a recovery entry follows the policy: scouts, split with the card, human", testRecoveryFollowsThePolicy],
  ["the card's text and example", testCardText],
  ["E5 plans by default, the trivial rule is direct, and standing mode has no per-call rule", testTierTexts],
  ["the skills lead with plans and drop S13's names", testTeachingSkills],
  ["the strategy block in both validators", testBothValidators],
];

let failed = 0;
try {
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  OK: ${name}`);
    } catch (error) {
      failed++;
      console.error(`  FAIL: ${name}`);
      console.error(`    ${error instanceof Error ? error.message.split("\n")[0] ?? "" : String(error)}`);
    }
  }
} finally {
  for (const restore of restores.reverse()) restore();
  restoreEnv();
  rmWorkspace(root);
}
if (failed > 0) {
  console.error(`\n[workflow-strategy-smoke] ${String(failed)}/${String(tests.length)} FAILED`);
  process.exit(1);
}
console.log(`\n[workflow-strategy-smoke] all ${String(tests.length)} checks passed`);
