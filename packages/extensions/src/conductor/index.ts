import { parseFrontmatter, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import os from "node:os";
import { Type } from "typebox";
import { finalAssistantOutput, pendingValidatorFindings, registerValidatorTools } from "./validate/validator.ts";
import { appendFileSafe, createFileExclusive, openFileExclusive, writeFileSafe } from "./shared/safe-fs.ts";

// conductor: durable, restartable engagement lifecycle state. It only contributes
// context for context-sieve to inject; it never injects a system prompt itself.

export const PHASES = [
  "intake",
  "authorisation",
  "scoping",
  "recon-planning",
  "execution",
  "evidence",
  "independent-validation",
  "reporting",
  "close-out",
] as const;

type Phase = (typeof PHASES)[number];

interface EngagementHistory {
  phase: Phase;
  at: string;
  note?: string;
}

export interface RecursionBudget {
  maxDepth: number;
  maxDispatches: number;
  dispatchesUsed: number;
}

interface Engagement {
  version: 2;
  phase: Phase;
  startedAt: string;
  updatedAt: string;
  history: EngagementHistory[];
  recursion: RecursionBudget;
}

interface TraceEntry {
  ts: string;
  turn: number;
  kind: "call" | "result";
  tool: string;
  target?: string;
  argsHash: string;
  status?: "ok" | "error";
}

const VERDICT_MAX_AGE_MS = Number(process.env.PI_KIT_VERDICT_MAX_AGE_MS) || 24 * 60 * 60 * 1000;
export const DEFAULT_RECURSION_BUDGET: Readonly<RecursionBudget> = Object.freeze({ maxDepth: 2, maxDispatches: 8, dispatchesUsed: 0 });
const AGENT_NAME = /^[a-z0-9][a-z0-9-]*$/;
const LOCK_STALE_MS = 60_000;
// Shell access is deliberately excluded in Phase 4: a bash-capable child could invoke
// pi directly and evade the wrapper-owned durable reservation boundary.
const SPECIALIST_ALLOWED_TOOLS = new Set(["read", "grep", "find", "ls", "write", "edit"]);
const DEFAULT_PROTECTED_PATHS = [".env", ".git/", "node_modules/"];
export const ENGAGEMENT_BLOCKED_TOOLS: ReadonlySet<string> = new Set(["subagent", "workflow_run", "dual_review"]);

function engagementFile(cwd: string): string {
  return path.join(cwd, ".pi", "engagement", "engagement.json");
}

// B-005: contribution files are scoped per session so concurrent sessions sharing a cwd
// (child agents do) cannot overwrite each other. The resolver is duplicated in each producer
// (not imported) because every extension must stay independently extractable
// (packages/core/verify.ts self-containment lint).
const SESSION_ID_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
let currentSessionId: string | undefined;

function isSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID_RE.test(value);
}

