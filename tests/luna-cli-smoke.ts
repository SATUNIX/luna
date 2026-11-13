#!/usr/bin/env node
/**
 * The `luna` command: --bare starts pi with no Luna extensions; `exec` is a thin headless wrapper
 * (final answer on stdout, progress on stderr, --json passthrough, the shared ceiling as environment,
 * exit 13 passed through); an extension switched off in overrides.json is found before pi starts.
 * Offline: a fake `pi` on PATH records its arguments.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT, isolateKitEnv } from "../packages/core/eval/harness.ts";
import { array, isRecord, object, parseJsonAs, record as recordOf, string } from "../packages/core/lib/guard.ts";
import { pendingDisables, planExec } from "../packages/core/lib/headless.ts";
import { piSpawnPlan } from "../packages/core/lib/pi-cli.ts";

isolateKitEnv();
if (process.platform === "win32") {
  console.log("skip: the fake pi is a POSIX script");
  process.exit(0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "luna-cli-"));
try {
  const bin = path.join(tmp, "bin");
  fs.mkdirSync(bin);
  const record = path.join(tmp, "record.json");
  const events = [
    { type: "session", id: "x" },
    { type: "tool_execution_start", toolName: "read", args: {} },
    { type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "the answer" }] } },
  ];
  fs.writeFileSync(path.join(bin, "pi"), `#!/usr/bin/env node
const fs = require("node:fs");
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("PI_KIT_CEILING") || k === "PI_KIT_AUTO_PROFILE"));
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args: process.argv.slice(2), env }));
for (const e of ${JSON.stringify(events)}) console.log(JSON.stringify(e));
process.exit(Number(process.env.FAKE_PI_EXIT || 0));
`, { mode: 0o755 });
  const agent = path.join(tmp, "agent");
  fs.mkdirSync(agent);
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, PI_CODING_AGENT_DIR: agent };
  const luna = (args: string[], extra: NodeJS.ProcessEnv = {}, input?: string) =>
    spawnSync(process.execPath, [path.join(ROOT, "packages", "core", "luna.ts"), ...args], { env: { ...env, ...extra }, encoding: "utf8", ...(input !== undefined ? { input } : {}) });
  const Recorded = object({ args: array(string()), env: recordOf(string()) });
  const recorded = () => parseJsonAs(Recorded, fs.readFileSync(record, "utf8"));

  // --bare: pi gets the flags that drop every Luna extension, and the rest of the command line unchanged.
  const bare = luna(["--bare", "--model", "x"]);
  assert.equal(bare.status, 0);
  for (const flag of ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes"]) assert.ok(recorded().args.includes(flag), `--bare passes ${flag}`);
  assert.deepEqual(recorded().args.slice(-2), ["--model", "x"]);

  // exec: the final answer is the only thing on stdout; progress is on stderr.
  const run = luna(["exec", "--ephemeral", "--max-turns", "5", "--max-cost", "1.5", "--timeout", "2m", "do it"]);
  assert.equal(run.status, 0);
  assert.equal(run.stdout, "the answer\n");
  assert.match(run.stderr, /tool read/);
  const seen = recorded();
  assert.ok(seen.args.includes("--no-session") && seen.args.includes("json"));
  assert.equal(seen.args.at(-1), "do it");
  assert.deepEqual({ ...seen.env }, { PI_KIT_CEILING_TURNS: "5", PI_KIT_CEILING_USD: "1.5", PI_KIT_CEILING_SECONDS: "120", PI_KIT_AUTO_PROFILE: "0" });

  // The prompt from stdin; --json hands pi's event stream through untouched.
  const piped = luna(["exec", "--json", "-"], {}, "from stdin\n");
  assert.equal(recorded().args.at(-1), "from stdin");
  assert.deepEqual(piped.stdout.trim().split("\n").map((l) => { const e: unknown = JSON.parse(l); return isRecord(e) ? e.type : undefined; }), ["session", "tool_execution_start", "message_end"]);

  // A parked run (pi exits 13) keeps its code.
  assert.equal(luna(["exec", "go"], { FAKE_PI_EXIT: "13" }).status, 13);

  // A bad limit is refused, never read as no limit.
  // A ceiling is refused when overrides.json switches off the extension that enforces it.
  fs.mkdirSync(path.join(agent, "pi-kit"), { recursive: true });
  fs.writeFileSync(path.join(agent, "pi-kit", "overrides.json"), JSON.stringify({ extensions: { remove: ["goal-core"] } }));
  const refused = luna(["exec", "--max-turns", "3", "p"]);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /goal-core/);
  fs.rmSync(path.join(agent, "pi-kit"), { recursive: true });

  for (const bad of [["--max-turns", "0", "p"], ["--max-cost", "abc", "p"], ["--timeout", "soon", "p"], ["--wat", "p"], []]) {
    assert.equal(typeof planExec(bad), "string", `refused: ${bad.join(" ")}`);
  }

  // Windows: pi is an npm .cmd shim that Node cannot start without a shell, and a shell splits the prompt.
  // exec starts pi's node entry named in the shim, with no shell, so the prompt stays one argument.
  const shim = '@ECHO off\r\nSETLOCAL\r\nSET dp0=%~dp0\r\n"%_prog%"  "%dp0%\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js" %*\r\n';
  const winDeps = { platform: "win32" as const, nodePath: "C:\\node\\node.exe", env: { PATH: "C:\\x;C:\\npm" }, readFile: (file: string) => (file === "C:\\npm\\pi.cmd" ? shim : undefined) };
  assert.deepEqual(piSpawnPlan("pi", ["--mode", "json", "--", "two words & more"], winDeps), {
    command: "C:\\node\\node.exe",
    args: ["C:\\npm\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js", "--mode", "json", "--", "two words & more"],
  });
  const missing = piSpawnPlan("pi", ["a b"], { ...winDeps, readFile: () => undefined });
  assert.equal(typeof missing === "string" && /could not find pi's node entry/.test(missing), true, "no shim found: a reason, never a shell");
  assert.deepEqual(piSpawnPlan("pi", ["a b"], { platform: "linux" }), { command: "pi", args: ["a b"] });

  // overrides.json: a removed extension the marker still lists is pending; none once applied.
  fs.mkdirSync(path.join(agent, "pi-kit"));
  fs.writeFileSync(path.join(agent, "pi-kit", "overrides.json"), JSON.stringify({ extensions: { remove: ["herdr", "branch-lab"] } }));
  fs.writeFileSync(path.join(agent, ".pi-kit.json"), JSON.stringify({ profile: "balanced", scope: "global", extensions: ["herdr", "effort"] }));
  assert.deepEqual(pendingDisables(agent), { profile: "balanced", names: ["herdr"] });
  fs.writeFileSync(path.join(agent, ".pi-kit.json"), JSON.stringify({ profile: "balanced", scope: "global", extensions: ["effort"] }));
  assert.equal(pendingDisables(agent), null);
  console.log("luna-cli-smoke: ok");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
