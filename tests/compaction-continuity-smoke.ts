#!/usr/bin/env node
/**
 * Offline compaction containment checks: preserve the native compactor's full
 * prepared input and do not delete/import another session's startup directives.
 * Native model-generated summary quality is outside this no-inference test.
 */
import type { BeforeAgentStartEventResult, SessionBeforeCompactResult } from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadExtension, fakePi, tmpWorkspace, rmWorkspace, setEnv, textOf, type FakePi } from "../packages/core/eval/harness.ts";

/** context-sieve's before_agent_start result: always the system prompt, plus a text message when per-turn blocks changed. */
type SieveTurn = BeforeAgentStartEventResult & { systemPrompt: string; message?: { content: string } };
const sieveTurn = async (pi: FakePi, event: object, ctx?: object): Promise<SieveTurn> => (await pi.handlers.get("before_agent_start")(event, ctx)) as SieveTurn;
/** compress's session_before_compact result when it writes the summary itself. */
type CompressResult = SessionBeforeCompactResult & { compaction: { summary: string } };

/** The subset of pi's AgentMessage shape these fixtures use. */
interface Message {
  role: string;
  content: string | Array<{ type: string; text: string }>;
}

interface SessionEntry {
  type: string;
  id: string;
  [field: string]: unknown;
}

function fakePreparation(overrides: { messagesToSummarize?: Message[] } = {}) {
  return { messagesToSummarize: [], firstKeptEntryId: "entry-1", tokensBefore: 15000, ...overrides };
}

async function testNativeCompactionPreservesPreparedInput(): Promise<void> {
  const ws = tmpWorkspace("pi-kit-native-compact-");
  try {
    const pi = fakePi();
    (await loadExtension("extensions/context-sieve/index.ts"))(pi.api);
    await pi.handlers.get("session_start")({}, { cwd: ws });
    fs.writeFileSync(path.join(ws, ".pi", "GOAL.yaml"), "goal: old goal\n");
    fs.writeFileSync(path.join(ws, ".pi", "ctx-contributions", "current.json"), JSON.stringify({
      id: "current", priority: 5, budgetTokens: 100, content: "Current handoff",
    }));
    const event = {
      customInstructions: "Preserve the operator correction",
      preparation: fakePreparation({ messagesToSummarize: [
        { role: "user", content: "Old hypothesis " + "x".repeat(12000) },
        { role: "user", content: "CORRECTION: stop implementation; report the blocker." },
      ] }),
    };
    const before = structuredClone(event);
    const result = await pi.handlers.get("session_before_compact")(event);
    assert.equal(result, undefined, "native summarizer must receive the full prepared transcript");
    assert.deepEqual(event, before, "do not mutate readonly compaction inputs or discard late corrections");
    const prompt = await sieveTurn(pi, { systemPrompt: "base" });
    assert.match(prompt.systemPrompt, /Current handoff/, "current contributions remain available after compaction");
    assert.doesNotMatch(prompt.systemPrompt, /old goal/, "do not separately reimport unscoped GOAL.yaml");
  } finally { rmWorkspace(ws); }
}

async function testStartupPreservesForeignContributions(): Promise<void> {
  const ws = tmpWorkspace("pi-kit-contribution-owner-");
  try {
    const dir = path.join(ws, ".pi", "ctx-contributions");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "orchestrator.json");
    const raw = JSON.stringify({ id: "orchestrator", content: "Parent private directive", priority: 1 });
    fs.writeFileSync(file, raw);
    // Genuine prior-session leftover: an old mtime well beyond the epoch grace window.
    const old = new Date(Date.now() - 3600_000);
    fs.utimesSync(file, old, old);
    const pi = fakePi();
    (await loadExtension("extensions/context-sieve/index.ts"))(pi.api);
    await pi.handlers.get("session_start")({}, { cwd: ws });
    const orch = fakePi();
    (await loadExtension("extensions/orchestrator/index.ts"))(orch.api);
    await orch.handlers.get("session_start")({}, { cwd: ws });
    assert.equal(fs.readFileSync(file, "utf8"), raw, "child startup cannot delete parent state");
    assert.equal(await pi.handlers.get("before_agent_start")({ systemPrompt: "base" }), undefined,
      "unchanged preexisting directives must not be imported into child prompt");
  } finally { rmWorkspace(ws); }
}

