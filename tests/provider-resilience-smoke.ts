#!/usr/bin/env node
/**
 * Provider failures and stalled turns, end to end through the extension hooks:
 *  - a 402 that names what the account can afford is retried once with a lower output maximum, and
 *    cannot loop;
 *  - a failure offered to provider-router's fallback list moves the session to the next model, and the
 *    first model is restored after its cooldown;
 *  - an empty turn is steered at most twice per user message;
 *  - a tool-argument error names the bad field and the required keys instead of echoing the arguments.
 * Offline: no provider, no network.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadExtension, fakePi, tmpWorkspace, rmWorkspace, setEnv, isolateKitEnv } from "../packages/core/eval/harness.ts";
import { classifyProviderError, redactProviderError } from "../packages/extensions/src/finish-reason-retry/provider-errors.ts";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/compat";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { isRecord } from "../packages/core/lib/guard.ts";

const restoreIsolation = isolateKitEnv();
const asMessage = (m: object): AssistantMessage => m as AssistantMessage;
const afford = (n: number): string => `402 This request requires more credits, or fewer max_tokens. You requested up to 32768 tokens, but can only afford ${n}. See https://example.test/credits?key=sk-secret`;
/** The rewritten assistant message a message_end handler returned, if it returned one. */
const rewrittenOf = (result: unknown): AssistantMessage | undefined => (isRecord(result) && isRecord(result.message) ? asMessage(result.message) : undefined);
/** The text of the first content part a tool_result handler returned, if any. */
const textOf = (result: unknown): string => {
  const parts: unknown[] = isRecord(result) && Array.isArray(result.content) ? result.content : [];
  const first = parts[0];
  return isRecord(first) && typeof first.text === "string" ? first.text : "";
};
const errorTurn = (text: string) => ({ role: "assistant", stopReason: "error", errorMessage: text, content: [] });

// The classifier is the single reading of a provider failure.
assert.equal(classifyProviderError(afford(1234)).kind, "credit");
assert.equal(classifyProviderError(afford(1234)).clampTo, 1110);
assert.equal(classifyProviderError(afford(100)).clampTo, undefined, "too little to be worth a retry");
assert.equal(classifyProviderError("429 Too Many Requests").kind, "rate_limit");
assert.equal(classifyProviderError("503 service unavailable").kind, "server");
assert.equal(classifyProviderError("insufficient credits, rate limit reached").kind, "rate_limit", "a rate limit is transient even beside credit wording");
assert.equal(classifyProviderError("model not found").kind, "other");
assert.ok(!/sk-secret|example\.test/.test(redactProviderError(afford(1234))), "key URLs are not surfaced");

