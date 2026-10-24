#!/usr/bin/env node
/**
 * /profile is all-or-nothing: every failure stage rolls the configuration back byte-for-byte.
 *
 * The command runs a REAL child process (a stub install.ts whose behaviour is chosen with
 * STUB_MODE) through an exec that reproduces pi.exec's quirk: a signal-killed child resolves as
 * `code: 0` (pi's child-process.js resolves `code ?? 0`), so the command must not trust exit codes.
 * Every case hashes all the files a switch can change before and after and demands equality.
 *
 * Stages covered: installer non-zero exit, installer killed mid-way (with and without output),
 * installer timeout, exception, corrupt marker, mismatching marker, no marker rewrite, unknown
 * firewall policy, dangling extension entry, leftover lock/tmp files, a profile that names an unknown
 * firewall policy, a failing reload, project scope, invalid arguments and a cancelled picker.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fakePi, isolateKitEnv, loadModule, rmWorkspace, setEnv } from "../packages/core/eval/harness.ts";
import { object, optional, parseJsonAs, string } from "../packages/core/lib/guard.ts";
import type * as SessionHelpers from "../packages/extensions/src/session-helpers/index.ts";
import type * as ProfileSwitch from "../packages/extensions/src/session-helpers/profile-switch.ts";

/** session-helpers as this smoke loads it: the extension is registered on the harness's fake pi. */
type SessionHelpersView = Omit<typeof SessionHelpers, "default"> & { default: (api: ReturnType<typeof fakePi>["api"]) => void };

const restoreEnv = isolateKitEnv();
const helpers = await loadModule<SessionHelpersView>("extensions/session-helpers/index.ts");
const txn: typeof ProfileSwitch = await loadModule("extensions/session-helpers/profile-switch.ts");
const sessionHelpers = helpers.default;

const STUB = `
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = process.argv.slice(2);
const flag = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const profile = flag("--profile");
const scope = flag("--scope", "global");
const mode = process.env.STUB_MODE || "ok";
const agent = process.env.PI_CODING_AGENT_DIR;
const settingsPath = scope === "project" ? path.join(process.cwd(), ".pi", "settings.json") : path.join(agent, "settings.json");
const markerPath = scope === "project" ? path.join(process.cwd(), ".pi", ".pi-kit.json") : path.join(agent, ".pi-kit.json");
const firewallPath = path.join(agent, "pi-kit", "firewall.json");
const def = JSON.parse(fs.readFileSync(path.join(root, "packages", "kit", "profiles", profile + ".json"), "utf8"));
const include = def.include || [];
const patterns = include.filter((n) => fs.existsSync(path.join(root, "packages", "extensions", "src", n, "index.ts"))).map((n) => "packages/extensions/src/" + n + "/index.ts");
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const writeSettings = (extra) => {
  let s = {}; try { s = JSON.parse(fs.readFileSync(settingsPath, "utf8")); } catch {}
  const packages = Array.isArray(s.packages) ? s.packages : [];
  const at = packages.findIndex((p) => (typeof p === "string" ? p : p.source) === root);
  const entry = { source: root, extensions: patterns.concat(extra || []) };
  if (at >= 0) packages[at] = entry; else packages.push(entry);
  s.packages = packages;
  write(settingsPath, JSON.stringify(s, null, 2));
};
const writeMarker = (over) => write(markerPath, JSON.stringify(Object.assign({ kitSource: root, profile, scope, mode: "local", extensions: include, installedAt: new Date().toISOString() }, over || {}), null, 2));
const writeFirewall = (over) => {
  write(firewallPath, JSON.stringify(Object.assign({ mode: (def.firewall && def.firewall.mode) || "manual", policy: (def.firewall && def.firewall.policy) || "coding", source: "profile" }, over || {}), null, 2));
  write(path.join(agent, "pi-kit", "security.json"), JSON.stringify({ schemaVersion: 1, level: def.securityLevel || (profile === "pentest" ? "guarded" : "balanced"), source: "profile", revision: 1, changedAt: new Date().toISOString() }));
};
if (mode !== "silent-kill") console.log("[install] pi-system");
switch (mode) {
  case "exit1-after-settings": writeSettings(); console.error("[install] FAIL: boom"); process.exit(1);
  case "sigkill-after-settings": writeSettings(); process.kill(process.pid, "SIGKILL"); break;
  case "silent-kill": writeSettings(); writeFirewall(); process.kill(process.pid, "SIGKILL"); break;
  case "hang": writeSettings(); setTimeout(() => {}, 60000); await new Promise(() => {}); break;
  case "stale-lock": writeSettings(); write(settingsPath + ".pi-kit.lock", "1"); write(settingsPath + ".4242.tmp", "{"); console.error("[install] FAIL: crashed"); process.exit(1);
  case "throw": writeSettings(); throw new Error("stub exception");
  case "corrupt-marker": writeSettings(); writeFirewall(); write(markerPath, "{ not json"); break;
  case "wrong-profile": writeSettings(); writeFirewall(); writeMarker({ profile: "balanced" }); break;
  case "no-marker-write": writeSettings(); writeFirewall(); break;
  case "bad-firewall": writeSettings(); writeFirewall({ policy: "yolo" }); writeMarker(); break;
  case "bad-security": writeSettings(); writeFirewall(); write(path.join(agent, "pi-kit", "security.json"), JSON.stringify({ schemaVersion: 1, level: "off", source: "profile", revision: 1, changedAt: new Date().toISOString() })); writeMarker(); break;
  case "bad-mode": writeSettings(); writeFirewall({ mode: "always" }); writeMarker(); break;
  case "dangling": writeSettings(["packages/extensions/src/ghost/index.ts"]); writeFirewall(); writeMarker(); break;
  case "unfiltered": { let s = {}; try { s = JSON.parse(fs.readFileSync(settingsPath, "utf8")); } catch {} s.packages = [root]; write(settingsPath, JSON.stringify(s)); writeFirewall(); writeMarker(); break; }
  case "warn-ok": console.error("[install] WARN: overrides.json extensions.add \\"old-ext\\" no longer exists; skipped"); writeSettings(); writeFirewall(); writeMarker(); break;
  default: writeSettings(); writeFirewall(); writeMarker();
}
console.log("[install] Done.");
`;

