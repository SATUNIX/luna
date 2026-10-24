#!/usr/bin/env node
/**
 * AG-07 regression coverage (the narrow contribution-budgeting mechanism, not the
 * broader unimplemented "budgets the whole prompt" claim). Fully offline — no live pi,
 * no network.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { BeforeAgentStartEventResult } from "@earendil-works/pi-coding-agent";
import { loadExtension, loadModule, fakePi, tmpWorkspace, rmWorkspace, setEnv, type FakePi } from "../packages/core/eval/harness.ts";
import { array, boolean, nullable, number, object, optional, parseJsonAs, string, type Infer } from "../packages/core/lib/guard.ts";
import type * as ContextSieve from "../packages/extensions/src/context-sieve/index.ts";

const sieveModule = await loadModule<typeof ContextSieve>("extensions/context-sieve/index.ts");

/** sieve-budget.json, the telemetry context-sieve writes after each turn: the fields these checks read. */
const SieveBudget = object({
  budget: number(),
  totalTokens: number(),
  included: array(string()),
  truncated: array(string()),
  contextWindow: optional(nullable(number())),
  windowClamped: optional(boolean()),
});
const readBudget = (file: string): Infer<typeof SieveBudget> => parseJsonAs(SieveBudget, fs.readFileSync(file, "utf8"), "sieve-budget.json");

async function loadSieve(ws: string): Promise<ReturnType<typeof fakePi>> {
  const register = await loadExtension("extensions/context-sieve/index.ts");
  const pi = fakePi();
  register(pi.api);
  await pi.handlers.get("session_start")({}, { cwd: ws });
  return pi;
}

/** context-sieve's before_agent_start result: always the system prompt, plus a text message when per-turn blocks changed. */
type SieveTurn = BeforeAgentStartEventResult & { systemPrompt: string; message?: { content: string } };
const sieveTurn = async (pi: FakePi, event: object): Promise<SieveTurn> => (await pi.handlers.get("before_agent_start")(event)) as SieveTurn;

function writeContrib(ws: string, id: string, priority: number, budgetTokens: number, content: string): void {
  const dir = path.join(ws, ".pi", "ctx-contributions");
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, priority, budgetTokens, content }));
}

// Independent repro: PI_KIT_CTX_BUDGET_TOKENS set to a non-numeric value previously
// parsed to NaN, and `used + len > NaN` is always false in JS, so budgeting silently
// disabled itself (everything included, unbounded) instead of falling back to a safe
// default.
async function testInvalidBudgetEnvFallsBackToDefault() {
  const ws = tmpWorkspace("pi-kit-ctxbudget-nan-");
  const restore = setEnv("PI_KIT_CTX_BUDGET_TOKENS", "not-a-number");
  try {
    const pi = await loadSieve(ws);
    // A contribution far larger than the real default budget (4096 tokens / ~16KB).
    writeContrib(ws, "huge", 5, 999999, "x".repeat(200000));
    await pi.handlers.get("before_agent_start")({ systemPrompt: "base" });
    const budget = readBudget(path.join(ws, ".pi", "ctx-contributions", "sieve-budget.json"));
    assert.ok(budget.budget > 0 && Number.isFinite(budget.budget), "an invalid env value must fall back to a real positive default, not NaN");
    assert.ok(budget.totalTokens < 200000, "budgeting must actually be enforced, not silently disabled");
  } finally {
    restore();
    rmWorkspace(ws);
  }
}

// A contribution's own declared budgetTokens must be respected even when the global
// budget has plenty of room left.
async function testPerContributionBudgetEnforced() {
  const ws = tmpWorkspace("pi-kit-ctxbudget-own-");
  const restore = setEnv("PI_KIT_CTX_BUDGET_TOKENS", "100000"); // plenty of global room
  try {
    const pi = await loadSieve(ws);
    writeContrib(ws, "capped", 5, 50, "y".repeat(5000)); // own budget: 50 tokens = 200 chars
    const result = await sieveTurn(pi, { systemPrompt: "base" });
    const includedLen = result.systemPrompt.length - "base\n\n".length;
    assert.ok(includedLen < 5000, "a contribution's own declared budgetTokens must cap it even with global room to spare");
    const budget = readBudget(path.join(ws, ".pi", "ctx-contributions", "sieve-budget.json"));
    assert.deepEqual(budget.truncated, ["capped"]);
  } finally {
    restore();
    rmWorkspace(ws);
  }
}