const frrFactory = await loadExtension("extensions/finish-reason-retry/index.ts");
const routerFactory = await loadExtension("extensions/provider-router/index.ts");
const ws = tmpWorkspace("pi-kit-resilience-");
try {
  // 1. clamp and retry
  {
    const pi = fakePi();
    frrFactory(pi.api);
    const ctx = { cwd: ws, hasUI: true, model: { id: "m1", contextWindow: 200_000, maxTokens: 32_768 }, ui: { notify() {} } };
    const out = rewrittenOf(await pi.handlers.get("message_end")({ message: errorTurn(afford(4000)) }, ctx));
    assert.ok(out, "an affordable-tokens 402 is rewritten");
    assert.equal(isRetryableAssistantError(out), true, "pi retries the rewritten message");
    assert.ok(!/sk-secret/.test(out.errorMessage ?? ""), "and it does not carry the key");
    const request = { max_tokens: 32_768, model: "m1" };
    await pi.handlers.get("before_provider_request")({ payload: request }, ctx);
    assert.equal(request.max_tokens, 3600, "the retry asks for what the account can afford");
    const other = { max_tokens: 32_768 };
    await pi.handlers.get("before_provider_request")({ payload: other }, { ...ctx, model: { id: "m2" } });
    assert.equal(other.max_tokens, 32_768, "another model is not held to it");
    // The same wall again, at the same size: no second retry (bounded, not a loop).
    const again = rewrittenOf(await pi.handlers.get("message_end")({ message: errorTurn(afford(4000)) }, ctx));
    assert.ok(again === undefined || !isRetryableAssistantError(again), "an unchanged clamp is not retried again");
    // Not enough to be useful: terminal.
    const tiny = rewrittenOf(await pi.handlers.get("message_end")({ message: errorTurn(afford(50)) }, ctx));
    assert.ok(tiny === undefined || !isRetryableAssistantError(tiny), "an account that can afford almost nothing is terminal");
  }

  // 2. fallback list with cooldown and restore
  {
    const policy = path.join(ws, "policy.json");
    fs.writeFileSync(policy, JSON.stringify({ fallback: ["p/second", "p/third"] }));
    const restorePolicy = setEnv("PI_KIT_ROUTING_POLICY", policy);
    try {
      const frr = fakePi();
      const router = fakePi();
      Object.assign(router.api, { events: frr.api.events });
      frrFactory(frr.api);
      routerFactory(router.api);
      const models = [{ provider: "p", id: "first" }, { provider: "p", id: "second" }, { provider: "p", id: "third" }];
      const registry = { find: (p: string, id: string) => models.find((m) => m.provider === p && m.id === id), getAll: () => models };
      const ctx = { cwd: ws, hasUI: false, model: models[0], modelRegistry: registry, ui: { notify() {} }, sessionManager: { getSessionId: () => "s" } };
      await router.handlers.get("session_start")({}, ctx);
      await router.handlers.get("before_agent_start")({}, ctx);
      const out = rewrittenOf(await frr.handlers.get("message_end")({ message: errorTurn("429 rate limit") }, { ...ctx, model: { id: "first" } }));
      assert.ok(out && isRetryableAssistantError(out), "a failure the fallback list took is retried");
      assert.equal(router.modelSelections.at(-1)?.id, "second", "on the next fallback model");
      const again = rewrittenOf(await frr.handlers.get("message_end")({ message: errorTurn("503 overloaded") }, { ...ctx, model: { id: "second" } }));
      assert.ok(again, "the second failure is taken too");
      assert.equal(router.modelSelections.at(-1)?.id, "third", "and moves on, skipping the model that is cooling down");
      const last = await frr.handlers.get("message_end")({ message: errorTurn("503 overloaded") }, { ...ctx, model: { id: "third" } });
      assert.equal(last, undefined, "an exhausted list is not taken, so the failure surfaces as it is");
      assert.equal(router.modelSelections.at(-1)?.id, "third", "and the model is not switched again");
    } finally {
      restorePolicy();
    }
  }

  // 2b. the retry is released only after the model switch has finished
  {
    const policy = path.join(ws, "policy-slow.json");
    fs.writeFileSync(policy, JSON.stringify({ fallback: ["p/second"] }));
    const restorePolicy = setEnv("PI_KIT_ROUTING_POLICY", policy);
    try {
      const frr = fakePi();
      const router = fakePi();
      Object.assign(router.api, { events: frr.api.events });
      let current = "first";
      Object.assign(router.api, { setModel: async (m: { id: string }) => { await new Promise((r) => setTimeout(r, 30)); current = m.id; return true; } });
      frrFactory(frr.api);
      routerFactory(router.api);
      const models = [{ provider: "p", id: "first" }, { provider: "p", id: "second" }];
      const registry = { find: (p: string, id: string) => models.find((m) => m.provider === p && m.id === id), getAll: () => models };
      const ctx = { cwd: ws, hasUI: false, model: models[0], modelRegistry: registry, ui: { notify() {} }, sessionManager: { getSessionId: () => "s" } };
      await router.handlers.get("session_start")({}, ctx);
      await router.handlers.get("before_agent_start")({}, ctx);
      const out = rewrittenOf(await frr.handlers.get("message_end")({ message: errorTurn("429 rate limit") }, { ...ctx, model: { id: "first" } }));
      assert.ok(out && isRetryableAssistantError(out));
      assert.equal(current, "second", "pi's retry is released only once the model has switched");
    } finally {
      restorePolicy();
    }
  }

  // 2c. pi.setModel returns false (no credentials) rather than throwing: that fallback is skipped, and a
  // failure no fallback could take is not retried on the model that just failed
  {
    const policy = path.join(ws, "policy-noauth.json");
    fs.writeFileSync(policy, JSON.stringify({ fallback: ["p/second", "p/third"] }));
    const restorePolicy = setEnv("PI_KIT_ROUTING_POLICY", policy);
    try {
      const run = async (usable: string[]) => {
        const frr = fakePi();
        const router = fakePi();
        Object.assign(router.api, { events: frr.api.events });
        const tried: string[] = [];
        let current = "first";
        Object.assign(router.api, { setModel: async (m: { id: string }) => { tried.push(m.id); if (!usable.includes(m.id)) return false; current = m.id; return true; } });
        frrFactory(frr.api);
        routerFactory(router.api);
        const models = [{ provider: "p", id: "first" }, { provider: "q", id: "first" }, { provider: "p", id: "second" }, { provider: "p", id: "third" }];
        const registry = { find: (p2: string, id: string) => models.find((m) => m.provider === p2 && m.id === id), getAll: () => models };
        const ctx = { cwd: ws, hasUI: false, model: models[1], modelRegistry: registry, ui: { notify() {} }, sessionManager: { getSessionId: () => "s" } };
        await router.handlers.get("session_start")({}, ctx);
        await router.handlers.get("before_agent_start")({}, ctx);
        const out = rewrittenOf(await frr.handlers.get("message_end")({ message: errorTurn("429 rate limit") }, { ...ctx, model: { provider: "q", id: "first" } }));
        return { out, tried, current: () => current };
      };
      const partial = await run(["third"]);
      assert.deepEqual(partial.tried, ["second", "third"], "an unauthenticated fallback is skipped for the next one");
      assert.ok(partial.out && isRetryableAssistantError(partial.out));
      assert.equal(partial.current(), "third");
      const none = await run([]);
      assert.deepEqual(none.tried, ["second", "third"]);
      assert.equal(none.out, undefined, "no fallback took the switch: the failure is not retried on the same model");
    } finally {
      restorePolicy();
    }
  }

  // 3. empty turns: two steers per user message
  {
    const pi = fakePi();
    frrFactory(pi.api);
    const ctx = { cwd: ws, hasUI: false, model: { id: "m" } };
    const empty = { message: { role: "assistant", stopReason: "stop", content: [{ type: "thinking", thinking: "hm" }, { type: "text", text: "  " }] } };
    const productive = { message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] } };
    const toolCall = { message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "1", name: "read", arguments: {} }] } };
    await pi.handlers.get("message_end")(productive, ctx);
    await pi.handlers.get("message_end")(toolCall, ctx);
    assert.equal(pi.steers.length, 0, "turns with text or a tool call are left alone");
    for (let i = 0; i < 4; i++) await pi.handlers.get("message_end")(empty, ctx);
    assert.equal(pi.steers.length, 2, "an empty turn is steered at most twice");
    await pi.handlers.get("input")({ source: "interactive", text: "go on" }, ctx);
    await pi.handlers.get("message_end")(empty, ctx);
    assert.equal(pi.steers.length, 3, "a new user message starts a fresh budget");
  }

  // 4. tool-argument errors
  {
    const pi = fakePi();
    frrFactory(pi.api);
    Object.assign(pi.api, { getAllTools: () => [{ name: "write", description: "", parameters: { type: "object", properties: { path: {}, content: {}, mode: {} }, required: ["path", "content"] } }] });
    const raw = 'Validation failed for tool "write":\n  - content: must be string\n\nReceived arguments:\n{"path":"a","content":' + "x".repeat(5000) + "}";
    const out = await pi.handlers.get("tool_result")({ isError: true, content: [{ type: "text", text: raw }] });
    const text = textOf(out);
    assert.match(text, /content: must be string/);
    assert.match(text, /Required: path, content/);
    assert.ok(text.length < 500, "the received arguments are not echoed back");
    const cut = await pi.handlers.get("tool_result")({ isError: true, content: [{ type: "text", text: 'Invalid arguments for tool "write": Unexpected end of JSON input' }] });
    assert.match(textOf(cut), /cut off/);
    assert.equal(await pi.handlers.get("tool_result")({ isError: true, content: [{ type: "text", text: "ENOENT: no such file" }] }), undefined, "other tool errors are untouched");
    assert.equal(await pi.handlers.get("tool_result")({ isError: false, content: [{ type: "text", text: raw }] }), undefined);
  }
  console.log("PASS provider-resilience: 402 clamp-and-retry, fallback list, empty-turn steer, tool-argument errors");
} finally {
  rmWorkspace(ws);
  restoreIsolation();
}
