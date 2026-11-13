#!/usr/bin/env node
/**
 * First-start behaviour: pi draws nothing while it compiles extensions after an install, update or
 * reboot. The delegation-guard notice must appear only on a cold interactive start, must be gone
 * before pi's first write, and must never write into a script, child or running TUI. The
 * installer's pre-load must run pi offline in rpc mode and never fail the install.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { spawnSync } from "node:child_process";
import { showColdStartNotice, kitKey as extKitKey, type ColdStartEnv } from "../packages/extensions/src/delegation-guard/cold-start.ts";
import { stampCompiledKit, kitKey as coreKitKey } from "../packages/core/lib/cold-stamp.ts";
import { warmPiExtensions } from "../packages/core/lib/pi-cli.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "luna-startup-notice-"));
const written: string[] = [];
const terminal = (isTTY = true): NodeJS.WriteStream => {
  const fake = { isTTY, columns: 120, write: (chunk: string): boolean => (written.push(chunk), true) };
  return fake as unknown as NodeJS.WriteStream;
};
const env = (over: Partial<ColdStartEnv> = {}): ColdStartEnv => ({ stdout: terminal(), stdin: { isTTY: true }, env: {}, argv: ["node", "pi"], stampDir: dir, kitKey: "kit-1", ...over });

try {
  // A cold interactive start shows the notice, then erases it before pi's first bytes.
  const cold = env();
  assert.equal(showColdStartNotice(cold), true, "cold interactive start draws");
  assert.equal(written.length, 1, "only the notice so far");
  assert.ok(!written[0]?.includes("\n"), "no newline: it must be erasable");
  cold.stdout.write("pi's own bytes");
  assert.ok(written.includes("pi's own bytes"), "pi's own bytes pass through untouched");
  assert.ok(written.length >= 3, "the notice was erased before pi's first write");

  // The same kit is now compiled, so the next start is silent; an update (new key) is cold again.
  written.length = 0;
  assert.equal(showColdStartNotice(env()), false, "warm start draws nothing");
  assert.equal(showColdStartNotice(env({ kitKey: "kit-2" })), true, "a different kit version is cold again");
  assert.equal(fs.readdirSync(dir).length, 1, "only the finished kit left a stamp");
  written.length = 0;

  // An exit during the compile erases the line but does not stamp, so the next cold start still warns.
  {
    const d2 = fs.mkdtempSync(path.join(os.tmpdir(), "luna-startup-exit-"));
    const exits: Array<() => void> = [];
    const realOnce = process.once.bind(process);
    process.once = ((ev: string, fn: () => void) => (ev === "exit" ? (exits.push(fn), process) : realOnce(ev, fn))) as typeof process.once;
    try {
      assert.equal(showColdStartNotice(env({ stampDir: d2, kitKey: "e1" })), true);
      exits[0]?.();
      assert.deepEqual(fs.readdirSync(d2), [], "an exit mid-compile writes no stamp");
      assert.ok(written.length >= 2, "but still erases the line");
    } finally {
      process.once = realOnce;
      fs.rmSync(d2, { recursive: true, force: true });
    }
    written.length = 0;
  }

  // Install then first start: the installer's stamp makes the first real start silent.
  {
    const d3 = fs.mkdtempSync(path.join(os.tmpdir(), "luna-startup-install-"));
    try {
      assert.equal(coreKitKey(path.join(process.cwd(), "packages", "core", "lib")), extKitKey(path.join(process.cwd(), "packages", "extensions", "src", "delegation-guard")), "installer and extension agree on the key");
      stampCompiledKit(d3, coreKitKey());
      assert.equal(showColdStartNotice(env({ stampDir: d3, kitKey: extKitKey(path.join(process.cwd(), "packages", "extensions", "src", "delegation-guard")) })), false, "first start after install is silent");
      assert.deepEqual(written, []);
    } finally {
      fs.rmSync(d3, { recursive: true, force: true });
    }
  }

  // Never in a script, a child, CI, a dumb terminal or a non-interactive pi run.
  const quiet: Array<[string, Partial<ColdStartEnv>]> = [
    ["stdout is not a terminal", { stdout: terminal(false), kitKey: "q1" }],
    ["stdin is not a terminal", { stdin: { isTTY: false }, kitKey: "q2" }],
    ["CI", { env: { CI: "1" }, kitKey: "q3" }],
    ["TERM=dumb", { env: { TERM: "dumb" }, kitKey: "q4" }],
    ["print mode", { argv: ["node", "pi", "-p", "hi"], kitKey: "q5" }],
    ["rpc mode", { argv: ["node", "pi", "--mode", "rpc"], kitKey: "q6" }],
  ];
  for (const [why, over] of quiet) assert.equal(showColdStartNotice(env(over)), false, `silent when ${why}`);
  assert.deepEqual(written, [], "nothing was written in any of them");

  // The installer's pre-load: pi in rpc mode, offline, input closed after get_commands; failure is not fatal.
  const calls: Array<{ command: string; args: readonly string[]; options: { input?: string; env?: NodeJS.ProcessEnv } }> = [];
  const fakeSpawn = (status: number | null, error?: Error): typeof spawnSync => {
    const spawn = (command: string, args: readonly string[], options: { input?: string; env?: NodeJS.ProcessEnv }): { status: number | null; error: Error | undefined } => {
      calls.push({ command, args, options });
      return { status, error };
    };
    return spawn as unknown as typeof spawnSync;
  };
  const good = warmPiExtensions("pi", { spawn: fakeSpawn(0), platform: "linux" });
  assert.equal(good.ok, true);
  assert.deepEqual(calls[0]?.args, ["--mode", "rpc"]);
  assert.equal(calls[0]?.options.env?.PI_OFFLINE, "1", "never waits on the network");
  assert.match(calls[0]?.options.input ?? "", /"get_commands"/);
  assert.equal(warmPiExtensions("pi", { spawn: fakeSpawn(1), platform: "linux" }).ok, false, "a pi that fails is reported");
  assert.equal(warmPiExtensions("pi", { spawn: fakeSpawn(null, new Error("ENOENT")), platform: "linux" }).ok, false, "a missing pi is reported, not thrown");
  console.log("startup-notice smoke: ok");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