// A contribution that mostly fits should be truncated to use the remaining budget, not
// dropped wholesale when only a small amount is over.
async function testTruncationInsteadOfWholesaleDrop() {
  const ws = tmpWorkspace("pi-kit-ctxbudget-trunc-");
  const restore = setEnv("PI_KIT_CTX_BUDGET_TOKENS", "100"); // 400 chars total
  try {
    const pi = await loadSieve(ws);
    writeContrib(ws, "a", 10, 1000, "a".repeat(100)); // fits fully
    writeContrib(ws, "b", 5, 1000, "b".repeat(500)); // would have been dropped wholesale before
    await pi.handlers.get("before_agent_start")({ systemPrompt: "base" });
    const budget = readBudget(path.join(ws, ".pi", "ctx-contributions", "sieve-budget.json"));
    assert.ok(budget.included.includes("b"), "a contribution that mostly fits must be truncated into the summary, not dropped entirely");
    assert.ok(budget.truncated.includes("b"));
  } finally {
    restore();
    rmWorkspace(ws);
  }
}

// A contribution a producer re-writes with byte-identical content during the current
// session (goal-core re-materializes a surviving goal right after context-sieve's
// session_start handler, guidelines likewise) must still be included: it was written
// this session, even though its bytes match the session-start snapshot.
async function testRewrittenIdenticalContributionIsIncluded() {
  const ws = tmpWorkspace("pi-kit-ctxbudget-rewrite-");
  try {
    const dir = path.join(ws, ".pi", "ctx-contributions");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "goal-core.json");
    const body = JSON.stringify({ id: "goal-core", priority: 85, budgetTokens: 400, content: "## Active Goal\nShip it" });
    // Pre-existing from a prior session: captured by context-sieve's session_start snapshot.
    fs.writeFileSync(file, body);
    // Realistic leftover: an old mtime beyond the epoch grace window.
    const old = new Date(Date.now() - 3600_000);
    fs.utimesSync(file, old, old);
    const pi = await loadSieve(ws);
    // Producer re-materializes the identical contribution during session_start.
    await new Promise((r) => setTimeout(r, 5));
    fs.writeFileSync(file, body);
    const result = await sieveTurn(pi, { systemPrompt: "base" });
    assert.ok(result && /Active Goal/.test(result.systemPrompt), "a re-written identical contribution must enter the prompt this session");
  } finally {
    rmWorkspace(ws);
  }
}

// Compaction leaves native summarization intact; current contributions still
// use the ordinary sorted, budgeted prompt assembly.
async function testCompactionContributionsAreSortedAndBudgeted() {
  const ws = tmpWorkspace("pi-kit-ctxbudget-compact-");
  const restore = setEnv("PI_KIT_CTX_BUDGET_TOKENS", "50"); // 200 chars total
  try {
    const pi = await loadSieve(ws);
    const dir = path.join(ws, ".pi", "ctx-contributions");
    fs.writeFileSync(path.join(dir, "low.json"), JSON.stringify({ id: "low", priority: 1, budgetTokens: 1000, content: "LOW_PRIORITY_MARKER" }));
    fs.writeFileSync(path.join(dir, "high.json"), JSON.stringify({ id: "high", priority: 99, budgetTokens: 1000, content: "HIGH_PRIORITY_MARKER" }));
    const result = await pi.handlers.get("session_before_compact")({
      preparation: { messagesToSummarize: [], firstKeptEntryId: "e1", tokensBefore: 1 },
    });
    assert.equal(result, undefined, "compaction must preserve the native summarizer");
    const prompt = await sieveTurn(pi, { systemPrompt: "base" });
    const highIdx = prompt.systemPrompt.indexOf("HIGH_PRIORITY_MARKER");
    const lowIdx = prompt.systemPrompt.indexOf("LOW_PRIORITY_MARKER");
    assert.ok(highIdx >= 0 && (lowIdx === -1 || highIdx < lowIdx), "current contributions remain sorted and budgeted in prompt assembly");
  } finally {
    restore();
    rmWorkspace(ws);
  }
}

