#!/usr/bin/env node
/**
 * delegation-guard: the single launch contract for child pi sessions. Covers what every launch
 * path (subagents, workflows, completion review, conductor) gets: mandatory protections and task
 * governance always load, a missing protection refuses the launch, overrides cannot drop a
 * protection, the launch reserves against the shared effort budget at every depth, and the child
 * verifies before any tool runs that everything required registered itself.
 *
 * Deterministic and offline: no child is spawned; the argv/env the guard hands back is what is
 * checked, and the child-side hook is driven with a fake pi API.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fakePi, isolateKitEnv, loadModule, rmWorkspace, setEnv } from "../packages/core/eval/harness.ts";
import type { ChildRequest, Prepared } from "../packages/extensions/src/delegation-guard/index.ts";
import type { isReadOnlyRole, prepareChildLaunch, readOnlyTools } from "../packages/extensions/third_party/subagent/launch.ts";
import type { AgentConfig, discoverAgents } from "../packages/extensions/third_party/subagent/agents.ts";
import type { RunAgentOptions } from "../packages/extensions/third_party/subagent/runner.ts";
import type { SingleResult } from "../packages/extensions/third_party/subagent/types.ts";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

type FakePi = ReturnType<typeof fakePi>;
type Register = (api: FakePi["api"]) => void;

/** delegation-guard's result: the ok-variant carries the launch, the refused one a code and reason. */
type Granted = Extract<Prepared, { ok: true }>;
type Refused = Extract<Prepared, { ok: false }>;
interface LaunchRefusal {
  ok: boolean;
  reason: string;
}
interface EffortRegistry {
  snapshot(): { usage: { total: number; recoveryUsed: number } };
  setRecoveryActive(active: boolean, reason?: string): void;
}
interface GuardModule {
  default: Register;
  DELEGATION_KEY: symbol;
  PROTECTIONS_KEY: symbol;
  prepareChild: (request: ChildRequest) => Prepared;
  requiredForChild(): string[];
  kitExtensionPath(name: string): string | null;
}
interface FixtureExtension {
  childGovernance?: boolean;
  avenue?: string;
}
interface WorldOptions {
  registered?: string[];
  fixture?: Record<string, FixtureExtension>;
  env?: Record<string, string | undefined>;
}
interface World<Root extends string | null> {
  agent: string;
  root: Root;
  cleanup: () => void;
}
/** The process-wide registries the extensions keep on globalThis under Symbol.for keys. */
const kitGlobals: Record<symbol, unknown> = globalThis;

const restoreEnv = isolateKitEnv();
const guardMod = await loadModule<GuardModule>("extensions/delegation-guard/index.ts");
const effortMod = await loadModule<{ default: Register }>("extensions/effort/index.ts");
const launchMod = await loadModule<{ prepareChildLaunch: typeof prepareChildLaunch; isReadOnlyRole: typeof isReadOnlyRole; readOnlyTools: typeof readOnlyTools }>("vendor/subagent/launch.ts");
const agentsMod = await loadModule<{ discoverAgents: typeof discoverAgents }>("vendor/subagent/agents.ts");
/** A stand-in for the child process the subagent runner spawns: one assistant message, then exit 0. */
function fakeChild() {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: () => true });
  queueMicrotask(() => {
    child.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "end" } }) + "\n");
    child.emit("close", 0);
  });
  return child;
}
const subagentMod = await loadModule<{
  runAgent: (options: Omit<RunAgentOptions, "spawnChild"> & { spawnChild: (cmd: string, args: string[], options?: { env?: Record<string, string | undefined> }) => ReturnType<typeof fakeChild> }) => Promise<SingleResult>;
}>("vendor/subagent/index.ts");
const conductorMod = await loadModule<{
  runSpecialistProcess(cwd: string, agent: string, task: string, childDepth: number): Promise<LaunchRefusal>;
  specialistRoleDigest(cwd: string, agent: string): string | null;
}>("extensions/conductor/index.ts");
// A specialist role is a project file, so these launch-path checks run it under an exact digest grant.
function grantRecon(cwd: string): () => void {
  const previous = process.env.PI_KIT_TRUSTED_PROJECT_ROLES;
  process.env.PI_KIT_TRUSTED_PROJECT_ROLES = conductorMod.specialistRoleDigest(cwd, "recon") ?? "";
  return () => { if (previous === undefined) delete process.env.PI_KIT_TRUSTED_PROJECT_ROLES; else process.env.PI_KIT_TRUSTED_PROJECT_ROLES = previous; };
}
const validatorMod = await loadModule<{
  runValidatorProcess(cwd: string, task: string): Promise<LaunchRefusal>;
}>("extensions/conductor/validate/validator.ts");
const verifyGateMod = await loadModule<{
  runReviewerProcess(cwd: string, task: string, options: object): Promise<LaunchRefusal>;
}>("extensions/verify-gate/index.ts");
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const { default: guard, DELEGATION_KEY, PROTECTIONS_KEY, prepareChild } = guardMod;
const EFFORT_KEY = Symbol.for("pi-kit.effort");
const effortRegistry = () => kitGlobals[EFFORT_KEY] as EffortRegistry;
const protectionsRegistry = () => kitGlobals[PROTECTIONS_KEY] as Set<string>;