async function testCustomCompactionUsesNativeFallback(): Promise<void> {
  const ws = tmpWorkspace("pi-kit-compact-custom-");
  const templatePath = path.join(ws, "template.md");
  fs.writeFileSync(templatePath, "Preserve the deployment checklist above all else.");
  const restore = setEnv("PI_KIT_COMPACT_TEMPLATE", templatePath);
  try {
    const pi = fakePi();
    (await loadExtension("extensions/custom-compaction/index.ts"))(pi.api);
    const notices: string[] = [];
    await pi.handlers.get("session_start")({}, { cwd: ws, hasUI: true, ui: { notify: (message: string) => notices.push(message) } });
    assert.equal(notices.length, 1);
    const [notice] = notices;
    assert.ok(notice !== undefined, "a notice was shown");
    assert.match(notice, /unsupported.*native summarization/);
    const event = {
      customInstructions: "Keep the latest correction",
      preparation: fakePreparation({ messagesToSummarize: [{ role: "user", content: "x".repeat(12000) + "LATEST CORRECTION" }] }),
    };
    const before = structuredClone(event);
    assert.equal(await pi.handlers.get("session_before_compact")(event), undefined);
    assert.deepEqual(event, before, "configured template must not remove later transcript state");
  } finally { restore(); rmWorkspace(ws); }
}

// --- continuity across a whole compaction cycle ------------------------------------------------------
// What must survive session_before_compact -> session_compact: the goal, the todo list, recovery
// state, and any custom session entries (the effort tier is one; an extension re-applies it every turn
// from entries in the session, so what matters here is that no compaction hook drops or rewrites them).
// The hooks under test are the kit's real ones; the "session" is a fake with a real session id.
function sessionCtx(ws: string, entries: SessionEntry[], extra: Record<string, unknown> = {}) {
  return {
    cwd: ws,
    hasUI: false,
    ui: { notify() {}, setStatus() {} },
    sessionManager: { getSessionId: () => "sess-continuity", getEntries: () => entries, getBranch: () => entries, getSessionFile: () => undefined },
    ...extra,
  };
}

