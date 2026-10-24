#!/usr/bin/env node
// Policy authority: invalid files/rules deny all, content revisions and pending answers.
// Offline; no provider or operator state.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadExtension, fakePi, setEnv, isolateKitEnv } from "../packages/core/eval/harness.ts";

type Note = [message: string, level: string | undefined];

async function fixture(policy: unknown) {
  const restoreIsolation = isolateKitEnv();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-fw-policy-"));
  const policyFile = path.join(workspace, "policy.json");
  fs.writeFileSync(policyFile, JSON.stringify(policy));
  // Integral timestamps make the same-mtime regression exact, including sub-ms filesystems.
  const stamp = new Date("2025-01-01T00:00:00.000Z");
  fs.utimesSync(policyFile, stamp, stamp);
  const restores = [
    setEnv("HOME", path.join(workspace, "home")),
    setEnv("PI_CODING_AGENT_DIR", path.join(workspace, "agent")),
    setEnv("PI_KIT_FIREWALL_POLICY", policyFile),
    setEnv("PI_KIT_FIREWALL_AUDIT_LOG", path.join(workspace, "audit.jsonl")),
    setEnv("PI_KIT_AUTO_MODE", "0"),
    setEnv("PI_KIT_HUMAN_CONSOLE_DIR", path.join(workspace, "console")),
    setEnv("PI_KIT_HUMAN_CONSOLE_TIMEOUT_MS", "2000"),
  ];
  const notes: Note[] = [];
  const ctx = { cwd: workspace, hasUI: true, ui: { notify: (message: string, level?: string) => notes.push([message, level]), confirm: async () => true } };
  const register = await loadExtension("extensions/tool-firewall/index.ts");
  const pi = fakePi();
  register(pi.api);
  await pi.handlers.get("session_start")({}, ctx);
  return {
    pi, ctx, notes, workspace, policyFile,
    call: (toolName: string, input: Record<string, unknown>) => pi.handlers.get("tool_call")({ toolName, input }, ctx),
    cleanup: () => { restores.reverse().forEach((r) => r()); restoreIsolation(); fs.rmSync(workspace, { recursive: true, force: true }); },
  };
}

const base = { defaults: { unknown: "allow" }, tools: { bash: { decision: "allow" }, read: { decision: "allow" } } };

async function invalidPoliciesDenyAll(): Promise<void> {
  for (const bad of [
    null, [], "policy",
    { ...base, defaults: { unknown: "alow" } },
    { ...base, defaults: [] },
    { ...base, tools: [] },
    { ...base, tools: { read: { decision: "dney" } } },
    { ...base, tools: { read: null } },
    { ...base, tools: { read: { decision: "allow", risk_class: 1 } } },
    { ...base, command_rules: [] },
    { ...base, command_rules: { deny: "echo" } },
    { ...base, command_rules: { deny: [null] } },
    { ...base, command_rules: { deny: [{ pattern: 123 }] } },
    { ...base, command_rules: { deny: [{ pattern: "(unterminated[" }] } },
    { ...base, command_rules: { deny: [{ pattern: "echo", flags: 3 }] } },
    { ...base, command_rules: { deni: [{ pattern: "echo" }] } },
    { ...base, policies: { pentest: { command_rules: { ask: [{ pattern: "[" }] } } } },
  ]) {
    const f = await fixture(bad);
    try {
      assert.ok(f.notes.some(([m, lvl]) => lvl === "warning" && /fail-closed \(deny all\)/.test(m)), "invalid policy warns visibly");
      for (const [toolName, input] of [["bash", { command: "echo harmless" }], ["read", { path: "src/a.ts" }], ["opaque", {}]] satisfies Array<[string, Record<string, unknown>]>) {
        const result = await f.call(toolName, input);
        assert.equal(result?.block, true, "broken restriction must not disappear, even for builtins or explicit allow");
        assert.match(result?.reason ?? "", /HARD DENY/);
        assert.match(result?.reason ?? "", /policy is invalid/, "the denial says the policy is broken, not that a pi tool is unknown");
      }
    } finally { f.cleanup(); }
  }
}

