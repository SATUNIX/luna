#!/usr/bin/env node
/**
 * H-01 regression coverage: dream/print-mode write authorization must be a real path
 * boundary, not a substring match. Fully offline — no live pi, no network.
 */
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { loadExtension, fakePi, setEnv, tmpWorkspace, rmWorkspace } from "../packages/core/eval/harness.ts";

// Isolate from the operator's firewall.json; each test picks its policy explicitly.
const agentWs = tmpWorkspace("pi-kit-protected-paths-");
const globalRestores = [setEnv("PI_CODING_AGENT_DIR", path.join(agentWs, "agent")), setEnv("PI_KIT_FIREWALL_CONFIG", undefined), setEnv("PI_KIT_FIREWALL_PROFILE", "pentest")];

async function loadProtectedPaths() {
  const register = await loadExtension("vendor/protected-paths/index.ts");
  const pi = fakePi();
  register(pi.api);
  return pi;
}

const ctx = { hasUI: false, ui: { notify() {} }, cwd: process.cwd() };
type FakePi = ReturnType<typeof fakePi>;
const call = (pi: FakePi, toolName: string, input: Record<string, unknown>) => pi.handlers.get("tool_call")({ toolName, input }, ctx);

// H-01 independent-repro bypasses (all previously returned allow) under
// PI_KIT_WRITE_ALLOWLIST="AGENTS.md;.pi/memory;GOAL.yaml".
async function testAllowlistBypasses() {
  const restore = setEnv("PI_KIT_WRITE_ALLOWLIST", "AGENTS.md;.pi/memory;GOAL.yaml");
  try {
    const pi = await loadProtectedPaths();

    const legit = await call(pi, "write", { path: "AGENTS.md" });
    assert.equal(legit, undefined, "an actually-allowlisted file must still be allowed");

    const blocked = await call(pi, "write", { path: "src/app.ts" });
    assert.equal(blocked?.block, true, "a non-allowlisted file must still be blocked");

    const backdoor = await call(pi, "write", { path: "src/AGENTS.md.backdoor" });
    assert.equal(backdoor?.block, true, "AGENTS.md.backdoor must NOT satisfy the AGENTS.md allowlist entry");

    const escape = await call(pi, "write", { path: ".pi/memory-escape/file.txt" });
    assert.equal(escape?.block, true, ".pi/memory-escape must NOT satisfy the .pi/memory allowlist entry");

    const legitNested = await call(pi, "write", { path: ".pi/memory/notes.md" });
    assert.equal(legitNested, undefined, "a real file inside the allowlisted .pi/memory directory must still be allowed");

    const bashRedirect = await call(pi, "bash", { command: "echo pwned > src/app.ts" });
    assert.equal(bashRedirect?.block, true, "a bash redirect to a non-allowlisted path must be blocked");

    const bashAllowed = await call(pi, "bash", { command: "echo note >> .pi/memory/log.md" });
    assert.equal(bashAllowed, undefined, "a bash redirect to an allowlisted path must be allowed");

    // A bare filename entry names the workspace file, not any file with that basename.
    const outside = await call(pi, "write", { path: "../elsewhere/AGENTS.md" });
    assert.equal(outside?.block, true, "an outside-workspace AGENTS.md must NOT satisfy the AGENTS.md entry");
    const nested = await call(pi, "write", { path: "src/AGENTS.md" });
    assert.equal(nested?.block, true, "a nested AGENTS.md must NOT satisfy the root AGENTS.md entry");
  } finally {
    restore();
  }
}

// Denylist (always-on, no allowlist configured; pentest policy) must still block
// .env/.git//node_modules/ without regressing to substring-anywhere matching.
async function testDenylistStillWorksAndIsBounded() {
  const pi = await loadProtectedPaths();
  const envBlocked = await call(pi, "write", { path: "config/.env" });
  assert.equal(envBlocked?.block, true, ".env must be blocked");

  const gitBlocked = await call(pi, "write", { path: ".git/config" });
  assert.equal(gitBlocked?.block, true, ".git/ contents must be blocked");

  const bashToEnv = await call(pi, "bash", { command: "echo X=1 > .env" });
  assert.equal(bashToEnv?.block, true, "a bash redirect to .env must be blocked");

  const benign = await call(pi, "write", { path: "src/index.ts" });
  assert.equal(benign, undefined, "an ordinary source write must be allowed");

  // Checked-in env templates carry no secrets, so the installer can scaffold them. The
  // exemption is narrow: the real `.env` (above) and `.env.<other>` still match.
  assert.equal(await call(pi, "write", { path: "packages/core/.env.example" }), undefined, ".env.example must be writable");
  assert.equal(await call(pi, "write", { path: ".env.sample" }), undefined, ".env.sample must be writable");
  assert.equal((await call(pi, "write", { path: "config/.env.local" }))?.block, true, ".env.local must stay blocked");
  assert.equal(await call(pi, "bash", { command: "cat packages/core/.env.example" }), undefined, "reading a template must be allowed");
  assert.equal((await call(pi, "bash", { command: "cp .env.example .env" }))?.block, true, "copying a template onto the real .env must stay blocked");

  // Directory entries containing "/" (conductor passes ".pi/engagement/" to specialists)
  // must match regardless of path case on Windows and of lexical traversal.
  const restore = setEnv("PI_KIT_PROTECTED_PATHS", ".pi/engagement/;packages/core/policies/");
  try {
    const scoped = await loadProtectedPaths();
    assert.equal((await call(scoped, "write", { path: ".pi/engagement/scope.yaml" }))?.block, true, "slash directory entry must block");
    assert.equal((await call(scoped, "edit", { path: "src/../packages/core/policies/p.json" }))?.block, true, "traversal into slash directory entry must block");
    assert.equal(await call(scoped, "write", { path: "packages/core/policies-notes.md" }), undefined, "sibling with shared prefix stays writable");
  } finally {
    restore();
  }
}

