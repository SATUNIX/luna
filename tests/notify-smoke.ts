#!/usr/bin/env node
/**
 * notify (UX-08): output is emitted only for a UI session, never from a delegated child, and can be
 * switched off. Raw OSC bytes must never reach stdout in print/JSON mode. Offline.
 */
import assert from "node:assert/strict";
import { loadExtension, fakePi, setEnv } from "../packages/core/eval/harness.ts";

const register = await loadExtension("vendor/notify/index.ts");

interface RunOptions {
  env?: Record<string, string>;
  hasUI?: boolean;
  elapsedMs?: number;
}

async function run({ env = {}, hasUI = true, elapsedMs = 60_000 }: RunOptions = {}): Promise<string> {
  const restores = Object.entries({ PI_KIT_NOTIFY: undefined, PI_KIT_NOTIFY_MIN_SECONDS: undefined, PI_SUBAGENT_CHILD: undefined, PI_KIT_INTERNAL_CHILD: undefined, WT_SESSION: undefined, KITTY_WINDOW_ID: undefined, ...env }).map(([k, v]) => setEnv(k, v));
  const written: string[] = [];
  const realWrite = process.stdout.write.bind(process.stdout);
  const realNow = Date.now;
  try {
    const pi = fakePi();
    register(pi.api);
    let now = 1_000_000;
    Date.now = () => now;
    await pi.handlers.get("agent_start")({}, {});
    now += elapsedMs;
    process.stdout.write = (chunk) => (written.push(String(chunk)), true);
    await pi.handlers.get("agent_end")({}, { hasUI });
  } finally {
    process.stdout.write = realWrite;
    Date.now = realNow;
    for (const r of restores.reverse()) r();
  }
  return written.join("");
}

assert.notEqual(await run(), "", "a long UI run notifies");
assert.equal(await run({ hasUI: false }), "", "print/JSON sessions never write OSC bytes to stdout");
assert.equal(await run({ env: { PI_SUBAGENT_CHILD: "1" } }), "", "delegated children never notify");
assert.equal(await run({ env: { PI_KIT_INTERNAL_CHILD: "1" } }), "");
assert.equal(await run({ env: { PI_KIT_NOTIFY: "off" } }), "", "PI_KIT_NOTIFY=off silences it");
console.log("notify-smoke: OK");
