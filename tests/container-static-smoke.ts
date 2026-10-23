#!/usr/bin/env node
// The container package's own static validators (scripts/preflight.sh: required files, JSON
// validity, version pins, MCP hardening flags, engagement templates, compose parity, ledger
// format) used to be documented but were never run, and had drifted until they could not pass.
// This runs them, so a change that breaks the container package's contract fails the gate. It
// needs `sh` and `python3`, and does not need a container engine.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { ROOT } from "../packages/core/eval/harness.ts";

const dir = path.join(ROOT, "packages", "container");

if (process.platform === "win32") {
  console.log("[container-static-smoke] SKIP: needs a POSIX shell; runs in the Linux CI job");
  process.exit(0);
}

const have = (cmd: string): boolean => spawnSync(cmd, ["--version"], { encoding: "utf8" }).status === 0;
assert.ok(have("python3"), "python3 is required for the container validators");

const run = spawnSync("sh", ["scripts/preflight.sh"], { cwd: dir, encoding: "utf8", env: { ...process.env, PI_AGENT_DATA_ROOT: path.join(dir, ".no-data-root") } });
assert.equal(run.status, 0, `preflight failed:\n${run.stdout}\n${run.stderr}`);
assert.match(run.stdout, /Pentest environment checks passed/);
assert.match(run.stdout, /Runtime readiness passed/);
assert.match(run.stdout, /\[validate-compose\] All checks passed\./);

