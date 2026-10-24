#!/usr/bin/env node
/**
 * F-02 regression coverage: pentest-governance-domain's MCP-only mode must not block
 * this kit's own first-party tools, and must not lock down general coding profiles
 * (balanced/long-horizon/autonomous/self-improving) by default absent a configured
 * pentest engagement. Fully offline - no live pi, no network.
 */
import type { ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadExtension, fakePi } from "../packages/core/eval/harness.ts";

function withCwd<T>(cwd: string, fn: () => T | Promise<T>): Promise<T> {
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

function writeCompleteEngagement(workspace: string): void {
  const dir = path.join(workspace, "engagement");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "scope.yaml"),
    "allowed_assets:\n  web:\n    hosts:\n      - example.test\n    url_prefixes:\n      - https://example.test/\n    methods:\n      - GET\n",
  );
  fs.writeFileSync(
    path.join(dir, "roe.yaml"),
    "timezone: UTC\nalways_denied: []\ntesting_windows:\n  - days: [Mon, Tue, Wed, Thu, Fri, Sat, Sun]\n    start: \"00:00\"\n    end: \"23:59\"\n",
  );
}

type FakePi = ReturnType<typeof fakePi>;
/** The governance gate's tool_call decision: a block always carries its reason. */
type Decision = ToolCallEventResult & { reason: string };

async function loadGovernance(_workspace: string): Promise<FakePi> {
  const register = await loadExtension("extensions/pentest-governance-domain/index.ts");
  const pi = fakePi();
  register(pi.api);
  await pi.handlers.get("session_start")({}, { ui: { notify() {} } });
  return pi;
}

async function callTool(pi: FakePi, toolName: string, input: Record<string, unknown> = {}): Promise<Decision | undefined> {
  return (await pi.handlers.get("tool_call")({ toolName, input }, { hasUI: false, ui: {} })) as Decision | undefined;
}

// 1. No engagement configured: write/edit/bash must NOT be blocked by MCP-only mode
// by default - this is what broke "balanced" (an everyday driver, not pentest-only).
async function testNoEngagementAllowsDirectTools() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-gov-noeng-"));
  await withCwd(workspace, async () => {
    const pi = await loadGovernance(workspace);
    const result = await callTool(pi, "write", { path: "notes.md", content: "x" });
    assert.equal(result, undefined, "write must be allowed with no engagement configured");
    const bashResult = await callTool(pi, "bash", { command: "echo hi" });
    assert.equal(bashResult, undefined, "bash must be allowed with no engagement configured");
  });
}

// 2. First-party kit tools (including plain `todo`) must never be blocked by MCP-only
// mode, engagement or not - this is F-02's exact repro (`todo` blocked by default).
async function testFirstPartyToolsAlwaysExempt() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-gov-firstparty-"));
  writeCompleteEngagement(workspace);
  await withCwd(workspace, async () => {
    const pi = await loadGovernance(workspace);
    for (const toolName of ["todo", "subagent", "task_create", "record_verdict", "memory_store"]) {
      const result = await callTool(pi, toolName, { text: "x" });
      assert.equal(result, undefined, `${toolName} must be exempt from MCP-only mode`);
    }
  });
}

// 3. A real, complete engagement configured: MCP-only activates by default and blocks
// direct write/edit/bash - the actual security posture this extension exists for.
async function testConfiguredEngagementLocksDownDirectTools() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-gov-eng-"));
  writeCompleteEngagement(workspace);
  await withCwd(workspace, async () => {
    const pi = await loadGovernance(workspace);
    const result = await callTool(pi, "write", { path: "notes.md", content: "x" });
    assert.equal(result?.block, true, "write must be blocked once a real engagement is configured");
    assert.match(result.reason, /MCP-only/);
  });
}

// 4. PI_ALLOW_DIRECT_TOOLS is an explicit override in both directions.
async function testOperatorOverrideBothDirections() {
  const noEngagement = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-gov-ov1-"));
  const withEngagement = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-gov-ov2-"));
  writeCompleteEngagement(withEngagement);

  let restore = setEnv("PI_ALLOW_DIRECT_TOOLS", "0");
  try {
    await withCwd(noEngagement, async () => {
      const pi = await loadGovernance(noEngagement);
      const result = await callTool(pi, "bash", { command: "echo hi" });
      assert.equal(result?.block, true, "PI_ALLOW_DIRECT_TOOLS=0 must force lockdown even without an engagement");
    });
  } finally {
    restore();
  }

  restore = setEnv("PI_ALLOW_DIRECT_TOOLS", "1");
  try {
    await withCwd(withEngagement, async () => {
      const pi = await loadGovernance(withEngagement);
      const result = await callTool(pi, "bash", { command: "echo hi" });
      assert.equal(result, undefined, "PI_ALLOW_DIRECT_TOOLS=1 must force-allow even mid-engagement");
    });
  } finally {
    restore();
  }
}

