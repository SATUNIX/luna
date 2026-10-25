#!/usr/bin/env node
// Clean install from the real artefact, run by the real pi runtime.
//
// `npm pack` the repository exactly as a release would, unpack the tarball into an empty directory
// (so nothing can lean on the checkout: no tests/, docs/ or node_modules of this repo), install the
// kit from that copy into a throw-away HOME and agent directory for every shipped profile, and start
// the real `pi` in RPC mode with it. RPC mode loads every extension without needing a model or a
// network, and answers `get_commands` with what the extensions registered. A profile passes when
// pi starts, reports no extension error, and offers the commands the kit promises.
//
// This never touches the operator's pi installation: HOME and PI_CODING_AGENT_DIR are temporary.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildNpm } from "../packages/core/build-npm.ts";
import { ROOT } from "../packages/core/eval/harness.ts";
import { array, isRecord, object, optional, parseJson, parseJsonAs, record, string, union, type Infer } from "../packages/core/lib/guard.ts";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const shell = process.platform === "win32";
const PROFILES = fs.readdirSync(path.join(ROOT, "packages", "kit", "profiles")).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")).sort();
const TIMEOUT_MS = 90_000;

// Commands every profile must offer, and ones only some may. Names come from the shipped manifests,
// not from this list alone: the profile's own extension set decides what to expect.
const EVERY_PROFILE = ["effort", "update", "profile"];

let checks = 0;
const ok = (name: string): void => { checks += 1; console.log(`  ok  ${name}`); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-clean-install-"));
const cleanup = () => fs.rmSync(tmp, { recursive: true, force: true });

interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

function run(command: string, args: string[], options: RunOptions = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", shell, ...options });
  return result;
}

const RpcCommand = object({ name: string(), source: optional(string()), sourceInfo: optional(object({ path: optional(string()) })) });
type RpcCommand = Infer<typeof RpcCommand>;
/** The data of a successful get_commands response. */
const CommandsData = object({ commands: array(RpcCommand) });

/**
 * One JSON object line from `pi --mode rpc`: a command response or an event. Kept whole (fields
 * read where they are checked) so a reported error event is printed with all its detail.
 */
type RpcMessage = Record<string, unknown>;
type RpcResponse = RpcMessage;

interface RpcResult {
  response: RpcResponse;
  events: RpcMessage[];
  stderr: string;
}

const PackageEntry = object({ extensions: optional(array(string())) });
type PackageEntry = Infer<typeof PackageEntry>;
/** settings.json as far as this test reads it. */
const AgentSettings = object({ packages: optional(array(union(string(), PackageEntry))) });
/** `npm pack --json` output. */
const PackOutput = array(object({ filename: string() }));
const ArtefactPackage = object({ dependencies: optional(record(string())) });

/** Talk to `pi --mode rpc`: send one command, wait for its response, return it with the events seen. */
function rpc(agentDir: string, home: string, cwd: string, command: { id: string; type: string }): Promise<RpcResult> {
  return new Promise<RpcResult>((resolve, reject) => {
    const pi = spawn("pi", ["--mode", "rpc", "--offline", "--no-session"], {
      cwd,
      env: { ...process.env, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir },
      stdio: ["pipe", "pipe", "pipe"],
      shell,
    });
    const events: RpcMessage[] = [];
    let stderr = "";
    let buffer = "";
    let settled = false;
    const finish = (...[error, value]: [Error] | [null, RpcResult]): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { pi.stdin.end(); } catch { /* already closed */ }
      pi.kill("SIGKILL");
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error(`pi did not answer within ${TIMEOUT_MS / 1000}s\nstderr: ${stderr.slice(-800)}`)), TIMEOUT_MS);
    pi.stderr.on("data", (d) => { stderr += String(d); });
    pi.on("error", (error) => finish(error));
    pi.on("exit", (code) => finish(new Error(`pi exited early (${code})\nstderr: ${stderr.slice(-800)}`)));
    pi.stdout.on("data", (d) => {
      buffer += String(d);
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let message: unknown;
        try { message = parseJson(line); } catch { continue; }
        if (!isRecord(message)) continue;
        // A response to our command carries the command data (RpcResponse).
        if (message.type === "response" && message.id === command.id) { finish(null, { response: message, events, stderr }); return; }
        events.push(message);
      }
    });
    // Give the extensions a moment to finish loading before the first command.
    setTimeout(() => pi.stdin.write(`${JSON.stringify(command)}\n`), 2500);
  });
}