// The warning says what to repair: the exact rule, field or key, not only that the policy failed.
async function warningsNameTheBrokenItem(): Promise<void> {
  for (const [bad, where] of [
    [{ ...base, command_rules: { deny: [{ pattern: "echo" }, { pattern: 123 }] } }, /command_rules\.deny\[1\] has no string "pattern"/],
    [{ ...base, command_rules: { ask: [{ pattern: "(unterminated[" }] } }, /command_rules\.ask\[0\] pattern is invalid regex/],
    [{ ...base, command_rules: { deni: [{ pattern: "echo" }] } }, /command_rules\.deni is unrecognised/],
    [{ ...base, tools: { read: { decision: "dney" } } }, /tools\.read has an invalid decision/],
  ] satisfies Array<[unknown, RegExp]>) {
    const f = await fixture(bad);
    try {
      assert.ok(f.notes.some(([m, lvl]) => lvl === "warning" && where.test(m)), `the warning names the broken item (${String(where)})`);
    } finally { f.cleanup(); }
  }
}

async function statefulFlagsKeepDenying(): Promise<void> {
  const f = await fixture({ ...base, command_rules: { deny: [{ pattern: "\\becho\\b", flags: "gy", reason: "no echo" }] } });
  try {
    assert.ok(f.notes.some(([m, lvl]) => lvl === "warning" && /adjusted but still enforced/.test(m)));
    for (let i = 0; i < 2; i++) {
      const result = await f.call("bash", { command: "echo hello" });
      assert.equal(result?.block, true);
      assert.match(result?.reason ?? "", /policy rule: no echo/);
    }
    assert.equal(await f.call("bash", { command: "pwd" }), undefined, "sanitised valid rules do not deny everything");
  } finally { f.cleanup(); }
}

async function nonStatefulFlagsKeepWorking(): Promise<void> {
  const f = await fixture({ ...base, command_rules: { deny: [{ pattern: "hello", flags: "i", reason: "no hello" }] } });
  try {
    assert.ok(!f.notes.some(([, level]) => level === "warning"));
    assert.equal((await f.call("bash", { command: "echo HELLO" }))?.block, true);
    assert.equal(await f.call("bash", { command: "echo world" }), undefined);
  } finally { f.cleanup(); }
}

async function contentRevisionsAndRepair(): Promise<void> {
  const f = await fixture(base);
  try {
    assert.equal(await f.call("bash", { command: "pwd" }), undefined);
    const stat = fs.statSync(f.policyFile);
    fs.writeFileSync(f.policyFile, JSON.stringify({ ...base, tools: { bash: { decision: "deny" } } }));
    fs.utimesSync(f.policyFile, stat.atime, stat.mtime);
    assert.equal(fs.statSync(f.policyFile).mtimeMs, stat.mtimeMs, "revision preserves the exact cached mtime");
    assert.equal((await f.call("bash", { command: "pwd" }))?.block, true, "same-mtime deny revision is effective");
    for (const text of ["{bad JSON", JSON.stringify({ ...base, tools: { bash: { decision: "dney" } } })]) {
      fs.writeFileSync(f.policyFile, text);
      fs.utimesSync(f.policyFile, stat.atime, stat.mtime);
      assert.equal((await f.call("read", { path: "src/a.ts" }))?.block, true);
      assert.ok(f.notes.some(([m, lvl]) => lvl === "warning" && /invalid policy/.test(m)), "hot reload warns without session_start");
    }
    fs.writeFileSync(f.policyFile, "{different bad JSON");
    const throwingUi = await f.pi.handlers.get("tool_call")({ toolName: "read", input: { path: "src/a.ts" } }, { ...f.ctx, ui: { ...f.ctx.ui, notify: () => { throw new Error("UI unavailable"); } } });
    assert.equal(throwingUi?.block, true, "diagnostic UI failures cannot weaken enforcement");
    fs.unlinkSync(f.policyFile);
    assert.equal((await f.call("read", { path: "src/a.ts" }))?.block, true, "missing configured file cannot fall back to a weaker policy");
    fs.mkdirSync(f.policyFile);
    assert.equal((await f.call("read", { path: "src/a.ts" }))?.block, true, "unreadable file denies");
    fs.rmdirSync(f.policyFile);
    fs.writeFileSync(f.policyFile, JSON.stringify(base));
    fs.utimesSync(f.policyFile, stat.atime, stat.mtime);
    assert.equal(await f.call("bash", { command: "pwd" }), undefined, "content repair restores normal decisions");
  } finally { f.cleanup(); }
}