// A scratch extensions tree with fake governance extensions, so the test controls the manifests.
function fixtureRoot(extensions: Record<string, FixtureExtension>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-guard-root-"));
  for (const [name, { childGovernance = false, avenue = "src" } = {}] of Object.entries(extensions)) {
    const dir = path.join(root, avenue, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "index.ts"), "export default function () {}\n");
    fs.writeFileSync(path.join(dir, "extension.json"), JSON.stringify({ name, childGovernance }));
  }
  return root;
}

function world(options: WorldOptions & { fixture: Record<string, FixtureExtension> }): World<string>;
function world(options?: WorldOptions): World<string | null>;
function world({ registered = [], fixture, env = {} }: WorldOptions = {}): World<string | null> {
  const agent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-guard-agent-"));
  const root = fixture ? fixtureRoot(fixture) : null;
  const restores = [setEnv("PI_CODING_AGENT_DIR", agent), ...(root ? [setEnv("PI_KIT_EXTENSIONS_ROOT", root)] : []), ...Object.entries(env).map(([k, v]) => setEnv(k, v))];
  kitGlobals[PROTECTIONS_KEY] = new Set(registered);
  return { agent, root, cleanup: () => { restores.reverse().forEach((r) => r()); Reflect.deleteProperty(kitGlobals, PROTECTIONS_KEY); Reflect.deleteProperty(kitGlobals, DELEGATION_KEY); Reflect.deleteProperty(kitGlobals, EFFORT_KEY); rmWorkspace(agent); if (root) rmWorkspace(root); } };
}

/** The kit's roles, discovered under a temp PI_CODING_AGENT_DIR so no operator override in ~/.pi is read. */
function kitAgents(): AgentConfig[] {
  const w = world();
  try { return agentsMod.discoverAgents(process.cwd(), "user").agents.filter((a) => a.source === "kit"); } finally { w.cleanup(); }
}

// The real effort extension, opened on a fresh scope, gives real reservations.
async function withEffort(tier = "standard"): Promise<{ registry: EffortRegistry; done: () => void }> {
  Reflect.deleteProperty(kitGlobals, EFFORT_KEY);
  const restore = setEnv("PI_KIT_EFFORT", tier);
  const pi = fakePi();
  effortMod.default(pi.api);
  const ctx = { hasUI: false, cwd: process.cwd(), ui: {}, sessionManager: { getSessionId: () => "g1" } };
  await pi.handlers.get("session_start")({ reason: "startup" }, ctx);
  await pi.handlers.get("before_agent_start")({ systemPrompt: "" }, ctx);
  return { registry: effortRegistry(), done: () => restore() };
}

/**
 * Narrow a launch to its ok-variant. Fails exactly as `assert.equal(p.ok, true, message ?? p.reason)`
 * would; the trailing throw is unreachable (it only tells the compiler the refused branch ends).
 */
function granted(p: Prepared, message?: string): Granted {
  if (p.ok) return p;
  assert.equal(p.ok, true, message ?? p.reason);
  throw new Error("unreachable");
}
/** Narrow a launch to its refused variant. Fails exactly as `assert.equal(p.ok, false, message)` would. */
function refused(p: Prepared, message?: string): Refused {
  if (!p.ok) return p;
  // Two calls only because assert's overloads take either no message or a string, not `string | undefined`.
  if (message === undefined) assert.equal(p.ok, false);
  else assert.equal(p.ok, false, message);
  throw new Error("unreachable");
}
/** A child environment variable the guard always sets on a granted launch. */
function envOf(p: Granted, key: string): string {
  const value = p.env[key];
  assert.ok(typeof value === "string", `${key} is set in the child environment`);
  return value;
}

const argsOf = (p: Granted): string[] => p.args.filter((_, i) => p.args[i - 1] === "-e").map((f) => path.basename(path.dirname(f)));

type ExitCode = Parameters<typeof process.exit>[0];
/**
 * A process.exit stand-in that records the code and returns, so the guard's EX_CONFIG exit can be
 * observed. The real signature returns `never`; the cast admits the recording stub.
 */
const fakeExit = (exits: ExitCode[]) => ((code?: ExitCode) => { exits.push(code); }) as typeof process.exit;

