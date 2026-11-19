/**
 * Run by tests/herdr-smoke.ts (imported at its end). The `/herdr` client
 * (packages/extensions/src/herdr/client.ts) against a fake `herdr` binary first on PATH, which logs
 * each call and answers from a fixture. No live herdr is touched. Offline.
 *
 * Pins: list, read, send and spawn build the right CLI calls and format the answers; terminal
 * escapes are stripped; a target that looks like an option is refused before herdr runs; send
 * never prompts an agent blocked on a dialog (checked first, and herdr's own agent_blocked refusal
 * is reported); spawn never focuses; no call ever focuses, sends keys or attaches; a missing herdr
 * is reported; /herdr is registered outside a herdr pane but not in a child session or when
 * PI_KIT_HERDR is off.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fakePi, isolateKitEnv, loadExtension, setEnv } from "../packages/core/eval/harness.ts";
import { herdrCommand, HERDR_USAGE, runHerdrCli } from "../packages/extensions/src/herdr/client.ts";

const restoreIsolation = isolateKitEnv();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "luna-herdr-client-"));
const bin = path.join(dir, "bin");
const log = path.join(dir, "calls.jsonl");
const fixture = path.join(dir, "fixture.json");
fs.mkdirSync(bin);
// The fake: logs argv, answers by the first two words (or "agent get <target>"), from fixture.json.
fs.writeFileSync(path.join(bin, "herdr"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
const f = JSON.parse(fs.readFileSync(${JSON.stringify(fixture)}, "utf8"));
const key = args[0] + " " + args[1];
const answer = f[key + " " + (args[2] || "")] ?? f[key];
process.stdout.write(answer === undefined ? JSON.stringify({ error: { code: "unknown", message: key } }) : answer);
`, { mode: 0o755 });
const ESC = String.fromCharCode(27);
const agent = (name: string, status: string) => ({ agent: "claude", agent_status: status, cwd: `/work/${name}`, name, pane_id: `w:${name}`, workspace_id: "wA" });
fs.writeFileSync(fixture, JSON.stringify({
  "agent list": JSON.stringify({ id: "cli:agent:list", result: { agents: [agent("lane-core", "working"), agent("lane-ux", "blocked")] } }),
  "agent read": `line one\n${ESC}[31mred${ESC}[0m line\n${ESC}]0;title${String.fromCharCode(7)}done\n`,
  "agent get lane-core": JSON.stringify({ id: "cli:agent:get", result: { agent: agent("lane-core", "idle"), type: "agent_info" } }),
  "agent get lane-ux": JSON.stringify({ id: "cli:agent:get", result: { agent: agent("lane-ux", "blocked"), type: "agent_info" } }),
  "agent get lane-race": JSON.stringify({ id: "cli:agent:get", result: { agent: agent("lane-race", "working"), type: "agent_info" } }),
  "agent prompt lane-core": JSON.stringify({ id: "cli:agent:prompt", result: { type: "agent_prompted" } }),
  "agent prompt lane-race": JSON.stringify({ error: { code: "agent_blocked", message: "agent lane-race is blocked" }, id: "cli:agent:prompt" }),
  "workspace create": JSON.stringify({ id: "cli:workspace:create", result: { workspace: { workspace_id: "wZ", label: "scratch" } } }),
}));
const calls = (): string[][] => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]) : []);
const fresh = (): void => fs.rmSync(log, { force: true });
const restorePath = setEnv("PATH", `${bin}${path.delimiter}${process.env.PATH ?? ""}`);
const ok = (m: string): void => console.log(`  OK: ${m}`);

try {
  fresh();
  const list = await herdrCommand("list", dir);
  assert.match(list, /lane-core {2}claude {2}working {2}\/work\/lane-core/);
  assert.match(list, /lane-ux {2}claude {2}blocked/);
  assert.deepEqual(calls(), [["agent", "list"]]);
  ok("list names each agent with its state and directory");

  fresh();
  const read = await herdrCommand("read lane-core 5", dir);
  assert.deepEqual(calls(), [["agent", "read", "lane-core", "--source", "recent", "--lines", "5"]]);
  assert.ok(read.includes("line one\nred line\ndone") && !read.includes(ESC), `escapes are stripped: ${JSON.stringify(read)}`);
  fresh();
  for (const bad of ["read --source=x", "read -h", "read lane-core 0", "read lane-core 201", "read lane-core five", "read", "spawn -x", "send --all hi", "frobnicate", ""]) {
    assert.equal(await herdrCommand(bad, dir), HERDR_USAGE, `usage for ${JSON.stringify(bad)}`);
  }
  assert.deepEqual(calls(), [], "a bad command or a target that looks like an option never reaches herdr");
  ok("read passes the target and line count, strips escapes; bad input is refused before herdr runs");

  fresh();
  const sent = await herdrCommand("send lane-core  please rebase   on trunk", dir);
  assert.deepEqual(calls(), [["agent", "get", "lane-core"], ["agent", "prompt", "lane-core", "please rebase   on trunk"]], "send checks the state, then prompts with the text as typed");
  assert.match(sent, /sent 24 characters to lane-core \(it was idle\)/);
  fresh();
  const refused = await herdrCommand("send lane-ux yes", dir);
  assert.deepEqual(calls(), [["agent", "get", "lane-ux"]], "a blocked agent is never prompted");
  assert.match(refused, /waiting on a dialog \(blocked\); Luna never answers another agent's dialog\. Nothing was sent\./);
  fresh();
  const raced = await herdrCommand("send lane-race go", dir);
  assert.match(raced, /agent_blocked: agent lane-race is blocked\. Nothing was sent\./, "herdr's own refusal is reported");
  fresh();
  assert.match(await herdrCommand(`send lane-core ${"x".repeat(4001)}`, dir), /limit is 4000/);
  assert.match(await herdrCommand(`send lane-core a${String.fromCharCode(27)}[2Jb`, dir), /control characters/);
  assert.deepEqual(calls(), [], "an oversized prompt or one with control characters is never sent");
  ok("send checks the agent's state first and never prompts a blocked agent; herdr's refusal is reported");

  fresh();
  const spawned = await herdrCommand("spawn scratch", dir);
  assert.deepEqual(calls(), [["workspace", "create", "--no-focus", "--label", "scratch", "--cwd", dir]]);
  assert.match(spawned, /opened workspace scratch \(wZ\).*without focusing it/);
  fresh();
  assert.match(await herdrCommand("spawn scratch does-not-exist", dir), /is not a directory/);
  assert.deepEqual(calls(), []);
  ok("spawn opens a workspace with --no-focus in an existing directory");

  // Across a call of each kind: nothing focuses, sends keys or attaches.
  fresh();
  for (const c of ["list", "read lane-core", "send lane-core hi", "send lane-ux hi", "spawn s2"]) await herdrCommand(c, dir);
  for (const argv of calls()) {
    assert.ok(!argv.includes("focus") && !argv.includes("--focus") && !argv.includes("send-keys") && !argv.includes("attach") && !argv.includes("send-text"), `no focus, keys or attach: ${argv.join(" ")}`);
  }
  ok("no call focuses, sends keys or attaches");

  const restoreEmpty = setEnv("PATH", path.join(dir, "nowhere"));
  assert.match(await herdrCommand("list", dir), /herdr is not installed or not on PATH/);
  const direct = await runHerdrCli(["agent", "list"]);
  assert.equal(direct.ok, false);
  restoreEmpty();
  ok("a missing herdr is reported, not thrown");

  // Registration: any session, but not a child and not when switched off.
  const mod = await loadExtension<(pi: unknown, send: unknown, stateDir: string) => void>("extensions/herdr/index.ts");
  const stateDir = path.join(dir, "state");
  for (const [env, want] of [[{}, true], [{ PI_SUBAGENT_CHILD: "1" }, false], [{ PI_KIT_HERDR: "off" }, false]] as const) {
    const restores = Object.entries({ HERDR_ENV: undefined, HERDR_PANE_ID: undefined, HERDR_SOCKET_PATH: undefined, PI_SUBAGENT_CHILD: undefined, PI_KIT_HERDR: undefined, ...env }).map(([k, v]) => setEnv(k, v));
    const pi = fakePi();
    mod(pi.api, async () => true, stateDir);
    assert.equal(pi.commands.find("herdr") !== undefined, want, `/herdr registered with ${JSON.stringify(env)}: ${String(want)}`);
    if (want) {
      const notes: string[] = [];
      fresh();
      await pi.commands.get("herdr").handler("list", { cwd: dir, ui: { notify: (m: string) => notes.push(m) } });
      assert.match(notes.join("\n"), /lane-core/, "the command reports through ui.notify");
    }
    restores.reverse().forEach((r) => r());
  }
  ok("/herdr is registered outside a herdr pane, not in a child session or with PI_KIT_HERDR=off");
} finally {
  restorePath();
  restoreIsolation();
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log("herdr client checks: OK");