/** Options of the pi.exec reproduction (the subset /profile passes). */
interface ExecOptions {
  cwd?: string;
  timeout?: number;
}

/** pi.exec's result shape, plus whether the timeout killed the child. */
interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}

/** One recorded installer invocation. */
interface ExecCall {
  command: string;
  args: string[];
  options?: ExecOptions | undefined;
}

/** A throwaway kit checkout, agent dir and project dir. */
interface World {
  dir: string;
  root: string;
  agent: string;
  project: string;
  done: () => void;
}

interface Note {
  message: string;
  level: string;
}

type SelectFn = (title: string, options: string[]) => Promise<string | undefined>;

/** The command context /profile sees, plus the counters this smoke reads back. */
interface TestCtx {
  cwd: string;
  hasUI: boolean;
  notes: Note[];
  reloads: number;
  ui: {
    notify: (message: string, level: string) => number;
    select: SelectFn;
    confirm: () => Promise<boolean>;
    setStatus(): void;
  };
  reload: () => Promise<void>;
  waitForIdle: () => Promise<void>;
  model?: { contextWindow: number };
}

interface CtxOptions {
  hasUI?: boolean;
  select?: SelectFn;
  confirm?: () => Promise<boolean>;
  reload?: () => Promise<void>;
}

type FakePi = ReturnType<typeof fakePi>;
type ProfileHandler = (args: string, ctx: TestCtx) => Promise<void>;

interface LoadedCommand {
  pi: FakePi;
  calls: ExecCall[];
  handler: ProfileHandler;
}

interface KitEntry {
  source: string;
  extensions: string[];
}

/** The parts of a pi settings.json this smoke edits. */
interface SettingsFile {
  theme?: string;
  packages: Array<string | KitEntry>;
}

/** The parts of the .pi-kit.json install marker this smoke reads or edits. */
interface MarkerFile {
  profile: string;
  companions?: string[];
  channel?: string;
}

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// pi.exec reproduction: code is `code ?? 0` (a signal-killed child reads as success), plus timeout kill.
function piLikeExec(command: string, args: string[], options: ExecOptions = {}): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve) => {
    const proc = spawn(command, args, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"], env: process.env });
    let stdout = "";
    let stderr = "";
    let killed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (options.timeout) timer = setTimeout(() => { killed = true; proc.kill("SIGKILL"); }, options.timeout);
    proc.stdout.on("data", (d) => { stdout += String(d); });
    proc.stderr.on("data", (d) => { stderr += String(d); });
    proc.on("close", (code) => { clearTimeout(timer); resolve({ stdout, stderr, code: code ?? 0, killed }); });
    proc.on("error", (error) => { clearTimeout(timer); resolve({ stdout, stderr: String(error), code: 1, killed }); });
  });
}

