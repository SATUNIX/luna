#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HandlerRegistry, Registry, loadExtension, textOf } from "../packages/core/eval/harness.ts";
import type { FakeCommand, FakeTool, RegisteredHandler } from "../packages/core/eval/harness.ts";
import { array, object, optional, parseJson, parseJsonAs, string, unknownValue } from "../packages/core/lib/guard.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// `firewall` stays unknown so the deepEqual checks below still see every key the profile has.
const ProfileManifest = object({ include: array(string()), firewall: optional(unknownValue()) });
const LeaseRecords = array(object({ worktreePath: string() }));

interface Note {
  message: string;
  level: string;
}

interface LeanNote {
  m: string;
  l: string;
}

interface SessionEntry {
  type: string;
  message: object;
}

const readProfile = (file: string) => parseJsonAs(ProfileManifest, fs.readFileSync(file, "utf8"), file);
const readLeases = (file: string) => parseJsonAs(LeaseRecords, fs.readFileSync(file, "utf8"), file);

function fakePi() {
  const handlers = new HandlerRegistry();
  const tools = new Registry<FakeTool>("tool");
  const commands = new Registry<FakeCommand>("command");
  return {
    api: {
      on(name: string, handler: RegisteredHandler) {
        handlers.set(name, handler);
      },
      registerTool(tool: FakeTool) {
        tools.set(tool.name, tool);
      },
      registerCommand(name: string, command: FakeCommand) {
        commands.set(name, command);
      },
    },
    handlers,
    tools,
    commands,
  };
}

function withCwd(cwd: string, fn: () => unknown): Promise<unknown> {
  const previous = process.cwd();
  process.chdir(cwd);
  return Promise.resolve(fn()).finally(() => process.chdir(previous));
}

function setEnv(name: string, value: string | undefined): () => void {
  const previous = process.env[name];
  if (value === undefined) Reflect.deleteProperty(process.env, name);
  else process.env[name] = value;
  return () => {
    if (previous === undefined) Reflect.deleteProperty(process.env, name);
    else process.env[name] = previous;
  };
}

