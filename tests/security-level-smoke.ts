#!/usr/bin/env node
// Security ladder: hermetic resolution, real firewall decisions, pending approvals and controls.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fakePi, isolateKitEnv, loadExtension, loadModule, setEnv } from "../packages/core/eval/harness.ts";
import { loadProfileDef, parseProfile, profileSecurityLevel, writeSecurityConfig } from "../packages/core/lib/profiles.ts";
import type * as Security from "../packages/extensions/src/tool-firewall/security-level.ts";
import type * as Approvals from "../packages/extensions/src/tool-firewall/approvals.ts";
import type * as Trajectory from "../packages/extensions/src/tool-firewall/trajectory.ts";
import type * as ProfileSwitch from "../packages/extensions/src/session-helpers/profile-switch.ts";
import type * as FooterData from "../packages/extensions/third_party/custom-footer/data.ts";
import type * as FooterRender from "../packages/extensions/third_party/custom-footer/render.ts";
import type * as HubValues from "../packages/extensions/src/control-center/values.ts";
import type { SecurityLevel, SecuritySnapshot } from "../packages/extensions/src/tool-firewall/security-level.ts";

const restore = isolateKitEnv();
const root = fs.mkdtempSync(path.join(os.tmpdir(), "fw-security-level-"));
const agent = path.join(root, "agent");
const cwd = path.join(root, "workspace");
fs.mkdirSync(cwd);
const restores = [setEnv("HOME", path.join(root, "home")), setEnv("PI_CODING_AGENT_DIR", agent),
  setEnv("PI_KIT_FIREWALL_AUDIT_LOG", path.join(root, "audit.jsonl")), setEnv("PI_KIT_AUTO_MODE_STATE_DIR", path.join(root, "legacy"))];
