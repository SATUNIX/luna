#!/usr/bin/env node
/**
 * B-033 regression pin: finish-reason-retry must annotate the raw provider error so pi's
 * REAL retry classifier accepts the rewritten message.
 *
 * The eval fixture (packages/core/eval/fixtures.ts) only asserts the extension's own
 * RETRYABLE_PROVIDER_ERROR regex against its own toRetryableErrorMessage() output — a
 * circular check. The property that matters in production is whether pi's actual retry
 * classifier (isRetryableAssistantError) returns true for the annotated message,
 * otherwise the extension silently becomes a no-op.
 *
 * Classifier import: PRIMARY is `@earendil-works/pi-ai/compat`'s isRetryableAssistantError
 * (the exported compat surface). FALLBACK, if that import is unavailable in this process,
 * is the same function from `@earendil-works/pi-ai/utils/retry` (both resolve to
 * pi-ai/dist/utils/retry.js). The path actually used is printed below.
 *
 * B-040 composed-predicate pin: pi's host retry decision is _isRetryableError(), which
 * returns false when isContextOverflow(message, contextWindow) matches BEFORE consulting
 * isRetryableAssistantError. We therefore also pin isContextOverflow on the annotated
 * message, with the same compat/fallback import strategy, to catch an annotated message
 * that reads as retryable but would be suppressed as a context overflow in production.
 */
import assert from "node:assert/strict";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { MessageEndEventResult } from "@earendil-works/pi-coding-agent";
import { loadModule, fakePi } from "../packages/core/eval/harness.ts";
import type { ExtensionFactory } from "../packages/core/eval/harness.ts";
import { isRecord } from "../packages/core/lib/guard.ts";
import type * as FrrModule from "../packages/extensions/src/finish-reason-retry/index.ts";

let isRetryableAssistantError: (message: AssistantMessage) => boolean;
let classifierSource: string;
try {
  ({ isRetryableAssistantError } = await import("@earendil-works/pi-ai/compat"));
  classifierSource = "@earendil-works/pi-ai/compat";
} catch {
  ({ isRetryableAssistantError } = await import("@earendil-works/pi-ai/utils/retry"));
  classifierSource = "@earendil-works/pi-ai/utils/retry";
}
assert.equal(typeof isRetryableAssistantError, "function", "pi's real retry classifier must be importable");

let isContextOverflow: (message: AssistantMessage, contextWindow?: number) => boolean;
let overflowSource: string;
try {
  ({ isContextOverflow } = await import("@earendil-works/pi-ai/compat"));
  overflowSource = "@earendil-works/pi-ai/compat";
} catch {
  ({ isContextOverflow } = await import("@earendil-works/pi-ai/utils/overflow"));
  overflowSource = "@earendil-works/pi-ai/utils/overflow";
}
assert.equal(typeof isContextOverflow, "function", "pi's real context-overflow classifier must be importable");

const RAW_ERROR_MESSAGE = "Provider finish_reason: error";
// Partial assistant messages: the classifiers and the handler only read role/stopReason/errorMessage/usage.
type MessageFixture = Partial<Omit<AssistantMessage, "usage">> & { usage?: Partial<AssistantMessage["usage"]> };
const partialMessage = (message: MessageFixture): AssistantMessage => message as AssistantMessage;
/** What finish-reason-retry's message_end handler returns when it rewrites: the annotated assistant message. */
type Rewritten = MessageEndEventResult & { message: AssistantMessage & { errorMessage: string } };
const rawMessage = () => partialMessage({ role: "assistant", stopReason: "error", errorMessage: RAW_ERROR_MESSAGE });

// The default export is called with the fake pi API, so the test states it as the harness's ExtensionFactory.
const mod = await loadModule<Omit<typeof FrrModule, "default"> & { default: ExtensionFactory }>("extensions/finish-reason-retry/index.ts");
assert.equal(typeof mod.toRetryableErrorMessage, "function", "toRetryableErrorMessage must be exported");
assert.equal(typeof mod.RETRYABLE_PROVIDER_ERROR, "object", "RETRYABLE_PROVIDER_ERROR must be exported");