const tests: Record<string, () => unknown> = {
  "a child loads the guard first, every governance extension the parent runs, and nothing the parent lacks": async () => {
    const w = world({ registered: ["tool-firewall", "protected-paths", "pentest-governance-domain", "delegation-guard", "effort"], fixture: { "delegation-guard": { childGovernance: true }, effort: { childGovernance: true }, "tool-firewall": { childGovernance: true }, "protected-paths": { childGovernance: true, avenue: "third_party" }, "secret-guard": { childGovernance: true }, "pentest-governance-domain": { childGovernance: true }, todo: {}, "finish-reason-retry": {} } });
    const e = await withEffort();
    try {
      const p = granted(prepareChild({ cwd: process.cwd(), kind: "discretionary", role: "implementer" }));
      assert.equal(p.args[0], "--no-extensions");
      assert.equal(argsOf(p)[0], "delegation-guard", "the guard is loaded first so its blocking hook runs first");
      for (const name of ["tool-firewall", "protected-paths", "pentest-governance-domain", "effort", "todo", "finish-reason-retry"]) assert.ok(argsOf(p).includes(name), `${name} is loaded in the child`);
      assert.ok(!argsOf(p).includes("secret-guard"), "secret-guard is required only when the parent actually runs it");
      assert.equal(envOf(p, "PI_KIT_CHILD_REQUIRE").split(",").sort().join(), ["delegation-guard", "effort", "pentest-governance-domain", "protected-paths", "tool-firewall"].join());
      assert.equal(p.env.PI_KIT_INTERNAL_CHILD, "1");
      // secret-guard enabled in the parent -> the child must have it too
      protectionsRegistry().add("secret-guard");
      const q = granted(prepareChild({ cwd: process.cwd(), kind: "discretionary", role: "implementer" }));
      assert.ok(argsOf(q).includes("secret-guard") && envOf(q, "PI_KIT_CHILD_REQUIRE").includes("secret-guard"));
    } finally { e.done(); w.cleanup(); }
  },

  "a protection that cannot be located refuses the launch; it is never silently skipped": async () => {
    const w = world({ registered: ["tool-firewall", "delegation-guard", "effort"], fixture: { "delegation-guard": { childGovernance: true }, effort: { childGovernance: true }, "tool-firewall": { childGovernance: true } } });
    const e = await withEffort();
    try {
      fs.rmSync(path.join(w.root, "src", "tool-firewall", "index.ts"));
      const p = refused(prepareChild({ cwd: process.cwd(), kind: "discretionary", role: "worker" }));
      assert.equal(p.code, "governance-missing");
      assert.match(p.reason, /tool-firewall/);
      assert.match(p.reason, /never started with weaker protection/);
      // and it consumed no budget: the refusal happened before the reservation
      assert.equal(effortRegistry().snapshot().usage.total, 0);
    } finally { e.done(); w.cleanup(); }
  },

  "overrides can add extensions but can never drop a required protection or disable isolation": async () => {
    const w = world({ registered: ["tool-firewall", "delegation-guard", "effort"], fixture: { "delegation-guard": { childGovernance: true }, effort: { childGovernance: true }, "tool-firewall": { childGovernance: true }, todo: {}, memory: {} }, env: { PI_KIT_SUBAGENT_EXTENSIONS: "memory", PI_KIT_SUBAGENT_ISOLATE: "0" } });
    const e = await withEffort();
    try {
      const p = granted(prepareChild({ cwd: process.cwd(), kind: "discretionary", role: "worker" }));
      assert.ok(argsOf(p).includes("tool-firewall") && argsOf(p).includes("delegation-guard"), "the override list cannot remove protections");
      assert.ok(argsOf(p).includes("memory"), "the override list still adds what was asked for");
      assert.ok(!argsOf(p).includes("todo"), "the override replaces the optional defaults");
      assert.equal(p.args[0], "--no-extensions", "PI_KIT_SUBAGENT_ISOLATE=0 no longer disables isolation");
      assert.equal(p.env.PI_KIT_SUBAGENT_ISOLATE, undefined, "the knob is not passed on");
    } finally { e.done(); w.cleanup(); }
  },

  "launches reserve against the effort budget and carry the child's tier; exhaustion refuses before any spawn": async () => {
    const w = world({ registered: ["delegation-guard", "effort"] });
    const e = await withEffort("focused"); // one child in total
    try {
      const first = granted(prepareChild({ cwd: process.cwd(), kind: "discretionary", role: "scout", scout: true, requestedTier: "exhaustive" }));
      assert.equal(first.childTier, "focused", "a child is never above its parent");
      assert.equal(first.env.PI_KIT_EFFORT, "focused");
      assert.equal(first.env.PI_KIT_EFFORT_CAP, "focused");
      assert.ok(first.env.PI_KIT_EFFORT_LEDGER);
      first.slot.settle("failed");
      const second = refused(prepareChild({ cwd: process.cwd(), kind: "discretionary", role: "worker" }), "a failed child is not refunded");
      assert.equal(second.code, "total");
      assert.match(second.reason, /\/effort/);
      // completion review is mandatory verification: it still runs at any tier
      assert.equal(prepareChild({ cwd: process.cwd(), kind: "mandatory", role: "reviewer" }).ok, true);
    } finally { e.done(); w.cleanup(); }
  },

  "while recovery is active a scout launch is charged to the recovery budget, so recovery works at E1 and never spends the discretionary one": async () => {
    const w = world({ registered: ["delegation-guard", "effort"] });
    const e = await withEffort("minimal"); // E1: no discretionary delegation at all
    try {
      const scout: ChildRequest = { cwd: process.cwd(), kind: "discretionary", role: "scout", scout: true, readOnly: true };
      assert.equal(refused(prepareChild(scout), "without recovery, a scout at E1 is refused").code, "tier", "without recovery, a scout at E1 is refused");
      e.registry.setRecoveryActive(true, "progress-guard escalation");
      const first = granted(prepareChild(scout));
      const notScout = refused(prepareChild({ cwd: process.cwd(), kind: "discretionary", role: "implementer", readOnly: false }), "recovery is only for the read-only scout role");
      assert.equal(notScout.code, "tier");
      assert.equal(refused(prepareChild(scout), "one recovery child at a time; the fallback to the discretionary budget is then refused by the tier").code, "tier", "one recovery child at a time; the fallback to the discretionary budget is then refused by the tier");
      first.slot.settle("ok");
      const second = granted(prepareChild(scout));
      second.slot.settle("ok");
      assert.equal(refused(prepareChild(scout), "the recovery budget is two invocations, then the tier decides").code, "tier", "the recovery budget is two invocations, then the tier decides");
      const snap = e.registry.snapshot();
      assert.equal(snap.usage.recoveryUsed, 2);
      assert.equal(snap.usage.total, 0, "recovery never draws on the discretionary budget");
    } finally { e.done(); w.cleanup(); }
  },

  "a role with bash, powershell or any non-read tool is not read-only; recovery charges it only on its read tools and hands those back": async () => {
    const role = (name: string, tools: string[]): AgentConfig => ({ name, description: "", tools, systemPrompt: "", source: "kit", filePath: "" });
    const kit = kitAgents();
    const toolsOf = (name: string) => kit.find((a) => a.name === name)?.tools;
    assert.ok(toolsOf("scout")?.includes("bash") && toolsOf("reviewer")?.includes("bash"), "the kit scout and reviewer have bash");
    for (const name of ["scout", "reviewer"]) assert.equal(launchMod.isReadOnlyRole(role(name, toolsOf(name) ?? []), undefined), false, `the kit ${name} has bash, so it is not read-only`);
    assert.equal(launchMod.isReadOnlyRole(role("planner", toolsOf("planner") ?? []), undefined), true, "the kit planner has only read tools");
    for (const extra of ["bash", "powershell", "web_fetch", "mcp__x__*", "write", "subagent"]) assert.equal(launchMod.isReadOnlyRole(role("r", ["read", extra]), undefined), false, `${extra} is not a read tool`);
    assert.equal(launchMod.isReadOnlyRole(role("r", ["read"]), []), false, "an empty tool list is not explicit");
    assert.deepEqual(launchMod.readOnlyTools(role("scout", ["read", "grep", "find", "ls", "bash"]), undefined), ["read", "grep", "find", "ls"]);
    assert.equal(launchMod.readOnlyTools(role("planner", ["read", "grep"]), undefined), undefined, "a read-only role needs no narrowing");
    assert.equal(launchMod.readOnlyTools(role("r", ["bash"]), undefined), undefined, "nothing read-only to narrow to");

    const w = world({ registered: ["delegation-guard", "effort"] });
    const e = await withEffort("minimal");
    try {
      e.registry.setRecoveryActive(true);
      const bashScout: ChildRequest = { cwd: process.cwd(), kind: "discretionary", role: "scout", scout: true, readOnly: false };
      assert.equal(refused(prepareChild(bashScout), "a scout that is not read-only is never charged to recovery").code, "tier");
      const narrowed = granted(prepareChild({ ...bashScout, readOnlyTools: ["read", "grep", "find", "ls"] }));
      assert.deepEqual(narrowed.tools, ["read", "grep", "find", "ls"], "the recovery launch runs with only the read tools");
      assert.equal(e.registry.snapshot().usage.recoveryUsed, 1);
      narrowed.slot.settle("ok");
      assert.equal(granted(prepareChild({ ...bashScout, readOnly: true })).tools, undefined, "a read-only role keeps its own tool list");
    } finally { e.done(); w.cleanup(); }

    // Above the recovery budget, at a tier that allows delegation, the scout is an ordinary child with all its tools.
    const w2 = world({ registered: ["delegation-guard", "effort"] });
    const e2 = await withEffort("thorough");
    try {
      e2.registry.setRecoveryActive(true);
      const request: ChildRequest = { cwd: process.cwd(), kind: "discretionary", role: "scout", scout: true, readOnly: false, readOnlyTools: ["read"] };
      for (let i = 0; i < 2; i++) { const p = granted(prepareChild(request)); assert.deepEqual(p.tools, ["read"]); p.slot.settle("ok"); }
      const third = granted(prepareChild(request));
      assert.equal(third.tools, undefined, "a launch charged to the discretionary budget is not narrowed");
      assert.equal(e2.registry.snapshot().usage.total, 1);
      third.slot.settle("ok");
    } finally { e2.done(); w2.cleanup(); }
  },

  "the subagent runner starts a recovery scout without bash, and an ordinary scout with it": async () => {
    const scout = kitAgents().find((a) => a.name === "scout");
    assert.ok(scout, "the kit scout resolves");
    const toolsArg = async (): Promise<string | undefined> => {
      let seen: string[] = [];
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-guard-cwd-")); // run logs land here, not in the checkout
      try {
        const result = await subagentMod.runAgent({ defaultCwd: cwd, agents: [scout], agentName: "scout", task: "look", spawnChild: (_cmd, args) => { seen = args; return fakeChild(); } });
        assert.equal(result.exitCode, 0, result.errorMessage ?? "the scout ran");
      } finally { rmWorkspace(cwd); }
      return seen[seen.indexOf("--tools") + 1];
    };
    const w = world({ registered: ["delegation-guard", "effort"] });
    guard(fakePi().api);
    const e = await withEffort("minimal");
    try {
      e.registry.setRecoveryActive(true);
      assert.equal(await toolsArg(), "read,grep,find,ls", "recovery: the child has no bash");
    } finally { e.done(); w.cleanup(); }
    const w2 = world({ registered: ["delegation-guard", "effort"] });
    guard(fakePi().api);
    const e2 = await withEffort("thorough");
    try {
      assert.equal(await toolsArg(), "read,grep,find,ls,bash", "an ordinary scout keeps bash");
    } finally { e2.done(); w2.cleanup(); }
  },

  "a workflow launch is charged to its run scope at E1, never loads subagent, and a wrong run token is refused": async () => {
    const w = world({ registered: ["delegation-guard", "effort"], fixture: { "delegation-guard": { childGovernance: true }, effort: { childGovernance: true }, subagent: { avenue: "third_party" } } });
    const e = await withEffort("standard");
    try {
      const open: unknown = Reflect.get(Object(kitGlobals[EFFORT_KEY]), "openRunScope");
      assert.equal(typeof open, "function", "effort exposes openRunScope");
      const scope: unknown = typeof open === "function" ? Reflect.apply(open, kitGlobals[EFFORT_KEY], ["wf-guard-1"]) : null;
      const runToken: unknown = Reflect.get(Object(scope), "runToken");
      assert.ok(typeof runToken === "string" && runToken.length > 0, "the run scope opens");
      const p = granted(prepareChild({ cwd: process.cwd(), kind: "workflow", role: "delegator", runId: "wf-guard-1", runToken, needsSubagent: true, extraExtensions: ["subagent"] }));
      assert.ok(!argsOf(p).includes("subagent"), "a workflow agent never gets the subagent extension");
      assert.equal(envOf(p, "PI_KIT_EFFORT"), "minimal", "workflow agents run at E1");
      assert.equal(envOf(p, "PI_KIT_EFFORT_CAP"), "minimal");
      assert.match(envOf(p, "PI_KIT_EFFORT_LEDGER"), /-workflows\.json$/, "charged to the session's workflow ledger");
      p.slot.settle("ok");
      assert.equal(e.registry.snapshot().usage.total, 0, "the tier budget is not drawn on");
      const bad = refused(prepareChild({ cwd: process.cwd(), kind: "workflow", role: "implementer", runId: "wf-guard-1", runToken: "wrong" }));
      assert.equal(bad.code, "run-scope");
      const none = refused(prepareChild({ cwd: process.cwd(), kind: "workflow", role: "implementer" }));
      assert.equal(none.code, "run-scope", "a workflow launch without a run scope is refused");
    } finally { e.done(); w.cleanup(); }
  },

  "the subagent runner starts a workflow agent without the subagent tool and with its nesting limit at its own depth": async () => {
    const delegator = kitAgents().find((a) => a.name === "delegator");
    assert.ok(delegator, "the kit delegator resolves");
    const w = world({ registered: ["delegation-guard", "effort"] });
    guard(fakePi().api);
    const e = await withEffort("standard");
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-guard-cwd-"));
    try {
      const open: unknown = Reflect.get(Object(kitGlobals[EFFORT_KEY]), "openRunScope");
      const scope: unknown = typeof open === "function" ? Reflect.apply(open, kitGlobals[EFFORT_KEY], ["wf-guard-2"]) : null;
      const runToken: unknown = Reflect.get(Object(scope), "runToken");
      assert.ok(typeof runToken === "string");
      let seen: string[] = [];
      let env: Record<string, string | undefined> = {};
      const result = await subagentMod.runAgent({
        defaultCwd: cwd, agents: [delegator], agentName: "delegator", task: "look", launchKind: "workflow", workflowRun: { runId: "wf-guard-2", runToken },
        spawnChild: (_cmd, args, options?: { env?: Record<string, string | undefined> }) => { seen = args; env = options?.env ?? {}; return fakeChild(); },
      });
      assert.equal(result.exitCode, 0, result.errorMessage ?? "the agent ran");
      assert.equal(seen[seen.indexOf("--tools") + 1], "read,grep,find,ls", "the subagent tool is dropped");
      assert.ok(!seen.some((a) => a.includes(`${path.sep}subagent${path.sep}`)), "no subagent extension is loaded");
      assert.equal(env.PI_KIT_SUBAGENT_DEPTH, "1");
      assert.equal(env.PI_KIT_SUBAGENT_MAX_DEPTH, "1", "a workflow agent cannot delegate further");
      const denied = await subagentMod.runAgent({ defaultCwd: cwd, agents: [delegator], agentName: "delegator", task: "look", launchKind: "workflow", workflowRun: { runId: "wf-guard-2", runToken: "wrong" }, spawnChild: () => fakeChild() });
      assert.equal(denied.stopReason, "denied");
      assert.equal(denied.deniedCode, "run-scope", "the denial code reaches the caller");
    } finally { rmWorkspace(cwd); e.done(); w.cleanup(); }
  },

  "a recovery scout at a tier that allows delegation falls back to the discretionary budget once the recovery budget is spent": async () => {
    const w = world({ registered: ["delegation-guard", "effort"] });
    const e = await withEffort("thorough"); // 8 discretionary children, 2 scouts
    try {
      e.registry.setRecoveryActive(true);
      const scout: ChildRequest = { cwd: process.cwd(), kind: "discretionary", role: "scout", scout: true, readOnly: true };
      for (let i = 0; i < 2; i++) { const p = granted(prepareChild(scout)); p.slot.settle("ok"); }
      assert.equal(e.registry.snapshot().usage.recoveryUsed, 2);
      assert.equal(e.registry.snapshot().usage.total, 0);
      const third = granted(prepareChild(scout));
      assert.equal(e.registry.snapshot().usage.total, 1, "the third scout is an ordinary child");
      third.slot.settle("ok");
    } finally { e.done(); w.cleanup(); }
  },

  "without the effort extension a discretionary launch is refused (fail closed) but mandatory verification is not": async () => {
    const w = world({ registered: ["delegation-guard"] });
    try {
      Reflect.deleteProperty(kitGlobals, EFFORT_KEY);
      const denied = refused(prepareChild({ cwd: process.cwd(), kind: "discretionary", role: "worker" }));
      assert.equal(denied.code, "no-effort");
      assert.equal(prepareChild({ cwd: process.cwd(), kind: "mandatory", role: "reviewer" }).ok, true);
    } finally { w.cleanup(); }
  },

  "the subagent side refuses to launch when delegation-guard is not loaded, and survives a guard that throws": async () => {
    const w = world();
    try {
      Reflect.deleteProperty(kitGlobals, DELEGATION_KEY);
      const none = refused(launchMod.prepareChildLaunch({ cwd: process.cwd(), kind: "discretionary", role: "worker" }));
      assert.equal(none.code, "no-guard");
      assert.match(none.reason, /delegation-guard/);
      kitGlobals[DELEGATION_KEY] = { prepareChild() { throw new Error("boom"); } };
      const broken = refused(launchMod.prepareChildLaunch({ cwd: process.cwd(), kind: "discretionary", role: "worker" }));
      assert.equal(broken.code, "guard-error");
    } finally { w.cleanup(); }
  },

  "grandchildren: the same rules apply from inside a child, with the same or a lower tier and the shared ledger": async () => {
    const w = world({ registered: ["tool-firewall", "delegation-guard", "effort"], fixture: { "delegation-guard": { childGovernance: true }, effort: { childGovernance: true }, "tool-firewall": { childGovernance: true }, subagent: { avenue: "third_party" } } });
    const parent = await withEffort("thorough");
    try {
      const child = granted(prepareChild({ cwd: process.cwd(), kind: "discretionary", role: "delegator", requestedTier: "standard", needsSubagent: true }));
      assert.ok(argsOf(child).includes("subagent"), "a delegator child gets the subagent extension");
      // Become the child process: its env pins the tier and shares the parent's ledger.
      const restore = ["PI_KIT_EFFORT", "PI_KIT_EFFORT_CAP", "PI_KIT_EFFORT_LEDGER", "PI_KIT_CHILD_REQUIRE"].map((k) => setEnv(k, child.env[k]));
      try {
        const inner = await withEffort(child.env.PI_KIT_EFFORT);
        const grand = granted(prepareChild({ cwd: process.cwd(), kind: "discretionary", role: "worker", requestedTier: "exhaustive" }));
        assert.equal(grand.childTier, "standard", "a grandchild is never above its parent's tier");
        assert.ok(argsOf(grand).includes("tool-firewall"), "the boundary reaches the grandchild");
        assert.equal(grand.env.PI_KIT_EFFORT_LEDGER, child.env.PI_KIT_EFFORT_LEDGER, "descendants share one ledger, so no fresh budget");
        inner.done();
      } finally { restore.reverse().forEach((f) => f()); }
    } finally { parent.done(); w.cleanup(); }
  },

  "every other launch path (completion reviewer, conductor specialist, conductor validator) refuses without the guard and spawns nothing": async () => {
    const w = world();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-guard-cwd-"));
    try {
      Reflect.deleteProperty(kitGlobals, DELEGATION_KEY);
      fs.mkdirSync(path.join(cwd, ".pi", "agents"), { recursive: true });
      fs.writeFileSync(path.join(cwd, ".pi", "agents", "recon.md"), "---\nname: recon\ntools: read, grep\n---\nRecon.\n");
      const ungrant = grantRecon(cwd);
      const review = await verifyGateMod.runReviewerProcess(cwd, "task", {});
      assert.equal(review.ok, false);
      assert.match(review.reason, /delegation-guard extension is not loaded/);
      const specialist = await conductorMod.runSpecialistProcess(cwd, "recon", "scan", 1);
      ungrant();
      assert.equal(specialist.ok, false);
      assert.match(specialist.reason, /delegation-guard extension is not loaded/);
      const validator = await validatorMod.runValidatorProcess(cwd, "task");
      assert.equal(validator.ok, false);
      assert.match(validator.reason, /delegation-guard extension is not loaded/);
    } finally { rmWorkspace(cwd); w.cleanup(); }
  },

  "a conductor specialist is a discretionary child: refused at E1 with the reason, before any spawn": async () => {
    const w = world({ registered: ["delegation-guard", "effort", "tool-firewall"] });
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-guard-cwd-"));
    const e = await withEffort("minimal");
    try {
      // install the real guard registry next to the real effort registry
      const pi = fakePi();
      guard(pi.api);
      fs.mkdirSync(path.join(cwd, ".pi", "agents"), { recursive: true });
      fs.writeFileSync(path.join(cwd, ".pi", "agents", "recon.md"), "---\nname: recon\ntools: read, grep\n---\nRecon.\n");
      const ungrant = grantRecon(cwd);
      const specialist = await conductorMod.runSpecialistProcess(cwd, "recon", "scan", 1);
      ungrant();
      assert.equal(specialist.ok, false);
      assert.match(specialist.reason, /E1 Minimal does not delegate/);
      assert.equal(effortRegistry().snapshot().usage.total, 0);
    } finally { rmWorkspace(cwd); e.done(); w.cleanup(); }
  },

  "an ambient child (conductor specialists, validators) is always given the guard, so the child-side check cannot be skipped": async () => {
    const w = world({ registered: ["tool-firewall", "delegation-guard", "effort"], fixture: { "delegation-guard": { childGovernance: true }, effort: { childGovernance: true }, "tool-firewall": { childGovernance: true }, todo: {} } });
    const e = await withEffort();
    try {
      const p = granted(prepareChild({ cwd: process.cwd(), kind: "mandatory", role: "validator", readOnly: true, isolation: "ambient" }));
      assert.deepEqual(argsOf(p), ["delegation-guard"], "the guard, and nothing else, is passed explicitly");
      assert.ok(!p.args.includes("--no-extensions"), "an ambient child still loads the operator's installed extensions");
      assert.equal(p.args.filter((a) => a === "-e").length, 1);
      assert.match(envOf(p, "PI_KIT_CHILD_REQUIRE"), /tool-firewall/, "and is told what must have loaded");
      // Without that explicit load a child whose settings did not include the guard would never check anything.
      fs.rmSync(path.join(w.root, "src", "delegation-guard", "index.ts"));
      const missing = refused(prepareChild({ cwd: process.cwd(), kind: "mandatory", role: "validator", readOnly: true, isolation: "ambient" }));
      assert.equal(missing.code, "governance-missing");
    } finally { e.done(); w.cleanup(); }
  },

  "extensions are named, never addressed by path: a role, workflow or settings file cannot load arbitrary code into a governed child": async () => {
    const w = world({ registered: ["delegation-guard", "effort"], fixture: { "delegation-guard": { childGovernance: true }, effort: { childGovernance: true }, memory: {}, todo: {} } });
    const e = await withEffort();
    const stray = path.join(w.agent, "evil.ts");
    fs.writeFileSync(stray, "export default function () { process.exit(0); }\n");
    try {
      const p = granted(prepareChild({ cwd: process.cwd(), kind: "discretionary", role: "worker", extraExtensions: ["memory", stray, "../evil", "evil.ts", "./evil.ts", "Memory", "mem ory", "", "-e", "a".repeat(200)] }));
      assert.ok(argsOf(p).includes("memory"), "a registry name is honoured");
      for (const bad of [stray, "../evil", "evil.ts", "./evil.ts"]) assert.ok(!p.args.includes(bad) && !p.args.some((a) => a.includes("evil")), `${bad} is not loaded`);
      assert.deepEqual(p.args.filter((_, i) => p.args[i - 1] === "-e").filter((f) => !f.startsWith(w.root)), [], "everything loaded lives in the kit's own extension directories");
      assert.equal(guardMod.kitExtensionPath(stray), null);
      assert.equal(guardMod.kitExtensionPath("../delegation-guard"), null);
      assert.ok(guardMod.kitExtensionPath("delegation-guard"), "a registry name resolves");
      // The operator's override list follows the same rule.
      const restore = setEnv("PI_KIT_SUBAGENT_EXTENSIONS", `memory,${stray}`);
      try {
        const q = granted(prepareChild({ cwd: process.cwd(), kind: "discretionary", role: "worker" }));
        assert.ok(argsOf(q).includes("memory") && !q.args.includes(stray));
      } finally { restore(); }
    } finally { e.done(); w.cleanup(); }
  },

  "every extension that can start a pi child goes through the guard": () => {
    // A launcher that resolves pi's own entry point starts a child process. Each must ask delegation-guard (directly or through
    // the subagent launch wrapper) in code, not in a comment, so a new launch path cannot skip the boundary unnoticed.
    const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const launchers: string[] = [];
    for (const avenue of ["src", "third_party"]) {
      const root = path.join(ROOT, "packages", "extensions", avenue);
      for (const name of fs.readdirSync(root)) {
        const dir = path.join(root, name);
        if (!fs.statSync(dir).isDirectory()) continue;
        const files: string[] = [];
        const walk = (d: string): void => { for (const f of fs.readdirSync(d)) { const full = path.join(d, f); if (fs.statSync(full).isDirectory()) { if (f !== "node_modules") walk(full); } else if (/\.(ts|js|mjs)$/.test(f)) files.push(full); } };
        walk(dir);
        const code = files.map((f) => strip(fs.readFileSync(f, "utf8")));
        const spawnsPi = code.some((c) => /import\.meta\.resolve\(\s*["']@earendil-works\/pi-coding-agent["']\s*\)/.test(c) || /piChildArgv\(/.test(c));
        if (!spawnsPi) continue;
        launchers.push(name);
        if (name === "delegation-guard") continue; // the guard itself only builds arguments
        assert.ok(code.some((c) => /Symbol\.for\(["']pi-kit\.delegation["']\)/.test(c) || /prepareChildLaunch\(/.test(c)), `${name} starts pi children but never asks delegation-guard (Symbol.for("pi-kit.delegation") or prepareChildLaunch)`);
      }
    }
    for (const known of ["dual-review", "verify-gate", "conductor", "subagent"]) assert.ok(launchers.includes(known), `the scan finds the known launcher ${known} (found: ${launchers.join(", ")})`);
  },

  "child side: a missing protection blocks every tool call and exits with EX_CONFIG": async () => {
    const w = world({ registered: ["delegation-guard", "tool-firewall"], env: { PI_KIT_CHILD_REQUIRE: "tool-firewall,protected-paths,delegation-guard" } });
    const realExit = process.exit.bind(process);
    const realWrite = process.stderr.write.bind(process.stderr);
    const exits: ExitCode[] = [];
    const written: string[] = [];
    process.exit = fakeExit(exits);
    process.stderr.write = (c: string | Uint8Array) => { written.push(String(c)); return true; };
    const priorExitCode = process.exitCode;
    try {
      const pi = fakePi();
      guard(pi.api);
      const notes: Array<{ m: string; l: string }> = [];
      await pi.handlers.get("session_start")({ reason: "startup" }, { hasUI: true, ui: { notify: (m: string, l: string) => notes.push({ m, l }) } });
      await new Promise((r) => setTimeout(r, 120));
      assert.deepEqual(exits, [78], "the child exits visibly");
      assert.match(written.join(""), /missing required protection \(protected-paths\)/);
      assert.equal(notes[0]?.l, "error");
      const verdict = await pi.handlers.get("tool_call")({ toolName: "bash", input: { command: "ls" } });
      assert.equal(verdict?.block, true);
      assert.match(verdict.reason as string, /Every tool call is refused/);
    } finally {
      process.exit = realExit;
      process.stderr.write = realWrite;
      process.exitCode = priorExitCode;
      w.cleanup();
    }
  },

  "child side: a complete child runs normally; a root session (no requirements) is untouched": async () => {
    const w = world({ registered: ["delegation-guard", "tool-firewall"], env: { PI_KIT_CHILD_REQUIRE: "tool-firewall,delegation-guard" } });
    const realExit = process.exit.bind(process);
    const exits: ExitCode[] = [];
    process.exit = fakeExit(exits);
    try {
      let pi = fakePi();
      guard(pi.api);
      await pi.handlers.get("session_start")({ reason: "startup" }, { hasUI: false });
      assert.equal(await pi.handlers.get("tool_call")({ toolName: "read", input: {} }), undefined);
      delete process.env.PI_KIT_CHILD_REQUIRE;
      pi = fakePi();
      guard(pi.api);
      await pi.handlers.get("session_start")({ reason: "startup" }, { hasUI: false });
      assert.equal(await pi.handlers.get("tool_call")({ toolName: "bash", input: {} }), undefined);
      await new Promise((r) => setTimeout(r, 80));
      assert.deepEqual(exits, []);
    } finally { process.exit = realExit; w.cleanup(); }
  },

  "every extension that declares childGovernance registers itself as a protection": () => {
    const seen: string[] = [];
    for (const avenue of ["src", "third_party"]) {
      const dir = path.join(ROOT, "packages", "extensions", avenue);
      for (const name of fs.readdirSync(dir)) {
        const manifest = path.join(dir, name, "extension.json");
        if (!fs.existsSync(manifest) || (JSON.parse(fs.readFileSync(manifest, "utf8")) as { childGovernance?: unknown }).childGovernance !== true) continue;
        seen.push(name);
        const files = fs.readdirSync(path.join(dir, name)).filter((f) => f.endsWith(".ts"));
        // Code only: a comment that mentions the symbol must not satisfy the check.
        const src = files.map((f) => fs.readFileSync(path.join(dir, name, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")).join("\n");
        assert.ok(/registerProtection\(\s*["'][a-z0-9-]+["']\s*\)|Symbol\.for\(["']pi-kit\.protections["']\)/.test(src), `${name} must register itself in the protections registry so a child can verify it loaded`);
      }
    }
    assert.ok(seen.includes("effort") && seen.includes("delegation-guard"), `governance set: ${seen.join(", ")}`);
  },

  "every shipped profile includes effort and delegation-guard together with subagent": () => {
    for (const file of fs.readdirSync(path.join(ROOT, "packages", "kit", "profiles")).filter((f) => f.endsWith(".json"))) {
      const include = (JSON.parse(fs.readFileSync(path.join(ROOT, "packages", "kit", "profiles", file), "utf8")) as { include: string[] }).include;
      assert.ok(include.includes("effort") && include.includes("delegation-guard"), `${file}: effort and delegation-guard are in every profile`);
    }
  },
};

let failed = 0;
for (const [name, fn] of Object.entries(tests)) {
  try {
    await fn();
    console.log(`  OK: ${name}`);
  } catch (error) {
    failed++;
    console.error(`  FAIL: ${name}\n    ${String((error instanceof Error && error.stack) || error)}`);
  }
}
restoreEnv();
if (failed) {
  console.error(`\n[delegation-guard-smoke] ${failed} check(s) failed`);
  process.exit(1);
}
console.log(`\n[delegation-guard-smoke] all ${Object.keys(tests).length} checks passed`);