function makeWorld(): World {
  const dir = tmp("pi-kit-txn-");
  const root = path.join(dir, "kit");
  const agent = path.join(dir, "agent");
  const project = path.join(dir, "project");
  fs.mkdirSync(path.join(root, "packages", "core"), { recursive: true });
  fs.writeFileSync(path.join(root, "packages", "core", "install.ts"), STUB);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "@satunix/pi-system", version: "0.0.0", type: "module" }));
  fs.mkdirSync(path.join(root, "packages", "kit", "profiles"), { recursive: true });
  for (const n of ["tool-firewall", "protected-paths", "alpha", "beta", "gamma"]) {
    fs.mkdirSync(path.join(root, "packages", "extensions", "src", n), { recursive: true });
    fs.writeFileSync(path.join(root, "packages", "extensions", "src", n, "index.ts"), "");
  }
  const profile = (name: string, include: string[], firewall: { mode: string; policy: string }): void => fs.writeFileSync(path.join(root, "packages", "kit", "profiles", `${name}.json`), JSON.stringify({ name, description: `${name} profile`, include, firewall }));
  profile("balanced", ["tool-firewall", "protected-paths", "alpha", "beta"], { mode: "manual", policy: "coding" });
  profile("long", ["tool-firewall", "protected-paths", "alpha", "gamma"], { mode: "auto", policy: "coding" });
  profile("pentest", ["tool-firewall", "protected-paths", "beta"], { mode: "manual", policy: "pentest" });
  profile("broken-fw", ["tool-firewall", "protected-paths"], { mode: "manual", policy: "pentset" });
  fs.mkdirSync(agent, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  const restores = [setEnv("PI_CODING_AGENT_DIR", agent), setEnv("PI_KIT_ROOT", root)];
  return { dir, root, agent, project, done: () => { for (const r of restores) r(); rmWorkspace(dir); } };
}

// Put the world on the "balanced" profile with a hand-tuned settings file, an overrides file and a
// user-owned firewall mode: everything a rollback has to preserve exactly.
async function installBalanced(world: World, scope = "global"): Promise<void> {
  const restore = setEnv("STUB_MODE", "ok");
  try {
    const args = [path.join(world.root, "packages", "core", "install.ts"), "--profile", "balanced", "--yes", "--settings-only", "--scope", scope];
    const r = await piLikeExec(process.execPath, args, { cwd: scope === "project" ? world.project : world.root });
    assert.equal(r.code, 0, r.stderr);
  } finally { restore(); }
  const settingsPath = scope === "project" ? path.join(world.project, ".pi", "settings.json") : path.join(world.agent, "settings.json");
  const s = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as SettingsFile;
  s.theme = "solarized";
  s.packages.push("npm:pi-lens@3.8.63");
  fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2) + "\n");
  fs.chmodSync(settingsPath, 0o600);
  fs.mkdirSync(path.join(world.agent, "pi-kit"), { recursive: true });
  fs.writeFileSync(path.join(world.agent, "pi-kit", "overrides.json"), JSON.stringify({ extensions: { add: [], remove: [] } }, null, 2));
  fs.writeFileSync(path.join(world.agent, "pi-kit", "firewall.json"), JSON.stringify({ mode: "auto", policy: "coding", source: "user", judgeModel: "x/y" }, null, 2));
}

function hashAll(world: Pick<World, "project">): Record<string, string | null> {
  const files = helpers.switchFiles(world.project);
  const out: Record<string, string | null> = {};
  for (const f of files) {
    try {
      const st = fs.statSync(f);
      out[f] = crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex") + ":" + (st.mode & 0o777).toString(8);
    } catch { out[f] = null; }
  }
  // Nothing may be left behind next to them either.
  for (const f of files) {
    const dir = path.dirname(f);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) if (/\.(lock|tmp)$/.test(name)) out[path.join(dir, name)] = "transient";
  }
  return out;
}

// `_world` is unused: the command reads its paths from the environment makeWorld() sets.
function loadCommand(_world: Partial<World>): LoadedCommand {
  const pi = fakePi();
  sessionHelpers(pi.api);
  const calls: ExecCall[] = [];
  pi.api.exec = (command: string, args: string[], options?: ExecOptions) => { calls.push({ command, args, options }); return piLikeExec(command, args, options); };
  return { pi, calls, handler: pi.commands.get("profile").handler };
}

function makeCtx(world: Pick<World, "project"> & Partial<World>, { hasUI = true, select, confirm, reload }: CtxOptions = {}): TestCtx {
  const ctx: TestCtx = {
    cwd: world.project,
    hasUI,
    notes: [],
    reloads: 0,
    ui: {
      notify: (message: string, level: string) => ctx.notes.push({ message, level }),
      select: select ?? (async () => undefined),
      confirm: confirm ?? (async () => false),
      setStatus() {},
    },
    reload: reload ?? (async () => { ctx.reloads++; }),
    waitForIdle: async () => {},
  };
  return ctx;
}

async function withMode<T>(mode: string, fn: () => Promise<T>): Promise<T> {
  const restore = setEnv("STUB_MODE", mode);
  try { return await fn(); } finally { restore(); }
}