// Cache-friendly injection: per-turn contributions (memory recall, delegation directives)
// go into one hidden message, not the system prompt, so the provider's prompt cache survives;
// an unchanged block is not re-injected; compaction re-arms it.
async function testDynamicContributionsUseMessageChannel() {
  const ws = tmpWorkspace("pi-kit-ctxbudget-channel-");
  try {
    const pi = await loadSieve(ws);
    writeContrib(ws, "guidelines", 10, 500, "STATIC GUIDELINES");
    writeContrib(ws, "memory-local", 60, 400, "RECALLED MEMORY");
    const dir = path.join(ws, ".pi", "ctx-contributions");
    fs.writeFileSync(path.join(dir, "custom.json"), JSON.stringify({ id: "custom", priority: 5, budgetTokens: 100, content: "EXPLICIT MESSAGE", channel: "message" }));
    const r1 = await sieveTurn(pi, { systemPrompt: "base" });
    assert.match(r1.systemPrompt, /STATIC GUIDELINES/);
    // B-020: the top-level `included` telemetry must merge both channels, not just system.
    const budget = readBudget(path.join(dir, "sieve-budget.json"));
    assert.ok(budget.included.includes("guidelines"), "top-level included must list the system-channel contribution");
    assert.ok(budget.included.includes("memory-local"), "top-level included must list the message-channel contribution");
    assert.doesNotMatch(r1.systemPrompt, /RECALLED MEMORY/, "dynamic content must not rewrite the system prompt");
    assert.ok(r1.message, "a per-turn block is injected");
    assert.equal(r1.message.display, false);
    assert.match(r1.message.content, /RECALLED MEMORY[\s\S]*EXPLICIT MESSAGE/, "message-channel blocks are merged by priority");
    const r2 = await sieveTurn(pi, { systemPrompt: "base" });
    assert.equal(r2.message, undefined, "an unchanged block is not injected twice");
    assert.equal(r2.systemPrompt, r1.systemPrompt, "the system prompt stays byte-identical across turns");
    writeContrib(ws, "memory-local", 60, 400, "DIFFERENT MEMORY");
    const r3 = await sieveTurn(pi, { systemPrompt: "base" });
    assert.ok(r3.message, "a per-turn block is injected");
    assert.match(r3.message.content, /DIFFERENT MEMORY/);
    await pi.handlers.get("session_compact")({}, { cwd: ws });
    const r4 = await sieveTurn(pi, { systemPrompt: "base" });
    assert.ok(r4.message, "a per-turn block is injected");
    assert.match(r4.message.content, /DIFFERENT MEMORY/, "after compaction the block is injected again");
  } finally {
    rmWorkspace(ws);
  }
}

// EFF-4: the message channel is deduplicated per contribution, not as one joined block. When one
// contribution changes, only that contribution is injected again; the unchanged ones are named,
// not repeated, because their earlier copy is still in the conversation.
async function testMessageDedupeIsPerContribution() {
  const ws = tmpWorkspace("pi-kit-ctxbudget-percontrib-");
  try {
    const pi = await loadSieve(ws);
    writeContrib(ws, "orchestrator", 80, 800, "DELEGATION POLICY score=3");
    writeContrib(ws, "progress-guard", 78, 320, "LOOP NUDGE");
    writeContrib(ws, "autonomous-loop", 70, 500, "LOOP GOAL");
    const r1 = await sieveTurn(pi, { systemPrompt: "base" });
    assert.ok(r1.message, "the first turn injects every message-channel contribution");
    assert.match(r1.message.content, /DELEGATION POLICY score=3[\s\S]*LOOP NUDGE[\s\S]*LOOP GOAL/);
    writeContrib(ws, "orchestrator", 80, 800, "DELEGATION POLICY score=7");
    const r2 = await sieveTurn(pi, { systemPrompt: "base" });
    assert.ok(r2.message, "a changed contribution is injected");
    assert.match(r2.message.content, /DELEGATION POLICY score=7/);
    assert.doesNotMatch(r2.message.content, /LOOP NUDGE|LOOP GOAL/, "unchanged contributions are not injected again");
    assert.match(r2.message.content, /progress-guard, autonomous-loop/, "unchanged contributions are named as still current");
    const budget = parseJsonAs(object({ message: object({ included: array(string()), injected: array(string()), skippedUnchanged: boolean() }) }), fs.readFileSync(path.join(ws, ".pi", "ctx-contributions", "sieve-budget.json"), "utf8"), "sieve-budget.json");
    assert.deepEqual(budget.message.injected, ["orchestrator"], "telemetry lists only the re-injected contribution");
    assert.equal(budget.message.included.length, 3);
    assert.equal(budget.message.skippedUnchanged, false);
    // A contribution that disappears and later returns identical is injected again.
    fs.rmSync(path.join(ws, ".pi", "ctx-contributions", "progress-guard.json"));
    const r3 = await sieveTurn(pi, { systemPrompt: "base" });
    assert.equal(r3?.message, undefined, "removing a contribution injects nothing new");
    writeContrib(ws, "progress-guard", 78, 320, "LOOP NUDGE");
    const r4 = await sieveTurn(pi, { systemPrompt: "base" });
    assert.ok(r4.message, "a returning contribution is injected");
    assert.match(r4.message.content, /LOOP NUDGE/);
    assert.doesNotMatch(r4.message.content, /DELEGATION POLICY|LOOP GOAL/);
  } finally {
    rmWorkspace(ws);
  }
}

