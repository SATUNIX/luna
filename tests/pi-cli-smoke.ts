#!/usr/bin/env node
// The installer and uninstaller pass package sources to `pi install` / `pi remove`. A source is data
// (settings.json, a state marker under the agent directory, an environment variable, a checkout path)
// and must never be able to run a command. This test runs a stand-in `pi` that records the argument
// vector, with sources that would execute under a shell, and checks that nothing runs and that the
// arguments arrive verbatim; that Windows refuses shell metacharacters; that a failing pi throws; and
// that neither script builds a shell command string from a variable any more.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, type SpawnSyncOptions, type SpawnSyncReturns } from "node:child_process";
import { displayCommand, runPi } from "../packages/core/lib/pi-cli.ts";
import { parseJson } from "../packages/core/lib/guard.ts";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cli-smoke-"));
let checks = 0;
const ok = (name: string): void => { checks += 1; console.log(`  OK: ${name}`); };

try {
  const record = path.join(work, "argv.json");
  const pwned = path.join(work, "PWNED");
  const fakePi = path.join(work, "pi");
  fs.writeFileSync(fakePi, `#!/bin/sh\nnode -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))' "${record}" "$@"\nexit \${FAKE_PI_EXIT:-0}\n`, { mode: 0o755 });

  // 1. Hostile sources reach pi as one literal argument each, and nothing runs.
  if (process.platform !== "win32") {
    const hostile = [
      `git:gitlab.example/x/y@$(touch ${pwned})`,
      `git:example.org/a"; touch ${pwned}; echo "`,
      `git:example.org/a\`touch ${pwned}\``,
      `/tmp/dir with spaces/and 'quotes' and \\backslashes`,
      "npm:@scope/name@1.0.0",
    ];
    for (const source of hostile) {
      fs.rmSync(record, { force: true });
      runPi(fakePi, ["remove", source, "-l"], { stdio: "pipe" });
      assert.deepEqual(JSON.parse(fs.readFileSync(record, "utf8")), ["remove", source, "-l"], `${source} arrives verbatim`);
      assert.equal(fs.existsSync(pwned), false, `${source} ran a command`);
    }
    ok("sources with $(...), quotes, backticks, spaces and backslashes reach pi verbatim and run nothing");
  }

  // 2. A control character is refused everywhere; Windows refuses shell metacharacters (it needs a shell for .cmd).
  assert.throws(() => runPi(fakePi, ["install", "a\nb"]), /control character/);
  assert.throws(() => runPi(fakePi, ["install", "a\0b"]), /control character/);
  // A number in the argument vector is deliberately malformed input for the runtime type check.
  // @ts-expect-error -- deliberately the wrong type, to prove runPi checks it at run time
  assert.throws(() => runPi(fakePi, ["install", 7]), /non-string/);
  interface StubCall { command: string; args: readonly string[]; options: SpawnSyncOptions }
  const calls: StubCall[] = [];
  // A spawn double: it records the call and returns only the status runPi reads, so it is cast to spawnSync's overloaded type.
  const stub = ((command: string, args: readonly string[], options: SpawnSyncOptions): Pick<SpawnSyncReturns<Buffer>, "status"> => { calls.push({ command, args, options }); return { status: 0 }; }) as typeof spawnSync;
  for (const bad of ['a"b', "a&b", "a|b", "a<b", "a>b", "a^b", "a%PATH%b", "a!b", "a`b"]) assert.throws(() => runPi("pi", ["install", bad], { platform: "win32", spawn: stub }), /shell metacharacter/, bad);
  assert.equal(calls.length, 0, "a refused argument starts nothing");
  runPi("C:\\Program Files\\nodejs\\pi.cmd", ["install", "git:github.com/SATUNIX/pi-system@v0.2.4-beta.0"], { platform: "win32", spawn: stub });
  const [windowsCall] = calls;
  assert.ok(windowsCall, "the Windows call reached spawn");
  assert.equal(windowsCall.command, '"C:\\Program Files\\nodejs\\pi.cmd"', "a Windows path with spaces is quoted");
  assert.equal(windowsCall.options.shell, true, "on Windows the .cmd shim needs a shell");
  runPi("pi", ["install", "x"], { platform: "linux", spawn: stub });
  const posixCall = calls[1];
  assert.ok(posixCall, "the POSIX call reached spawn");
  assert.equal(posixCall.options.shell, false, "on POSIX there is no shell");
  ok("control characters are refused; on Windows shell metacharacters are refused and a path with spaces is quoted; POSIX never uses a shell");

  // 3. A failing pi throws (as execSync did), and a missing binary does too.
  if (process.platform !== "win32") {
    process.env.FAKE_PI_EXIT = "3";
    try { assert.throws(() => runPi(fakePi, ["remove", "x"], { stdio: "pipe" }), (e: unknown) => e instanceof Error && "status" in e && e.status === 3 && /pi remove exited with 3/.test(e.message)); } finally { delete process.env.FAKE_PI_EXIT; }
    assert.throws(() => runPi(path.join(work, "no-such-pi"), ["remove", "x"], { stdio: "pipe" }), /ENOENT/);
    ok("a pi that exits non-zero, or is missing, throws");
  }

  // 4. The display form is for reading only and quotes what needs it.
  assert.equal(displayCommand(["install", "git:github.com/SATUNIX/pi-system@v0.2.4-beta.0"]), "pi install git:github.com/SATUNIX/pi-system@v0.2.4-beta.0");
  assert.equal(displayCommand(["remove", "/tmp/a b", "-l"]), 'pi remove "/tmp/a b" -l');
  ok("the printed command quotes arguments that contain spaces");

  // 5. Neither script builds a shell command from a variable any more (a static guard for a regression).
  for (const file of ["packages/core/install.ts", "packages/core/uninstall.ts"]) {
    const src = fs.readFileSync(path.join(ROOT, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.equal(/exec(?:Sync)?\(\s*`[^`]*\$\{/.test(src), false, `${file} builds a shell command from a variable`);
    assert.equal(/\bshellQuote\b/.test(src), false, `${file} still shell-quotes`);
  }
  ok("install.ts and uninstall.ts run pi through runPi, not a shell string");

  // 6. End to end: the real uninstaller, given a state marker whose kit source is hostile, runs nothing.
  if (process.platform !== "win32") {
    const home = path.join(work, "home");
    const agent = path.join(home, ".pi", "agent");
    fs.mkdirSync(agent, { recursive: true });
    fs.writeFileSync(path.join(agent, ".pi-kit.json"), JSON.stringify({ kitSource: `git:example.org/x@$(touch ${pwned})`, profile: "balanced", companions: [`npm:x"; touch ${pwned}; echo "`] }));
    const bin = path.join(work, "bin");
    fs.mkdirSync(bin, { recursive: true });
    fs.copyFileSync(fakePi, path.join(bin, "pi"));
    fs.chmodSync(path.join(bin, "pi"), 0o755);
    fs.rmSync(record, { force: true });
    const r = spawnSync(process.execPath, [path.join(ROOT, "packages/core/uninstall.ts"), "--scope", "global", "--yes"], { encoding: "utf8", cwd: work, env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agent, PATH: `${bin}${path.delimiter}${process.env.PATH}` } });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(fs.existsSync(pwned), false, "the hostile marker ran a command");
    const argv = parseJson(fs.readFileSync(record, "utf8"));
    assert.ok(Array.isArray(argv), "the stand-in pi recorded an argument vector");
    assert.deepEqual(argv.slice(0, 1), ["remove"]);
    ok("the real uninstaller passes a hostile state marker to pi as data");
  }

  console.log(`[pi-cli-smoke] OK (${checks} checks)`);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
