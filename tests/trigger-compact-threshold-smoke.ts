#!/usr/bin/env node
/**
 * Offline checks for the configurable auto-compact threshold in vendor/trigger-compact.
 * The upstream extension hardcoded the threshold at 100k tokens, which fires far too early
 * on large-context-window models. This pins:
 *   1. The built-in 100k default still applies with no env var and no saved setting.
 *   2. PI_KIT_COMPACT_THRESHOLD_TOKENS overrides the default and locks /compact-threshold.
 *   3. /compact-threshold <amount> (plain int or "500k"/"1.2m" shorthand) persists to
 *      <agent dir>/pi-kit/trigger-compact.json and a fresh load of the module picks it up.
 *   4. A threshold at or above the model's context window is rejected, not silently accepted.
 *   5. /compact-threshold reset clears the saved override back to the built-in default.
 *   6. The turn_end hook still only fires on an upward crossing of whatever the current
 *      threshold is (unchanged edge-triggered behavior from upstream).
 *   7. pi's own `compaction.enabled: false` (the /settings auto-compact toggle, global or
 *      project) stops automatic compaction — the reported "off in settings but still
 *      compacts" bug — while manual /trigger-compact still works.
 *   8. /compact-threshold off|on toggles just this trigger and survives a reset.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadExtension, fakePi, tmpWorkspace, rmWorkspace, setEnv } from "../packages/core/eval/harness.ts";
import { isRecord, parseJson } from "../packages/core/lib/guard.ts";

interface Notice {
  msg: string;
  level: string | undefined;
}

// What the extension passes to ctx.compact(): pi's completion callbacks.
interface CompactOptions {
  onComplete: (result: unknown) => void;
  onError: (error: Error) => void;
}

type FakePi = ReturnType<typeof fakePi>;

function fakeCtx(contextWindow = 1_300_000) {
  const notices: Notice[] = [];
  const compactCalls: CompactOptions[] = [];
  return {
    hasUI: true,
    ui: { notify: (msg: string, level?: string) => notices.push({ msg, level }) },
    getContextUsage: () => ({ tokens: 0, contextWindow, percent: 0 }),
    compact: (opts: CompactOptions) => compactCalls.push(opts),
    notices,
    compactCalls,
  };
}

type FakeCtx = ReturnType<typeof fakeCtx>;

// The most recent notice; a missing one fails the check just as reading `.msg` of undefined did.
function lastNotice(notices: Notice[]): Notice {
  const notice = notices.at(-1);
  if (!notice) throw new Error("no notice was shown");
  return notice;
}

// The first ctx.compact() call; a missing one fails the check just as calling through undefined did.
function firstCompact(calls: CompactOptions[]): CompactOptions {
  const call = calls[0];
  assert.ok(call, "ctx.compact() was called");
  return call;
}

async function withAgentDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = tmpWorkspace("pi-kit-trigger-compact-agentdir-");
  const restore = setEnv("PI_CODING_AGENT_DIR", dir);
  try {
    await fn(dir);
  } finally {
    restore();
    rmWorkspace(dir);
  }
}

async function crossThreshold(pi: FakePi, ctx: FakeCtx, below: number, above: number): Promise<void> {
  await pi.handlers.get("turn_end")(undefined, { ...ctx, getContextUsage: () => ({ tokens: below, contextWindow: ctx.getContextUsage().contextWindow, percent: null }) });
  await pi.handlers.get("turn_end")(undefined, { ...ctx, getContextUsage: () => ({ tokens: above, contextWindow: ctx.getContextUsage().contextWindow, percent: null }) });
}

async function testDefaultThreshold() {
  await withAgentDir(async () => {
    const pi = fakePi();
    (await loadExtension("vendor/trigger-compact/index.ts"))(pi.api);
    const ctx = fakeCtx();
    await crossThreshold(pi, ctx, 90_000, 110_000);
    assert.equal(ctx.compactCalls.length, 1, "must auto-compact once the default 100k threshold is crossed");

    const belowCtx = fakeCtx();
    await pi.commands.get("compact-threshold").handler("", belowCtx);
    assert.match(lastNotice(belowCtx.notices).msg, /100k tokens \[default\]/);
  });
}

async function testEnvOverrideLocksCommand() {
  await withAgentDir(async () => {
    const restore = setEnv("PI_KIT_COMPACT_THRESHOLD_TOKENS", "250000");
    try {
      const pi = fakePi();
      (await loadExtension("vendor/trigger-compact/index.ts"))(pi.api);
      const ctx = fakeCtx();

      await crossThreshold(pi, ctx, 200_000, 260_000);
      assert.equal(ctx.compactCalls.length, 1, "env-configured threshold (250k) must still drive auto-compact");

      const lockedCtx = fakeCtx();
      await pi.commands.get("compact-threshold").handler("500k", lockedCtx);
      assert.match(lastNotice(lockedCtx.notices).msg, /locked by PI_KIT_COMPACT_THRESHOLD_TOKENS/);
      assert.equal(lastNotice(lockedCtx.notices).level, "error");
    } finally { restore(); }
  });
}

async function testCommandPersistsAndReloads() {
  await withAgentDir(async (agentDir: string) => {
    const pi = fakePi();
    (await loadExtension("vendor/trigger-compact/index.ts"))(pi.api);
    const ctx = fakeCtx();

    await pi.commands.get("compact-threshold").handler("500k", ctx);
    assert.match(lastNotice(ctx.notices).msg, /set to 500k tokens/);
    assert.equal(lastNotice(ctx.notices).level, "info");

    const saved = parseJson(fs.readFileSync(path.join(agentDir, "pi-kit", "trigger-compact.json"), "utf8"));
    assert.ok(isRecord(saved), "the saved threshold file holds an object");
    assert.equal(saved.thresholdTokens, 500_000, "500k shorthand must resolve to 500000");

    // A fresh module load (simulating a new pi session) must pick up the saved value.
    const pi2 = fakePi();
    (await loadExtension("vendor/trigger-compact/index.ts"))(pi2.api);
    const ctx2 = fakeCtx();

    await crossThreshold(pi2, ctx2, 490_000, 510_000);
    assert.equal(ctx2.compactCalls.length, 1, "reloaded module must auto-compact at the persisted 500k, not the 100k default");

    const belowOldDefaultCtx = fakeCtx();
    await pi2.handlers.get("turn_end")(undefined, { ...belowOldDefaultCtx, getContextUsage: () => ({ tokens: 50_000, contextWindow: 1_300_000, percent: null }) });
    await pi2.handlers.get("turn_end")(undefined, { ...belowOldDefaultCtx, getContextUsage: () => ({ tokens: 150_000, contextWindow: 1_300_000, percent: null }) });
    assert.equal(belowOldDefaultCtx.compactCalls.length, 0, "150k must not trigger compaction once the threshold is 500k");
  });
}

async function testRejectsThresholdAtOrAboveContextWindow() {
  await withAgentDir(async (agentDir: string) => {
    const pi = fakePi();
    (await loadExtension("vendor/trigger-compact/index.ts"))(pi.api);
    const ctx = fakeCtx(200_000);

    await pi.commands.get("compact-threshold").handler("200000", ctx);
    assert.match(lastNotice(ctx.notices).msg, /at or above the 200k context window/);
    assert.equal(lastNotice(ctx.notices).level, "error");
    assert.equal(fs.existsSync(path.join(agentDir, "pi-kit", "trigger-compact.json")), false, "a rejected threshold must not be persisted");
  });
}

async function testReset() {
  await withAgentDir(async (agentDir: string) => {
    const pi = fakePi();
    (await loadExtension("vendor/trigger-compact/index.ts"))(pi.api);
    const ctx = fakeCtx();

    await pi.commands.get("compact-threshold").handler("500k", ctx);
    assert.equal(fs.existsSync(path.join(agentDir, "pi-kit", "trigger-compact.json")), true);

    const resetCtx = fakeCtx();
    await pi.commands.get("compact-threshold").handler("reset", resetCtx);
    assert.match(lastNotice(resetCtx.notices).msg, /reset to default \(100k tokens\)/);
    assert.equal(fs.existsSync(path.join(agentDir, "pi-kit", "trigger-compact.json")), false, "reset must remove the saved override");

    await crossThreshold(pi, ctx, 90_000, 110_000);
    assert.equal(ctx.compactCalls.length, 1, "after reset, auto-compact must fire at the 100k default again");
  });
}

async function testNullSettingsFileFallsBackToDefault() {
  await withAgentDir(async (agentDir: string) => {
    const settingsDir = path.join(agentDir, "pi-kit");
    fs.mkdirSync(settingsDir, { recursive: true });
    fs.writeFileSync(path.join(settingsDir, "trigger-compact.json"), "null");

    const pi = fakePi();
    (await loadExtension("vendor/trigger-compact/index.ts"))(pi.api);
    const ctx = fakeCtx();
    await crossThreshold(pi, ctx, 90_000, 110_000);
    assert.equal(ctx.compactCalls.length, 1, "a `null` settings file must fall back to the 100k default, not throw");
  });
}

async function testRespectsPiAutoCompactionSetting() {
  await withAgentDir(async (dir: string) => {
    const ws = tmpWorkspace("pi-kit-trigger-compact-ws-");
    try {
      const pi = fakePi();
      (await loadExtension("vendor/trigger-compact/index.ts"))(pi.api);
      fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ compaction: { enabled: false } }));
      const ctx = { ...fakeCtx(), cwd: ws };
      await crossThreshold(pi, ctx, 90_000, 110_000);
      assert.equal(ctx.compactCalls.length, 0, "compaction.enabled=false in global settings must stop auto-compaction");

      // A project setting overrides the global one (pi's merge order), in both directions.
      // Both writes get the same mtime, as they do within one timestamp tick on a coarse-clock
      // filesystem (CI overlayfs): the settings cache must still see the second one.
      const projectSettings = path.join(ws, ".pi", "settings.json");
      const sameTick = new Date(Date.UTC(2026, 0, 1));
      fs.mkdirSync(path.join(ws, ".pi"), { recursive: true });
      fs.writeFileSync(projectSettings, JSON.stringify({ compaction: { enabled: true } }));
      fs.utimesSync(projectSettings, sameTick, sameTick);
      await crossThreshold(pi, ctx, 90_000, 110_000);
      assert.equal(ctx.compactCalls.length, 1, "a project compaction.enabled=true re-enables it for that project");
      fs.writeFileSync(projectSettings, JSON.stringify({ compaction: { enabled: false }, other: 1 }));
      fs.utimesSync(projectSettings, sameTick, sameTick);
      await crossThreshold(pi, ctx, 90_000, 110_000);
      assert.equal(ctx.compactCalls.length, 1, "a project compaction.enabled=false disables it even if global is on");

      await pi.commands.get("trigger-compact").handler("", ctx);
      assert.equal(ctx.compactCalls.length, 2, "manual /trigger-compact always works");

      const statusCtx = { ...fakeCtx(), cwd: ws };
      await pi.commands.get("compact-threshold").handler("status", statusCtx);
      assert.match(lastNotice(statusCtx.notices).msg, /OFF \(pi auto-compaction is disabled/);
    } finally {
      rmWorkspace(ws);
    }
  });
}

async function testKitOffSwitch() {
  await withAgentDir(async () => {
    const pi = fakePi();
    (await loadExtension("vendor/trigger-compact/index.ts"))(pi.api);
    const ctx = fakeCtx();
    await pi.commands.get("compact-threshold").handler("300k", ctx);
    await pi.commands.get("compact-threshold").handler("off", ctx);
    await crossThreshold(pi, ctx, 290_000, 310_000);
    assert.equal(ctx.compactCalls.length, 0, "/compact-threshold off stops the trigger");
    await pi.commands.get("compact-threshold").handler("reset", ctx);
    await crossThreshold(pi, ctx, 90_000, 110_000);
    assert.equal(ctx.compactCalls.length, 0, "reset restores the default threshold but keeps the trigger off");
    await pi.commands.get("compact-threshold").handler("on", ctx);
    await crossThreshold(pi, ctx, 90_000, 110_000);
    assert.equal(ctx.compactCalls.length, 1, "/compact-threshold on re-enables it");
  });
}

// --- pi 0.85.1 semantics (ground truth: agent-session.js / compaction.js) ---------------------------
// ctx.compact() is AgentSession.compact(): it aborts the running agent first and never resumes it;
// pi's own threshold compaction (window - reserveTokens) runs inside the run and continues it;
// getContextUsage() is undefined for an unknown window and {tokens: null} right after a compaction.
interface LiveCtxOptions {
  tokens: number | null | undefined;
  window?: number;
  idle?: boolean;
  cwd?: string;
  extra?: Record<string, unknown>;
}

function liveCtx({ tokens, window = 1_300_000, idle = false, cwd, extra = {} }: LiveCtxOptions) {
  const ctx = {
    ...fakeCtx(window),
    cwd,
    isIdle: () => idle,
    hasPendingMessages: () => false,
    getContextUsage: () => (tokens === undefined ? undefined : { tokens, contextWindow: window, percent: tokens === null ? null : (tokens / window) * 100 }),
    ...extra,
  };
  return ctx;
}
const withTools = { toolResults: [{ role: "toolResult" }] };

async function testFirstObservationAboveThresholdFiresOnce() {
  await withAgentDir(async () => {
    const pi = fakePi();
    (await loadExtension("vendor/trigger-compact/index.ts"))(pi.api);
    // A resumed session whose first turn_end already reads 150k: the old edge trigger needed a
    // previous reading at or below the threshold and never fired.
    const ctx = liveCtx({ tokens: 150_000 });
    await pi.handlers.get("turn_end")(withTools, ctx);
    assert.equal(ctx.compactCalls.length, 1, "already above the threshold on first sight: fire once");
    firstCompact(ctx.compactCalls).onComplete({}); // the compaction finished but (as in a real low-threshold case) usage stays high
    // Still above on the following turns (compaction could not get below): no loop.
    for (let i = 0; i < 5; i++) await pi.handlers.get("turn_end")(withTools, { ...ctx, getContextUsage: () => ({ tokens: 150_000, contextWindow: 1_300_000, percent: 11 }) });
    assert.equal(ctx.compactCalls.length, 1, "no repeat while usage stays above the threshold");
    // Only known usage at or below the threshold re-arms it.
    await pi.handlers.get("turn_end")(withTools, { ...ctx, getContextUsage: () => ({ tokens: null, contextWindow: 1_300_000, percent: null }) });
    await pi.handlers.get("turn_end")(withTools, { ...ctx, getContextUsage: () => ({ tokens: 30_000, contextWindow: 1_300_000, percent: 2 }) });
    await pi.handlers.get("turn_end")(withTools, { ...ctx, getContextUsage: () => ({ tokens: 120_000, contextWindow: 1_300_000, percent: 9 }) });
    assert.equal(ctx.compactCalls.length, 2, "re-armed after usage fell below, fires again on the next crossing");
  });
}

async function testUnknownUsageIsNeverTreatedAsZeroOrAbove() {
  await withAgentDir(async () => {
    const pi = fakePi();
    (await loadExtension("vendor/trigger-compact/index.ts"))(pi.api);
    const noWindow = liveCtx({ tokens: undefined });
    await pi.handlers.get("turn_end")(withTools, noWindow); // getContextUsage() === undefined: unknown window / no model
    const afterCompaction = liveCtx({ tokens: null });
    await pi.handlers.get("turn_end")(withTools, afterCompaction); // {tokens: null}: unknown until the next response
    assert.equal(noWindow.compactCalls.length + afterCompaction.compactCalls.length, 0);
    const status = liveCtx({ tokens: undefined });
    await pi.commands.get("compact-threshold").handler("status", status);
    assert.match(lastNotice(status.notices).msg, /context window: unknown/, "an unknown window is reported as unknown");
    assert.doesNotMatch(lastNotice(status.notices).msg, /context window: 0/);
  });
}

async function testStandsDownWhenPiWouldCompactFirst() {
  await withAgentDir(async () => {
    const pi = fakePi();
    (await loadExtension("vendor/trigger-compact/index.ts"))(pi.api);
    // window 120k, reserve 16384 -> pi's own trigger is 103,616. Usage 110k is above BOTH triggers
    // on the same turn: pi compacts inside the run; a kit ctx.compact() on top would double-trigger.
    const both = liveCtx({ tokens: 110_000, window: 120_000 });
    await pi.handlers.get("turn_end")(withTools, both);
    assert.equal(both.compactCalls.length, 0, "pi's own trigger fires on this turn; the kit stands down");
    const again = liveCtx({ tokens: 111_000, window: 120_000 });
    await pi.handlers.get("turn_end")(withTools, again);
    // A kit threshold between the two does fire (100k < 103.6k) and does not double up.
    const pi2 = fakePi();
    (await loadExtension("vendor/trigger-compact/index.ts"))(pi2.api);
    const between = liveCtx({ tokens: 102_000, window: 120_000 });
    await pi2.handlers.get("turn_end")(withTools, between);
    assert.equal(between.compactCalls.length, 1, "100k < pi's 103.6k: the kit trigger is the earlier one and fires alone");
  });
}

async function testEnvThresholdAboveWindowIsIdleNotSilent() {
  await withAgentDir(async () => {
    const restore = setEnv("PI_KIT_COMPACT_THRESHOLD_TOKENS", "500000");
    try {
      const pi = fakePi();
      (await loadExtension("vendor/trigger-compact/index.ts"))(pi.api);
      const ctx = liveCtx({ tokens: 510_000, window: 200_000 });
      await pi.handlers.get("turn_end")(withTools, ctx);
      assert.equal(ctx.compactCalls.length, 0);
      assert.match(lastNotice(ctx.notices).msg, /at or above pi's own trigger.*idle/);
      const status = liveCtx({ tokens: 1000, window: 200_000 });
      await pi.commands.get("compact-threshold").handler("status", status);
      assert.match(lastNotice(status.notices).msg, /idle: pi compacts first at 183.6k/);
    } finally { restore(); }
  });
}

async function testThresholdBetweenNativeAndWindowIsRejected() {
  await withAgentDir(async (agentDir: string) => {
    const pi = fakePi();
    (await loadExtension("vendor/trigger-compact/index.ts"))(pi.api);
    const ctx = liveCtx({ tokens: 1000, window: 200_000 });
    await pi.commands.get("compact-threshold").handler("190k", ctx);
    assert.match(lastNotice(ctx.notices).msg, /at or above pi's own compaction trigger \(183\.6k = window 200k - reserveTokens 16\.4k\)/);
    assert.equal(lastNotice(ctx.notices).level, "error");
    assert.equal(fs.existsSync(path.join(agentDir, "pi-kit", "trigger-compact.json")), false);
  });
}

async function testOneShotChildNeverCallsCompact() {
  await withAgentDir(async () => {
    for (const child of [{ env: "1" }, { mode: "print" }, { mode: "json" }]) {
      const restore = setEnv("PI_KIT_INTERNAL_CHILD", child.env);
      try {
        const pi = fakePi();
        (await loadExtension("vendor/trigger-compact/index.ts"))(pi.api);
        const ctx = liveCtx({ tokens: 500_000, extra: child.mode ? { mode: child.mode } : {} });
        await pi.handlers.get("turn_end")(withTools, ctx);
        await pi.handlers.get("agent_settled")({}, ctx);
        assert.equal(ctx.compactCalls.length, 0, `ctx.compact() aborts the run and nobody resumes a one-shot child (${JSON.stringify(child)})`);
        const status = liveCtx({ tokens: 1000, extra: child.mode ? { mode: child.mode } : {} });
        await pi.commands.get("compact-threshold").handler("status", status);
        assert.match(lastNotice(status.notices).msg, /not used in this one-shot child session/);
      } finally { restore(); }
    }
  });
}

async function testMidRunCompactionIsResumedOnce() {
  await withAgentDir(async () => {
    const pi = fakePi();
    (await loadExtension("vendor/trigger-compact/index.ts"))(pi.api);
    const ctx = liveCtx({ tokens: 150_000 });
    await pi.handlers.get("turn_end")(withTools, ctx);
    assert.equal(ctx.compactCalls.length, 1);
    // pi aborted the live run to compact and will not continue it. Simulate completion with the
    // agent idle: the extension continues the run exactly once.
    ctx.isIdle = () => true; // pi aborted the run to compact, so it is idle by the time compaction completes
    firstCompact(ctx.compactCalls).onComplete({});
    assert.equal(pi.steers.length, 1);
    const [steer] = pi.steers;
    assert.ok(steer, "the run was resumed");
    assert.match(steer.message as string, /compacted automatically .* Continue the task from where you left off/);
    // If another extension already started a run (an autonomous loop's follow-up), do not pile on.
    const pi2 = fakePi();
    (await loadExtension("vendor/trigger-compact/index.ts"))(pi2.api);
    const busy = liveCtx({ tokens: 150_000 });
    await pi2.handlers.get("turn_end")(withTools, busy);
    busy.isIdle = () => false;
    firstCompact(busy.compactCalls).onComplete({});
    assert.equal(pi2.steers.length, 0, "a run that is already going is not resumed twice");
    // A failed compaction resumes nothing and re-reports the failure.
    const pi3 = fakePi();
    (await loadExtension("vendor/trigger-compact/index.ts"))(pi3.api);
    const failing = liveCtx({ tokens: 150_000 });
    await pi3.handlers.get("turn_end")(withTools, failing);
    firstCompact(failing.compactCalls).onError(new Error("summariser down"));
    assert.equal(pi3.steers.length, 0);
    assert.match(lastNotice(failing.notices).msg, /Compaction failed: summariser down/);
    // Manual /trigger-compact never resumes (the operator is at the keyboard).
    const pi4 = fakePi();
    (await loadExtension("vendor/trigger-compact/index.ts"))(pi4.api);
    const manual = liveCtx({ tokens: 150_000, idle: true });
    await pi4.commands.get("trigger-compact").handler("", manual);
    firstCompact(manual.compactCalls).onComplete({});
    assert.equal(pi4.steers.length, 0);
  });
}

async function testFinalTurnCompactsAfterSettling() {
  await withAgentDir(async () => {
    const pi = fakePi();
    (await loadExtension("vendor/trigger-compact/index.ts"))(pi.api);
    const ctx = liveCtx({ tokens: 150_000 });
    // The turn ended with a plain answer (no tool calls): the run is finishing, so aborting it would
    // only cancel a queued follow-up. Wait for agent_settled, when nothing is running.
    await pi.handlers.get("turn_end")({ toolResults: [] }, ctx);
    assert.equal(ctx.compactCalls.length, 0, "not while the run is finishing");
    await pi.handlers.get("agent_settled")({}, { ...ctx, isIdle: () => true });
    assert.equal(ctx.compactCalls.length, 1, "once pi has settled");
    firstCompact(ctx.compactCalls).onComplete({});
    assert.equal(pi.steers.length, 0, "nothing was interrupted, so nothing is resumed");
    await pi.handlers.get("agent_settled")({}, ctx);
    assert.equal(ctx.compactCalls.length, 1, "and only once");
  });
}

async function testEscapeIsRespected() {
  await withAgentDir(async () => {
    const pi = fakePi();
    (await loadExtension("vendor/trigger-compact/index.ts"))(pi.api);
    const ctx = liveCtx({ tokens: 150_000, extra: { signal: { aborted: true } } });
    await pi.handlers.get("turn_end")(withTools, ctx);
    assert.equal(ctx.compactCalls.length, 0, "an operator interrupt must not start a compaction behind their back");
  });
}

async function testUntrustedProjectSettingsAreIgnored() {
  await withAgentDir(async () => {
    const ws = tmpWorkspace("pi-kit-trigger-untrusted-");
    try {
      fs.mkdirSync(path.join(ws, ".pi"), { recursive: true });
      fs.writeFileSync(path.join(ws, ".pi", "settings.json"), JSON.stringify({ compaction: { enabled: false } }));
      const pi = fakePi();
      (await loadExtension("vendor/trigger-compact/index.ts"))(pi.api);
      const untrusted = liveCtx({ tokens: 150_000, cwd: ws, extra: { isProjectTrusted: () => false } });
      await pi.handlers.get("turn_end")(withTools, untrusted);
      assert.equal(untrusted.compactCalls.length, 1, "pi ignores an untrusted project's settings, so compaction is still on");
      const trusted = liveCtx({ tokens: 150_000, cwd: ws, extra: { isProjectTrusted: () => true } });
      const pi2 = fakePi();
      (await loadExtension("vendor/trigger-compact/index.ts"))(pi2.api);
      await pi2.handlers.get("turn_end")(withTools, trusted);
      assert.equal(trusted.compactCalls.length, 0, "a trusted project's enabled:false applies");
    } finally { rmWorkspace(ws); }
  });
}

const tests: Array<[string, () => Promise<void>]> = [
  ["first reading above the threshold fires once, never loops, re-arms below", testFirstObservationAboveThresholdFiresOnce],
  ["unknown usage (no window, or null after compaction) is never read as 0 or as above", testUnknownUsageIsNeverTreatedAsZeroOrAbove],
  ["the kit trigger stands down when pi's own trigger fires on the same turn", testStandsDownWhenPiWouldCompactFirst],
  ["a threshold at/above pi's own trigger is idle (and says so), not silent", testEnvThresholdAboveWindowIsIdleNotSilent],
  ["/compact-threshold rejects a value pi's own trigger would pre-empt", testThresholdBetweenNativeAndWindowIsRejected],
  ["one-shot children (print/json, PI_KIT_INTERNAL_CHILD) never call ctx.compact", testOneShotChildNeverCallsCompact],
  ["a mid-run compaction aborts the run, so the extension resumes it exactly once", testMidRunCompactionIsResumedOnce],
  ["a final turn compacts after agent_settled, without resuming anything", testFinalTurnCompactsAfterSettling],
  ["an operator interrupt (signal aborted) suppresses the trigger", testEscapeIsRespected],
  ["an untrusted project's settings are ignored, as pi ignores them", testUntrustedProjectSettingsAreIgnored],
  ["pi compaction.enabled (global/project) gates auto-compaction; manual still works", testRespectsPiAutoCompactionSetting],
  ["/compact-threshold off|on toggles the trigger and survives reset", testKitOffSwitch],
  ["built-in 100k default applies and is reported as such", testDefaultThreshold],
  ["env var overrides the default and locks the TUI command", testEnvOverrideLocksCommand],
  ["/compact-threshold persists and a fresh module load honors it", testCommandPersistsAndReloads],
  ["a threshold at/above the context window is rejected, not saved", testRejectsThresholdAtOrAboveContextWindow],
  ["/compact-threshold reset clears the saved override", testReset],
  ["a corrupt `null` settings file falls back to the 100k default", testNullSettingsFileFallsBackToDefault],
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
  console.error(`\n[trigger-compact-threshold-smoke] ${failed}/${tests.length} FAILED`);
  process.exit(1);
}
console.log(`\n[trigger-compact-threshold-smoke] all ${tests.length} checks passed`);