// Equal-priority contributions must be ordered by id (deterministic), and higher priority
// must still sort first.
async function testEqualPriorityOrderedById() {
  const { compareContributions } = sieveModule;
  // Only the id and priority take part in the ordering.
  const c = (id: string, priority: number) => ({ id, priority, budgetTokens: 1, content: "" });
  assert.ok(compareContributions(c("b", 5), c("a", 5)) > 0, "equal priority must order by id ascending");
  assert.ok(compareContributions(c("a", 5), c("b", 5)) < 0, "the reverse comparison must be negative");
  assert.ok(compareContributions(c("a", 9), c("b", 1)) < 0, "higher priority must still sort first");
}

// A non-finite/absent priority is coerced to 0 rather than dropped or producing NaN ordering.
async function testNonFinitePriorityNormalisedToZero() {
  const { normalizeContribution } = sieveModule;
  const coerced = normalizeContribution({ id: "x", content: "y", priority: "high", budgetTokens: 1 });
  assert.ok(coerced, "a non-finite priority does not reject the contribution");
  assert.equal(coerced.priority, 0);
  const kept = normalizeContribution({ id: "x", content: "y", priority: 7, budgetTokens: 1 });
  assert.ok(kept, "a valid contribution is admitted");
  assert.equal(kept.priority, 7);
  assert.equal(normalizeContribution({ id: "", content: "y", priority: 1 }), null, "an empty id must be rejected");
  assert.equal(normalizeContribution({ id: "x", content: 5, priority: 1 }), null, "a non-string content must be rejected");
}

// A contribution file larger than MAX_CONTRIBUTION_BYTES is skipped before JSON.parse, so its
// marker never reaches the prompt while a small valid sibling is still included.
async function testOversizedContributionFileSkippedBeforeParse() {
  const ws = tmpWorkspace("pi-kit-ctxbudget-oversize-");
  const restore = setEnv("PI_KIT_CTX_BUDGET_TOKENS", "1000000");
  try {
    const pi = await loadSieve(ws);
    const { MAX_CONTRIBUTION_BYTES } = sieveModule;
    writeContrib(ws, "small", 5, 1000, "SMALL_MARKER");
    const dir = path.join(ws, ".pi", "ctx-contributions");
    const oversized = `OVERSIZED_MARKER${"x".repeat(MAX_CONTRIBUTION_BYTES)}`;
    fs.writeFileSync(path.join(dir, "oversized.json"), JSON.stringify({ id: "oversized", priority: 1, budgetTokens: 1000, content: oversized }));
    assert.ok(fs.statSync(path.join(dir, "oversized.json")).size > MAX_CONTRIBUTION_BYTES, "the oversized fixture must exceed the cap");
    const result = await sieveTurn(pi, { systemPrompt: "base" });
    assert.match(result.systemPrompt, /SMALL_MARKER/);
    assert.doesNotMatch(result.systemPrompt, /OVERSIZED_MARKER/, "an oversized contribution file must be skipped before parse");
  } finally {
    restore();
    rmWorkspace(ws);
  }
}