const last = (ctx: TestCtx): Note => {
  const note = ctx.notes.at(-1);
  assert.ok(note, "expected a notification");
  return note;
};
const tests: Record<string, () => void | Promise<void>> = {};

tests["a clean switch changes the files, verifies them and reloads once"] = async () => {
  const w = makeWorld();
  try {
    await installBalanced(w);
    const before = hashAll(w);
    const { handler, calls } = loadCommand(w);
    const ctx = makeCtx(w);
    await withMode("ok", () => handler("long", ctx));
    assert.equal(calls.length, 1);
    assert.ok(calls[0]?.args.includes("--no-migrate"), "a switch never moves the kit's source: its rollback cannot restore a removed clone");
    assert.equal(ctx.reloads, 1);
    assert.match(ctx.notes[0]?.message ?? "", /switched to "long"\. Verified: marker, extension list and firewall match/);
    const marker = JSON.parse(fs.readFileSync(path.join(w.agent, ".pi-kit.json"), "utf8")) as MarkerFile;
    assert.equal(marker.profile, "long");
    assert.notDeepEqual(hashAll(w), before);
  } finally { w.done(); }
};

tests["installer warnings are shown to the operator, not swallowed"] = async () => {
  const w = makeWorld();
  try {
    await installBalanced(w);
    const { handler } = loadCommand(w);
    const ctx = makeCtx(w);
    await withMode("warn-ok", () => handler("long", ctx));
    assert.equal(ctx.reloads, 1);
    assert.match(ctx.notes[0]?.message ?? "", /Warnings:\s+WARN: overrides\.json extensions\.add "old-ext" no longer exists/);
  } finally { w.done(); }
};

const failureCases: Array<[name: string, mode: string, pattern: RegExp]> = [
  ["installer exits non-zero after rewriting settings", "exit1-after-settings", /FAILED at install: installer exited 1/],
  ["installer throws after rewriting settings", "throw", /FAILED at install: installer exited 1/],
  ["installer is SIGKILLed mid-way (pi.exec reports code 0)", "sigkill-after-settings", /FAILED at install: the installer stopped before finishing/],
  ["installer is SIGKILLed with no output at all", "silent-kill", /FAILED at verify: .*marker/],
  ["installer leaves a corrupt marker", "corrupt-marker", /FAILED at verify: install marker .* is not valid JSON/],
  ["installer writes a marker for the wrong profile", "wrong-profile", /FAILED at verify: marker records profile "balanced", expected "long"/],
  ["installer never rewrites the marker", "no-marker-write", /FAILED at verify: marker records profile "balanced", expected "long"/],
  ["installer writes an unknown firewall policy", "bad-firewall", /FAILED at verify: firewall policy "yolo" is not a known policy/],
  ["installer writes an unavailable security level", "bad-security", /FAILED at verify: security config .* is invalid/],
  ["installer writes an unknown firewall mode", "bad-mode", /FAILED at verify: firewall mode "always" is not a known mode/],
  ["installer lists an extension that does not exist", "dangling", /FAILED at verify: .*(differs from profile "long"; unexpected: ghost|do not exist in the kit: ghost)/],
  ["installer leaves an unfiltered kit entry", "unfiltered", /FAILED at verify: .*no filtered kit entry/],
  ["installer crashes leaving lock and tmp files behind", "stale-lock", /FAILED at install: installer exited 1/],
];
for (const [name, mode, pattern] of failureCases) {
  tests[`rollback: ${name}`] = async () => {
    const w = makeWorld();
    try {
      await installBalanced(w);
      const before = hashAll(w);
      const { handler } = loadCommand(w);
      const ctx = makeCtx(w);
      await withMode(mode, () => handler("long", ctx));
      assert.equal(ctx.reloads, 0, "a failed switch must not reload");
      assert.equal(last(ctx).level, "error");
      assert.match(last(ctx).message, pattern);
      assert.match(last(ctx).message, /restored byte-for-byte and the previous profile stays in force/);
      assert.deepEqual(hashAll(w), before, "every configuration file (bytes and mode) and no transient file must be back as it was");
    } finally { w.done(); }
  };
}

tests["rollback: a failing reload restores the files and reloads the old configuration"] = async () => {
  const w = makeWorld();
  try {
    await installBalanced(w);
    const before = hashAll(w);
    const { handler } = loadCommand(w);
    let calls = 0;
    const ctx = makeCtx(w, { reload: async () => { calls++; if (calls === 1) throw new Error("extension failed to load"); } });
    await withMode("ok", () => handler("long", ctx));
    assert.equal(calls, 2, "reload the new config (fails), then the restored one");
    assert.match(last(ctx).message, /FAILED at reload: pi could not reload the new configuration: extension failed to load/);
    assert.deepEqual(hashAll(w), before);
  } finally { w.done(); }
};

