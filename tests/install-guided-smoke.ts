#!/usr/bin/env node
/**
 * `install.ts --guided`: the helpers in packages/core/lib/install-guide.ts, then the real installer
 * as a subprocess answering on stdin.
 *
 * Hermetic, as tests/install-marker-smoke.ts: a throwaway PI_CODING_AGENT_DIR and HOME, a fake `pi`
 * first on PATH that only logs its arguments, a missing PI_LEAN_CTX_BIN, and
 * `--settings-only --mode local --no-externals`, so no network and no verify gate.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { isolateKitEnv } from "../packages/core/eval/harness.ts";
import { detectEnvironment, MAX_ATTEMPTS, parseChoice, parseConfirm, parseScope, profileChoices, recommendProfile, runGuide, streamIO, summarizeChanges, versionAtLeast, type Environment, type GuideIO } from "../packages/core/lib/install-guide.ts";
import { readKitMarker } from "../packages/core/lib/settings.ts";
import { isRecord, parseJson } from "../packages/core/lib/guard.ts";

isolateKitEnv();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INSTALL = path.join(ROOT, "packages", "core", "install.ts");
const ok = (msg: string): void => console.log(`  OK: ${msg}`);

// 1. The pure helpers.
const choices = profileChoices();
const names = choices.map((c) => c.name);
assert.deepEqual(names, [...names].sort(), "profiles are listed sorted by name");
assert.ok(names.includes("balanced") && names.includes("lite"), `the shipped profiles include balanced and lite: ${names.join(", ")}`);
assert.ok(choices.every((c) => c.summary.length > 0 && !c.summary.includes(". ")), "each profile has a one-sentence summary");
{
  const lite = names.indexOf("lite") + 1;
  assert.equal(parseChoice(String(lite), choices, "balanced"), "lite", "a number picks that profile");
  assert.equal(parseChoice(" lite ", choices, "balanced"), "lite", "a name picks that profile");
  assert.equal(parseChoice("", choices, "balanced"), "balanced", "an empty answer is the default");
  assert.equal(parseChoice("0", choices, "balanced"), null);
  assert.equal(parseChoice(String(names.length + 1), choices, "balanced"), null);
  assert.equal(parseChoice("quick", choices, "balanced"), null, "a retired profile name is not an alias");
  assert.equal(parseScope("", "global"), "global");
  assert.equal(parseScope("Project", "global"), "project");
  assert.equal(parseScope("both", "global"), null);
  assert.equal(parseConfirm(""), true);
  assert.equal(parseConfirm("N"), false);
  assert.equal(parseConfirm("maybe"), null);
  assert.equal(recommendProfile("lite", choices), "lite", "the installed profile is recommended");
  assert.equal(recommendProfile("gone", choices), "balanced", "else balanced");
  assert.equal(recommendProfile(null, choices), "balanced");
  assert.ok(versionAtLeast("v22.19.0", [22, 19]) && versionAtLeast("v24.1.0", [22, 19]));
  assert.ok(!versionAtLeast("v22.18.9", [22, 19]) && !versionAtLeast("garbage", [22, 19]));
  const before = new Map([["a", Buffer.from("1")], ["b", undefined], ["c", Buffer.from("same")], ["d", Buffer.from("x")]]);
  const after = new Map([["a", Buffer.from("2")], ["b", Buffer.from("new")], ["c", Buffer.from("same")], ["d", undefined]]);
  assert.deepEqual(summarizeChanges(before, after), ["  changed a", "  created b", "  removed d"]);
  const env = detectEnvironment({
    nodeVersion: "v22.10.0",
    env: { CI: "true", container: "podman" },
    exists: () => false,
    run: (cmd, args) => (cmd === "git" && args[0] === "--version" ? "git version 2.47.0" : null),
    tty: false,
    installedProfile: null,
  });
  assert.deepEqual(env, { node: "v22.10.0", nodeOk: false, git: "git version 2.47.0", pi: null, container: true, ci: true, tty: false, gitRepo: false, installedProfile: null });
  ok("profile, scope and confirmation parsing, the recommendation, the change summary and detection");
}

// 2. The question flow, with scripted answers.
const ENV: Environment = { node: "v24.0.0", nodeOk: true, git: null, pi: null, container: false, ci: false, tty: false, gitRepo: false, installedProfile: null };
function scripted(answers: string[]): GuideIO & { printed: string[]; asked: number } {
  const io = { printed: [] as string[], asked: 0, ask: (_: string) => Promise.resolve(answers[io.asked++] ?? null), print: (l: string) => { io.printed.push(l); } };
  return io;
}
{
  assert.deepEqual(await runGuide(scripted(["lite", "project", "y"]), ENV, choices, null), { kind: "proceed", profile: "lite", scope: "project" });
  assert.deepEqual(await runGuide(scripted(["", "y"]), ENV, choices, "global"), { kind: "proceed", profile: "balanced", scope: "global" }, "a fixed --scope is not asked");
  assert.deepEqual(await runGuide(scripted(["lite", "", "n"]), ENV, choices, null), { kind: "declined" });
  const strikes = scripted(["x", "y", "z", "lite"]);
  const failed = await runGuide(strikes, ENV, choices, null);
  assert.equal(failed.kind, "failed");
  assert.equal(strikes.asked, MAX_ATTEMPTS, "an invalid answer is asked again at most MAX_ATTEMPTS times");
  const eof = await runGuide(scripted(["lite", ""]), ENV, choices, null);
  assert.ok(eof.kind === "failed" && /input ended/.test(eof.reason), "input ending before the confirmation fails");
  // streamIO splits piped input into one answer per question, and gives null once it ends.
  const input = new PassThrough();
  const out: string[] = [];
  const io = streamIO(input, (t) => out.push(t));
  input.end("one\r\ntwo\nthree");
  assert.deepEqual([await io.ask("? "), await io.ask("? "), await io.ask("? "), await io.ask("? ")], ["one", "two", "three", null]);
  io.close();
  ok("the guided flow proceeds, declines, gives up after three invalid answers and on ended input");
}

// 3. The real installer.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "luna-install-guided-"));
try {
  const binDir = path.join(dir, "bin");
  fs.mkdirSync(binDir);
  const fakePi = path.join(binDir, "pi");
  fs.writeFileSync(fakePi, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$PI_FAKE_LOG"\nexit 0\n`);
  fs.chmodSync(fakePi, 0o755);
  const SEEDED = `${JSON.stringify({ packages: [ROOT] }, null, 2)}\n`;
  const untouched = (agentDir: string): void => {
    assert.deepEqual(fs.readdirSync(agentDir), ["settings.json"], "nothing is written");
    assert.equal(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"), SEEDED, "settings.json is unchanged");
  };
  let n = 0;
  const install = (args: string[], input: string): { status: number | null; stdout: string; stderr: string; agentDir: string } => {
    const home = path.join(dir, `home-${++n}`);
    const agentDir = path.join(home, "agent");
    fs.mkdirSync(agentDir, { recursive: true });
    // The fake pi registers nothing, so the kit entry a real `pi install` adds is seeded.
    fs.writeFileSync(path.join(agentDir, "settings.json"), SEEDED);
    const env = { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agentDir, PI_LEAN_CTX_BIN: path.join(home, "no-lean-ctx"), PI_FAKE_LOG: path.join(home, "pi.log"), PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` };
    const r = spawnSync(process.execPath, [INSTALL, ...args], { cwd: home, env, input, encoding: "utf8", timeout: 120_000 });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, agentDir };
  };
  const FLAGS = ["--guided", "--settings-only", "--mode", "local", "--no-externals"];
  const show = (r: { stdout: string; stderr: string }): string => `${r.stdout}\n${r.stderr}`;

  for (const [answer, how] of [[String(names.indexOf("lite") + 1), "number"], ["lite", "name"]] as const) {
    const r = install(FLAGS, `${answer}\n\ny\n`);
    assert.equal(r.status, 0, show(r));
    assert.match(r.stdout, /\[install\] Detected:\n {2}node: {9}v\d+/);
    assert.match(r.stdout, /\(recommended\)/);
    assert.match(r.stdout, /\[install\] Verified: settings entry, profile lite/);
    const settingsPath = path.join(r.agentDir, "settings.json");
    const markerPath = path.join(r.agentDir, ".pi-kit.json");
    assert.ok(r.stdout.includes(`[install] Changed:\n  changed ${settingsPath}`), show(r));
    assert.ok(r.stdout.includes(`  created ${markerPath}`), show(r));
    assert.equal(readKitMarker(markerPath)?.profile, "lite");
    const settings = parseJson(fs.readFileSync(settingsPath, "utf8"));
    const entries: unknown = isRecord(settings) ? settings.packages : undefined;
    assert.ok(Array.isArray(entries) && entries.some((e) => e === ROOT || (isRecord(e) && e.source === ROOT)), `the kit entry is registered:\n${JSON.stringify(settings)}`);
    ok(`guided install by ${how} records lite, verifies it and lists the files it changed`);
  }

  {
    const r = install(FLAGS, "lite\n\nn\n");
    assert.equal(r.status, 0, show(r));
    assert.match(r.stdout, /Declined; nothing was changed/);
    untouched(r.agentDir);
    ok("declining writes nothing and exits 0");
  }
  for (const [input, why] of [["nope\nstill no\nno again\n", /no valid profile after 3 attempts/], ["lite\n\n", /input ended before the answer/]] as const) {
    const r = install(FLAGS, input);
    assert.equal(r.status, 1, show(r));
    assert.match(r.stderr, why);
    untouched(r.agentDir);
  }
  ok("three invalid answers, or input ending before the confirmation, exit 1 with nothing written");

  for (const flag of [["--profile", "lite"], ["--yes"], ["--all"], ["--only", "todo"]]) {
    const r = install([...FLAGS, ...flag], "");
    assert.equal(r.status, 1, show(r));
    assert.ok(r.stderr.includes(`--guided cannot be combined with ${flag[0] ?? ""}\nusage: install.ts`), show(r));
  }
  ok("--guided with --profile, --yes, --all or --only exits 1 with the usage line");

  {
    const r = install(["--profile", "lite", "--settings-only", "--mode", "local", "--no-externals"], "");
    assert.equal(r.status, 0, show(r));
    assert.ok(!/Detected:|Verified:|Changed:|Proceed\?/.test(r.stdout), "a non-guided run asks and adds nothing");
    ok("a non-guided install neither prompts nor prints the guided report");
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log("\n[install-guided-smoke] all checks passed");