// 1. The raw provider error is NOT retryable by pi's own classifier. If this ever becomes
//    true the extension is redundant, so the baseline must be asserted, not assumed.
assert.equal(isRetryableAssistantError(rawMessage()), false, `raw "${RAW_ERROR_MESSAGE}" must not be retryable (${classifierSource})`);

// 2. THE PIN: the annotated message MUST be retryable by pi's real classifier. This fails
//    if either pi's retry pattern or the extension's marker drifts to a non-matching value.
const rewritten = mod.toRetryableErrorMessage(RAW_ERROR_MESSAGE);
const annotated = { ...rawMessage(), errorMessage: rewritten };
assert.equal(isRetryableAssistantError(annotated), true, `annotated errorMessage must be retryable by ${classifierSource}: ${rewritten}`);

// 2b. B-040 composed-predicate pin: pi's host retry decision is _isRetryableError(),
//     which negates isContextOverflow before consulting isRetryableAssistantError. The
//     annotated message must clear BOTH gates, or the extension becomes a no-op in
//     production while assertion 2 alone stays green.
const CONTEXT_WINDOW = 200000;
assert.equal(isContextOverflow(annotated, CONTEXT_WINDOW), false, `annotated errorMessage must not look like a context overflow (${overflowSource})`);
const hostWouldRetry = !isContextOverflow(annotated, CONTEXT_WINDOW) && isRetryableAssistantError(annotated);
assert.equal(hostWouldRetry, true, "the composed host predicate must retry the annotated message");

// 3. Driving the real message_end handler rewrites the target case...
const pi = fakePi();
mod.default(pi.api);
const out = (await pi.handlers.get("message_end")({ message: rawMessage() })) as Rewritten | undefined;
assert.ok(out?.message, "the target case must return a rewritten message");
assert.equal(out.message.errorMessage, rewritten, "handler must annotate with toRetryableErrorMessage()");
assert.equal(isRetryableAssistantError(out.message), true, "the handler output must be accepted by pi's retry classifier");

// ...and leaves every non-target case untouched (undefined).
const untouchedCases = [
  ["non-assistant role", { message: { role: "user", stopReason: "error", errorMessage: RAW_ERROR_MESSAGE } }],
  ["non-error stopReason", { message: { role: "assistant", stopReason: "stop", errorMessage: RAW_ERROR_MESSAGE } }],
  ["different error message", { message: { role: "assistant", stopReason: "error", errorMessage: "Provider finish_reason: content_filter" } }],
] satisfies Array<[string, object]>;
for (const [name, event] of untouchedCases) {
  assert.equal(await pi.handlers.get("message_end")(event), undefined, `${name} must return undefined`);
}

console.log(`PASS finish-reason-retry classifier pin (via ${classifierSource}): raw not retryable, annotated retryable, handler branches correct`);

// ---------------------------------------------------------------------------------------------
// Exhausted context windows (pi 0.85.1: compaction.enabled=false disables threshold compaction AND
// overflow recovery; enabled: one compact-and-retry, then the run ends). This extension is loaded in
// subagent children, so the explanation has to be in the message the parent will read.
// ---------------------------------------------------------------------------------------------
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { setEnv, rmWorkspace } from "../packages/core/eval/harness.ts";