async function smokeFirewall(): Promise<void> {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-firewall-"));
  const audit = path.join(workspace, "audit.jsonl");
  const restoreAudit = setEnv("PI_KIT_FIREWALL_AUDIT_LOG", audit);
  const restoreSessions = setEnv("PI_KIT_FIREWALL_SESSIONS_DIR", path.join(workspace, "firewall-sessions"));
  // Epic 2: with the shipped starter policy loaded, a benign shell command is allowed
  // but the default is no longer allow-all (see tests/tool-firewall-smoke.ts for the
  // default-deny / destructive-command assertions).
  const restorePolicy = setEnv("PI_KIT_FIREWALL_POLICY", path.join(ROOT, "packages", "core", "policies", "default.json"));
  try {
    await withCwd(workspace, async () => {
      const register = await loadExtension("extensions/tool-firewall/index.ts");
      const pi = fakePi();
      register(pi.api);
      await pi.handlers.get("session_start")({}, { ui: { notify() {} } });
      const allowed = await pi.handlers.get("tool_call")({ toolName: "bash", input: { command: "echo ok" } }, { hasUI: false, ui: {} });
      assert.equal(allowed, undefined);
      assert.equal(fs.readFileSync(audit, "utf8").trim().split(/\r?\n/).length, 1);

      const policy = path.join(workspace, "policy.json");
      fs.writeFileSync(policy, JSON.stringify({ tools: { bash: { decision: "deny", risk_class: "shell" } } }));
      process.env.PI_KIT_FIREWALL_POLICY = policy;
      await pi.handlers.get("session_start")({}, { ui: { notify() {} } });
      const denied = await pi.handlers.get("tool_call")({ toolName: "bash", input: { command: "whoami" } }, { hasUI: false, ui: {} });
      assert.ok(denied, "the deny policy returns a result");
      assert.equal(denied.block, true);
      assert.match(denied.reason ?? "", /denied bash/);
    });
  } finally {
    restorePolicy();
    restoreSessions();
    restoreAudit();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

function smokeProfiles(): void {
  const profiles = {
    quick: readProfile(path.join(ROOT, "packages", "kit", "profiles", "quick.json")),
    balanced: readProfile(path.join(ROOT, "packages", "kit", "profiles", "balanced.json")),
    longHorizon: readProfile(path.join(ROOT, "packages", "kit", "profiles", "long-horizon.json")),
    autonomous: readProfile(path.join(ROOT, "packages", "kit", "profiles", "autonomous.json")),
    selfImproving: readProfile(path.join(ROOT, "packages", "kit", "profiles", "self-improving.json")),
  };
  for (const [name, profile] of Object.entries(profiles)) {
    assert.ok(profile.include.includes("tool-firewall"), `${name} should include tool-firewall`);
    assert.ok(profile.include.includes("custom-footer"), `${name} should include custom-footer`);
  }
  // Coding profiles carry no pentest gate; only the pentest profile layers it on.
  for (const [name, profile] of Object.entries(profiles)) {
    assert.ok(!profile.include.includes("pentest-governance-domain"), `${name} is a coding profile and must not include pentest-governance-domain`);
  }
  const pentest = readProfile(path.join(ROOT, "packages", "kit", "profiles", "pentest.json"));
  assert.ok(pentest.include.indexOf("tool-firewall") < pentest.include.indexOf("pentest-governance-domain"), "pentest should load tool-firewall before pentest-governance-domain");
  // Firewall defaults: autonomy profiles run auto mode on the coding policy; pentest is strict and manual.
  for (const [name, profile] of Object.entries(profiles)) {
    const expected = ["longHorizon", "autonomous", "selfImproving"].includes(name) ? "auto" : "manual";
    assert.deepEqual(profile.firewall, { mode: expected, policy: "coding" }, `${name} firewall defaults`);
  }
  assert.deepEqual(pentest.firewall, { mode: "manual", policy: "pentest" }, "pentest firewall defaults");
}

async function smokeBranchLab(): Promise<void> {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-branch-repo-"));
  const leaseFile = path.join(repo, "leases.json");
  const restoreLease = setEnv("PI_KIT_BRANCH_LEASES_FILE", leaseFile);
  const restoreMax = setEnv("PI_KIT_MAX_BRANCHES", "2");
  try {
    execFileSync("git", ["init"], { cwd: repo, stdio: "pipe" });
    execFileSync("git", ["config", "user.email", "smoke@example.invalid"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Smoke Test"], { cwd: repo });
    fs.writeFileSync(path.join(repo, "README.md"), "smoke\n");
    execFileSync("git", ["add", "README.md"], { cwd: repo });
    execFileSync("git", ["commit", "-m", "init"], { cwd: repo, stdio: "pipe" });

    await withCwd(repo, async () => {
      const register = await loadExtension("extensions/branch-lab/index.ts");
      const pi = fakePi();
      register(pi.api);
      await pi.handlers.get("session_start")({}, { ui: { notify() {} } });
      // H-02: production-shaped calls - execute(toolCallId, params, signal, onUpdate, ctx),
      // not execute(params) - previously this smoke asserted against the SAME wrong shape
      // the extension itself used, so both looked consistent while being wrong together.
      const ctx = { cwd: repo, hasUI: false, ui: { notify() {} } };
      const created = await pi.tools.get("branch_create").execute("call-1", { taskId: "task-1" }, undefined, undefined, ctx);
      assert.match(textOf(created), /created pi\/task-1/);
      const leases = readLeases(leaseFile);
      assert.equal(leases.length, 1);
      const [lease] = leases;
      assert.ok(lease && fs.existsSync(lease.worktreePath));
      const listed = await pi.tools.get("branch_list").execute("call-2", {}, undefined, undefined, ctx);
      assert.match(textOf(listed), /task-1/);
      const discarded = await pi.tools.get("branch_discard").execute("call-3", { taskId: "task-1" }, undefined, undefined, ctx);
      assert.match(textOf(discarded), /discarded pi\/task-1/);
      assert.deepEqual(parseJson(fs.readFileSync(leaseFile, "utf8")), []);

      // branch_switch and branch_merge (also named in H-02) with the same production shape.
      await pi.tools.get("branch_create").execute("call-4", { taskId: "task-2" }, undefined, undefined, ctx);
      const switched = await pi.tools.get("branch_switch").execute("call-5", { taskId: "task-2" }, undefined, undefined, ctx);
      assert.match(textOf(switched), /use worktree/);
      const [switchedLease] = readLeases(leaseFile);
      assert.ok(switchedLease, "a lease for task-2");
      const { worktreePath } = switchedLease;
      execFileSync("git", ["commit", "--allow-empty", "-m", "wt change"], { cwd: worktreePath, stdio: "pipe" });
      const merged = await pi.tools.get("branch_merge").execute("call-6", { taskId: "task-2" }, undefined, undefined, ctx);
      assert.match(textOf(merged), /merged pi\/task-2/);
      // Clean up the worktree branch-lab made under its os.tmpdir()-based root (it is merged
      // and clean, so no force is needed).
      await pi.tools.get("branch_discard").execute("call-7", { taskId: "task-2" }, undefined, undefined, ctx);
    });
  } finally {
    restoreLease();
    restoreMax();
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

async function smokeCustomFooter(): Promise<void> {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-footer-"));
  const restoreInput = setEnv("PI_KIT_COST_INPUT_PER_MTOK", undefined);
  const restoreOutput = setEnv("PI_KIT_COST_OUTPUT_PER_MTOK", undefined);
  const restoreCacheRead = setEnv("PI_KIT_COST_CACHE_READ_PER_MTOK", undefined);
  const restoreCacheWrite = setEnv("PI_KIT_COST_CACHE_WRITE_PER_MTOK", undefined);
  // Keep /footer settings writes out of the operator's real agent dir.
  const restoreAgentDir = setEnv("PI_CODING_AGENT_DIR", path.join(workspace, "agent"));
  try {
    await withCwd(workspace, async () => {
      const register = await loadExtension("vendor/custom-footer/index.ts");
      const pi = fakePi();
      register(pi.api);

      const notifications: Note[] = [];
      const footerCalls: unknown[][] = [];
      const statusCalls: Array<[string, unknown]> = [];
      const entries: SessionEntry[] = [];
      const lastNote = (): string => {
        const note = notifications.at(-1);
        assert.ok(note, "a notification");
        return note.message;
      };
      const ctx = {
        cwd: workspace,
        hasUI: true,
        model: { id: "local-small" },
        getContextUsage: () => ({ tokens: 1300, percent: 42 }),
        sessionManager: { getEntries: () => entries },
        ui: {
          setFooter(...args: unknown[]) { footerCalls.push(args); },
          setStatus(key: string, value: unknown) { statusCalls.push([key, value]); },
          notify(message: string, level: string) { notifications.push({ message, level }); },
        },
      };

      await pi.handlers.get("session_start")({}, ctx);
      assert.equal(footerCalls.length, 1, "the status bar installs one footer factory");
      assert.equal(typeof footerCalls[0]?.[0], "function", "setFooter receives a factory, never a status key");
      assert.equal(statusCalls.length, 0, "the status bar does not add a status entry of its own");

      const usage = { role: "assistant", usage: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, totalTokens: 1500 } };
      entries.push({ type: "message", message: usage });
      await pi.handlers.get("turn_end")({ message: usage }, ctx);
      await pi.commands.get("footer").handler(["status"], ctx);
      assert.match(lastNote(), /pricing unconfigured/);
      assert.match(lastNote(), /cost\s+\? \(unknown: no prices configured/);

      fs.mkdirSync(path.join(workspace, ".pi-kit"));
      fs.writeFileSync(path.join(workspace, ".pi-kit", "costs.json"), JSON.stringify({ inputPerMTok: 2, outputPerMTok: 8 }));
      await pi.commands.get("footer").handler(["reload"], ctx);
      assert.match(lastNote(), /pricing reloaded from/);
      await pi.commands.get("footer").handler(["status"], ctx);
      assert.match(lastNote(), /cost\s+~\$0\.0060 \(estimated/);

      fs.writeFileSync(path.join(workspace, ".pi-kit", "costs.json"), "{bad json");
      await pi.commands.get("footer").handler(["reload"], ctx);
      assert.ok(notifications.some(item => item.level === "warning" && /kept its prior pricing/.test(item.message)));
      await pi.commands.get("footer").handler(["status"], ctx);
      assert.match(lastNote(), /cost\s+~\$0\.0060 \(estimated/);

      await pi.commands.get("footer").handler([], ctx);
      assert.equal(footerCalls.at(-1)?.[0], undefined, "/footer off restores pi's built-in footer");
    });
  } finally {
    restoreAgentDir();
    restoreCacheWrite();
    restoreCacheRead();
    restoreOutput();
    restoreInput();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

function smokeLiteSurface(): void {
  // The lite surface is now the lite profile of the single package. Themes are not filtered
  // by profile, so every accessible theme ships to lite users with the package.
  const profile = readProfile(path.join(ROOT, "packages", "kit", "profiles", "lite.json"));
  assert.ok(profile.include.includes("custom-footer"));
  for (const theme of ["gitops-dark.json", "iso-dark.json", "high-contrast-dark.json", "colourblind-dark.json", "ansi-dark.json", "tty-dark.json"]) {
    assert.ok(fs.existsSync(path.join(ROOT, "packages", "kit", "themes", theme)), `package ships ${theme}`);
  }
}

async function smokeSessionHelpersLeanCtx(): Promise<void> {
  // Sprint 1.1 DoD: a missing lean-ctx binary produces exactly one warning, not a crash.
  const restoreExpected = setEnv("PI_KIT_LEAN_CTX", "1"); // force "expected"
  const restoreBin = setEnv("PI_LEAN_CTX_BIN", "/nonexistent/lean-ctx-binary");
  try {
    const register = await loadExtension("extensions/session-helpers/index.ts");
    const pi = fakePi();
    register(pi.api);
    const notes: LeanNote[] = [];
    const ctx = { hasUI: true, ui: { notify: (m: string, l: string) => notes.push({ m, l }) } };
    // Must not throw.
    await pi.handlers.get("session_start")({}, ctx);
    const leanNotes = notes.filter(n => /lean-ctx/i.test(n.m));
    assert.equal(leanNotes.length, 1, "exactly one lean-ctx warning expected");
    assert.match(leanNotes[0]?.m ?? "", /not found on PATH/);

    // When explicitly disabled, no warning fires.
    process.env.PI_KIT_LEAN_CTX = "0";
    const pi2 = fakePi();
    register(pi2.api);
    const notes2: LeanNote[] = [];
    await pi2.handlers.get("session_start")({}, { hasUI: true, ui: { notify: (m: string, l: string) => notes2.push({ m, l }) } });
    assert.equal(notes2.filter(n => /lean-ctx/i.test(n.m)).length, 0, "no warning when PI_KIT_LEAN_CTX=0");
  } finally {
    restoreBin();
    restoreExpected();
  }
}

await smokeFirewall();
smokeProfiles();
await smokeBranchLab();
await smokeCustomFooter();
smokeLiteSurface();
await smokeSessionHelpersLeanCtx();
console.log("[smoke:epic1] OK");