tests["rollback: an installer timeout (killed) is a failure even though pi.exec says code 0"] = async () => {
  const w = makeWorld();
  try {
    await installBalanced(w);
    const before = hashAll(w);
    const world = w;
    const files = helpers.switchFiles(world.project);
    const outcome = await withMode("hang", () => txn.transactionalSwitch({
      exec: piLikeExec,
      command: process.execPath,
      args: [path.join(world.root, "packages", "core", "install.ts"), "--profile", "long", "--yes", "--settings-only"],
      cwd: world.root,
      timeoutMs: 400,
      files,
      expectation: {
        profile: "long", scope: "global", kitRoot: world.root,
        markerFile: path.join(world.agent, ".pi-kit.json"), settingsFile: path.join(world.agent, "settings.json"), firewallFile: path.join(world.agent, "pi-kit", "firewall.json"),
        extensions: ["tool-firewall", "protected-paths", "alpha", "gamma"], firewall: { policy: "coding", mode: "auto" },
        loadedExtensions: (f: string) => helpers.loadedKitExtensions(f, world.root), extensionExists: () => true,
      },
    }));
    assert.equal(outcome.ok, false);
    assert.equal(outcome.stage, "install");
    assert.match(outcome.message, /the installer was killed after/);
    assert.deepEqual(hashAll(world), before);
  } finally { w.done(); }
};

tests["rollback: pi.exec rejecting is a failure"] = async () => {
  const w = makeWorld();
  try {
    await installBalanced(w);
    const before = hashAll(w);
    const pi = fakePi();
    sessionHelpers(pi.api);
    pi.api.exec = async () => { throw new Error("spawn EAGAIN"); };
    const ctx = makeCtx(w);
    await pi.commands.get("profile").handler("long", ctx);
    assert.match(last(ctx).message, /FAILED at install: could not run the installer: spawn EAGAIN/);
    assert.deepEqual(hashAll(w), before);
  } finally { w.done(); }
};