// Scope/ROE is deterministic and must reject an out-of-scope target before the
// broker is even created, regardless of any hypothetical approval response.
async function testOutOfScopeNeverReachesBroker() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-gov-scope-"));
  writeCompleteEngagement(workspace);
  const consoleDir = path.join(workspace, "console");
  const restoreConsole = setEnv("PI_KIT_HUMAN_CONSOLE_DIR", consoleDir);
  try {
    await withCwd(workspace, async () => {
      const pi = await loadGovernance(workspace);
      const result = await callTool(pi, "mcp", { tool: "remote_request", url: "https://outside.example/" });
      assert.equal(result?.block, true, "out-of-scope target must block");
      assert.match(result.reason, /Scope\/ROE/);
      assert.match(result.reason, /target_out_of_scope/, "out-of-scope target must be rejected for scope, not the testing window");
      assert.doesNotMatch(result.reason, /outside_testing_window/);
      assert.equal(fs.existsSync(path.join(consoleDir, "pending")), false, "out-of-scope action must never reach the broker");
    });
  } finally { restoreConsole(); }
}

// 6. Checked-in env templates are not protected paths. The installer scaffolds
// `.env.example`, so both the write path and shell commands naming it must stay allowed —
// while the real `.env` and any copy onto it remain blocked.
async function testEnvTemplatesAreNotProtectedPaths() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-gov-envtemplate-"));
  writeCompleteEngagement(workspace);
  await withCwd(workspace, async () => {
    const allowed = setEnv("PI_ALLOW_DIRECT_TOOLS", "1");
    try {
      const pi = await loadGovernance(workspace);
      assert.equal(await callTool(pi, "write", { path: ".env.example", content: "X=\n" }), undefined, ".env.example must be writable");
      assert.equal(await callTool(pi, "write", { path: ".env.sample", content: "X=\n" }), undefined, ".env.sample must be writable");
      assert.equal((await callTool(pi, "write", { path: ".env", content: "X=1" }))?.block, true, "the real .env must stay blocked");
      assert.equal((await callTool(pi, "write", { path: ".env.local", content: "X=1" }))?.block, true, ".env.local must stay blocked");
      assert.equal(await callTool(pi, "bash", { command: "cat .env.example" }), undefined, "reading a template must be allowed");
      assert.equal((await callTool(pi, "bash", { command: "cp .env.example .env" }))?.block, true, "copying a template onto .env must stay blocked");
      assert.equal((await callTool(pi, "bash", { command: "echo X=1 > .env" }))?.block, true, "writing the real .env must stay blocked");
    } finally {
      allowed();
    }
  });
}

// 7. B-032 regression: a corrupt audit chain must not strand the broker nor throw out
// of the broker poll. Pre-fix the resolved branch called audit() before finish(), so the
// audit throw was swallowed by the `catch { /* waiting */ }` (the approval was lost), and
// the deadline-branch audit ran outside any try, throwing uncaught and killing pi.
// This test corrupts the audit tail, delivers an approval, and asserts the call settles
// with no uncaughtException escaping the unref'd broker interval. The approved action is
// still BLOCKED: an action that cannot be recorded in the evidence chain never runs.
async function testBrokerResolvesWhenAuditFails() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-gov-broker-audit-"));
  writeCompleteEngagement(workspace);
  const consoleDir = path.join(workspace, "console");
  const dataRoot = path.join(workspace, "pentest-data");
  const auditFile = path.join(dataRoot, "audit", "audit.jsonl");
  const pendingDir = path.join(consoleDir, "pending");
  const restoreConsole = setEnv("PI_KIT_HUMAN_CONSOLE_DIR", consoleDir);
  const restoreDataRoot = setEnv("PENTEST_DATA_ROOT", dataRoot);
  // Short deadline so the pre-fix timeout-branch throw is reached promptly; the broker
  // poll interval is unref'd, so a keepalive is held while the call is outstanding.
  const restoreTimeout = setEnv("PI_KIT_HUMAN_CONSOLE_TIMEOUT_MS", "1500");
  const keepAlive = setInterval(() => {}, 1000);
  let originalAudit;
  let uncaught: unknown;
  const onUncaught = (error: Error) => { uncaught = error; };
  process.on("uncaughtException", onUncaught);
  try {
    await withCwd(workspace, async () => {
      const pi = await loadGovernance(workspace);
      const call = callTool(pi, "mcp", { tool: "remote_request", url: "https://example.test/" });
      let id;
      for (let i = 0; i < 200 && !id; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        if (fs.existsSync(pendingDir) && fs.readdirSync(pendingDir).length) id = fs.readdirSync(pendingDir)[0]?.replace(/\.json$/, "");
      }
      assert.ok(id, "in-scope action must reach the human-console broker");
      assert.ok(fs.existsSync(auditFile), "the broker must have audited before the corruption");
      originalAudit = fs.readFileSync(auditFile);
      // Corrupt the chain tail: every subsequent audit()/appendChainedJsonl() throws.
      fs.appendFileSync(auditFile, "CORRUPT-NOT-JSON\n");
      fs.mkdirSync(path.join(consoleDir, "resolved"), { recursive: true });
      fs.writeFileSync(path.join(consoleDir, "resolved", `${id}.json`), JSON.stringify({ id, approved: true }));

      const result = await Promise.race([
        call,
        new Promise<"__pending__">((resolve) => setTimeout(() => resolve("__pending__"), 4000)),
      ]);
      assert.notEqual(result, "__pending__", "a resolved approval must settle despite a failing audit");
      assert.equal(result === "__pending__" ? undefined : result?.block, true, "an approved action that cannot be audited must be BLOCKED (fail closed)");
      assert.equal(uncaught, undefined, "a failing audit must not throw out of the broker interval");
      assert.ok(!fs.existsSync(path.join(pendingDir, `${id}.json`)), "settled broker request must remove its pending file");
      assert.ok(!fs.existsSync(path.join(consoleDir, "resolved", `${id}.json`)), "settled broker request must remove its resolved file");
    });
  } finally {
    // Heal the chain so a pre-fix lingering broker interval (finish() never ran) can
    // settle on its next tick and stop throwing during the remaining tests.
    if (originalAudit !== undefined) { try { fs.writeFileSync(auditFile, originalAudit); } catch { /* best effort */ } }
    process.removeListener("uncaughtException", onUncaught);
    clearInterval(keepAlive);
    restoreTimeout();
    restoreDataRoot();
    restoreConsole();
  }
}

