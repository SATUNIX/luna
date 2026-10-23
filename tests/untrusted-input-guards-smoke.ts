#!/usr/bin/env node
/**
 * Malformed untrusted input in the security extensions and session-helpers is checked, not cast.
 *
 * Tool-call arguments (model input), parsed JSON files and in-process test hooks used to be cast
 * to the shape the code expected. A wrong-typed value then either threw inside a tool_call hook
 * (pi blocks the call, but with an opaque handler error) or flowed on with the wrong type. These
 * cases pin the guarded behaviour: a clear refusal for a malformed path or command, and wrong-typed
 * file fields ignored. Fully offline, with a temp HOME and PI_CODING_AGENT_DIR.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fakePi, isolateKitEnv, loadExtension, loadModule, rmWorkspace, setEnv, tmpWorkspace } from "../packages/core/eval/harness.ts";
import type * as SessionHelpers from "../packages/extensions/src/session-helpers/index.ts";
import type * as SecurityGuard from "../packages/extensions/src/session-helpers/security-guard.ts";
import type * as Classify from "../packages/extensions/src/tool-firewall/classify.ts";
import type * as Trajectory from "../packages/extensions/src/tool-firewall/trajectory.ts";

const restoreIsolation = isolateKitEnv();
const ws = tmpWorkspace("pi-kit-untrusted-guards-");
const agentDir = path.join(ws, "agent");
fs.mkdirSync(path.join(agentDir, "pi-kit"), { recursive: true });
const restores = [
  setEnv("HOME", path.join(ws, "home")),
  setEnv("PI_CODING_AGENT_DIR", agentDir),
  setEnv("PI_KIT_FIREWALL_SESSIONS_DIR", path.join(ws, "sessions")),
  setEnv("PI_KIT_FIREWALL_PROFILE", "pentest"),
];
const ctx = { hasUI: false, ui: { notify() {} }, cwd: ws };

async function toolCallHook(file: string) {
  const register = await loadExtension(file);
  const pi = fakePi();
  register(pi.api);
  return (toolName: string, input: Record<string, unknown>) => pi.handlers.get("tool_call")({ toolName, input }, ctx);
}

async function testProtectedPaths() {
  const call = await toolCallHook("vendor/protected-paths/index.ts");
  for (const [tool, input, field] of [
    ["write", { path: 42 }, "path"],
    ["edit", { path: { nested: "a" } }, "path"],
    ["bash", { command: ["echo", "x"] }, "command"],
    ["bash", { cmd: 7 }, "cmd"],
  ] satisfies Array<[string, Record<string, unknown>, string]>) {
    const result = await call(tool, input);
    assert.equal(result?.block, true, `protected-paths: a non-string ${field} for ${tool} must be blocked`);
    assert.match(result?.reason ?? "", new RegExp(`protected-paths: blocked ${tool}: ${field} is not a string`), `protected-paths: the refusal names the malformed ${field}`);
  }
  // Positive controls: well-formed and absent fields behave as before.
  assert.equal(await call("write", { path: "notes.md" }), undefined, "protected-paths: a plain write stays allowed");
  assert.equal(await call("write", {}), undefined, "protected-paths: a write without a path is not judged here");
  assert.equal(await call("bash", { command: "ls" }), undefined, "protected-paths: a harmless command stays allowed");
}

async function testSecretGuard() {
  const call = await toolCallHook("packages/extensions/src/secret-guard/index.ts");
  for (const [tool, input, field] of [
    ["read", { path: 42 }, "path"],
    ["write", { file: { nested: "a" }, content: "x" }, "file"],
    ["bash", { command: ["cat", "x"] }, "command"],
    ["bash", { script: 7 }, "script"],
  ] satisfies Array<[string, Record<string, unknown>, string]>) {
    const result = await call(tool, input);
    assert.equal(result?.block, true, `secret-guard: a non-string ${field} for ${tool} must be blocked`);
    assert.match(result?.reason ?? "", new RegExp(`secret-guard: blocked ${tool}: ${field} is not a string`), `secret-guard: the refusal names the malformed ${field}`);
  }
  // A malformed edits element is skipped; the valid one is still scanned.
  const key = "AKIA" + "ABCDEFGHIJKLMNOP";
  const edit = await call("edit", { path: "a.txt", edits: [null, 5, "x", { newText: `id = ${key}` }] });
  assert.equal(edit?.block, true, "secret-guard: a secret in a valid edits element is still blocked");
  assert.equal(await call("read", { path: "notes.md" }), undefined, "secret-guard: a plain read stays allowed");
  assert.equal(await call("bash", { command: "ls" }), undefined, "secret-guard: a harmless command stays allowed");
}

async function testTrajectory() {
  const trajectory = await loadModule<typeof Trajectory>("extensions/tool-firewall/trajectory.ts");
  const dir = path.join(ws, "sessions");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "bad.json"), JSON.stringify({
    stats: { actions: "x", human: 3, judged: null },
    credentialReads: [{ what: "~/.aws/credentials", at: 1 }, { what: 1, at: "now" }],
    judgeCache: { good: { verdict: "allow", reason: "ok", turn: "t" }, bad: { verdict: "maybe", reason: 1, turn: "t" } },
  }));
  const s = trajectory.loadSession("bad");
  assert.equal(s.stats.actions, 0, "trajectory: a non-number stats field falls back to 0");
  assert.equal(s.stats.judged, 0, "trajectory: a null stats field falls back to 0");
  assert.equal(s.stats.human, 3, "trajectory: a numeric stats field is kept");
  assert.deepEqual(s.credentialReads, [{ what: "~/.aws/credentials", at: 1 }], "trajectory: a wrong-shape credentialReads row is dropped, the valid rows kept");
  assert.deepEqual(s.judgeCache, { good: { verdict: "allow", reason: "ok", turn: "t" } }, "trajectory: a wrong-shape judgeCache entry is dropped, a valid one kept");

  // One malformed credentialReads row must not erase the valid ones: the secret_egress finding
  // for a later network send depends on them.
  const at = Date.now();
  fs.writeFileSync(path.join(dir, "mixed.json"), JSON.stringify({ credentialReads: [{ what: "~/.aws/credentials", at }, { what: "x" }] }));
  const mixed = trajectory.loadSession("mixed");
  assert.deepEqual(mixed.credentialReads, [{ what: "~/.aws/credentials", at }], "trajectory: the valid credentialReads row is kept beside a malformed one");
  const send: Classify.Assessment = {
    tool: "bash", tier: "low", findings: [], effects: [], segments: [], summary: "",
    credentialReads: [], downloads: [], executes: [], chmodExec: [], sends: [{ dest: "example.com", local: false }], hosts: [], remotes: [], remoteChanges: 0, deletes: 0, untrusted: false,
  };
  const codes = trajectory.trajectoryFindings(send, mixed).map((f) => f.code);
  assert.ok(codes.includes("secret_egress"), "trajectory: a network send after the kept credential read still raises secret_egress");
}

async function testSessionHelpers() {
  const helpers = await loadModule<typeof SessionHelpers>("extensions/session-helpers/index.ts");
  const settings = path.join(agentDir, "settings.json");
  fs.writeFileSync(settings, "[1]");
  assert.throws(() => helpers.setGlobalCompactionEnabled(false), /not valid JSON; not changed/, "session-helpers: an array settings.json is refused, not silently left unchanged");
  assert.equal(fs.readFileSync(settings, "utf8"), "[1]", "session-helpers: the refused settings.json is untouched");
  fs.writeFileSync(settings, JSON.stringify({ theme: "dark" }));
  helpers.setGlobalCompactionEnabled(false);
  assert.deepEqual(JSON.parse(fs.readFileSync(settings, "utf8")), { theme: "dark", compaction: { enabled: false } }, "session-helpers: an object settings.json is updated");

  const trigger = path.join(agentDir, "pi-kit", "trigger-compact.json");
  fs.writeFileSync(trigger, "[1]");
  helpers.setKitTriggerEnabled(false);
  assert.deepEqual(JSON.parse(fs.readFileSync(trigger, "utf8")), { enabled: false }, "session-helpers: an array trigger-compact.json is replaced, so turning the trigger off takes effect");

  // A wrong-typed kitSource in the install marker is ignored rather than passed on as a path.
  fs.writeFileSync(path.join(agentDir, ".pi-kit.json"), JSON.stringify({ kitSource: 42 }));
  const cwd = process.cwd();
  process.chdir(ws);
  try {
    assert.doesNotThrow(() => helpers.findKitRoot(), "session-helpers: a non-string kitSource must not throw");
  } finally {
    process.chdir(cwd);
  }

  assert.deepEqual(helpers.firewallExpectation({ firewall: { policy: "pentest", mode: "auto" } }), { policy: "pentest", mode: "auto" }, "session-helpers: a valid firewall block is read");
  assert.equal(helpers.firewallExpectation({ firewall: [] }), null, "session-helpers: an array firewall block is refused");

  const guard = await loadModule<typeof SecurityGuard>("extensions/session-helpers/security-guard.ts");
  const security = path.join(ws, "security.json");
  fs.writeFileSync(security, JSON.stringify({ source: "operator", level: "strict" }));
  assert.equal(guard.securityLowering(security, "balanced", "relaxed"), null, "security-guard: an operator-chosen level is never lowered by a switch");
  fs.writeFileSync(security, JSON.stringify(["operator"]));
  assert.deepEqual(guard.securityLowering(security, "balanced", "relaxed"), { from: "balanced", to: "relaxed" }, "security-guard: a wrong-shape file counts as the profile default");
}

try {
  await testProtectedPaths();
  await testSecretGuard();
  await testTrajectory();
  await testSessionHelpers();
  console.log("untrusted-input-guards smoke: ok");
} finally {
  for (const restore of restores.reverse()) restore();
  restoreIsolation();
  rmWorkspace(ws);
}