async function testGoalTodoRecoveryAndCustomEntriesSurviveACompactionCycle(): Promise<void> {
  const ws = tmpWorkspace("pi-kit-compact-cycle-");
  const restoreAgent = setEnv("PI_CODING_AGENT_DIR", path.join(ws, "agent"));
  try {
    const entries: SessionEntry[] = [
      { type: "message", id: "e1", message: { role: "user", content: "start" } },
      { type: "custom", id: "e2", customType: "effort-tier", data: { tier: "high", source: "session" } },
      { type: "custom", id: "e3", customType: "caveman-state", data: { level: "full" } },
    ];
    const ctx = sessionCtx(ws, entries);
    // fakePi keeps one handler per event, so each extension under test gets its own instance.
    const hooks: Array<{ name: string; p: ReturnType<typeof fakePi> }> = [];
    for (const name of ["context-sieve", "custom-compaction", "compress"]) {
      const p = fakePi();
      (await loadExtension(`extensions/${name}/index.ts`))(p.api);
      hooks.push({ name, p });
    }
    const [sieveHook] = hooks;
    assert.ok(sieveHook, "the context sieve was loaded");
    const sieve = sieveHook.p;
    const goalPi = fakePi();
    (await loadExtension("extensions/goal-core/index.ts"))(goalPi.api);
    const todoPi = fakePi();
    (await loadExtension("vendor/todo/index.ts"))(todoPi.api);

    // Session start in the real order the producers use (the sieve first, then the producers).
    await sieve.handlers.get("session_start")({}, ctx);
    await goalPi.handlers.get("session_start")({}, ctx);
    await goalPi.commands.get("goal").handler("Ship the invoice migration by Friday", ctx);
    const todo = todoPi.tools.get("todo");
    await todo.execute("t1", { action: "add", items: ["write the migration", "backfill old invoices", "run the verifier"] }, undefined, undefined, ctx);
    await todo.execute("t2", { action: "start", id: 2 }, undefined, undefined, ctx);
    // A recovery producer (recovery-orchestrator) has queued a per-turn directive on the message channel.
    const dir = path.join(ws, ".pi", "ctx-contributions", "sessions", "sess-continuity");
    fs.writeFileSync(path.join(dir, "recovery-orchestrator.json"), JSON.stringify({ id: "recovery-orchestrator", priority: 90, budgetTokens: 480, content: "## recovery: stuck on 'repeat:xyz' (attempt 1/3)\nFill in .pi/recovery/1-repeat-xyz.md" }));

    const before = await sieveTurn(sieve, { systemPrompt: "base" }, ctx);
    assert.match(before.systemPrompt, /## Active Goal\nShip the invoice migration by Friday/);
    assert.ok(before.message, "the recovery directive is injected");
    assert.match(before.message.content, /recovery: stuck on 'repeat:xyz'/);
    const todoFile = path.join(ws, ".pi", "todos", "sess-continuity.md");
    const todoBefore = fs.readFileSync(todoFile, "utf8");
    assert.match(todoBefore, /backfill old invoices/);
    const goalBefore = fs.readFileSync(path.join(ws, ".pi", "GOAL.yaml"), "utf8");

    // Automatic compaction (no custom instructions): every kit hook must be transparent, and must not
    // touch the prepared input or the session entries.
    const event = () => ({
      customInstructions: undefined,
      reason: "threshold",
      willRetry: false,
      branchEntries: entries,
      preparation: fakePreparation({ messagesToSummarize: [{ role: "user", content: "the goal was set with /goal" }] }),
    });
    for (const { name, p } of hooks) {
      const ev = event();
      const snapshot = structuredClone(ev);
      const result = await p.handlers.get("session_before_compact")(ev, ctx);
      assert.equal(result, undefined, `${name}: automatic compaction must use pi's native summary (no cancel, no replacement)`);
      assert.deepEqual(ev, snapshot, `${name}: must not mutate the prepared input or the session entries`);
    }
    assert.deepEqual(entries.map((e) => e.id), ["e1", "e2", "e3"], "custom entries (effort tier, caveman state) are all still there");
    assert.deepEqual(entries[1]?.data, { tier: "high", source: "session" });

    for (const { p } of hooks) await p.handlers.find("session_compact")?.({ compactionEntry: { id: "c1" }, fromExtension: false, reason: "threshold", willRetry: false }, ctx);

    // After the cycle: goal still injected, recovery directive re-armed (the summary may have swallowed
    // the earlier hidden message), todo file and GOAL.yaml byte-identical, list still readable.
    const after = await sieveTurn(sieve, { systemPrompt: "base" }, ctx);
    assert.match(after.systemPrompt, /## Active Goal\nShip the invoice migration by Friday/, "the goal is re-injected on the first turn after compaction");
    assert.ok(after.message, "the recovery directive is injected");
    assert.match(after.message.content, /recovery: stuck on 'repeat:xyz'/, "recovery state is injected again after compaction");
    assert.equal(fs.readFileSync(todoFile, "utf8"), todoBefore, "todo state is on disk and untouched by compaction");
    assert.equal(fs.readFileSync(path.join(ws, ".pi", "GOAL.yaml"), "utf8"), goalBefore);
    const listing = await todo.execute("t3", { action: "list" }, undefined, undefined, ctx);
    assert.match(textOf(listing), /write the migration/);
    assert.match(textOf(listing), /backfill old invoices/);
    // Without a compaction in between the recovery block is NOT re-sent (it is already in the history).
    const again = await sieveTurn(sieve, { systemPrompt: "base" }, ctx);
    assert.equal(again.message, undefined);
  } finally { restoreAgent(); rmWorkspace(ws); }
}

async function testCompressKeepsTheActiveObjectiveAndOperatorNote(): Promise<void> {
  const ws = tmpWorkspace("pi-kit-compress-goal-");
  const restore = setEnv("PI_KIT_COMPRESS_MAX_CHARS", "4000"); // force turns to be dropped
  try {
    fs.mkdirSync(path.join(ws, ".pi"), { recursive: true });
    // The goal was set long after the first ask, so it lives only in GOAL.yaml (the middle turns are omitted).
    fs.writeFileSync(path.join(ws, ".pi", "GOAL.yaml"), "goal: Ship the invoice migration by Friday\ncreated: 2026-09-30T00:00:00Z\n");
    const messages: Message[] = [{ role: "user", content: "FIRST ASK: look at the billing service" }];
    for (let i = 0; i < 60; i++) {
      messages.push({ role: "user", content: `middle request ${i} ` + "y".repeat(300) });
      messages.push({ role: "assistant", content: [{ type: "text", text: `middle reply ${i} ` + "z".repeat(300) }] });
    }
    messages.push({ role: "user", content: "NEWEST: run the verifier" });
    const pi = fakePi();
    (await loadExtension("extensions/compress/index.ts"))(pi.api);
    const event = { customInstructions: `[[pi-kit:compress]]remember the TTL decision`, preparation: fakePreparation({ messagesToSummarize: messages }) };
    const result = (await pi.handlers.get("session_before_compact")(event, { cwd: ws })) as CompressResult;
    const summary = result.compaction.summary;
    assert.match(summary, /## Active goal\nShip the invoice migration by Friday/, "the active objective is pinned in the summary");
    assert.match(summary, /## Operator note\nremember the TTL decision/);
    assert.match(summary, /FIRST ASK: look at the billing service/, "the original ask is kept");
    assert.match(summary, /NEWEST: run the verifier/, "the newest turn is kept");
    assert.match(summary, /older turns omitted/, "the middle really was dropped, so the goal section is what carries the objective");
    assert.ok(summary.indexOf("## Active goal") < summary.indexOf("## Conversation"), "pinned above the conversation");
    // No goal, no section (and no crash without a ctx).
    fs.rmSync(path.join(ws, ".pi", "GOAL.yaml"));
    const none = (await pi.handlers.get("session_before_compact")({ ...event }, { cwd: ws })) as CompressResult;
    assert.doesNotMatch(none.compaction.summary, /Active goal/);
    const noCtx = (await pi.handlers.get("session_before_compact")({ ...event })) as CompressResult;
    assert.ok(noCtx.compaction.summary.length > 0);
  } finally { restore(); rmWorkspace(ws); }
}

async function testKitHooksNeverCancelOrReplaceAnAutomaticCompaction(): Promise<void> {
  const ws = tmpWorkspace("pi-kit-compact-hooks-");
  try {
    for (const name of ["context-sieve", "custom-compaction", "compress"]) {
      const pi = fakePi();
      (await loadExtension(`extensions/${name}/index.ts`))(pi.api);
      for (const reason of ["manual", "threshold", "overflow"]) {
        const result = await pi.handlers.get("session_before_compact")({ customInstructions: reason === "manual" ? "focus on the parser" : undefined, reason, willRetry: reason === "overflow", preparation: fakePreparation({ messagesToSummarize: [{ role: "user", content: "x" }] }) }, { cwd: ws });
        assert.equal(result, undefined, `${name}/${reason}: only /compress (its marker) may replace the summary`);
      }
    }
  } finally { rmWorkspace(ws); }
}

const tests: Array<[string, () => Promise<void>]> = [
  ["goal, todo, recovery state and custom entries survive a full compaction cycle", testGoalTodoRecoveryAndCustomEntriesSurviveACompactionCycle],
  ["/compress pins the active objective and operator note above the conversation", testCompressKeepsTheActiveObjectiveAndOperatorNote],
  ["kit hooks never cancel or replace a manual/threshold/overflow compaction", testKitHooksNeverCancelOrReplaceAnAutomaticCompaction],
  ["native compaction receives full unchanged transcript and custom instructions", testNativeCompactionPreservesPreparedInput],
  ["startup preserves and excludes unchanged foreign contributions", testStartupPreservesForeignContributions],
  ["configured template falls back to native compaction with notice", testCustomCompactionUsesNativeFallback],
];

let failed = 0;
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

if (failed > 0) {
  console.error(`\n[compaction-continuity-smoke] ${failed}/${tests.length} FAILED`);
  process.exit(1);
}
console.log(`\n[compaction-continuity-smoke] all ${tests.length} checks passed`);