const security = await loadModule<typeof Security>("extensions/tool-firewall/security-level.ts");
const approvals = await loadModule<typeof Approvals>("extensions/tool-firewall/approvals.ts");
const trajectory = await loadModule<typeof Trajectory>("extensions/tool-firewall/trajectory.ts");
const profileSwitch = await loadModule<typeof ProfileSwitch>("extensions/session-helpers/profile-switch.ts");
const data = await loadModule<typeof FooterData>("vendor/custom-footer/data.ts");
const render = await loadModule<typeof FooterRender>("vendor/custom-footer/render.ts");
const hubValues = await loadModule<typeof HubValues>("extensions/control-center/values.ts");
const register = await loadExtension("extensions/tool-firewall/index.ts");
const file = security.securityPath();
const reset = () => { fs.rmSync(agent, { recursive: true, force: true }); fs.mkdirSync(path.dirname(file), { recursive: true }); };
const resolve = (policy = "coding", env: NodeJS.ProcessEnv = {}) => security.resolveSecurity(policy === "pentest" ? "guarded" : "balanced", policy, env);
function isSecurityRegistry(value: unknown): value is { snapshot(): SecuritySnapshot } {
  return value !== null && typeof value === "object" && "snapshot" in value && typeof value.snapshot === "function";
}
const snapshot = (): SecuritySnapshot => {
  const reg = (globalThis as Record<symbol, unknown>)[security.REGISTRY_KEY];
  assert.ok(isSecurityRegistry(reg));
  return reg.snapshot();
};
let checks = 0;
const ok = (what: string) => { checks++; console.log(`  OK: ${what}`); };
const config = (mode = "manual", policy = "coding") => {
  fs.rmSync(path.join(root, "legacy"), { recursive: true, force: true });
  fs.writeFileSync(path.join(agent, "pi-kit", "firewall.json"), JSON.stringify({ mode, policy, source: "profile", learn: true }));
};
function context(id = "security-session", answers: Array<string | undefined> = [], hasUI = true) {
  const cards: string[][] = [];
  const notes: string[] = [];
  const confirms: string[] = [];
  let confirmation = true;
  const ctx = { cwd, hasUI, sessionManager: { getSessionId: () => id }, ui: {
    notify: (s: string) => notes.push(s),
    // A weakening choice is a select whose first option is "No, keep …"; the picker is any other.
    select: async (title: string, options: string[]) => {
      if (options[0]?.startsWith("No, keep")) { confirms.push(title); return confirmation ? options[1] : options[0]; }
      cards.push(options); return answers.shift();
    },
  } };
  return { ctx, cards, notes, confirms, answers, setConfirmation: (v: boolean) => { confirmation = v; } };
}
async function gate(level: SecurityLevel, mode = "auto", reply = '{"verdict":"allow","reason":"in scope","confidence":"high"}') {
  reset(); security.saveSecurity(level, "operator"); config(mode);
  const pi = fakePi();
  const judged: string[] = [];
  register(pi.api, { complete: async (system: string, prompt: string) => {
    if (!system.includes("review one tool call")) return '{"principles":[],"cautions":[]}';
    judged.push(prompt); return reply;
  } });
  const view = context();
  await pi.handlers.get("session_start")({}, view.ctx);
  const call = (toolName: string, input: Record<string, unknown>, ctx: unknown = view.ctx) => pi.handlers.get("tool_call")({ toolName, input }, ctx);
  const bash = (command: string, ctx: unknown = view.ctx) => call("bash", { command }, ctx);
  const command = (args: string, ctx: unknown = view.ctx) => pi.commands.get("security").handler(args, ctx);
  return { pi, view, judged, call, bash, command };
}
try {
  reset();
  assert.equal(resolve().effective, "balanced");
  for (const level of security.LEVELS) {
    if (level === "off") {
      fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, level, source: "operator", revision: 1, changedAt: new Date().toISOString() }));
      assert.equal(resolve().requested, "off"); assert.equal(resolve().effective, "balanced"); assert.match(resolve().warnings.join(), /attestation/);
    } else {
      const previous = security.readSecurity().config?.revision ?? 0;
      const saved = security.saveSecurity(level, "operator");
      assert.equal(saved.revision, previous + 1); assert.equal(resolve().effective, level);
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    }
    assert.deepEqual(resolve().unavailable.slice(0, 4), ["content screening", "OpenAPPA flow engine", "intent ledger", "detector"]);
  }
  assert.throws(() => security.saveSecurity("off", "operator"), /attestation/);
  for (const profile of ["quick", "balanced", "long-horizon", "autonomous", "self-improving", "pentest", "lite"]) {
    const def = loadProfileDef(profile);
    const expected = profile === "pentest" ? "guarded" : profile === "quick" || profile === "lite" ? "relaxed" : "balanced";
    assert.equal(profileSecurityLevel(def), expected);
    fs.rmSync(file); writeSecurityConfig(def, file);
    assert.equal(resolve(profile === "pentest" ? "pentest" : "coding").effective, expected);
    fs.writeFileSync(path.join(agent, ".pi-kit.json"), JSON.stringify({ profile }));
    assert.equal(security.profileDefault(cwd, "coding"), expected);
  }
  for (const bad of ["unknown", "off", 5, null]) assert.throws(() => parseProfile({ name: "bad", securityLevel: bad }), /securityLevel/);
  security.saveSecurity("relaxed", "operator");
  writeSecurityConfig(loadProfileDef("pentest"), file);
  assert.equal(resolve("pentest").requested, "relaxed"); assert.equal(resolve("pentest").effective, "guarded");
  assert.equal(resolve("coding", { PI_KIT_SECURITY_LEVEL: "strict" }).effective, "strict");
  security.saveSecurity("strict", "operator");
  assert.equal(resolve("coding", { PI_KIT_SECURITY_LEVEL: "relaxed" }).effective, "strict");
  assert.equal(resolve("coding", { PI_KIT_SECURITY_LEVEL: "off" }).effective, "strict");
  assert.match(resolve("coding", { PI_KIT_SECURITY_LEVEL: "invalid" }).warnings.join(), /ignored/);
  // Same mtime, different bytes: cached parsing must never keep the old strict request.
  const stat = fs.statSync(file);
  security.saveSecurity("balanced", "operator"); fs.utimesSync(file, stat.atime, stat.mtime);
  assert.equal(resolve().effective, "balanced");
  for (const text of ["{", '{}', JSON.stringify({ schemaVersion: 1, level: "bogus", source: "operator", revision: 8, changedAt: new Date().toISOString() })]) {
    fs.writeFileSync(file, text); assert.equal(resolve().effective, "balanced"); assert.ok(resolve().warnings.length);
    assert.equal(resolve("pentest").effective, "guarded");
    assert.equal(security.resolveSecurity("strict", "coding").effective, "strict");
    assert.throws(() => writeSecurityConfig(loadProfileDef("quick"), file), /security config/);
  }
  fs.rmSync(file); fs.mkdirSync(file); assert.equal(resolve().effective, "balanced"); assert.ok(resolve().warnings.length); fs.rmdirSync(file);
  ok("resolution: all defaults, schema, off lock, floors, env strength, content cache, fail closed, revision, mode 0600 and profile preservation");

  {
    reset(); security.saveSecurity("relaxed", "operator"); config("manual", "pentest");
    const markerFile = path.join(agent, ".pi-kit.json");
    const settingsFile = path.join(agent, "settings.json");
    fs.writeFileSync(markerFile, JSON.stringify({ profile: "pentest", installedAt: new Date().toISOString(), extensions: [] }));
    fs.writeFileSync(settingsFile, "{}");
    const expected: ProfileSwitch.Expectation = { profile: "pentest", scope: "global", kitRoot: cwd, markerFile, settingsFile,
      firewallFile: path.join(agent, "pi-kit", "firewall.json"), firewall: { mode: "manual", policy: "pentest" },
      security: { file, level: "guarded" }, extensions: [], startedAt: Date.now(), loadedExtensions: () => [], extensionExists: () => true };
    assert.deepEqual(profileSwitch.verifySwitch(expected), [], "operator relaxed survives a switch while effective security is guarded");
    const undoPin = setEnv("PI_KIT_SECURITY_LEVEL", "strict");
    assert.deepEqual(profileSwitch.verifySwitch(expected), [], "effective verification includes a stronger environment floor"); undoPin();
    security.saveSecurity("relaxed", "profile");
    assert.match(profileSwitch.verifySwitch(expected).join(), /profile requires guarded/);
    security.saveSecurity("guarded", "profile");
    assert.deepEqual(profileSwitch.verifySwitch(expected), []);
    fs.writeFileSync(file, JSON.stringify({ level: { toString: 1 } }));
    assert.match(profileSwitch.verifySwitch(expected).join(), /security config.*invalid/);
    ok("profile switch verification checks profile defaults, operator preservation, effective floors and malformed results");
  }

  for (const level of ["relaxed", "balanced", "guarded", "strict"] as const) {
    const g = await gate(level);
    assert.equal((await g.bash("rm -rf /"))?.block, true, `${level}: critical denies`);
    assert.equal(await g.bash("pwd"), undefined, `${level}: low allows`);
    assert.equal(await g.call("todo", { action: "list" }), undefined, `${level}: exact policy allow retains authority`);
    assert.equal(await g.bash("npm test"), undefined, `${level}: routine dev tooling is already low`);
    assert.equal(g.view.cards.length + g.judged.length, 0);
    const unknown = await g.call("vendor_opaque", { path: "src/file" });
    assert.equal(unknown?.block, true);
    assert.equal(g.view.cards.length, level === "strict" ? 0 : 1);
    assert.equal(g.judged.length, 0);
    assert.equal((await g.bash("npm install left-pad"))?.block, level === "strict" ? true : undefined, `${level}: medium judge`);
    assert.equal(g.judged.length, level === "strict" ? 0 : 1);
    const beforeOpaque = g.judged.length;
    await g.bash("echo ${UNRESOLVED_COMMAND} && $UNRESOLVED_COMMAND");
    if (level === "guarded" || level === "strict") assert.equal(g.judged.length, beforeOpaque, `${level}: uncertainty never judged`);
    const beforeHigh = g.judged.length;
    const high = "sudo systemctl restart nginx";
    g.view.answers.push("Allow once"); assert.equal(await g.bash(high), undefined);
    await g.bash("sudo systemctl restart apache2");
    if (level === "guarded" || level === "strict") assert.equal(g.judged.length, beforeHigh, `${level}: no high judge, including approved families`);
    config("manual");
    const sessionCall = "git push origin feature/security";
    g.view.answers.push("Allow for this session"); assert.equal(await g.bash(sessionCall), undefined);
    const atGrant = g.view.cards.length;
    await g.bash(sessionCall);
    assert.equal(g.view.cards.length, atGrant + (level === "strict" ? 1 : 0), `${level}: session creation/honouring`);
    if (level === "strict") {
      assert.equal(approvals.readApprovals().approvals.length, 0);
      assert.ok(g.view.cards.every((options) => !options.some((o) => o.startsWith("Allow for this session"))), "strict never offers reusable approvals");
    }
    await g.pi.commands.get("auto").handler("on", g.view.ctx);
    if (level === "strict") assert.match(g.view.notes.at(-1) ?? "", /refused.*strict/);
    await g.command("status");
    for (const unavailable of ["content screening", "OpenAPPA flow engine", "intent ledger", "detector", "attestation is unavailable"]) assert.ok(g.view.notes.at(-1)?.includes(unavailable), `${level}: status must disclose ${unavailable}`);
    assert.ok(Object.isFrozen(snapshot())); assert.ok(Object.isFrozen(snapshot().floors));
    ok(`${level}: critical/low/unknown/medium/high/uncertainty/session grants/auto/registry`);
  }

  // Seed real learned authority at balanced, then show the stronger levels suspend it.
  {
    const g = await gate("balanced", "auto", '{"verdict":"block","reason":"outside scope","confidence":"high"}');
    const cmd = "sudo systemctl restart nginx";
    for (const id of ["learn1", "learn1", "learn2"]) {
      const v = context(id, ["Allow once"]); assert.equal(await g.bash(cmd, v.ctx), undefined);
    }
    const v = context("learn3"); assert.equal(await g.bash(cmd, v.ctx), undefined); assert.equal(v.cards.length, 0);
    assert.ok(approvals.readApprovals().approvals.some((a) => a.grantedBy.actor === "learned"));
    for (const level of ["guarded", "strict"] as const) {
      security.saveSecurity(level, "operator");
      const before = g.judged.length;
      assert.equal((await g.bash(cmd, v.ctx))?.block, true); assert.equal(g.judged.length, before);
    }
    ok("real learned exact authority and high precedents work at balanced and become advisory at guarded/strict");
  }

  {
    const g = await gate("balanced", "manual");
    const cmd = "git push origin feature/security";
    g.view.answers.push("Allow for this session"); const debugResult = await g.bash(cmd);
    assert.equal(debugResult, undefined, JSON.stringify({ debugResult, cards: g.view.cards, notes: g.view.notes }));
    assert.equal(approvals.readApprovals().approvals.length, 1);
    await g.command("guarded");
    assert.equal(approvals.readApprovals().approvals.length, 0);
    assert.equal(snapshot().effective, "guarded");
    const revision = snapshot().revision;
    await g.command("balanced"); assert.equal(g.view.confirms.length, 1); assert.equal(snapshot().effective, "balanced"); assert.ok(snapshot().revision > revision);
    await g.command("strict");
    g.view.setConfirmation(false); await g.command("balanced"); assert.equal(snapshot().effective, "strict");
    g.view.setConfirmation(true);
    const headless = context("headless", [], false);
    await g.command("balanced", headless.ctx); assert.equal(snapshot().effective, "strict");
    const undoChild = setEnv("PI_KIT_INTERNAL_CHILD", "1");
    await g.command("balanced"); assert.equal(snapshot().effective, "strict"); undoChild();
    const undoLedger = setEnv("PI_KIT_EFFORT_LEDGER", path.join(root, "child-ledger"));
    await g.command("balanced"); assert.equal(snapshot().effective, "strict"); undoLedger();
    const undoLowerPin = setEnv("PI_KIT_SECURITY_LEVEL", "guarded");
    const confirmations = g.view.confirms.length;
    await g.command("balanced"); assert.equal(snapshot().requested, "strict"); assert.equal(g.view.confirms.length, confirmations, "cannot save below a floor even when the current request is stronger than it"); undoLowerPin();
    await g.command("balanced"); assert.equal(snapshot().effective, "balanced");
    const undoPin = setEnv("PI_KIT_SECURITY_LEVEL", "strict");
    await g.command("relaxed"); assert.equal(snapshot().effective, "strict"); assert.equal(snapshot().requested, "balanced"); undoPin();
    config("manual", "pentest"); await g.command("balanced"); assert.equal(snapshot().effective, "guarded");
    config(); await g.command("reset"); assert.equal(snapshot().source, "profile"); assert.equal(snapshot().effective, "balanced");
    // Picker includes unavailable off, descriptions, and a current marker.
    const pick = context(); pick.ctx.ui.select = async (_title, options) => { pick.cards.push(options); return options.find((o) => o.startsWith("guarded")); };
    await g.command("", pick.ctx); assert.equal(snapshot().effective, "guarded");
    assert.ok(pick.cards[0]?.some((o) => o.startsWith("off") && o.includes("unavailable")));
    assert.ok(pick.cards[0]?.some((o) => o.includes("(current)")));
    await g.command("explain strict"); assert.match(g.view.notes.at(-1) ?? "", /once only/);
    await g.command("off"); assert.equal(snapshot().effective, "guarded");
    assert.ok((await g.pi.commands.get("security").getArgumentCompletions?.("str"))?.some((c) => c.value === "strict"));
    ok("controls: picker, confirm/cancel, strict exit, child/headless/floor refusal, reset, completions and immediate registry updates");
  }

  {
    // Weakening is answered at the terminal only: refused in RPC mode, and a linked phone's mirror
    // (remote-control/bridge.ts keeps the terminal's dialogs under a process-wide symbol) cannot answer.
    const g = await gate("strict", "manual");
    const rpc = context("rpc-session");
    Object.assign(rpc.ctx, { mode: "rpc" });
    await g.command("balanced", rpc.ctx);
    assert.equal(snapshot().effective, "strict"); assert.equal(rpc.confirms.length, 0); assert.match(rpc.notes.at(-1) ?? "", /at the terminal/);
    const linked = context("linked-session");
    Object.assign(linked.ctx, { mode: "tui" });
    const asked: Array<number | undefined> = [];
    let terminalAnswer = false;
    Object.defineProperty(linked.ctx.ui, Symbol.for("pi-system.remote-control.mirror"), { configurable: true, value: {
      select: async (_title: string, options: string[], opts?: { timeout?: number }) => { asked.push(opts?.timeout); return terminalAnswer ? options[1] : options[0]; },
    } });
    // The mirrored select, which a phone could answer, says yes; only the terminal's answer counts.
    await g.command("balanced", linked.ctx);
    assert.equal(snapshot().effective, "strict"); assert.equal(linked.confirms.length, 0); assert.equal(asked.length, 1);
    terminalAnswer = true;
    await g.command("balanced", linked.ctx);
    assert.equal(snapshot().effective, "balanced"); assert.equal(linked.confirms.length, 0);
    assert.ok(asked.every((t) => typeof t === "number" && t > 0), "the terminal confirmation carries a timeout");
    const picked: Array<number | undefined> = [];
    const pick = context();
    pick.ctx.ui.select = async (_title: string, _options: string[], opts?: { timeout?: number }) => { picked.push(opts?.timeout); return undefined; };
    await g.command("", pick.ctx);
    assert.equal(snapshot().effective, "balanced"); assert.ok(typeof picked[0] === "number" && picked[0] > 0, "the picker carries a timeout, and a timeout cancels");
    ok("weakening is confirmed at the terminal only (RPC refused, a linked phone cannot answer) and its dialogs time out");
  }

  {
    const g = await gate("balanced");
    await g.bash("npm install left-pad");
    const state = trajectory.loadSession("security-session"); assert.ok(Object.keys(state.judgeCache).length);
    await g.command("guarded");
    assert.equal(Object.keys(trajectory.loadSession("security-session").judgeCache).length, 0);
    await g.bash("npm install left-pad"); assert.equal(g.judged.length, 2, "new level cannot reuse previous judge verdict");
    // Out-of-band file changes also revoke grants on the next decision.
    config("manual"); g.view.answers.push("Allow for this session"); await g.bash("git push origin feature/security");
    assert.equal(approvals.readApprovals().approvals.length, 1);
    security.saveSecurity("strict", "operator"); await g.bash("pwd"); assert.equal(approvals.readApprovals().approvals.length, 0);
    // A restored session remembers its binding and revokes even after extension reload.
    const pi = fakePi(); register(pi.api, { complete: null });
    security.saveSecurity("balanced", "operator");
    assert.equal((await pi.handlers.get("tool_call")({ toolName: "bash", input: { command: "git push origin feature/security" } }, g.view.ctx))?.block, true);
    g.view.answers.push("Allow for this session");
    await pi.handlers.get("tool_call")({ toolName: "bash", input: { command: "git push origin feature/security" } }, g.view.ctx);
    const legacy = trajectory.loadSession("security-session"); delete legacy.securityBinding; trajectory.saveSession(legacy);
    security.saveSecurity("guarded", "operator");
    const restored = fakePi(); register(restored.api, { complete: null });
    assert.equal((await restored.handlers.get("tool_call")({ toolName: "bash", input: { command: "git push origin feature/security" } }, g.view.ctx))?.block, true);
    assert.equal(approvals.readApprovals().approvals.length, 0, "unbound legacy grants cannot cross into guarded");
    ok("level revisions revoke grants and judge cache, including file changes, reloads and legacy sessions");
  }

  {
    const g = await gate("balanced", "manual");
    let prompts = 0;
    g.view.ctx.ui.select = async () => { prompts++; if (prompts === 1) { security.saveSecurity("strict", "operator"); return "Allow for this session"; } return undefined; };
    assert.equal((await g.call("vendor_opaque", { command: "pwd" }))?.block, true);
    assert.equal(prompts, 1, "pending unknown-tool approval reclassified critical under strict");
    assert.equal(approvals.readApprovals().approvals.length, 0);
    const g2 = await gate("balanced");
    // Change security while the judge itself is awaiting a result.
    const pi = fakePi(); register(pi.api, { complete: async () => { security.saveSecurity("strict", "operator"); return '{"verdict":"allow","reason":"stale"}'; } });
    assert.equal((await pi.handlers.get("tool_call")({ toolName: "bash", input: { command: "npm install left-pad" } }, g2.view.ctx))?.block, true);
    assert.equal(Object.keys(trajectory.loadSession("security-session").judgeCache).length, 0);
    ok("pending operator and judge approvals re-evaluate when the security binding changes");
  }

  {
    const g = await gate("guarded");
    assert.equal(security.ROUTINE_EFFECTS.size, 0);
    config("manual"); await g.command("relaxed");
    assert.equal((await g.bash("npm install left-pad"))?.block, true); assert.equal(g.judged.length, 0);
    assert.equal((await g.bash("git remote add other https://example.invalid/repo"))?.block, true);
    const undo = setEnv("PI_KIT_SECURITY_LEVEL", "strict");
    const view = data.readSecurity(); assert.equal(view?.requested, "relaxed"); assert.equal(view.effective, "strict");
    // The control centre reads the same registry, without importing the firewall.
    const hub = hubValues.readSecurity(); assert.equal(hub.missing, false); assert.equal(hub.effective, "strict"); assert.equal(hub.requested, "relaxed");
    const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };
    const state: FooterRender.FooterState = { cwd, security: view, now: Date.now(), totals: data.emptyTotals(), partial: false, cost: { kind: "unknown" }, statuses: [], todos: [] };
    assert.match(render.renderDetail(state, "default").join("\n"), /security.*strict.*requested relaxed/);
    assert.match(render.renderFooter(state, theme, 200).join("\n"), /sec relaxed→strict/);
    undo();
    const undoSecurityPath = setEnv("PI_KIT_SECURITY_CONFIG", path.join(root, "custom-security.json"));
    security.saveSecurity("relaxed", "operator");
    assert.equal((await g.call("write", { path: security.securityPath(), content: "{}" }))?.block, true, "overridden security state is still a security-control path");
    undoSecurityPath();
    const undoPolicy = setEnv("PI_KIT_FIREWALL_POLICY", path.join(root, "invalid-policy"));
    assert.equal((await g.bash("pwd"))?.block, true, "relaxed never weakens invalid-policy deny all"); undoPolicy();
    ok("relaxed has no additional admissions; footer reads requested/effective; invalid policy still denies");
  }
  {
    // session-helpers/security-guard.ts copies the firewall's levels, security path, root-terminal
    // check and prompt timeout (extensions do not import each other); each copy must stay equal.
    type RootCheck = { atRootTerminal(ctx: { hasUI: boolean; mode: string | undefined }): boolean };
    type Copies = RootCheck & { LEVELS: readonly string[]; securityFilePath(agentDir: string): string; promptTimeoutMs(): number };
    const guard = await loadModule<Copies>("extensions/session-helpers/security-guard.ts");
    const command = await loadModule<RootCheck>("extensions/tool-firewall/security-command.ts");
    const firewall = await loadModule<{ promptTimeoutMs(): number }>("extensions/tool-firewall/index.ts");
    assert.deepEqual([...guard.LEVELS], [...security.LEVELS]);
    for (const value of [undefined, "  ", path.join(root, "custom-security.json")]) {
      const undo = setEnv("PI_KIT_SECURITY_CONFIG", value);
      assert.equal(guard.securityFilePath(agent), security.securityPath(), `security path with PI_KIT_SECURITY_CONFIG=${String(value)}`);
      undo();
    }
    for (const value of [undefined, "", "0", "0.5", "1", "1500.7", "-3", "abc", "120000"]) {
      const undo = setEnv("PI_KIT_FIREWALL_PROMPT_TIMEOUT_MS", value);
      assert.equal(guard.promptTimeoutMs(), firewall.promptTimeoutMs(), `prompt timeout with PI_KIT_FIREWALL_PROMPT_TIMEOUT_MS=${String(value)}`);
      undo();
    }
    for (const [name, value] of [["", ""], ["PI_KIT_INTERNAL_CHILD", "1"], ["PI_KIT_EFFORT_LEDGER", "  "], ["PI_KIT_EFFORT_LEDGER", path.join(root, "ledger.jsonl")]]) {
      const undo = name ? setEnv(name, value) : () => {};
      for (const hasUI of [true, false]) for (const mode of [undefined, "tui", "rpc", "print"]) {
        const ctx = { hasUI, mode };
        assert.equal(guard.atRootTerminal(ctx), command.atRootTerminal(ctx), `root terminal with ${name || "no child marker"}, hasUI=${hasUI}, mode=${String(mode)}`);
      }
      undo();
    }
    assert.equal(command.atRootTerminal({ hasUI: true, mode: "tui" }), true);
    ok("profile-switch guard copies equal the firewall's levels, security path, root-terminal check and prompt timeout");
  }
  console.log(`security-level-smoke: ${checks} groups passed`);
} finally {
  restores.reverse().forEach((f) => f()); restore(); fs.rmSync(root, { recursive: true, force: true });
  Reflect.deleteProperty(globalThis, security.REGISTRY_KEY);
}