function resolveSessionId(sessionManager?: unknown): string | undefined {
  try {
    const id = (sessionManager as { getSessionId?: () => unknown } | undefined)?.getSessionId?.();
    return isSessionId(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

function contribDir(cwd: string, sessionId: string | undefined = currentSessionId): string {
  const base = path.join(cwd, ".pi", "ctx-contributions");
  return isSessionId(sessionId) ? path.join(base, "sessions", sessionId) : base;
}

function contributionFile(cwd: string): string {
  return path.join(contribDir(cwd), "conductor.json");
}

function isPhase(value: unknown): value is Phase {
  return typeof value === "string" && (PHASES as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHistoryEntry(value: unknown): value is EngagementHistory {
  return isRecord(value) && isPhase(value.phase) && typeof value.at === "string" && (value.note === undefined || typeof value.note === "string");
}

// ORC-10: an engagement is checked field by field, history entries included, never cast.
function isEngagement(value: unknown): value is Engagement {
  if (!isRecord(value)) return false;
  const record = value;
  const budget = isRecord(record.recursion) ? record.recursion : null;
  const validBudget = !!budget && typeof budget.maxDepth === "number" && Number.isSafeInteger(budget.maxDepth) && budget.maxDepth >= 0 &&
    typeof budget.maxDispatches === "number" && Number.isSafeInteger(budget.maxDispatches) && budget.maxDispatches > 0 &&
    typeof budget.dispatchesUsed === "number" && Number.isSafeInteger(budget.dispatchesUsed) && budget.dispatchesUsed >= 0;
  return !!record && record.version === 2 && isPhase(record.phase) && typeof record.startedAt === "string" &&
    typeof record.updatedAt === "string" && Array.isArray(record.history) && record.history.every(isHistoryEntry) && validBudget;
}

function readEngagement(cwd: string): Engagement | null {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(engagementFile(cwd), "utf8"));
    // A history entry of the wrong shape is dropped; the rest of the record must still check.
    const parsed = isRecord(raw) && Array.isArray(raw.history) ? { ...raw, history: raw.history.filter(isHistoryEntry) } : raw;
    if (isEngagement(parsed)) return parsed;
    // Phase 1-3 records are safely upgraded on their next durable mutation.
    const legacy = isRecord(parsed) ? parsed : null;
    if (legacy?.version === 1 && isPhase(legacy.phase) && typeof legacy.startedAt === "string" && typeof legacy.updatedAt === "string" && Array.isArray(legacy.history)) {
      const history: unknown[] = legacy.history;
      return { version: 2, phase: legacy.phase, startedAt: legacy.startedAt, updatedAt: legacy.updatedAt, history: history.filter(isHistoryEntry), recursion: { ...DEFAULT_RECURSION_BUDGET } };
    }
    return null;
  } catch {
    return null;
  }
}

// Atomic write: a reader on another turn never sees a partially-written engagement record.
function saveEngagement(cwd: string, engagement: Engagement): void {
  // Workspace state is written without following committed symlinks (./shared/safe-fs.ts).
  writeFileSafe(engagementFile(cwd), JSON.stringify(engagement, null, 2), { root: cwd });
}

// Shared completion contract: tests/verifier-board-trust-smoke.ts pins all local readers.
function isStale(at: unknown): boolean {
  if (typeof at !== "string") return true;
  const parsed = Date.parse(at);
  const now = Date.now();
  return Number.isNaN(parsed) || parsed > now || now - parsed > VERDICT_MAX_AGE_MS;
}

// Sources reserved for independent, non-model writers. Kept in parity with verifier-board's
// isTrustedVerdictSource (self-containment forbids importing it): an untrusted-only board
// must not satisfy completion (WU-1 trust hardening).
const TRUSTED_SOURCE_PATTERNS: RegExp[] = [/^verify$/i, /^review$/i, /^validator:/i];

function isTrustedVerdictSource(source: unknown): boolean {
  const s = typeof source === "string" ? source.trim() : "";
  return s.length > 0 && TRUSTED_SOURCE_PATTERNS.some((p) => p.test(s));
}

// verify-gate's in-flight marker, read without importing verify-gate (self-containment).
// The TTL mirrors verify-gate.isVerifyPendingActive (PI_KIT_VERIFY_PENDING_TTL_MS,
// default 30 min) so a marker left by a SIGKILLed/crashed session cannot block
// phase advance forever. REL-5: verify-gate writes one .pi/verify-pending/<run>.json per
// run; the legacy flat .pi/verify-pending.json is still honoured.
function verifyPending(cwd: string): boolean {
  let runs: string[] = [];
  try {
    const dir = path.join(cwd, ".pi", "verify-pending");
    runs = fs.readdirSync(dir).filter((name) => name.endsWith(".json")).map((name) => path.join(dir, name));
  } catch {
    /* no per-run markers */
  }
  return [path.join(cwd, ".pi", "verify-pending.json"), ...runs].some(freshPendingMarker);
}

function freshPendingMarker(file: string): boolean {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const marker: unknown = JSON.parse(raw);
    const value = isRecord(marker) ? marker.startedAt ?? "" : "";
    // Date.parse coerces non-strings with ToString; booleans and plain objects never parse, so they map to "".
    const text = typeof value === "string" ? value : typeof value === "number" ? String(value) : Array.isArray(value) ? value.join(",") : "";
    let startedAt = Date.parse(text);
    if (Number.isNaN(startedAt)) startedAt = fs.statSync(file).mtimeMs;
    const ttl = Number(process.env.PI_KIT_VERIFY_PENDING_TTL_MS);
    const ttlMs = Number.isFinite(ttl) && ttl > 0 ? Math.floor(ttl) : 30 * 60 * 1000;
    return Date.now() - startedAt <= ttlMs;
  } catch {
    return false;
  }
}

// Kept in parity with verifier-board/orchestrator's own copies: self-containment
// forbids importing another extension, so this fail-closed read-only gate is local.
export function verifierBoardBlocked(cwd: string): { blocked: boolean; failing: string[] } {
  if (verifyPending(cwd)) return { blocked: true, failing: ["verify (in progress)"] };
  const file = path.join(cwd, ".pi", "verdicts.json");
  let board: unknown;
  try {
    if (!fs.existsSync(file)) return { blocked: true, failing: ["(no verdicts recorded — verification has not run)"] };
    board = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return { blocked: true, failing: ["(verdict board unreadable or corrupt)"] };
  }
  const verdicts = isRecord(board) ? board.verdicts : undefined;
  if (!isRecord(verdicts)) {
    return { blocked: true, failing: ["(verdict board malformed)"] };
  }
  const sources = Object.keys(verdicts);
  if (sources.length === 0) return { blocked: true, failing: ["(no verdicts recorded yet)"] };
  const failing = sources.filter((source) => {
    const verdict = verdicts[source];
    return !isRecord(verdict) || verdict.pass !== true || isStale(verdict.at);
  });
  if (failing.length > 0) return { blocked: true, failing };
  // Every recorded source passes and is fresh, but completion also requires at least one
  // trusted, independent source (WU-1).
  if (!sources.some((source) => isTrustedVerdictSource(source))) {
    return { blocked: true, failing: ["(no trusted verdict source — need verify, review, or validator:<id>)"] };
  }
  return { blocked: false, failing: [] };
}

function shortHash(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function appendTrace(cwd: string, entry: TraceEntry): void {
  try {
    appendFileSafe(path.join(cwd, ".pi", "trace.jsonl"), JSON.stringify(entry) + "\n", { root: cwd });
  } catch {
    /* best effort: audit logging never breaks an engagement operation */
  }
}

function auditTransition(cwd: string, now: string, tool: string, target: string, status: "ok" | "error"): void {
  appendTrace(cwd, { ts: now, turn: 0, kind: "result", tool, target, argsHash: shortHash(`${tool}:${target}`), status });
}

function recursionStatus(budget: RecursionBudget, depth = currentDepth()): string {
  return `depth ${depth}/${budget.maxDepth} · dispatches ${budget.dispatchesUsed}/${budget.maxDispatches}`;
}

function setRecursionStatus(ui: { setStatus?: (key: string, text: string) => void } | undefined, engagement: Engagement | null): void {
  if (engagement) ui?.setStatus?.("conductor-recursion", `Conductor: ${recursionStatus(engagement.recursion)}`);
}

function currentDepth(): number {
  const raw = process.env.PI_KIT_CONDUCTOR_DEPTH;
  if (raw === undefined) return 0;
  return /^\d+$/.test(raw) && Number.isSafeInteger(Number(raw)) ? Number(raw) : -1;
}

export function withEngagementLock<T>(cwd: string, operation: () => T): T | { ok: false; reason: string } {
  const lock = path.join(cwd, ".pi", "engagement", "recursion.lock");
  let fd: number | undefined;
  try {
    fd = openFileExclusive(lock, { root: cwd }) ?? undefined;
    if (fd === undefined) {
      try { if (Date.now() - fs.lstatSync(lock).mtimeMs > LOCK_STALE_MS) fs.rmSync(lock, { force: true }); } catch { /* fail closed below */ }
      fd = openFileExclusive(lock, { root: cwd }) ?? undefined;
      if (fd === undefined) return { ok: false, reason: "engagement ledger is busy or unreadable" };
    }
    try { return operation(); } finally {
      try { if (fd !== undefined) fs.closeSync(fd); } catch { /* release best effort */ }
      try { fs.rmSync(lock, { force: true }); } catch { /* stale lock is fail-closed */ }
    }
  } catch { return { ok: false, reason: "engagement ledger is unavailable" }; }
}

export type SpecialistRunResult = { ok: true; output: string } | { ok: false; reason: string };
export type SpecialistRunner = (cwd: string, agent: string, task: string, childDepth: number, signal?: AbortSignal, onUpdate?: (text: string) => void) => Promise<SpecialistRunResult>;

interface SpecialistDefinition { prompt: string; tools: string[]; digest: string }

// Same text conversion as the subagent role loader, so a frontmatter list and a comma string agree.
function frontmatterText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((item: unknown) => frontmatterText(item) ?? "").join(",");
  if (typeof value === "object") return Object.prototype.toString.call(value);
  return typeof value === "number" || typeof value === "boolean" || typeof value === "bigint" ? String(value) : "";
}

// The digest is computed exactly as subagent's projectRoleDigest (name, system prompt, tools,
// model), so one PI_KIT_TRUSTED_PROJECT_ROLES grant covers a role for both tools. The prompt and
// tools that launch are the ones the digest covers (tests/conductor-recursion-smoke.ts).
function agentDefinition(cwd: string, agent: string): SpecialistDefinition | null {
  try {
    const { frontmatter, body } = parseFrontmatter(fs.readFileSync(path.join(cwd, ".pi", "agents", `${agent}.md`), "utf8"));
    const tools = frontmatterText(frontmatter.tools)?.split(",").map((tool) => tool.trim()).filter(Boolean) ?? [];
    if (tools.length === 0 || !tools.every((tool) => SPECIALIST_ALLOWED_TOOLS.has(tool))) return null;
    const name = frontmatterText(frontmatter.name) ?? agent;
    const model = frontmatterText(frontmatter.model)?.trim() || "";
    const digest = crypto.createHash("sha256").update(JSON.stringify({ name, systemPrompt: body, tools, model })).digest("hex");
    return { prompt: body, tools, digest };
  } catch { return null; }
}

/** The PI_KIT_TRUSTED_PROJECT_ROLES digest of a project specialist role, or null when it is not a valid role. */
export function specialistRoleDigest(cwd: string, agent: string): string | null {
  return AGENT_NAME.test(agent) ? agentDefinition(cwd, agent)?.digest ?? null : null;
}

function grantedDigests(): string[] {
  return (process.env.PI_KIT_TRUSTED_PROJECT_ROLES ?? "").split(";").map((entry) => entry.trim()).filter(Boolean);
}

// Digests the operator approved for a launch that is in flight. runSpecialistProcess re-reads the
// role file, and refuses unless what it reads is still the content that was approved.
const approvedLaunches = new Map<string, number>();
function launchApproved(digest: string): boolean { return grantedDigests().includes(digest) || (approvedLaunches.get(digest) ?? 0) > 0; }

export interface RoleApprovalContext {
  hasUI?: boolean;
  ui?: { select?: (title: string, options: string[], opts?: { timeout?: number }) => Promise<string | undefined> };
}
export const ROLE_KEEP = "No, do not run this project role";
export const ROLE_RUN = "Yes, run it (only for a trusted repository)";

function approvalTimeoutMs(): number {
  const n = Number(process.env.PI_KIT_FIREWALL_PROMPT_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 15 * 60_000;
}

// Every specialist role comes from the project's .pi/agents, so it gets the gate subagent applies
// to project roles: an exact digest grant, or the operator's approval in an interactive session.
// The question starts on "No" (tests/conductor-recursion-smoke.ts).
async function specialistTrustError(cwd: string, agent: string, digest: string, approval: RoleApprovalContext | undefined): Promise<string | null> {
  const select = approval?.ui?.select;
  if (!approval?.hasUI || typeof select !== "function") return "Blocked: project-local agents require interactive operator approval.";
  const choice = await select.call(approval.ui, `Run project-local specialist "${agent}"?\nSource: ${path.join(cwd, ".pi", "agents", `${agent}.md`)}\nDigest: ${digest}`, [ROLE_KEEP, ROLE_RUN], { timeout: approvalTimeoutMs() });
  return choice === ROLE_RUN ? null : "Canceled: project-local agents not approved.";
}
export function specialistProtectedPaths(): string {
  const inherited = process.env.PI_KIT_PROTECTED_PATHS?.split(";").map((entry) => entry.trim()).filter(Boolean) ?? [...DEFAULT_PROTECTED_PATHS];
  if (!inherited.some((entry) => entry.replace(/\\/g, "/").replace(/\/+$/, "") === ".pi/engagement")) inherited.push(".pi/engagement/");
  return inherited.join(";");
}
// A compiled `pi` host passes its own executable as process.execPath; prepending the cli.js
// script then makes pi parse that path as the first prompt. Only a JS runtime gets the script.
const SPECIALIST_JS_RUNTIMES = new Set(["node", "nodejs", "bun", "deno"]);
function specialistArgv(cli: string, args: string[], execPath: string = process.execPath): string[] {
  const runtime = execPath.replace(/\\/g, "/").split("/").pop()?.toLowerCase().replace(/\.(?:exe|cmd|bat)$/, "") ?? "";
  return SPECIALIST_JS_RUNTIMES.has(runtime) ? [cli, ...args] : [...args];
}

export interface SpecialistBounds {
  streamCapBytes: number;
  idleTimeoutMs: number;
  maxRuntimeMs: number;
}

// Bounds mirror PI_KIT_SUBAGENT_* but are separate: a conductor specialist is a different
// process class with its own budget. A specialist with no bound could stream or hang forever
// and pin the parent tool call.
export function specialistBounds(env: Record<string, string | undefined> = process.env): SpecialistBounds {
  const int = (raw: string | undefined, fallback: number, min: number): number => {
    const n = Number(raw);
    return Number.isFinite(n) && n >= min ? Math.floor(n) : fallback;
  };
  return {
    streamCapBytes: int(env.PI_KIT_SPECIALIST_STREAM_CAP_BYTES, 256 * 1024 * 1024, 64 * 1024),
    idleTimeoutMs: int(env.PI_KIT_SPECIALIST_IDLE_TIMEOUT_MS, 15 * 60 * 1000, 0),
    maxRuntimeMs: int(env.PI_KIT_SPECIALIST_MAX_RUNTIME_MS, 0, 0),
  };
}

// The slice of a spawned child the stream reader uses (a ChildProcess, or a fake in the smoke).
export interface SpecialistChildProcess {
  kill(signal: NodeJS.Signals): unknown;
  stdout?: { on(event: "data", listener: (data: Buffer) => void): unknown } | null;
  stderr?: { on(event: "data", listener: (data: Buffer) => void): unknown } | null;
  once(event: "close", listener: (code: number | null) => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
}

export interface SpecialistChildStream {
  code: number;
  stderr: string;
  messages: Array<{ role?: unknown; content?: unknown }>;
  killed?: string | undefined;
}

// Stream one specialist child with the shared budgets. Exported so the kill behaviour can be
// exercised offline with a fake child (tests/conductor-specialist-bounds-smoke.ts).
export function streamSpecialistChild(
  proc: SpecialistChildProcess,
  bounds: SpecialistBounds,
  signal: AbortSignal | undefined,
  onUpdate?: (text: string) => void,
): Promise<SpecialistChildStream> {
  return new Promise((resolve) => {
    let buffer = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const messages: Array<{ role?: unknown; content?: unknown }> = [];
    let exited = false;
    let killed: string | undefined;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let wallTimer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => stop("signal");
    const cleanup = () => {
      exited = true;
      if (escalation) clearTimeout(escalation);
      if (idleTimer) clearTimeout(idleTimer);
      if (wallTimer) clearTimeout(wallTimer);
      signal?.removeEventListener("abort", onAbort);
    };
    const stop = (reason: string) => {
      if (exited || killed) return;
      killed = reason;
      try { proc.kill("SIGTERM"); } catch { /* already gone */ }
      escalation = setTimeout(() => { if (!exited) { try { proc.kill("SIGKILL"); } catch { /* already gone */ } } }, 5000);
      escalation.unref();
    };
    const armIdle = () => {
      if (exited || bounds.idleTimeoutMs <= 0) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => stop("idle-timeout"), bounds.idleTimeoutMs);
      idleTimer.unref();
    };
    const line = (raw: string) => {
      try {
        const event: unknown = JSON.parse(raw);
        if (isRecord(event) && (event.type === "message_end" || event.type === "tool_result_end") && isRecord(event.message)) { messages.push(event.message); onUpdate?.("received child progress"); }
      } catch { /* only JSON stream messages are trusted */ }
    };
    proc.stdout?.on("data", (data: Buffer) => {
      if (exited) return;
      armIdle();
      stdoutBytes += data.length;
      if (stdoutBytes > bounds.streamCapBytes) { stop("stream-cap"); return; }
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      lines.forEach(line);
    });
    proc.stderr?.on("data", (data: Buffer) => {
      if (exited) return;
      armIdle();
      stderrBytes += data.length;
      if (stderrBytes > bounds.streamCapBytes) { stop("stream-cap"); return; }
      stderr += data.toString();
    });
    proc.once("close", (code: number | null) => {
      cleanup();
      if (buffer.trim()) line(buffer);
      resolve({ code: killed ? 1 : (code ?? 1), stderr, messages, killed });
    });
    proc.once("error", (error: Error) => {
      cleanup();
      resolve({ code: 1, stderr: stderr || String(error), messages, killed });
    });
    if (signal) { if (signal.aborted) stop("signal"); else signal.addEventListener("abort", onAbort, { once: true }); }
    armIdle();
    if (bounds.maxRuntimeMs > 0) { wallTimer = setTimeout(() => stop("wall-clock"), bounds.maxRuntimeMs); wallTimer.unref(); }
  });
}

// A copy of subagent's READ_ONLY_TOOLS and isReadOnlyRole (third_party/subagent/launch.ts): only
// read, grep, find and ls can only read; bash, powershell and any extension or MCP tool can change
// state. delegation-guard charges a read-only launch to the recovery budget, so a specialist must be
// reported read-only under the same rule as a subagent role. tests/conductor-specialist-bounds-smoke.ts
// pins the two copies to each other.
export const SPECIALIST_READ_TOOLS: ReadonlySet<string> = new Set(["read", "grep", "find", "ls"]);
export function isReadOnlySpecialist(tools: readonly string[]): boolean {
  return tools.length > 0 && tools.every((t) => SPECIALIST_READ_TOOLS.has(t));
}

type GuardRegistry = { prepareChild(request: Record<string, unknown>): { ok: true; env: Record<string, string | undefined>; slot: { attach(pid: number | undefined): void; settle(outcome: string): void } } | { ok: false; reason: string } };
function guardRegistry(): GuardRegistry | undefined { return (globalThis as Record<symbol, unknown>)[Symbol.for("pi-kit.delegation")] as GuardRegistry | undefined; }

export const runSpecialistProcess: SpecialistRunner = async (cwd, agent, task, childDepth, signal, onUpdate) => {
  if (signal?.aborted) return { ok: false, reason: "specialist cancelled before launch" };
  const definition = agentDefinition(cwd, agent); if (!definition) return { ok: false, reason: `specialist role is missing a materialized tool restriction: ${agent}` };
  if (!launchApproved(definition.digest)) return { ok: false, reason: `specialist role ${agent} is not approved, or changed after it was approved` };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-conductor-specialist-")); const promptFile = path.join(dir, "agent.md");
  try {
    createFileExclusive(promptFile, definition.prompt, { root: dir, mode: 0o600 });
    const bounds = specialistBounds();
    const cli = fileURLToPath(new URL("./cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
    const args = ["--mode", "json", "-p", "--no-session", "--tools", definition.tools.join(","), "--append-system-prompt", promptFile];
    // The specialist keeps the operator's installed extensions (its tools include MCP servers), so
    // delegation-guard supplies only the environment: the required-protection list the child's own
    // guard verifies before any tool runs (it fails closed when one is not loaded), and the effort
    // ledger, so specialists share the request's delegation budget like every other child.
    const guard = guardRegistry();
    if (!guard) return { ok: false, reason: "specialist not started: the delegation-guard extension is not loaded, so the specialist cannot be given the mandatory protections and an effort budget" };
    const prepared = guard.prepareChild({ cwd, kind: "discretionary", role: agent, readOnly: isReadOnlySpecialist(definition.tools), isolation: "ambient", baseEnv: { ...process.env } });
    if (!prepared.ok) return { ok: false, reason: `specialist not started: ${prepared.reason}` };
    const proc = spawn(process.execPath, specialistArgv(cli, args), { cwd, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: { ...prepared.env, PI_KIT_INTERNAL_CHILD: "1", PI_KIT_CONDUCTOR_DEPTH: String(childDepth), PI_KIT_PROTECTED_PATHS: specialistProtectedPaths() } });
    // The task goes over stdin (print mode merges it into the prompt), never argv: one argument is
    // capped at MAX_ARG_STRLEN (spawn E2BIG) and argv is readable by any local user through ps.
    proc.stdin.on("error", () => { /* an early exit is reported through the exit code */ });
    proc.stdin.end(`Task: ${task}`);
    prepared.slot.attach(proc.pid);
    proc.once("close", () => prepared.slot.settle("closed"));
    proc.once("error", () => prepared.slot.settle("error"));
    const result = await streamSpecialistChild(proc, bounds, signal, onUpdate ? (text) => onUpdate(`[${agent}] ${text}`) : undefined);
    if (signal?.aborted) return { ok: false, reason: "specialist cancelled" };
    if (result.killed) return { ok: false, reason: `specialist child stopped by ${result.killed}` };
    if (result.code !== 0) return { ok: false, reason: result.stderr.trim() || `specialist child exited ${result.code}` };
    const output = finalAssistantOutput(result.messages);
    return output ? { ok: true, output } : { ok: false, reason: "specialist child returned no assistant output" };
  } catch (error) { return { ok: false, reason: `specialist child failed: ${error instanceof Error ? error.message : String(error)}` }; }
  finally { try { fs.unlinkSync(promptFile); } catch { /* ignore */ } try { fs.rmdirSync(dir); } catch { /* ignore */ } }
};

export async function dispatchSpecialist(cwd: string, agent: string, task: string, runner: SpecialistRunner = runSpecialistProcess, signal?: AbortSignal, onUpdate?: (text: string) => void, approval?: RoleApprovalContext): Promise<SpecialistRunResult> {
  if (signal?.aborted) return { ok: false, reason: "specialist cancelled before reservation" };
  const depth = currentDepth();
  if (!AGENT_NAME.test(agent) || !task.trim()) {
    const reason = "specialist agent name and non-empty task are required";
    auditTransition(cwd, new Date().toISOString(), "conductor:dispatch_specialist", `${agent}; ${reason}`, "error");
    return { ok: false, reason };
  }
  // Validate materialized role policy before consuming an irreversible budget slot.
  const definition = agentDefinition(cwd, agent);
  if (!definition) {
    const reason = `specialist role is missing a materialized tool restriction: ${agent}`;
    auditTransition(cwd, new Date().toISOString(), "conductor:dispatch_specialist", `${agent}; ${reason}`, "error");
    return { ok: false, reason };
  }
  // The trust gate also runs before the budget slot is reserved, so a refusal costs nothing.
  // A granted digest is checked synchronously, so no other writer can slip in before the reservation.
  const trustError = grantedDigests().includes(definition.digest) ? null : await specialistTrustError(cwd, agent, definition.digest, approval);
  if (trustError) {
    auditTransition(cwd, new Date().toISOString(), "conductor:dispatch_specialist", `${agent}; ${trustError}`, "error");
    return { ok: false, reason: trustError };
  }
  const reserved = withEngagementLock(cwd, () => {
    const engagement = readEngagement(cwd);
    if (!engagement) return { ok: false as const, reason: "no valid engagement record; start an engagement first" };
    if (depth < 0) return { ok: false as const, reason: "invalid conductor depth marker; refusing specialist dispatch" };
    if (depth >= engagement.recursion.maxDepth) return { ok: false as const, reason: `depth cap reached (${depth}/${engagement.recursion.maxDepth})` };
    if (engagement.recursion.dispatchesUsed >= engagement.recursion.maxDispatches) return { ok: false as const, reason: `dispatch budget exhausted (${engagement.recursion.dispatchesUsed}/${engagement.recursion.maxDispatches})` };
    engagement.recursion.dispatchesUsed++; engagement.updatedAt = new Date().toISOString(); saveEngagement(cwd, engagement);
    // Attempt reservation audits before releasing the engagement writer lock.
    auditTransition(cwd, engagement.updatedAt, "conductor:dispatch_specialist", `${agent}@${depth + 1}; cap allowed`, "ok");
    auditTransition(cwd, engagement.updatedAt, "conductor:dispatch_budget_consumed", recursionStatus(engagement.recursion, depth), "ok");
    return { ok: true as const, childDepth: depth + 1, budget: engagement.recursion };
  });
  if (!reserved.ok) { auditTransition(cwd, new Date().toISOString(), "conductor:dispatch_specialist", `${agent}; ${reserved.reason}`, "error"); return reserved; }
  approvedLaunches.set(definition.digest, (approvedLaunches.get(definition.digest) ?? 0) + 1);
  let result: SpecialistRunResult;
  try { result = await runner(cwd, agent, task, reserved.childDepth, signal, onUpdate); } finally {
    const left = (approvedLaunches.get(definition.digest) ?? 1) - 1;
    if (left > 0) approvedLaunches.set(definition.digest, left); else approvedLaunches.delete(definition.digest);
  }
  auditTransition(cwd, new Date().toISOString(), "conductor:dispatch_specialist", agent, result.ok ? "ok" : "error"); return result;
}

function registerSpecialistTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "dispatch_specialist", label: "Conductor: bounded specialist dispatch",
    description: "Dispatch a materialized specialist in an isolated child process after durably enforcing Conductor recursion and per-run dispatch caps.",
    parameters: Type.Object({ agent: Type.String({ description: "Materialized synthesized agent name" }), task: Type.String({ description: "Scoped specialist task" }) }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const result = await dispatchSpecialist(ctx.cwd, params.agent, params.task, runSpecialistProcess, signal, (message) => onUpdate?.({ content: [{ type: "text" as const, text: message }], details: undefined }), ctx);
      setRecursionStatus(ctx.ui, readEngagement(ctx.cwd));
      return { content: [{ type: "text" as const, text: result.ok ? `Specialist:${params.agent} completed.\n${result.output}` : `Specialist dispatch refused: ${result.reason}` }], details: undefined };
    },
  });
}

function writeContribution(cwd: string, engagement: Engagement | null): void {
  try {
    const file = contributionFile(cwd);
    if (!engagement) {
      fs.rmSync(file, { force: true });
      return;
    }
    writeFileSafe(file, JSON.stringify({
      id: "conductor",
      priority: 80,
      budgetTokens: 300,
      content: `## Engagement\nPhase: ${engagement.phase} (started ${engagement.startedAt})`,
    }), { root: cwd });
  } catch {
    /* best effort */
  }
}

export default function (pi: ExtensionAPI) {
  registerValidatorTools(pi);
  registerSpecialistTool(pi);
  pi.on("before_agent_start", async (_event, ctx) => {
    currentSessionId = resolveSessionId(ctx.sessionManager);
    const cwd = ctx.cwd ?? process.cwd();
    const engagement = readEngagement(cwd);
    writeContribution(cwd, engagement);
    setRecursionStatus(ctx.ui, engagement);
    return undefined;
  });

  // Every model-callable tool that launches a discretionary child is held to dispatch_specialist's
  // bounded delegation while an engagement is open, that is, before it reaches close-out
  // (ORC-3; tests/conductor-recursion-smoke.ts).
  pi.on("tool_call", async (event, ctx) => {
    if (!ENGAGEMENT_BLOCKED_TOOLS.has(event.toolName)) return undefined;
    const engagement = readEngagement(ctx.cwd ?? process.cwd());
    if (!engagement || engagement.phase === "close-out") return undefined;
    return { block: true, reason: `conductor: an engagement is active, so ${event.toolName} is blocked; use dispatch_specialist for bounded delegation` };
  });

  pi.registerCommand("engagement", {
    description: "Manage engagement lifecycle: /engagement start | status | phase <name>",
    handler: async (args, ctx) => {
      const cwd = ctx.cwd ?? process.cwd();
      const input = (args ?? "").trim();
      const [subcommand, ...rest] = input.split(/\s+/);

      if (subcommand === "start") {
        const started = withEngagementLock(cwd, () => {
          const existing = readEngagement(cwd);
          if (existing) return { ok: false as const, existing };
          const now = new Date().toISOString();
          const engagement: Engagement = { version: 2, phase: "intake", startedAt: now, updatedAt: now, history: [{ phase: "intake", at: now }], recursion: { ...DEFAULT_RECURSION_BUDGET } };
          saveEngagement(cwd, engagement);
          auditTransition(cwd, now, "conductor:engagement_start", "intake", "ok");
          return { ok: true as const, engagement };
        });
        if (!started.ok && "existing" in started) {
          const existing = started.existing;
          ctx.ui.notify(`engagement: already started — current phase: ${existing.phase}`, "info");
          return;
        }
        if (!started.ok) { ctx.ui.notify(`engagement: ${started.reason}`, "error"); return; }
        writeContribution(cwd, started.engagement);
        setRecursionStatus(ctx.ui, started.engagement);
        ctx.ui.notify("engagement: started at phase intake", "info");
        return;
      }

      if (subcommand === "status" || subcommand === "") {
        const engagement = readEngagement(cwd);
        if (!engagement) {
          ctx.ui.notify("engagement: none started — use /engagement start", "info");
          return;
        }
        const gate = verifierBoardBlocked(cwd);
        const pending = pendingValidatorFindings(cwd);
        const gateText = gate.blocked || pending.length > 0 ? `gate: BLOCKED — ${[...gate.failing, ...pending.map((id) => `validator:${id} (pending)`)].join(", ")}` : "gate: passing";
        setRecursionStatus(ctx.ui, engagement);
        ctx.ui.notify(`engagement: ${engagement.phase}\nstarted: ${engagement.startedAt}\nhistory entries: ${engagement.history.length}\nrecursion: ${recursionStatus(engagement.recursion)}\n${gateText}`, gate.blocked || pending.length > 0 ? "warning" : "info");
        return;
      }

      if (subcommand === "phase") {
        const next = rest.join(" ");
        const advanced = withEngagementLock(cwd, () => {
          const engagement = readEngagement(cwd);
          if (!engagement) return { ok: false as const, message: "engagement: none started — run /engagement start first" };
          const now = new Date().toISOString();
          if (!isPhase(next)) { auditTransition(cwd, now, "conductor:phase_advance", `${engagement.phase}->${next}`, "error"); return { ok: false as const, message: `engagement: unknown phase '${next}'. Known phases: ${PHASES.join(", ")}` }; }
          if (PHASES.indexOf(next) <= PHASES.indexOf(engagement.phase)) { auditTransition(cwd, now, "conductor:phase_advance", `${engagement.phase}->${next}`, "error"); return { ok: false as const, message: `engagement: phase can only move forward from ${engagement.phase}; '${next}' was rejected` }; }
          const gate = verifierBoardBlocked(cwd); const pending = pendingValidatorFindings(cwd);
          if (gate.blocked || pending.length > 0) { auditTransition(cwd, now, "conductor:phase_advance", `${engagement.phase}->${next}`, "error"); return { ok: false as const, message: `engagement: phase advance blocked by verification — ${[...gate.failing, ...pending.map((id) => `validator:${id} (pending)`)].join(", ")}` }; }
          const previous = engagement.phase;
          engagement.phase = next; engagement.updatedAt = now; engagement.history.push({ phase: next, at: now }); saveEngagement(cwd, engagement);
          auditTransition(cwd, now, "conductor:phase_advance", `${previous}->${next}`, "ok");
          return { ok: true as const, previous, engagement };
        });
        if (!advanced.ok) { ctx.ui.notify("message" in advanced ? advanced.message : `engagement: ${advanced.reason}`, "error"); return; }
        writeContribution(cwd, advanced.engagement);
        setRecursionStatus(ctx.ui, advanced.engagement);
        ctx.ui.notify(`engagement: advanced from ${advanced.previous} to ${next}`, "info");
        return;
      }

      ctx.ui.notify("engagement: use /engagement start | status | phase <name>", "error");
    },
  });
}
