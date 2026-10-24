#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type * as Conductor from "../packages/extensions/src/conductor/index.ts";
import type * as Agents from "../packages/extensions/third_party/subagent/agents.ts";
import type * as Runner from "../packages/extensions/third_party/subagent/runner.ts";
import { ROOT, loadExtension, loadModule, fakePi, tmpWorkspace, rmWorkspace } from "../packages/core/eval/harness.ts";

interface Note {
  message: string;
  level: string;
}

interface StatusEntry {
  key: string;
  text: string;
}

interface RecursionBudget {
  maxDepth: number;
  maxDispatches: number;
  dispatchesUsed: number;
}

interface EngagementRecord {
  phase: string;
  recursion: RecursionBudget;
}

interface TraceEntry {
  tool: string;
  target: string;
  status: string;
  [key: string]: unknown;
}

type SpecialistRunResult = Conductor.SpecialistRunResult;
type SpecialistRunner = Conductor.SpecialistRunner;

// The subset of packages/extensions/src/conductor/index.ts this smoke drives directly.
type ConductorModule = Pick<typeof Conductor, "dispatchSpecialist" | "withEngagementLock" | "specialistProtectedPaths" | "specialistRoleDigest" | "runSpecialistProcess" | "ROLE_KEEP" | "ROLE_RUN" | "ENGAGEMENT_BLOCKED_TOOLS">;
type AgentsModule = Pick<typeof Agents, "parseAgentFile">;
type RunnerModule = Pick<typeof Runner, "projectRoleDigest">;

function context(cwd: string, notes: Note[], statuses: StatusEntry[]) {
  return { cwd, ui: { notify: (message: string, level: string) => notes.push({ message, level }), setStatus: (key: string, text: string) => statuses.push({ key, text }) } };
}

async function setup(ws: string) {
  const register = await loadExtension("extensions/conductor/index.ts");
  const pi = fakePi(); register(pi.api);
  const notes: Note[] = []; const statuses: StatusEntry[] = []; const ctx = context(ws, notes, statuses);
  await pi.commands.get("engagement").handler("start", ctx);
  fs.mkdirSync(path.join(ws, ".pi", "agents"), { recursive: true });
  fs.writeFileSync(path.join(ws, ".pi", "agents", "scout.md"), "---\nname: scout\ntools: read\n---\nYou are a scout.\n");
  // The budget and lock checks below run on a role the operator has granted by digest.
  const module = await loadModule<ConductorModule>("extensions/conductor/index.ts");
  process.env.PI_KIT_TRUSTED_PROJECT_ROLES = module.specialistRoleDigest(ws, "scout") ?? "";
  return { pi, notes, statuses };
}

function updateBudget(ws: string, budget: RecursionBudget): void {
  const file = path.join(ws, ".pi", "engagement", "engagement.json");
  const record = JSON.parse(fs.readFileSync(file, "utf8")) as EngagementRecord; record.recursion = budget; fs.writeFileSync(file, JSON.stringify(record, null, 2));
}

function engagement(ws: string): EngagementRecord {
  return JSON.parse(fs.readFileSync(path.join(ws, ".pi", "engagement", "engagement.json"), "utf8")) as EngagementRecord;
}