// 8. F3 regression: `tool-policy.json` containing the JSON literal `null` is not a
// valid policy object. Pre-fix loadPolicy returned it verbatim, so metadataFor did
// `policy.tools` on null and the tool_call handler threw a TypeError. It must instead
// fall back to the default empty policy (no metadata -> default classification).
async function testNullPolicyFallsBackToEmptyPolicy() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-gov-nullpolicy-"));
  const dir = path.join(workspace, "engagement");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "tool-policy.json"), "null");
  await withCwd(workspace, async () => {
    const pi = await loadGovernance(workspace);
    const result = await callTool(pi, "write", { path: "notes.md", content: "x" });
    assert.equal(result, undefined, "a null policy must behave as the default empty policy");
    assert.equal(await callTool(pi, "read", { path: "notes.md" }), undefined, "read-only tools must stay allowed under a null policy");
  });
}

// 9. Evidence integrity: with no engagement configured, a direct write is allowed and
// audited. Once the audit chain is corrupt it must be blocked instead of running
// unrecorded, while read-only built-ins stay available so the operator can inspect.
async function testUnauditableAllowFailsClosed() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-gov-audit-closed-"));
  const dataRoot = path.join(workspace, "pentest-data");
  const auditFile = path.join(dataRoot, "audit", "audit.jsonl");
  const restoreDataRoot = setEnv("PENTEST_DATA_ROOT", dataRoot);
  try {
    await withCwd(workspace, async () => {
      const pi = await loadGovernance(workspace);
      assert.equal(await callTool(pi, "write", { path: "notes.md", content: "x" }), undefined, "an auditable write must be allowed");
      assert.ok(fs.existsSync(auditFile), "the allowed write must have been audited");
      const healthy = fs.readFileSync(auditFile);
      // Invalid JSON, and valid JSON that is not a chained record: none may restart the chain at 0.
      for (const tail of ["CORRUPT-NOT-JSON", "null", "5", "\"x\"", "[]", "{}", "{\"sequence\":\"7\",\"record_hash\":\"h\"}"]) {
        fs.writeFileSync(auditFile, Buffer.concat([healthy, Buffer.from(`${tail}\n`)]));
        assert.equal((await callTool(pi, "write", { path: "notes.md", content: "y" }))?.block, true, `an unauditable write must be blocked (tail ${tail})`);
        assert.equal(await callTool(pi, "read", { path: "notes.md" }), undefined, "read-only tools must stay allowed");
      }
    });
  } finally {
    restoreDataRoot();
  }
}

const tests: Array<[string, () => Promise<void>]> = [
  ["no engagement configured allows direct tools by default", testNoEngagementAllowsDirectTools],
  ["first-party kit tools always exempt from MCP-only mode", testFirstPartyToolsAlwaysExempt],
  ["configured engagement locks down direct tools by default", testConfiguredEngagementLocksDownDirectTools],
  ["PI_ALLOW_DIRECT_TOOLS overrides in both directions", testOperatorOverrideBothDirections],
  ["out-of-scope target never reaches the broker", testOutOfScopeNeverReachesBroker],
  ["env templates are not protected paths", testEnvTemplatesAreNotProtectedPaths],
  ["broker settles, and blocks the action, when the audit chain is corrupt", testBrokerResolvesWhenAuditFails],
  ["an unauditable allow fails closed; read-only tools stay available", testUnauditableAllowFailsClosed],
  ["null tool-policy.json falls back to the default empty policy", testNullPolicyFallsBackToEmptyPolicy],
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

if (failed > 0) {
  console.error(`\n[governance-smoke] ${failed}/${tests.length} FAILED`);
  process.exit(1);
}
console.log(`\n[governance-smoke] all ${tests.length} checks passed`);