// Agent-control and audit surfaces must be protected out of the box, and a custom
// PI_KIT_PROTECTED_PATHS must add to (never replace) the defaults.
async function testControlSurfaceDefaults() {
  const pi = await loadProtectedPaths();
  const blocked = [
    ".pi/auto-mode.json",
    ".pi/verdicts.json",
    ".pi/trace.jsonl",
    ".pi/tool-firewall-audit.jsonl",
    // EFF-6: the rotated copies are audit surfaces too.
    ".pi/trace.jsonl.1",
    ".pi/tool-firewall-audit.jsonl.1",
    ".pi/ctx-contributions/x.json",
    ".pi/GOAL.yaml",
    ".pi/agents/worker.md",
    "packages/core/policies/rule.json",
    "packages/extensions/src/tool-firewall/default-policy.json",
  ];
  for (const p of blocked) {
    assert.equal((await call(pi, "write", { path: p }))?.block, true, `${p} must be write-blocked`);
  }
  assert.equal((await call(pi, "bash", { command: "printf x > .pi/auto-mode.json" }))?.block, true, "bash redirect to auto-mode.json must be blocked");
  assert.equal((await call(pi, "bash", { command: "printf x > .pi/ctx-contributions/x.json" }))?.block, true, "bash redirect to ctx-contributions must be blocked");
  assert.equal((await call(pi, "bash", { command: "printf 'goal: x' > .pi/GOAL.yaml" }))?.block, true, "bash redirect to GOAL.yaml must be blocked");
  assert.equal((await call(pi, "bash", { command: "cp /tmp/x packages/core/policies/rule.json" }))?.block, true, "cp into policies must be blocked");

  const restore = setEnv("PI_KIT_PROTECTED_PATHS", "custom-thing");
  try {
    const scoped = await loadProtectedPaths();
    assert.equal((await call(scoped, "write", { path: "custom-thing/f.txt" }))?.block, true, "a custom env entry must still block");
    assert.equal((await call(scoped, "write", { path: "config/.env" }))?.block, true, "a custom env list must not drop .env protection");
    assert.equal((await call(scoped, "write", { path: ".git/config" }))?.block, true, "a custom env list must not drop .git protection");
    assert.equal((await call(scoped, "write", { path: ".pi/verdicts.json" }))?.block, true, "a custom env list must not drop control-surface protection");
  } finally {
    restore();
  }
}