const WINDOW = 200_000;
const overflowMessage = (text = "prompt is too long: 213462 tokens > 200000 maximum") => partialMessage({
  role: "assistant", stopReason: "error", errorMessage: text, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
});
const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-frr-agent-"));
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-frr-cwd-"));
const restoreAgent = setEnv("PI_CODING_AGENT_DIR", agentDir);
interface Note {
  m: string;
  l: string;
}
interface FrrCtx {
  cwd: string;
  hasUI: boolean;
  model: { contextWindow: number; maxTokens: number };
  ui: { notify: (m: string, l: string) => void };
  notes: Note[];
  isProjectTrusted?: () => boolean;
}
/** pi-ai's clampMaxTokensToContext as this test calls it: it reads only the window and the messages. */
type PiClamp = (model: { contextWindow: number }, context: { messages: Array<{ role: string; content: string; timestamp: number }> }, maxTokens: number) => number;
function isPiClamp(value: unknown): value is PiClamp {
  return typeof value === "function";
}
type PiTextEstimate = (text: string) => number;
function isPiTextEstimate(value: unknown): value is PiTextEstimate {
  return typeof value === "function";
}
type PiContextEstimate = (context: { messages: Array<{ role: string; content: string; timestamp: number }> }) => { tokens: number };
function isPiContextEstimate(value: unknown): value is PiContextEstimate {
  return typeof value === "function";
}
const ctxFor = (over: Partial<FrrCtx> = {}): FrrCtx => {
  const notes: Note[] = [];
  return { cwd, hasUI: true, model: { contextWindow: WINDOW, maxTokens: 16_384 }, ui: { notify: (m, l) => notes.push({ m, l }) }, notes, ...over };
};

