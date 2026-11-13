#!/usr/bin/env node
// pi's own project trust still blocks a hostile project under every Luna profile.
//
// A repository can ship `.pi/extensions/*.ts`, which pi would execute with the operator's rights. pi
// (core/trust-manager) refuses to load project resources until the operator trusts the folder, and
// a headless start has no one to ask, so the answer is "no". Luna adds no trust of its own, so this
// proves Luna does not weaken pi's: for every profile, installed into a scratch agent directory, a
// real pi start in a repository with a hostile extension never runs it. A positive control (`--approve`)
// shows the fixture does load when trusted, so a pass is not an artefact of a broken fixture. The
// autonomy worker passes `--no-approve`, so an untrusted project stays untrusted there too.
// CI runs this at the pi floor and at the newest release (the pi-compat matrix).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT } from "../packages/core/eval/harness.ts";

const PROFILES = fs.readdirSync(path.join(ROOT, "packages", "kit", "profiles")).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")).sort();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "luna-project-trust-"));
const shell = process.platform === "win32";

function pi(agentDir: string, home: string, cwd: string, mark: string, extra: string[] = []): ReturnType<typeof spawnSync> {
  // --list-models builds the full runtime (loads every extension, project ones when trusted) and exits.
  return spawnSync("pi", ["--list-models", "--offline", ...extra], {
    cwd, encoding: "utf8", shell, timeout: 120_000,
    env: { ...process.env, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir, PI_LEAN_CTX_BIN: path.join(home, "none"), LUNA_TRUST_MARK: mark },
  });
}

try {
  const hostile = path.join(tmp, "hostile");
  fs.mkdirSync(path.join(hostile, ".pi", "extensions"), { recursive: true });
  fs.writeFileSync(path.join(hostile, ".pi", "extensions", "evil.ts"), 'import fs from "node:fs";\nfs.writeFileSync(process.env.LUNA_TRUST_MARK ?? "", "ran");\nexport default function () {}\n');
  spawnSync("git", ["init", "-q"], { cwd: hostile });

  for (const profile of PROFILES) {
    const home = path.join(tmp, `home-${profile}`);
    const agentDir = path.join(tmp, `agent-${profile}`);
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
    const env = { ...process.env, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir, PI_LEAN_CTX_BIN: path.join(home, "none") };
    const install = spawnSync(process.execPath, [path.join(ROOT, "packages", "core", "install.ts"), "--profile", profile, "--yes", "--settings-only", "--mode", "local", "--no-externals"], { cwd: hostile, env, encoding: "utf8" });
    assert.equal(install.status, 0, `${profile}: install failed:\n${install.stdout}\n${install.stderr}`);

    const mark = path.join(tmp, `ran-${profile}`);
    const untrusted = pi(agentDir, home, hostile, mark);
    assert.ok(!fs.existsSync(mark), `${profile}: a hostile project extension ran without trust`);
    assert.ok(untrusted.status === 0 || /No models available/.test(String(untrusted.stdout) + String(untrusted.stderr)), `${profile}: pi did not start cleanly:\n${String(untrusted.stderr).slice(-400)}`);

    if (profile === PROFILES[0]) {
      const trusted = pi(agentDir, home, hostile, mark, ["--approve"]);
      assert.ok(fs.existsSync(mark), `control: the fixture extension should load when the project is trusted (${String(trusted.stderr).slice(-300)})`);
    }
    console.log(`  ok  ${profile}: the hostile project extension did not load`);
  }

  const entrypoint = fs.readFileSync(path.join(ROOT, "packages", "autonomy", "image", "entrypoint.sh"), "utf8");
  assert.match(entrypoint, /exec pi --mode rpc --no-approve\b/, "the autonomy worker starts pi with --no-approve");
  console.log("  ok  the autonomy worker starts pi with --no-approve");
  console.log(`[project-trust-smoke] OK (${PROFILES.length} profiles)`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