// The coding policy keeps secrets and control surfaces but lets ordinary development touch
// .git/, node_modules/ and agent definitions; the policy can come from env or firewall.json.
async function testCodingPolicy() {
  const restore = setEnv("PI_KIT_FIREWALL_PROFILE", "coding");
  try {
    const pi = await loadProtectedPaths();
    for (const p of [".git/COMMIT_EDITMSG", "node_modules/x/index.js", ".pi/agents/worker.md", "src/.git/info/exclude"]) {
      assert.equal(await call(pi, "write", { path: p }), undefined, `${p} must be writable under coding`);
    }
    assert.equal(await call(pi, "bash", { command: "rm -rf node_modules && npm ci > node_modules/.log" }), undefined, "bash writes into node_modules are fine under coding");
    for (const p of ["config/.env", ".pi/auto-mode.json", ".pi/verdicts.json", "packages/core/policies/rule.json", "keys/id_ed25519", "keys/id_ed25519.pub", ".pi/human-console/pending/x.json"]) {
      assert.equal((await call(pi, "write", { path: p }))?.block, true, `${p} must stay blocked under coding`);
    }
    // The firewall's own state under the agent dir is protected in every policy.
    const fwDir = path.join(agentWs, "agent", "pi-kit");
    for (const p of [path.join(fwDir, "firewall.json"), path.join(fwDir, "firewall-feedback.jsonl"), path.join(fwDir, "firewall-sessions", "s.json"), path.join(fwDir, "trusted-workflows.json"), path.join(fwDir, "autonomy.json")]) {
      assert.equal((await call(pi, "write", { path: p }))?.block, true, `${p} must be blocked`);
      assert.equal((await call(pi, "bash", { command: `echo x >> ${p}` }))?.block, true, `bash append to ${p} must be blocked`);
    }
  } finally {
    restore();
  }
  // No env: firewall.json decides; missing or unreadable config means coding.
  const restoreEnv = setEnv("PI_KIT_FIREWALL_PROFILE", undefined);
  try {
    const pi = await loadProtectedPaths();
    assert.equal(await call(pi, "write", { path: ".git/COMMIT_EDITMSG" }), undefined, "no config defaults to coding");
    const cfg = path.join(agentWs, "agent", "pi-kit", "firewall.json");
    fs.mkdirSync(path.dirname(cfg), { recursive: true });
    fs.writeFileSync(cfg, JSON.stringify({ mode: "manual", policy: "pentest" }));
    assert.equal((await call(pi, "write", { path: ".git/COMMIT_EDITMSG" }))?.block, true, "firewall.json policy pentest must restore the strict list");
    fs.writeFileSync(cfg, "{not json");
    assert.equal(await call(pi, "write", { path: ".git/COMMIT_EDITMSG" }), undefined, "an unreadable config falls back to coding");
    fs.rmSync(cfg);
  } finally {
    restoreEnv();
  }
}

// PRO-2: the agent cannot write .pi/GOAL.yaml with a tool, but the operator's /goal command (goal-core writes the
// file itself, not through a tool call) still sets, shows and clears it.
async function testGoalOnlyViaCommand() {
  const ws = tmpWorkspace("pi-kit-protected-goal-");
  try {
    const guard = await loadProtectedPaths();
    const wsCtx = { hasUI: false, ui: { notify() {} }, cwd: ws };
    const viaTool = (toolName: string, input: Record<string, unknown>) => guard.handlers.get("tool_call")({ toolName, input }, wsCtx);
    assert.equal((await viaTool("write", { path: ".pi/GOAL.yaml", content: "goal: x\n" }))?.block, true, "a write tool call to .pi/GOAL.yaml must be blocked");
    assert.equal((await viaTool("edit", { path: path.join(ws, ".pi", "GOAL.yaml") }))?.block, true, "an absolute edit of .pi/GOAL.yaml must be blocked");

    const register = await loadExtension("extensions/goal-core/index.ts");
    const goalPi = fakePi();
    register(goalPi.api);
    const notes: string[] = [];
    const cmdCtx = { cwd: ws, sessionManager: { getSessionId: () => "goal-cmd" }, ui: { notify(msg: string) { notes.push(msg); } } };
    await goalPi.commands.get("goal").handler("Ship the health endpoint", cmdCtx);
    const goalFile = path.join(ws, ".pi", "GOAL.yaml");
    assert.match(fs.readFileSync(goalFile, "utf8"), /^goal: Ship the health endpoint$/m, "/goal must still write .pi/GOAL.yaml");
    await goalPi.commands.get("goal").handler("show", cmdCtx);
    assert.ok(notes.includes("goal: Ship the health endpoint"), "/goal show must read it back");
    await goalPi.commands.get("goal").handler("clear", cmdCtx);
    assert.equal(fs.existsSync(goalFile) && /^goal:/m.test(fs.readFileSync(goalFile, "utf8")), false, "/goal clear must clear it");
  } finally {
    rmWorkspace(ws);
  }
}

const tests: Array<[string, () => Promise<void>]> = [
  ["allowlist enforces real path boundaries, not substrings", testAllowlistBypasses],
  ["denylist still blocks protected paths (including via bash) without over-matching", testDenylistStillWorksAndIsBounded],
  ["control/audit surfaces are protected by default and env only augments", testControlSurfaceDefaults],
  ["coding policy frees .git/node_modules/agents but keeps secrets and control files", testCodingPolicy],
  ["only the /goal command writes .pi/GOAL.yaml", testGoalOnlyViaCommand],
];

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`  OK: ${name}`);
  } catch (error) {
    failed++;
    console.error(`  FAIL: ${name}`);
    console.error(`    ${error instanceof Error ? error.stack || error.message : String(error)}`);
  }
}

globalRestores.reverse().forEach((restore) => restore());
rmWorkspace(agentWs);

if (failed > 0) {
  console.error(`\n[protected-paths-smoke] ${failed}/${tests.length} FAILED`);
  process.exit(1);
}
console.log(`\n[protected-paths-smoke] all ${tests.length} checks passed`);