try {
  const frr = fakePi();
  mod.default(frr.api);

  // 1. Compaction ON (default): pi compacts and retries once by itself; the message is left alone.
  {
    const ctx = ctxFor();
    assert.equal(await frr.handlers.get("message_end")({ message: overflowMessage() }, ctx), undefined, "pi's own recovery handles it; do not touch the message");
    assert.equal(ctx.notes.length, 0);
  }

  // 2. Compaction OFF globally: nothing will recover this run, so the message says why and how out,
  //    and pi's own overflow classification still holds on the rewritten text (else it would treat a
  //    full window as an ordinary retryable error).
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ compaction: { enabled: false } }));
  {
    const ctx = ctxFor();
    const out = (await frr.handlers.get("message_end")({ message: overflowMessage() }, ctx)) as Rewritten | undefined;
    assert.ok(out?.message, "an unrecoverable overflow is rewritten");
    assert.match(out.message.errorMessage, /^\[pi-kit context-exhausted\] The context window is full \(200k-token window\) and pi auto-compaction is OFF \(compaction\.enabled=false in .*settings\.json\)/);
    assert.match(out.message.errorMessage, /\/compaction on/);
    assert.match(out.message.errorMessage, /prompt is too long: 213462 tokens > 200000 maximum$/, "the provider's own text is kept");
    assert.equal(isContextOverflow(out.message, WINDOW), true, "still classified as an overflow by pi");
    assert.equal(isRetryableAssistantError(out.message), false, "and never retried as an ordinary error (no retry loop)");
    assert.equal(ctx.notes.length, 1);
    assert.equal(ctx.notes[0]?.l, "error");
    // Already annotated: idempotent.
    assert.equal(await frr.handlers.get("message_end")({ message: out.message }, ctxFor()), undefined);
  }

  // 3. A provider pattern anchored to the message start (Cerebras "^413 (no body)") keeps working:
  //    the explanation goes behind it.
  //    That pattern is pi-ai's, and newer pi-ai releases changed which bare 413 texts count as an
  //    overflow: the extension must follow pi's classifier either way, so the expectation is derived
  //    from it (rewrite exactly when pi calls the raw message an overflow, and then keep it one).
  {
    const raw = overflowMessage("413 status code (no body)");
    const piCallsItOverflow = isContextOverflow(raw, WINDOW);
    const out = (await frr.handlers.get("message_end")({ message: raw }, ctxFor())) as Rewritten | undefined;
    if (piCallsItOverflow) {
      assert.ok(out, "an overflow is rewritten");
      assert.match(out.message.errorMessage, /^413 status code \(no body\) \[pi-kit context-exhausted\]/);
      assert.equal(isContextOverflow(out.message, WINDOW), true);
    } else {
      assert.equal(out, undefined, "not an overflow to pi, so the message is left alone");
    }
  }

  // 4. Non-overflow errors and rate limits are never touched.
  for (const text of ["429 rate limit exceeded", "Provider finish_reason: content_filter", "socket hang up"]) {
    assert.equal(await frr.handlers.get("message_end")({ message: overflowMessage(text) }, ctxFor()), undefined, text);
  }

  // 5. Precedence: an enabled project overrides the disabled global one (pi's merge); an untrusted
  //    project's file is not read at all.
  fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".pi", "settings.json"), JSON.stringify({ compaction: { enabled: true } }));
  assert.equal(await frr.handlers.get("message_end")({ message: overflowMessage() }, ctxFor({ isProjectTrusted: () => true })), undefined, "project enabled:true wins");
  assert.ok(await frr.handlers.get("message_end")({ message: overflowMessage() }, ctxFor({ isProjectTrusted: () => false })), "untrusted project ignored: global false applies");
  fs.rmSync(path.join(cwd, ".pi"), { recursive: true, force: true });

  // 6. No UI (a print/JSON child): the explanation goes to stderr, once per event.
  {
    const chunks: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = (c) => { chunks.push(String(c)); return true; };
    try {
      await frr.handlers.get("message_end")({ message: overflowMessage() }, ctxFor({ hasUI: false }));
    } finally { process.stderr.write = original; }
    assert.equal(chunks.length, 1);
    const [chunk] = chunks;
    assert.ok(chunk !== undefined, "the explanation was written to stderr");
    assert.match(chunk, /^\[pi-kit\] \[pi-kit context-exhausted\] The context window is full/);
  }

  // 7. A failed compact-and-retry (pi ends the run; it never loops) names the way out.
  fs.rmSync(path.join(agentDir, "settings.json"));
  {
    const ctx = ctxFor();
    await frr.handlers.get("session_compact_failed")({ reason: "overflow", errorMessage: "Context overflow recovery failed after one compact-and-retry attempt.", aborted: false, willRetry: false, fromExtension: false }, ctx);
    assert.equal(ctx.notes.length, 1);
    const [failure] = ctx.notes;
    assert.ok(failure, "a failed recovery is explained");
    assert.match(failure.m, /one compact-and-retry attempt failed .* will not retry again/);
    assert.match(failure.m, /\/compress .* \/new .* larger-context model/);
    const cancelled = ctxFor();
    await frr.handlers.get("session_compact_failed")({ reason: "overflow", aborted: true, willRetry: false, fromExtension: false }, cancelled);
    assert.equal(cancelled.notes.length, 0, "a deliberate cancel is not a failure");
    const threshold = ctxFor();
    await frr.handlers.get("session_compact_failed")({ reason: "threshold", errorMessage: "summariser down", aborted: false, willRetry: false, fromExtension: false }, threshold);
    const [thresholdNote] = threshold.notes;
    assert.ok(thresholdNote, "a failed threshold compaction is explained");
    assert.match(thresholdNote.m, /Automatic compaction failed \(summariser down\)/);
  }

  // 8. Output-cap arithmetic: derived from the model's real maxTokens/contextWindow, identical to pi-ai's
  //    own clamp (api/simple-options.js), never a hard-coded number.
  const piAiDist = path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-ai/compat")));
  const simpleOptions: unknown = await import(pathToFileURL(path.join(piAiDist, "api", "simple-options.js")).href);
  const piEstimate: unknown = await import(pathToFileURL(path.join(piAiDist, "utils", "estimate.js")).href);
  const capCases: Array<[number, number, number]> = [[200_000, 16_384, 10_000], [200_000, 16_384, 190_000], [8192, 4096, 6000], [32_768, 32_768, 100], [200_000, 16_384, 250_000]];
  for (const [window, maxTokens, input] of capCases) {
    const derived = mod.derivedOutputCap({ contextWindow: window, maxTokens }, input);
    assert.ok(derived !== null, `a known window ${window} has a derived cap`);
    const room = Math.max(1, window - input - 4096);
    assert.equal(derived, Math.min(maxTokens, room), `derived cap for window ${window}, input ${input}`);
    assert.ok(derived >= 1, "always at least one token");
    assert.ok(input + derived <= Math.max(window - 4096, input + 1), "input + output stays inside the window with the safety headroom (unless the input alone already overflows)");
  }
  const clampMaxTokensToContext = isRecord(simpleOptions) ? simpleOptions.clampMaxTokensToContext : undefined;
  assert.ok(isPiClamp(clampMaxTokensToContext), "pi-ai's own clamp is importable for the equivalence check");
  const estimateTextTokens = isRecord(piEstimate) ? piEstimate.estimateTextTokens : undefined;
  assert.ok(isPiTextEstimate(estimateTextTokens), "pi-ai's own token estimate is importable for sizing the input");
  // pi-ai estimates tokens from characters, and the ratio is its own (4 chars/token before pi-ai 1.x,
  // 3.5 since), so size the input with its estimate rather than assuming a ratio.
  const charsPerToken = 100_000 / estimateTextTokens("x".repeat(100_000));
  const estimateContextTokens = isRecord(piEstimate) ? piEstimate.estimateContextTokens : undefined;
  assert.ok(isPiContextEstimate(estimateContextTokens), "pi-ai's own context estimate is importable");
  const clampCases: Array<[number, number, number]> = [[200_000, 16_384, 10_000], [200_000, 16_384, 190_000], [8192, 4096, 6000]];
  for (const [window, maxTokens, input] of clampCases) {
    // pi-ai's estimateContextTokens works on messages; feed it text sized to `input` tokens.
    const context = { messages: [{ role: "user", content: "x".repeat(Math.floor(input * charsPerToken)), timestamp: 0 }] };
    const piClamp = clampMaxTokensToContext({ contextWindow: window }, context, maxTokens);
    // The same input as pi-ai counted it, so the comparison is of the clamp arithmetic alone.
    const mine = mod.derivedOutputCap({ contextWindow: window, maxTokens }, estimateContextTokens(context).tokens);
    assert.ok(mine !== null, `a known window ${window} has a derived cap`);
    assert.ok(Math.abs(piClamp - mine) <= 2, `matches pi-ai's clamp (${piClamp} vs ${mine}) for window ${window}`);
  }
  assert.equal(mod.derivedOutputCap({ maxTokens: 4096 }, 100), null, "an unknown window has no derivable cap");
  assert.equal(mod.derivedOutputCap({ contextWindow: 0, maxTokens: 4096 }, 100), null);

  // 9. A "length" stop that the window headroom clamped is explained; one at the model's own limit is not.
  {
    const lengthMsg = (output: number, input: number) => partialMessage({ role: "assistant", stopReason: "length", usage: { input, output, cacheRead: 0, cacheWrite: 0 } });
    const clamped = ctxFor({ model: { contextWindow: 32_768, maxTokens: 16_384 } });
    assert.equal(await frr.handlers.get("message_end")({ message: lengthMsg(400, 28_000) }, clamped), undefined, "never rewrites a length stop");
    assert.equal(clamped.notes.length, 1);
    const [clampNote] = clamped.notes;
    assert.ok(clampNote, "the clamped length stop is explained");
    assert.match(clampNote.m, /reply cut off at 400 tokens: with 28k tokens of input in a 32\.8k window only 672 of the model's 16\.4k output tokens fit/);
    await frr.handlers.get("message_end")({ message: lengthMsg(400, 28_000) }, clamped);
    assert.equal(clamped.notes.length, 1, "the same note is not repeated");
    const atLimit = ctxFor({ model: { contextWindow: 200_000, maxTokens: 16_384 } });
    await frr.handlers.get("message_end")({ message: lengthMsg(16_384, 5_000) }, atLimit);
    assert.equal(atLimit.notes.length, 0, "headroom was ample: the model simply hit its own maxTokens");
    const unknown = ctxFor({ model: { contextWindow: 0, maxTokens: 16_384 } });
    await frr.handlers.get("message_end")({ message: lengthMsg(400, 5_000) }, unknown);
    assert.equal(unknown.notes.length, 0, "an unknown window is not guessed at");
  }
  console.log("PASS finish-reason-retry: exhausted windows explained (compaction off / failed recovery / clamped output), no retry loop, no rewrite of unrelated errors");
} finally {
  restoreAgent();
  rmWorkspace(agentDir);
  rmWorkspace(cwd);
}