tests["rollback: package operations the installer already ran are named, never 'Nothing was changed'"] = async () => {
  const w = makeWorld();
  try {
    await installBalanced(w);
    const before = hashAll(w);
    const world = w;
    const expectation: ProfileSwitch.SwitchInput["expectation"] = {
      profile: "long", scope: "global", kitRoot: world.root,
      markerFile: path.join(world.agent, ".pi-kit.json"), settingsFile: path.join(world.agent, "settings.json"), firewallFile: path.join(world.agent, "pi-kit", "firewall.json"),
      extensions: ["tool-firewall", "protected-paths", "alpha", "gamma"], firewall: { policy: "coding", mode: "auto" },
      loadedExtensions: (f: string) => helpers.loadedKitExtensions(f, world.root), extensionExists: () => true,
    };
    const run = (stdout: string, code: number) => txn.transactionalSwitch({
      exec: async () => ({ stdout, stderr: code ? "[install] FAIL: companion" : "", code }),
      command: process.execPath, args: [], cwd: world.root, timeoutMs: 1000, files: helpers.switchFiles(world.project), expectation,
    });
    const change = "[install] Package change (a rollback cannot undo it): pi install npm:pi-lens@9.9.9\n";
    // The installer failed after a companion install (stage install) ...
    const failed = await run(change, 1);
    assert.equal(failed.stage, "install");
    assert.match(failed.message, /restored byte-for-byte, so the previous profile's settings are back, but these package operations had already run and were NOT rolled back: pi install npm:pi-lens@9\.9\.9\./);
    assert.doesNotMatch(failed.message, /Nothing was changed/);
    // ... or finished and the result did not verify (stage verify): the install still happened.
    const unverified = await run(`${change}[install] Done.\n`, 0);
    assert.equal(unverified.stage, "verify");
    assert.match(unverified.message, /NOT rolled back: pi install npm:pi-lens@9\.9\.9/);
    assert.deepEqual(hashAll(world), before, "the configuration files are still restored");
    assert.deepEqual(txn.packageChangeLines(`x\n${change}${change}`, ""), ["pi install npm:pi-lens@9.9.9"], "each change is listed once");
  } finally { w.done(); }
};

tests["rollback: project scope restores project files and leaves the global ones alone"] = async () => {
  const w = makeWorld();
  try {
    await installBalanced(w, "project");
    const before = hashAll(w);
    const { handler, calls } = loadCommand(w);
    const ctx = makeCtx(w);
    await withMode("wrong-profile", () => handler("long", ctx));
    const [call] = calls;
    assert.ok(call, "the installer ran");
    assert.ok(call.args.includes("--scope") && call.args.includes("project"));
    assert.equal(call.options?.cwd, w.project);
    assert.match(last(ctx).message, /FAILED at verify/);
    assert.deepEqual(hashAll(w), before);
    assert.equal(fs.existsSync(path.join(w.agent, ".pi-kit.json")), false, "the global marker never existed and must not be created");
  } finally { w.done(); }
};

tests["a profile whose firewall block is unknown is refused before the installer runs"] = async () => {
  const w = makeWorld();
  try {
    await installBalanced(w);
    const before = hashAll(w);
    const { handler, calls } = loadCommand(w);
    const ctx = makeCtx(w);
    await handler("broken-fw", ctx);
    assert.equal(calls.length, 0);
    assert.match(last(ctx).message, /refusing to switch to "broken-fw".*unknown policy or mode/);
    assert.deepEqual(hashAll(w), before);
  } finally { w.done(); }
};

tests["invalid arguments change nothing and never reach the installer"] = async () => {
  const w = makeWorld();
  try {
    await installBalanced(w);
    const before = hashAll(w);
    for (const arg of ["long extra", "--evil", "../etc/passwd", "LONG", "long;rm", "long --scope project"]) {
      const { handler, calls } = loadCommand(w);
      const ctx = makeCtx(w);
      await handler(arg, ctx);
      assert.equal(calls.length, 0, `"${arg}" must not run the installer`);
      assert.equal(ctx.reloads, 0);
      assert.equal(last(ctx).level, "error", arg);
      assert.match(last(ctx).message, /Nothing was changed|expected one argument/);
      assert.deepEqual(hashAll(w), before, arg);
    }
  } finally { w.done(); }
};

tests["a cancelled picker changes nothing"] = async () => {
  const w = makeWorld();
  try {
    await installBalanced(w);
    const before = hashAll(w);
    const { handler, calls } = loadCommand(w);
    const ctx = makeCtx(w, { select: async () => undefined });
    await handler("", ctx);
    assert.equal(calls.length, 0);
    assert.equal(ctx.reloads, 0);
    assert.equal(ctx.notes.length, 0);
    assert.deepEqual(hashAll(w), before);
  } finally { w.done(); }
};

tests["non-interactive sessions print results to stderr instead of doing nothing"] = async () => {
  const w = makeWorld();
  const chunks: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  try {
    await installBalanced(w);
    const { handler } = loadCommand(w);
    process.stderr.write = (c) => { chunks.push(String(c)); return true; };
    const ctx = makeCtx(w, { hasUI: false });
    await handler("nope", ctx); // unknown
    await handler("balanced", ctx); // already on
    await withMode("wrong-profile", () => handler("long", ctx)); // failed switch
    await withMode("ok", () => handler("long", ctx)); // good switch
    process.stderr.write = original;
    const text = chunks.join("");
    assert.match(text, /\[pi-kit\] profile: unknown profile "nope"/);
    assert.match(text, /\[pi-kit\] profile: already on "balanced"/);
    assert.match(text, /\[pi-kit\] profile: switch to "long" FAILED at verify/);
    assert.match(text, /\[pi-kit\] profile: switched to "long"\. Verified/);
    assert.equal(ctx.reloads, 1);
  } finally { process.stderr.write = original; w.done(); }
};

tests["/profile status prints the effective configuration"] = async () => {
  const w = makeWorld();
  try {
    await installBalanced(w);
    fs.writeFileSync(path.join(w.agent, "pi-kit", "overrides.json"), JSON.stringify({ extensions: { add: ["gamma"], remove: [] }, skills: { exclude: ["x"] } }));
    const marker = JSON.parse(fs.readFileSync(path.join(w.agent, ".pi-kit.json"), "utf8")) as MarkerFile;
    marker.companions = ["npm:pi-lens@3.8.63", "npm:pi-readseek@1.0.0"];
    marker.channel = "next";
    fs.writeFileSync(path.join(w.agent, ".pi-kit.json"), JSON.stringify(marker));
    const { handler } = loadCommand(w);
    const ctx = makeCtx(w);
    ctx.model = { contextWindow: 200_000 };
    await handler("status", ctx);
    const text = last(ctx).message;
    assert.match(text, /^Current: /);
    assert.match(text, /Profile: /);
    assert.match(text, /Install: local · channel next · scope global · source /);
    assert.match(text, /Extensions: 4 loaded - notable: tool-firewall, protected-paths/);
    assert.match(text, /Firewall: policy coding · mode auto \(set with \/auto\)/);
    assert.match(text, /Compaction: pi auto ON \(default\) · earliest trigger 183\.6k · no kit trigger/);
    assert.match(text, /Overrides: extensions \+1\/-0, skills -1\/\+0, prompts -0\/\+0 \(.*overrides\.json\)/);
    assert.match(text, /Companions: pi-lens@3\.8\.63, pi-readseek@1\.0\.0 \(not registered\)/);
  } finally { w.done(); }
};

tests["/profile status warns when a mandatory protection extension is not loaded"] = async () => {
  const w = makeWorld();
  try {
    await installBalanced(w);
    const s = JSON.parse(fs.readFileSync(path.join(w.agent, "settings.json"), "utf8")) as SettingsFile;
    const kit = s.packages.find((p): p is KitEntry => typeof p !== "string" && p.source === w.root);
    assert.ok(kit, "settings.json has the kit entry");
    kit.extensions = kit.extensions.filter((e) => !/protected-paths/.test(e));
    fs.writeFileSync(path.join(w.agent, "settings.json"), JSON.stringify(s));
    const { handler } = loadCommand(w);
    const ctx = makeCtx(w);
    await handler("status", ctx);
    assert.match(last(ctx).message, /WARNING: protected-paths is NOT loaded/);
  } finally { w.done(); }
};

tests["restoreSnapshots reports a file it cannot restore and saveBackup keeps the bytes"] = () => {
  const dir = tmp("pi-kit-txn-restore-");
  try {
    const blocker = path.join(dir, "blocker");
    fs.writeFileSync(blocker, "i am a file");
    const snap = { path: path.join(blocker, "child", "settings.json"), existed: true, bytes: Buffer.from("original"), mode: 0o600 };
    const result = txn.restoreSnapshots([snap]);
    assert.equal(result.restored.length, 0);
    assert.equal(result.errors.length, 1);
    const backup = txn.saveBackup([snap]);
    assert.ok(backup && fs.readdirSync(backup).length === 1);
    const [saved] = fs.readdirSync(backup);
    assert.ok(saved, "the backup holds the snapshot");
    assert.equal(fs.readFileSync(path.join(backup, saved), "utf8"), "original");
    rmWorkspace(backup);
  } finally { rmWorkspace(dir); }
};

tests["snapshot/restore round-trips bytes, mode and absence"] = () => {
  const dir = tmp("pi-kit-txn-snap-");
  try {
    const a = path.join(dir, "a.json");
    const b = path.join(dir, "sub", "b.json");
    fs.writeFileSync(a, Buffer.from([0, 1, 2, 255, 10, 13]));
    fs.chmodSync(a, 0o640);
    const snaps = txn.snapshotFiles([a, b, a]);
    assert.equal(snaps.length, 2, "duplicates collapse");
    fs.writeFileSync(a, "changed");
    fs.chmodSync(a, 0o777);
    fs.mkdirSync(path.dirname(b), { recursive: true });
    fs.writeFileSync(b, "created by the switch");
    const r = txn.restoreSnapshots(snaps);
    assert.deepEqual(r.errors, []);
    assert.deepEqual([...fs.readFileSync(a)], [0, 1, 2, 255, 10, 13]);
    assert.equal(fs.statSync(a).mode & 0o777, 0o640);
    assert.equal(fs.existsSync(b), false, "a file the switch created is removed");
  } finally { rmWorkspace(dir); }
};

// The real thing: the actual packages/core/install.ts and the shipped profiles, driven through the real
// command, must pass the command's own verification for every profile (a verifier that rejects a good
// switch would roll back every /profile in production).
tests["the real installer and the shipped profiles pass /profile's verification for all seven profiles"] = async () => {
  const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const dir = tmp("pi-kit-txn-real-");
  const agent = path.join(dir, "agent");
  const project = path.join(dir, "project");
  const bin = path.join(dir, "bin");
  for (const d of [agent, project, bin]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(bin, "pi"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ theme: "dark", packages: [repo] }, null, 2));
  const restores = [
    setEnv("PI_CODING_AGENT_DIR", agent),
    setEnv("PI_KIT_ROOT", repo),
    setEnv("PI_LEAN_CTX_BIN", path.join(dir, "no-lean-ctx")),
    setEnv("PATH", `${bin}${path.delimiter}${process.env.PATH ?? ""}`),
  ];
  try {
    const { handler } = loadCommand({});
    for (const profile of ["balanced", "quick", "long-horizon", "autonomous", "self-improving", "pentest", "lite"]) {
      // quick and lite default to relaxed: entering them from a balanced profile asks first.
      const asked: string[] = [];
      const ctx = makeCtx({ project, agent }, { select: async (title: string, options: string[]) => { asked.push(title); return options.find((o) => o.startsWith("Yes")); } });
      await handler(profile, ctx);
      assert.equal(ctx.reloads, 1, `${profile}: ${ctx.notes.map((n) => n.message).join("\n")}`);
      assert.equal(asked.length, profile === "quick" || profile === "lite" ? 1 : 0, `${profile}: lowering prompts ${JSON.stringify(asked)}`);
      assert.match(ctx.notes[0]?.message ?? "", new RegExp(`switched to "${profile}"\\. Verified`));
      const marker = JSON.parse(fs.readFileSync(path.join(agent, ".pi-kit.json"), "utf8")) as MarkerFile;
      assert.equal(marker.profile, profile);
      const fw = parseJsonAs(object({ policy: string() }), fs.readFileSync(path.join(agent, "pi-kit", "firewall.json"), "utf8"));
      assert.equal(fw.policy, profile === "pentest" ? "pentest" : "coding");
      const status = makeCtx({ project, agent });
      await handler("status", status);
      assert.match(last(status).message, new RegExp(`^Current: ${profile}\\n`), `${profile} is reported as the current profile`);
    }
    assert.equal(parseJsonAs(object({ theme: optional(string()) }), fs.readFileSync(path.join(agent, "settings.json"), "utf8")).theme, "dark", "other settings survive every switch");
    // A no-op switch to the profile already in force never touches anything.
    const same = makeCtx({ project, agent });
    await handler("lite", same);
    assert.match(same.notes[0]?.message ?? "", /already on "lite"/);
  } finally { for (const r of restores.reverse()) r(); rmWorkspace(dir); }
};