// The validators must be able to fail: in a scratch copy of the tree they read, a broken pin and a
// removed hardening flag are each caught.
import fs from "node:fs";
import os from "node:os";
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-container-static-"));
try {
  const copy = (rel: string): void => fs.cpSync(path.join(ROOT, rel), path.join(scratch, rel), { recursive: true, filter: (src) => !src.includes("node_modules") });
  copy("packages/container");
  copy("packages/extensions/src/pentest-governance-domain");
  copy("packages/kit/prompts");
  const cdir = path.join(scratch, "packages", "container");
  const validate = () => spawnSync("sh", ["scripts/validate-pentest-env.sh"], { cwd: cdir, encoding: "utf8", env: { ...process.env, PI_AGENT_DATA_ROOT: path.join(cdir, ".no-data-root") } });
  const clean = validate();
  assert.equal(clean.status, 0, `the copy must validate before it is broken:\n${clean.stdout}\n${clean.stderr}`);

  const dockerfile = path.join(cdir, "Dockerfile");
  const original = fs.readFileSync(dockerfile, "utf8");
  fs.writeFileSync(dockerfile, original.replace(/ARG PI_CODING_AGENT_VERSION=[0-9.]+/, "ARG PI_CODING_AGENT_VERSION=0.0.1"));
  const badPin = validate();
  assert.notEqual(badPin.status, 0, "a Dockerfile that drifts from the reviewed pi pin must fail");
  assert.match(badPin.stderr, /PI_CODING_AGENT_VERSION/);
  fs.writeFileSync(dockerfile, original);

  const mcp = path.join(cdir, "overlays", "pi", "mcp.json");
  const mcpOriginal = fs.readFileSync(mcp, "utf8");
  fs.writeFileSync(mcp, mcpOriginal.replace('"autoAuth": false', '"autoAuth": true'));
  const badFlag = validate();
  assert.notEqual(badFlag.status, 0, "turning an MCP hardening flag on must fail");
  assert.match(badFlag.stderr, /autoAuth/);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

// Runtime scripts, run on the host with stubs (no image): pi-agent fails closed, the entrypoint
// seeds the directory pi reads, and the health check needs no server.
const rt = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-container-runtime-"));
try {
  const scripts = path.join(dir, "scripts");
  const bin = path.join(rt, "bin");
  fs.mkdirSync(bin);
  // Stub pi: `pi install` fails when PI_STUB_INSTALL_FAIL=1; any other call reports it started.
  fs.writeFileSync(path.join(bin, "pi"), '#!/bin/sh\nif [ "$1" = install ]; then [ "${PI_STUB_INSTALL_FAIL:-0}" = 1 ] && { echo "stub install error" >&2; exit 3; }; exit 0; fi\necho "PI_STARTED $*"\n', { mode: 0o755 });
  const kit = path.join(rt, "kit");
  fs.mkdirSync(path.join(kit, "packages", "core"), { recursive: true });
  fs.writeFileSync(path.join(kit, "packages", "core", "install.mjs"), 'if (process.env.PI_STUB_PROFILE_FAIL === "1") { process.stderr.write("stub profile error\\n"); process.exit(4); }\n');
  const home = path.join(rt, "home");
  fs.mkdirSync(home);
  const baseEnv: NodeJS.ProcessEnv = { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, HOME: home, PI_CODING_AGENT_DIR: path.join(rt, "agent") };
  const piAgent = (env: NodeJS.ProcessEnv) => spawnSync("bash", [path.join(scripts, "pi-agent"), "--x"], { encoding: "utf8", env: { ...baseEnv, ...env } });

  const ok = piAgent({ PI_KIT_PATH: kit });
  assert.equal(ok.status, 0, `pi-agent with a working kit must start pi:\n${ok.stderr}`);
  assert.match(ok.stdout, /PI_STARTED --x/);
  for (const [label, env, why] of [
    ["no kit", { PI_KIT_PATH: path.join(rt, "missing") }, /no pi-kit found/],
    ["pi install fails", { PI_KIT_PATH: kit, PI_STUB_INSTALL_FAIL: "1" }, /stub install error[\s\S]*pi install .* failed/],
    ["profile apply fails", { PI_KIT_PATH: kit, PI_STUB_PROFILE_FAIL: "1" }, /stub profile error[\s\S]*applying the balanced profile failed/],
  ] as const) {
    const r = piAgent(env);
    assert.notEqual(r.status, 0, `pi-agent must exit non-zero when ${label}`);
    assert.doesNotMatch(r.stdout, /PI_STARTED/, `pi-agent must not start pi when ${label}`);
    assert.match(r.stderr, why, `pi-agent must show why it refused (${label}):\n${r.stderr}`);
    const allowed = piAgent({ ...env, PI_AGENT_ALLOW_UNGOVERNED: "1" });
    assert.equal(allowed.status, 0, `PI_AGENT_ALLOW_UNGOVERNED=1 must start pi when ${label}`);
    assert.match(allowed.stdout, /PI_STARTED/);
    assert.match(allowed.stderr, /WARN: .*WITHOUT the governed profile/);
  }

  const data = path.join(rt, "data");
  const entry = spawnSync("bash", [path.join(scripts, "entrypoint.sh"), "true"], { encoding: "utf8", env: { ...baseEnv, PI_AGENT_DATA_ROOT: data, PI_AGENT_OVERLAY_DIR: path.join(dir, "overlays", "pi") } });
  assert.equal(entry.status, 0, `entrypoint failed:\n${entry.stdout}\n${entry.stderr}`);
  for (const f of ["settings.json", "mcp.json", "models.json"]) {
    assert.ok(fs.existsSync(path.join(rt, "agent", f)), `entrypoint must seed ${f} into PI_CODING_AGENT_DIR`);
  }
  assert.ok(!fs.existsSync(path.join(home, ".pi", "agent")), "entrypoint must not seed $HOME/.pi/agent, which pi does not read when PI_CODING_AGENT_DIR is set");

  const health = (root: string) => spawnSync("python3", [path.join(scripts, "healthcheck.py"), "--check"], { encoding: "utf8", env: { ...process.env, PI_AGENT_DATA_ROOT: root, PI_AGENT_HEALTH_PORT: "1" } });
  const healthy = health(data);
  assert.equal(healthy.status, 0, `--check on a writable data root must pass without a server:\n${healthy.stderr}`);
  assert.notEqual(health(path.join(rt, "no-such-root")).status, 0, "--check on a missing data root must fail");
  const hostEnv = { ...process.env };
  delete hostEnv.PI_AGENT_HEALTH_HOST;
  delete hostEnv.PENTEST_HEALTH_HOST;
  const host = spawnSync("python3", ["-I", "-c", "import importlib.util,sys; s=importlib.util.spec_from_file_location('hc', sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); print(m.HOST)", path.join(scripts, "healthcheck.py")], { encoding: "utf8", env: hostEnv });
  assert.equal(host.stdout.trim(), "127.0.0.1", `--serve must bind loopback by default:\n${host.stderr}`);
} finally {
  fs.rmSync(rt, { recursive: true, force: true });
}

console.log("[container-static-smoke] OK (preflight passes; a drifted pin and a loosened MCP flag are each caught; pi-agent fails closed, the entrypoint seeds PI_CODING_AGENT_DIR, and --check needs no server)");
