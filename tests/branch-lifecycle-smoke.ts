#!/usr/bin/env node
/**
 * Branch-lab worktree lifecycle with production-shaped tool calls (create, list, switch, merge,
 * discard), and the one-warning behaviour when a configured lean-ctx binary is missing.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HandlerRegistry, Registry, loadExtension, textOf } from "../packages/core/eval/harness.ts";
import type { FakeCommand, FakeTool, RegisteredHandler } from "../packages/core/eval/harness.ts";
import { array, object, parseJson, parseJsonAs, string } from "../packages/core/lib/guard.ts";

const LeaseRecords = array(object({ worktreePath: string() }));

interface LeanNote {
  m: string;
  l: string;
}

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

await smokeBranchLab();
await smokeSessionHelpersLeanCtx();
console.log("[smoke:branch-lifecycle] OK");