// TOO-1: a project /profile drives install.ts --scope project, which leaves the machine-global
// firewall.json and security.json alone; the switch still verifies, and the difference is announced.
tests["a project /profile with the real installer leaves the global firewall.json and security.json byte-identical"] = async () => {
  const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const dir = tmp("pi-kit-txn-project-gate-");
  const agent = path.join(dir, "agent");
  const project = path.join(dir, "project");
  const bin = path.join(dir, "bin");
  const home = path.join(dir, "home");
  for (const d of [path.join(agent, "pi-kit"), path.join(project, ".pi"), bin, home]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(bin, "pi"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(path.join(project, ".pi", "settings.json"), JSON.stringify({ packages: [repo] }, null, 2));
  const firewallPath = path.join(agent, "pi-kit", "firewall.json");
  const securityPath = path.join(agent, "pi-kit", "security.json");
  fs.writeFileSync(firewallPath, JSON.stringify({ mode: "manual", policy: "coding", source: "profile" }, null, 2) + "\n");
  fs.writeFileSync(securityPath, JSON.stringify({ schemaVersion: 1, level: "strict", source: "profile", revision: 2, changedAt: "2026-01-01T00:00:00.000Z" }, null, 2) + "\n");
  const firewallBefore = fs.readFileSync(firewallPath);
  const securityBefore = fs.readFileSync(securityPath);
  const restores = [
    setEnv("HOME", home),
    setEnv("PI_CODING_AGENT_DIR", agent),
    setEnv("PI_KIT_ROOT", repo),
    setEnv("PI_KIT_FIREWALL_CONFIG", ""),
    setEnv("PI_KIT_SECURITY_CONFIG", ""),
    setEnv("PI_LEAN_CTX_BIN", path.join(dir, "no-lean-ctx")),
    setEnv("PATH", `${bin}${path.delimiter}${process.env.PATH ?? ""}`),
  ];
  try {
    const { handler, calls } = loadCommand({});
    const ctx = makeCtx({ project, agent }, { select: async (_title: string, options: string[]) => options.find((o) => o.startsWith("Yes")) });
    await handler("autonomous", ctx);
    const all = ctx.notes.map((n) => n.message).join("\n");
    assert.ok(calls[0]?.args.includes("project"), "the switch ran the installer at project scope");
    assert.equal(ctx.reloads, 1, all);
    assert.match(all, /switched to "autonomous"/);
    assert.match(all, /firewall auto\/coding[^\n]*firewall\.json/, "the differing global firewall mode is announced");
    assert.deepEqual(fs.readFileSync(firewallPath), firewallBefore, "global firewall.json is byte-identical");
    assert.deepEqual(fs.readFileSync(securityPath), securityBefore, "global security.json is byte-identical");
  } finally { for (const r of restores.reverse()) r(); rmWorkspace(dir); }
};

let failed = 0;
for (const [name, fn] of Object.entries(tests)) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failed++;
    console.error(`  FAIL ${name}\n${error instanceof Error ? error.stack : String(error)}`);
  }
}
restoreEnv();
const total = Object.keys(tests).length;
if (failed) {
  console.error(`profile-transaction-smoke: ${failed}/${total} failed`);
  process.exit(1);
}
console.log(`profile-transaction-smoke: ${total}/${total} passed`);