function traceEntries(ws: string): TraceEntry[] {
  return fs.readFileSync(path.join(ws, ".pi", "trace.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as TraceEntry);
}

async function testDepthCapIsDurableAndRefused(): Promise<void> {
  const ws = tmpWorkspace("pi-kit-conductor-depth-"); const originalDepth = process.env.PI_KIT_CONDUCTOR_DEPTH;
  try {
    const { pi, statuses } = await setup(ws);
    updateBudget(ws, { maxDepth: 1, maxDispatches: 4, dispatchesUsed: 0 });
    let calls = 0;
    const runner: SpecialistRunner = async (_cwd, _agent, _task, childDepth) => { calls++; assert.equal(childDepth, 1); return { ok: true, output: "done" }; };
    const module = await import(pathToFileURL(path.join(ROOT, "packages", "extensions", "src", "conductor", "index.ts")).href + `?depth=${Date.now()}`) as ConductorModule;
    delete process.env.PI_KIT_CONDUCTOR_DEPTH;
    assert.equal((await module.dispatchSpecialist(ws, "scout", "inspect", runner)).ok, true);
    process.env.PI_KIT_CONDUCTOR_DEPTH = "1";
    const refused = await module.dispatchSpecialist(ws, "scout", "recurse", runner);
    assert.deepEqual(refused, { ok: false, reason: "depth cap reached (1/1)" });
    assert.equal(calls, 1, "the runner must not start after a depth refusal");
    const record = engagement(ws);
    assert.equal(record.recursion.dispatchesUsed, 1, "the first reservation persists across a fresh dispatch call");
    await pi.commands.get("engagement").handler("status", context(ws, [], statuses));
    assert.ok(statuses.some((s) => s.key === "conductor-recursion" && /dispatches 1\/4/.test(s.text)), "footer status reports durable cap state");
    const entries = traceEntries(ws);
    const reservation = entries.find((entry) => entry.tool === "conductor:dispatch_specialist" && entry.target === "scout@1; cap allowed");
    assert.deepEqual(Object.fromEntries(["tool", "status"].map((key) => [key, reservation?.[key]])), { tool: "conductor:dispatch_specialist", status: "ok" }, "successful reservation has a structured audit entry");
    const consumption = entries.find((entry) => entry.tool === "conductor:dispatch_budget_consumed");
    assert.deepEqual(Object.fromEntries(["tool", "status"].map((key) => [key, consumption?.[key]])), { tool: "conductor:dispatch_budget_consumed", status: "ok" }, "budget consumption is audited with exact structured fields");
  } finally { if (originalDepth === undefined) delete process.env.PI_KIT_CONDUCTOR_DEPTH; else process.env.PI_KIT_CONDUCTOR_DEPTH = originalDepth; rmWorkspace(ws); }
}

async function testGenericSubagentIsBlockedAndLedgerIsProtected(): Promise<void> {
  const ws = tmpWorkspace("pi-kit-conductor-closure-"); const oldProtected = process.env.PI_KIT_PROTECTED_PATHS;
  try {
    const { pi } = await setup(ws);
    const blocked = await pi.handlers.get("tool_call")({ toolName: "subagent", input: {} }, { cwd: ws, hasUI: false, ui: {} });
    assert.deepEqual(blocked, { block: true, reason: "conductor: an engagement is active, so subagent is blocked; use dispatch_specialist for bounded delegation" });
    const module = await import(pathToFileURL(path.join(ROOT, "packages", "extensions", "src", "conductor", "index.ts")).href + `?protected=${Date.now()}`) as ConductorModule;
    fs.writeFileSync(path.join(ws, ".pi", "agents", "shell-role.md"), "---\nname: shell-role\ntools: read, bash\n---\nunsafe\n");
    const shellRole = await module.dispatchSpecialist(ws, "shell-role", "attempt shell escape", async () => ({ ok: true, output: "must not run" }));
    if (shellRole.ok) assert.fail("bash-capable specialist dispatch unexpectedly succeeded");
    assert.match(shellRole.reason, /materialized tool restriction/, "bash-capable specialist definitions are refused before reservation");
    assert.equal(engagement(ws).recursion.dispatchesUsed, 0, "a rejected shell-capable role cannot consume dispatch budget");
    process.env.PI_KIT_PROTECTED_PATHS = module.specialistProtectedPaths();
    const protectedRegister = await loadExtension("vendor/protected-paths/index.ts"); const protectedPi = fakePi(); protectedRegister(protectedPi.api);
    const protectedCtx = { cwd: ws, hasUI: false, ui: {} };
    for (const [toolName, input] of [["write", { path: ".pi/engagement/engagement.json" }], ["edit", { path: ".pi/engagement/findings/x.json" }], ["bash", { command: "echo x > .pi/engagement/engagement.json" }]] as Array<[string, Record<string, string>]>) {
      const decision = await protectedPi.handlers.get("tool_call")({ toolName, input }, protectedCtx);
      assert.equal(decision?.block, true, `${toolName} must not write the specialist recursion ledger`);
    }
    assert.match(process.env.PI_KIT_PROTECTED_PATHS, /\.env;\.git\/;node_modules\/;.pi\/engagement\//, "specialist environment merges defaults rather than replacing them");
    fs.rmSync(path.join(ws, ".pi", "engagement", "engagement.json"));
    assert.equal(await pi.handlers.get("tool_call")({ toolName: "subagent", input: {} }, { cwd: ws, hasUI: false, ui: {} }), undefined, "generic subagent is only constrained during an active engagement");
  } finally { if (oldProtected === undefined) delete process.env.PI_KIT_PROTECTED_PATHS; else process.env.PI_KIT_PROTECTED_PATHS = oldProtected; rmWorkspace(ws); }
}

async function testAllEngagementWritersShareTheLock(): Promise<void> {
  const ws = tmpWorkspace("pi-kit-conductor-writer-lock-"); const originalDepth = process.env.PI_KIT_CONDUCTOR_DEPTH;
  try {
    const { pi, notes, statuses } = await setup(ws); delete process.env.PI_KIT_CONDUCTOR_DEPTH;
    fs.writeFileSync(path.join(ws, ".pi", "verdicts.json"), JSON.stringify({ verdicts: { verify: { pass: true, at: new Date().toISOString() } } }));
    const module = await import(pathToFileURL(path.join(ROOT, "packages", "extensions", "src", "conductor", "index.ts")).href + `?lock=${Date.now()}`) as ConductorModule;
    let dispatch: Promise<SpecialistRunResult> | undefined; let phaseAttempt: unknown;
    module.withEngagementLock(ws, () => {
      dispatch = module.dispatchSpecialist(ws, "scout", "inspect", async () => ({ ok: true, output: "must not run" }));
      phaseAttempt = pi.commands.get("engagement").handler("phase authorisation", context(ws, notes, statuses));
    });
    const refused = await dispatch;
    if (!refused || refused.ok) assert.fail("dispatch inside the engagement lock was not refused");
    assert.match(refused.reason, /engagement ledger is busy/, "dispatch cannot reserve while another engagement writer holds the shared lock");
    await phaseAttempt;
    assert.equal(engagement(ws).phase, "intake", "phase cannot write while another engagement writer owns the lock");
    await pi.commands.get("engagement").handler("phase authorisation", context(ws, notes, statuses));
    assert.equal(engagement(ws).phase, "authorisation", "phase writer works after the shared lock is released");
    const allowed = await module.dispatchSpecialist(ws, "scout", "inspect", async () => ({ ok: true, output: "done" }));
    assert.equal(allowed.ok, true);
    assert.equal(engagement(ws).recursion.dispatchesUsed, 1, "a later phase write cannot erase a durable dispatch reservation");
  } finally { if (originalDepth === undefined) delete process.env.PI_KIT_CONDUCTOR_DEPTH; else process.env.PI_KIT_CONDUCTOR_DEPTH = originalDepth; rmWorkspace(ws); }
}

async function testBudgetCapIsRefusedBeforeRunner(): Promise<void> {
  const ws = tmpWorkspace("pi-kit-conductor-budget-"); const originalDepth = process.env.PI_KIT_CONDUCTOR_DEPTH;
  try {
    await setup(ws); updateBudget(ws, { maxDepth: 2, maxDispatches: 2, dispatchesUsed: 2 }); delete process.env.PI_KIT_CONDUCTOR_DEPTH;
    const module = await import(pathToFileURL(path.join(ROOT, "packages", "extensions", "src", "conductor", "index.ts")).href + `?budget=${Date.now()}`) as ConductorModule;
    let calls = 0; const refused = await module.dispatchSpecialist(ws, "scout", "runaway", async () => { calls++; return { ok: true, output: "must not run" }; });
    assert.deepEqual(refused, { ok: false, reason: "dispatch budget exhausted (2/2)" }); assert.equal(calls, 0, "budget refusal must precede child creation");
    const trace = fs.readFileSync(path.join(ws, ".pi", "trace.jsonl"), "utf8"); assert.match(trace, /"status":"error"/, "refused attempts are audited");
  } finally { if (originalDepth === undefined) delete process.env.PI_KIT_CONDUCTOR_DEPTH; else process.env.PI_KIT_CONDUCTOR_DEPTH = originalDepth; rmWorkspace(ws); }
}

function selectContext(ws: string, pick: (options: string[]) => string | undefined, asked: string[][]) {
  return { cwd: ws, hasUI: true, ui: { select: async (_title: string, options: string[]) => { asked.push(options); return pick(options); } } };
}

// ORC-4: a project specialist role gets subagent's trust gate before it reserves or launches.
async function testProjectSpecialistNeedsTrust(): Promise<void> {
  const ws = tmpWorkspace("pi-kit-conductor-trust-"); const originalDepth = process.env.PI_KIT_CONDUCTOR_DEPTH;
  try {
    await setup(ws); delete process.env.PI_KIT_TRUSTED_PROJECT_ROLES; delete process.env.PI_KIT_CONDUCTOR_DEPTH;
    const module = await import(pathToFileURL(path.join(ROOT, "packages", "extensions", "src", "conductor", "index.ts")).href + `?trust=${Date.now()}`) as ConductorModule;
    let calls = 0; const runner: SpecialistRunner = async () => { calls++; return { ok: true, output: "done" }; };
    const headless = await module.dispatchSpecialist(ws, "scout", "inspect", runner);
    assert.deepEqual(headless, { ok: false, reason: "Blocked: project-local agents require interactive operator approval." }, "a headless dispatch of an ungranted project role is blocked");
    const asked: string[][] = [];
    const declined = await module.dispatchSpecialist(ws, "scout", "inspect", runner, undefined, undefined, selectContext(ws, (options) => options[0], asked));
    assert.deepEqual(declined, { ok: false, reason: "Canceled: project-local agents not approved." }, "accepting the highlighted first option declines");
    assert.deepEqual(asked[0], [module.ROLE_KEEP, module.ROLE_RUN], "the approval question starts on No");
    assert.equal(calls, 0, "no specialist starts without trust");
    assert.equal(engagement(ws).recursion.dispatchesUsed, 0, "a trust refusal costs no dispatch budget");
    const approved = await module.dispatchSpecialist(ws, "scout", "inspect", runner, undefined, undefined, selectContext(ws, () => module.ROLE_RUN, asked));
    assert.equal(approved.ok, true, "an approved project role runs"); assert.equal(calls, 1);
    process.env.PI_KIT_TRUSTED_PROJECT_ROLES = `other;${module.specialistRoleDigest(ws, "scout") ?? ""}`;
    const granted = await module.dispatchSpecialist(ws, "scout", "inspect", runner);
    assert.equal(granted.ok, true, "an exact digest grant runs without asking"); assert.equal(calls, 2);
    // The digest is subagent's projectRoleDigest, so one grant covers the role in both tools.
    const agents = await loadModule<AgentsModule>("vendor/subagent/agents.ts"); const runnerModule = await loadModule<RunnerModule>("vendor/subagent/runner.ts");
    const file = path.join(ws, ".pi", "agents", "scout.md"); fs.writeFileSync(file, "---\nname: scout\ndescription: a scout\ntools: read, grep\nmodel: some/model\n---\nYou are a scout.\n");
    const parsed = agents.parseAgentFile(fs.readFileSync(file, "utf8"), "project", file); assert.ok(parsed, "subagent parses the role");
    assert.equal(module.specialistRoleDigest(ws, "scout"), runnerModule.projectRoleDigest(parsed), "conductor and subagent compute the same role digest");
    const changed = await module.dispatchSpecialist(ws, "scout", "inspect", runner);
    assert.match(changed.ok ? "" : changed.reason, /^Blocked: project-local agents/, "an edited role no longer matches the old grant");
    // The real runner re-reads the role and refuses content that was not the content approved.
    delete process.env.PI_KIT_TRUSTED_PROJECT_ROLES;
    const unapproved = await module.runSpecialistProcess(ws, "scout", "inspect", 1);
    assert.match(unapproved.ok ? "" : unapproved.reason, /not approved, or changed after it was approved/);
    const swapped = await module.dispatchSpecialist(ws, "scout", "inspect", async (cwd, agent, task, depth) => { fs.writeFileSync(file, "---\nname: scout\ntools: read\n---\nSwapped prompt.\n"); return module.runSpecialistProcess(cwd, agent, task, depth); }, undefined, undefined, selectContext(ws, () => module.ROLE_RUN, asked));
    assert.match(swapped.ok ? "" : swapped.reason, /changed after it was approved/, "a role edited between approval and launch does not launch");
  } finally { if (originalDepth === undefined) delete process.env.PI_KIT_CONDUCTOR_DEPTH; else process.env.PI_KIT_CONDUCTOR_DEPTH = originalDepth; rmWorkspace(ws); }
}

// ORC-3: the sibling delegation tools are blocked exactly like subagent during an engagement.
async function testSiblingDelegationToolsAreBlocked(): Promise<void> {
  const ws = tmpWorkspace("pi-kit-conductor-siblings-");
  try {
    const { pi } = await setup(ws);
    const module = await loadModule<ConductorModule>("extensions/conductor/index.ts");
    assert.deepEqual([...module.ENGAGEMENT_BLOCKED_TOOLS], ["subagent", "workflow_run", "dual_review"]);
    for (const toolName of ["workflow_run", "dual_review"]) {
      const decision = await pi.handlers.get("tool_call")({ toolName, input: {} }, { cwd: ws, hasUI: false, ui: {} });
      assert.deepEqual(decision, { block: true, reason: `conductor: an engagement is active, so ${toolName} is blocked; use dispatch_specialist for bounded delegation` });
    }
    assert.equal(await pi.handlers.get("tool_call")({ toolName: "workflow_status", input: {} }, { cwd: ws, hasUI: false, ui: {} }), undefined, "tools that start no child stay available");
    // The block ends when the engagement closes, through the supported command, not by deleting the record.
    const notes: Note[] = []; const statuses: StatusEntry[] = [];
    fs.writeFileSync(path.join(ws, ".pi", "verdicts.json"), JSON.stringify({ verdicts: { verify: { pass: true, at: new Date().toISOString() } } }));
    await pi.commands.get("engagement").handler("phase reporting", context(ws, notes, statuses));
    for (const toolName of module.ENGAGEMENT_BLOCKED_TOOLS) assert.equal((await pi.handlers.get("tool_call")({ toolName, input: {} }, { cwd: ws, hasUI: false, ui: {} }))?.block, true, `${toolName} stays blocked before close-out`);
    await pi.commands.get("engagement").handler("phase close-out", context(ws, notes, statuses));
    assert.equal(engagement(ws).phase, "close-out", notes.map((note) => note.message).join("; "));
    for (const toolName of module.ENGAGEMENT_BLOCKED_TOOLS) assert.equal(await pi.handlers.get("tool_call")({ toolName, input: {} }, { cwd: ws, hasUI: false, ui: {} }), undefined, `${toolName} is allowed again once the engagement is closed`);
    fs.rmSync(path.join(ws, ".pi", "engagement", "engagement.json"));
    for (const toolName of ["workflow_run", "dual_review"]) assert.equal(await pi.handlers.get("tool_call")({ toolName, input: {} }, { cwd: ws, hasUI: false, ui: {} }), undefined, `${toolName} is only constrained during an engagement`);
  } finally { rmWorkspace(ws); }
}

import { pathToFileURL } from "node:url";
// Stands in for the pi child (loaded with --import before cli.js): records argv and stdin,
// prints one assistant message and exits before pi starts.
const STDIN_CHILD_HOOK = [
  "import fs from 'node:fs';",
  "const input = fs.readFileSync(0, 'utf8');",
  "fs.writeFileSync(process.env.PI_KIT_SMOKE_CHILD_OUT, JSON.stringify({ argv: process.argv.slice(2), stdin: input }));",
  "process.stdout.write(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'child-ok' }] } }) + '\\n');",
  "process.exit(0);",
].join("\n");

// ORC-7: a specialist task larger than Linux's 128 KiB MAX_ARG_STRLEN reaches the child over
// stdin, never argv: argv made spawn fail with E2BIG and is visible through ps.
async function testSpecialistTaskTravelsOverStdin(): Promise<void> {
  const ws = tmpWorkspace("pi-kit-conductor-specialist-stdin-");
  const key = Symbol.for("pi-kit.delegation"); const registry: Record<symbol, unknown> = globalThis; const previousGuard = registry[key];
  try {
    await setup(ws);
    const module = await loadModule<ConductorModule>("extensions/conductor/index.ts");
    const hook = path.join(ws, "child-hook.mjs"); const seenFile = path.join(ws, "seen.json"); fs.writeFileSync(hook, STDIN_CHILD_HOOK);
    registry[key] = { prepareChild: () => ({ ok: true, env: { ...process.env, NODE_OPTIONS: `--import ${pathToFileURL(hook).href}`, PI_KIT_SMOKE_CHILD_OUT: seenFile }, slot: { attach: () => undefined, settle: () => undefined } }) };
    const task = `inspect ${"y".repeat(140 * 1024)}`;
    const run = await module.runSpecialistProcess(ws, "scout", task, 1);
    assert.deepEqual(run, { ok: true, output: "child-ok" }, "a task over 128 KiB still launches the specialist");
    const seen: unknown = JSON.parse(fs.readFileSync(seenFile, "utf8"));
    assert.ok(typeof seen === "object" && seen !== null && "argv" in seen && "stdin" in seen && Array.isArray(seen.argv));
    assert.equal(seen.argv.some((arg) => typeof arg === "string" && arg.includes("inspect")), false, "the task is not on the child's argv");
    assert.equal(seen.stdin, `Task: ${task}`, "the child reads the task from stdin");
  } finally {
    if (previousGuard === undefined) Reflect.deleteProperty(registry, key); else registry[key] = previousGuard;
    rmWorkspace(ws);
  }
}

const tests: Array<[string, () => Promise<void>]> = [
  ["gives project specialist roles subagent's trust gate, starting on No", testProjectSpecialistNeedsTrust],
  ["blocks workflow_run and dual_review like subagent until close-out", testSiblingDelegationToolsAreBlocked],
  ["durably refuses a depth-cap runaway with structured reservation audits", testDepthCapIsDurableAndRefused],
  ["refuses exhausted fan-out budget before spawning", testBudgetCapIsRefusedBeforeRunner],
  ["blocks generic delegation and protects the specialist ledger", testGenericSubagentIsBlockedAndLedgerIsProtected],
  ["serializes phase and dispatch writers through one lock", testAllEngagementWritersShareTheLock],
  ["sends the specialist task over stdin, never argv", testSpecialistTaskTravelsOverStdin],
];
let failed = 0;
const originalGrants = process.env.PI_KIT_TRUSTED_PROJECT_ROLES;
for (const [name, test] of tests) { try { await test(); console.log(`  OK: ${name}`); } catch (error) { failed++; console.error(`  FAIL: ${name}\n    ${error instanceof Error ? error.stack || error.message : String(error)}`); } finally { if (originalGrants === undefined) delete process.env.PI_KIT_TRUSTED_PROJECT_ROLES; else process.env.PI_KIT_TRUSTED_PROJECT_ROLES = originalGrants; } }
if (failed) { console.error(`\n[conductor-recursion-smoke] ${failed}/${tests.length} FAILED`); process.exit(1); }
console.log(`\n[conductor-recursion-smoke] all ${tests.length} checks passed`);