async function exactOwnPolicyNames(): Promise<void> {
  const f = await fixture(JSON.parse('{"defaults":{"unknown":"ask"},"tools":{"__proto__":{"decision":"deny"},"constructor":{"decision":"deny"},"trusted":{"decision":"allow","risk_class":"read_only"}}}'));
  try {
    for (const name of ["__proto__", "constructor"]) assert.match((await f.call(name, {}))?.reason ?? "", /HARD DENY/);
    assert.equal(await f.call("trusted", {}), undefined);
    // A differently-cased name still needs a human; explicit approval is supported.
    let prompts = 0;
    await f.pi.handlers.get("tool_call")({ toolName: "Trusted", input: {} }, { ...f.ctx, ui: { ...f.ctx.ui, confirm: async () => { prompts++; return false; } } });
    assert.equal(prompts, 1);
  } finally { f.cleanup(); }
}

async function pendingBrokerRechecksPolicy(): Promise<void> {
  const f = await fixture({ ...base, tools: { pending: { decision: "ask" } } });
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const pending = f.pi.handlers.get("tool_call")({ toolName: "pending", input: {} }, { ...f.ctx, hasUI: false, ui: {} });
    const dir = path.join(f.workspace, "console", "pending");
    let requestFile: string | undefined;
    for (let i = 0; i < 100 && !requestFile; i++) {
      await new Promise((r) => setTimeout(r, 5));
      requestFile = fs.existsSync(dir) ? fs.readdirSync(dir).find((n) => n.endsWith(".json")) : undefined;
    }
    assert.ok(requestFile, "broker request is pending");
    const id = requestFile.replace(/\.json$/, "");
    fs.writeFileSync(f.policyFile, JSON.stringify({ ...base, tools: { pending: { decision: "deny" } } }));
    const resolved = path.join(f.workspace, "console", "resolved");
    fs.mkdirSync(resolved, { recursive: true });
    fs.writeFileSync(path.join(resolved, requestFile), JSON.stringify({ id, approved: true, answer: "Allow for this session" }));
    const result = await pending;
    assert.equal(result?.block, true);
    assert.match(result?.reason ?? "", /HARD DENY/);
    assert.equal(fs.existsSync(path.join(f.workspace, "agent", "pi-kit", "firewall-approvals.json")), false, "stale broker answer cannot store a grant");
  } finally { clearInterval(keepAlive); f.cleanup(); }
}

async function pendingJudgeRechecksPolicy(): Promise<void> {
  const f = await fixture(base);
  const restoreAuto = setEnv("PI_KIT_AUTO_MODE", "1");
  try {
    const register = await loadExtension("extensions/tool-firewall/index.ts");
    const pi = fakePi();
    let judged = 0;
    register(pi.api, { complete: async () => {
      judged++;
      fs.writeFileSync(f.policyFile, JSON.stringify({ ...base, tools: { bash: { decision: "deny" } } }));
      return '{"verdict":"allow","reason":"allowed under the old policy"}';
    } });
    await pi.handlers.get("session_start")({}, f.ctx);
    const result = await pi.handlers.get("tool_call")({ toolName: "bash", input: { command: "npm install lodash" } }, f.ctx);
    assert.equal(judged, 1);
    assert.equal(result?.block, true);
    assert.match(result?.reason ?? "", /HARD DENY/);
  } finally { restoreAuto(); f.cleanup(); }
}

const tests: Array<[string, () => Promise<void>]> = [
  ["invalid files/rules warn and deny all calls", invalidPoliciesDenyAll],
  ["each warning names the rule, field or key to repair", warningsNameTheBrokenItem],
  ["stateful g/y flags are dropped and deny rules keep firing", statefulFlagsKeepDenying],
  ["non-stateful flags keep working without warnings", nonStatefulFlagsKeepWorking],
  ["content revisions survive same mtime; invalid/missing files deny; repair recovers", contentRevisionsAndRepair],
  ["policy identities are exact, case-sensitive own properties", exactOwnPolicyNames],
  ["pending judge approval rechecks the policy", pendingJudgeRechecksPolicy],
  ["pending broker approval rechecks the policy before storing a grant or allowing", pendingBrokerRechecksPolicy],
];
for (const [name, test] of tests) { await test(); console.log(`  OK: ${name}`); }
console.log(`[firewall-policy-warnings-smoke] all ${tests.length} checks passed`);