// The budgets are sized against the model's real context window (ctx.model.contextWindow): a fixed
// 4096 + 1200 tokens is most of an 8k window (the lite profile targets small local models). An
// unknown window (no model / contextWindow <= 0) keeps the configured numbers and is recorded as
// null, never as 0.
async function testBudgetsScaleWithContextWindow() {
  const ws = tmpWorkspace("pi-kit-ctxbudget-window-");
  const restoreEnv = setEnv("PI_KIT_CTX_BUDGET_TOKENS", undefined);
  const restoreMsg = setEnv("PI_KIT_CTX_MESSAGE_BUDGET_TOKENS", undefined);
  try {
    const pi = await loadSieve(ws);
    writeContrib(ws, "big", 5, 999999, "z".repeat(60000)); // 15k tokens if unbudgeted
    const read = () => readBudget(path.join(ws, ".pi", "ctx-contributions", "sieve-budget.json"));
    await pi.handlers.get("before_agent_start")({ systemPrompt: "base" }, { model: { contextWindow: 8192 } });
    let b = read();
    assert.equal(b.budget, 819, "default system budget is 10% of an 8k window, not 4096");
    assert.equal(b.contextWindow, 8192);
    assert.equal(b.windowClamped, true);
    assert.ok(b.totalTokens <= 819, `injected ${b.totalTokens} tokens into an 8k window`);
    await pi.handlers.get("before_agent_start")({ systemPrompt: "base" }, { model: { contextWindow: 200_000 } });
    b = read();
    assert.equal(b.budget, 4096, "a large window keeps the built-in default");
    assert.equal(b.windowClamped, false);
    for (const model of [undefined, { contextWindow: 0 }, { contextWindow: undefined }, { contextWindow: "n/a" }]) {
      await pi.handlers.get("before_agent_start")({ systemPrompt: "base" }, { model });
      b = read();
      assert.equal(b.budget, 4096, `unknown window (${JSON.stringify(model)}) keeps the configured budget`);
      assert.equal(b.contextWindow, null, "unknown is recorded as null, never 0");
    }
    // An explicit operator budget is honoured, but never allowed past half the window.
    const restoreBudget = setEnv("PI_KIT_CTX_BUDGET_TOKENS", "30000");
    try {
      await pi.handlers.get("before_agent_start")({ systemPrompt: "base" }, { model: { contextWindow: 200_000 } });
      assert.equal(read().budget, 30000, "explicit and inside half the window: honoured");
      await pi.handlers.get("before_agent_start")({ systemPrompt: "base" }, { model: { contextWindow: 32_000 } });
      b = read();
      assert.equal(b.budget, 16000, "explicit but over half of a 32k window: held at half");
      assert.equal(b.windowClamped, true);
    } finally { restoreBudget(); }
  } finally { restoreEnv(); restoreMsg(); rmWorkspace(ws); }
}

async function testBudgetForPureFunction() {
  const { budgetFor, knownContextWindow } = sieveModule;
  assert.deepEqual(budgetFor(undefined, 4096, 0.1, null), { tokens: 4096, clamped: false });
  assert.deepEqual(budgetFor(undefined, 4096, 0.1, 16_384), { tokens: 1638, clamped: true });
  assert.deepEqual(budgetFor(undefined, 1200, 0.03, 1_000_000), { tokens: 1200, clamped: false });
  assert.equal(budgetFor(undefined, 4096, 0.1, 100).tokens, 50, "floor of 64 never exceeds half of a tiny window");
  assert.equal(knownContextWindow({ model: { contextWindow: 128000 } }), 128000);
  for (const bad of [undefined, null, {}, { model: {} }, { model: { contextWindow: 0 } }, { model: { contextWindow: -5 } }, { model: { contextWindow: NaN } }]) {
    assert.equal(knownContextWindow(bad), null);
  }
}

const tests: Array<[string, () => Promise<void>]> = [
  ["budgets scale with the model's real context window; unknown stays unknown", testBudgetsScaleWithContextWindow],
  ["budgetFor / knownContextWindow arithmetic", testBudgetForPureFunction],
  ["an invalid budget env value falls back to a real default, not NaN", testInvalidBudgetEnvFallsBackToDefault],
  ["a contribution's own declared budgetTokens is enforced", testPerContributionBudgetEnforced],
  ["a mostly-fitting contribution is truncated, not dropped wholesale", testTruncationInsteadOfWholesaleDrop],
  ["a re-written identical contribution is still included this session", testRewrittenIdenticalContributionIsIncluded],
  ["native compaction preserves sorted/budgeted current prompt contributions", testCompactionContributionsAreSortedAndBudgeted],
  ["per-turn contributions use a deduplicated message, keeping the system prompt stable", testDynamicContributionsUseMessageChannel],
  ["the message channel is deduplicated per contribution, not as one block", testMessageDedupeIsPerContribution],
  ["equal-priority contributions are ordered by id, not directory order", testEqualPriorityOrderedById],
  ["a non-finite priority is normalised to 0", testNonFinitePriorityNormalisedToZero],
  ["an oversized contribution file is skipped before parse", testOversizedContributionFileSkippedBeforeParse],
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
  console.error(`\n[context-budget-smoke] ${failed}/${tests.length} FAILED`);
  process.exit(1);
}
console.log(`\n[context-budget-smoke] all ${tests.length} checks passed`);
