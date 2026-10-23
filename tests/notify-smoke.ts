#!/usr/bin/env node
/**
 * notify (UX-08): the OSC/bell/notify-send output is emitted only for a UI session, only for runs
 * long enough to have looked away, never from a delegated child, and can be switched off or moved to
 * the bell. Raw OSC bytes must never reach stdout in print/JSON mode. Offline.
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

assert.ok((await run()).includes("\x1b]777;notify;Pi;Ready for input"), "a long UI run notifies (OSC 777 by default)");
assert.equal(await run({ hasUI: false }), "", "print/JSON sessions never write OSC bytes to stdout");
assert.equal(await run({ elapsedMs: 2_000 }), "", "a run shorter than the default 10 s stays quiet");
assert.match(await run({ elapsedMs: 2_000, env: { PI_KIT_NOTIFY_MIN_SECONDS: "0" } }), /777/, "PI_KIT_NOTIFY_MIN_SECONDS=0 notifies every run");
assert.equal(await run({ env: { PI_SUBAGENT_CHILD: "1" } }), "", "delegated children never notify");
assert.equal(await run({ env: { PI_KIT_INTERNAL_CHILD: "1" } }), "");
assert.equal(await run({ env: { PI_KIT_NOTIFY: "off" } }), "", "PI_KIT_NOTIFY=off silences it");
assert.equal(await run({ env: { PI_KIT_NOTIFY: "bell" } }), "\x07", "PI_KIT_NOTIFY=bell rings the terminal bell only");
assert.ok((await run({ env: { KITTY_WINDOW_ID: "1" } })).includes("\x1b]99;"), "kitty keeps its native path");
console.log("notify-smoke: OK");