try {
  // 1. Build, pack and unpack the real artefact. It is the compiled stage (build-npm.ts, ADR 0001),
  // unpacked under node_modules/ as an npm install would put it: Node refuses to strip types
  // there, so a .ts entry point that missed the compile fails here.
  const stage = path.join(tmp, "stage");
  buildNpm(ROOT, stage);
  const packDir = path.join(tmp, "pack");
  fs.mkdirSync(packDir);
  const pack = run(npm, ["pack", stage, "--json", "--ignore-scripts", "--pack-destination", packDir], { cwd: ROOT });
  assert.equal(pack.status, 0, `npm pack failed:\n${pack.stdout}\n${pack.stderr}`);
  const packed = parseJsonAs(PackOutput, pack.stdout, "npm pack --json")[0];
  assert.ok(packed, "npm pack reported a tarball");
  const tarball = path.join(packDir, packed.filename);
  const unpacked = path.join(tmp, "project", "node_modules", "@satunix", "pi-system");
  fs.mkdirSync(unpacked, { recursive: true });
  const untar = run("tar", ["-xzf", tarball, "-C", unpacked, "--strip-components=1"]);
  assert.equal(untar.status, 0, untar.stderr);
  assert.ok(!fs.existsSync(path.join(unpacked, "tests")), "the artefact ships no tests directory");
  assert.ok(!fs.existsSync(path.join(unpacked, "node_modules")), "the artefact ships no node_modules");
  assert.ok(fs.existsSync(path.join(unpacked, "packages", "core", "install.js")), "the artefact ships the compiled installer");
  const strayTs = fs.readdirSync(path.join(unpacked, "packages", "core"), { recursive: true, encoding: "utf8" }).filter((f) => /\.(?:ts|mts)$/.test(f) && !f.endsWith(".d.ts"));
  assert.deepEqual(strayTs, [], "no Node-run TypeScript is left uncompiled in the artefact");
  ok("the compiled npm artefact unpacks under node_modules/ with no tests/, no node_modules and no uncompiled .ts");

  const pkg = parseJsonAs(ArtefactPackage, fs.readFileSync(path.join(unpacked, "package.json"), "utf8"), "package.json");
  // The runtime dependency set is a documented fact (docs/supply-chain.md, "What installing the kit
  // pulls in"): the artefact must ship exactly that set, each pinned to an exact version.
  const supplyChain = fs.readFileSync(path.join(ROOT, "docs", "supply-chain.md"), "utf8");
  const documented = /Runtime dependencies \(`dependencies` in `package\.json`\): ((?:`[^`]+`(?:, )?)+)\./.exec(supplyChain)?.[1];
  assert.ok(documented !== undefined, "docs/supply-chain.md lists the runtime dependencies");
  const documentedNames = [...documented.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? "").sort();
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}).sort(), documentedNames, "the artefact's runtime dependencies are exactly the documented ones");
  for (const [name, range] of Object.entries(pkg.dependencies ?? {})) assert.match(range, /^\d+\.\d+\.\d+$/, `${name} is pinned to an exact version, not ${range}`);
  ok(`the artefact's runtime dependencies are the documented set (${documentedNames.join(", ") || "none"}), pinned exactly`);
  if (Object.keys(pkg.dependencies ?? {}).length > 0) {
    const install = run(npm, ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: unpacked });
    assert.equal(install.status, 0, `runtime dependency install failed:\n${install.stderr}`);
    ok("the artefact's runtime dependencies install");
  } else {
    ok("the artefact has no runtime dependencies to install");
  }

  // 2. Every profile: install from the artefact, start real pi, look at what loaded.
  for (const profile of PROFILES) {
    const home = path.join(tmp, `home-${profile}`);
    const agentDir = path.join(tmp, `agent-${profile}`);
    const work = path.join(tmp, `work-${profile}`);
    for (const dir of [home, agentDir, work]) fs.mkdirSync(dir, { recursive: true });
    run("git", ["init", "-q"], { cwd: work });

    const env = { ...process.env, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir, PI_LEAN_CTX_BIN: path.join(home, "no-lean-ctx") };
    const install = run(process.execPath, [path.join(unpacked, "packages", "core", "install.js"), "--profile", profile, "--yes", "--settings-only", "--mode", "local", "--no-externals"], { cwd: work, env });
    assert.equal(install.status, 0, `${profile}: install failed:\n${install.stdout}\n${install.stderr}`);
    const settings = parseJsonAs(AgentSettings, fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"), "settings.json");
    const entry = settings.packages?.find((p): p is PackageEntry => typeof p === "object");
    assert.ok(entry, `${profile}: settings.json has a package entry`);
    const selected = (entry.extensions ?? []).length;
    assert.ok(selected >= 10, `${profile}: the profile selected extensions (${selected})`);

    const { response, events, stderr } = await rpc(agentDir, home, work, { id: "commands", type: "get_commands" });
    assert.equal(response.success, true, `${profile}: get_commands failed: ${JSON.stringify(response)}`);
    const commands = new Map(CommandsData.parse(response.data, `${profile}: get_commands data`).commands.map((c): [string, RpcCommand] => [c.name, c]));
    for (const name of EVERY_PROFILE) assert.ok(commands.has(name), `${profile}: /${name} is registered (have: ${[...commands.keys()].sort().join(", ")})`);
    // Every command must come from the artefact, not from a checkout of this repository.
    for (const [name, command] of commands) {
      const from = command.sourceInfo?.path ?? "";
      if (command.source === "extension") assert.ok(!from.startsWith(ROOT + path.sep), `${profile}: /${name} loaded from the checkout (${from}), not the artefact`);
    }
    const errors = events.filter((e) => /error/i.test(typeof e.type === "string" ? e.type : "") || (e.method === "notify" && e.notifyType === "error"));
    assert.deepEqual(errors, [], `${profile}: pi reported extension errors: ${JSON.stringify(errors).slice(0, 600)}`);
    assert.ok(!/failed to load|cannot find module|unhandled/i.test(stderr), `${profile}: pi wrote load errors to stderr:\n${stderr.slice(-600)}`);
    ok(`profile ${profile}: installed from the artefact, real pi loaded ${selected} extensions with no error and offers ${commands.size} commands`);
  }
} finally {
  cleanup();
}

console.log(`[clean-install-smoke] OK (${checks} checks)`);
