import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The narrow bundle is the structural independence boundary: finder reasoning never enters it.
export interface ValidatorBundleInput { evidence: string; requirement: string; }
export type ValidatorBundleResult = { ok: true; task: string } | { ok: false; reason: string };
export interface ValidatorQuestion { pass: boolean; note: string; }
export interface ValidatorVerdictInput { evidence: string; requirement: string; real: ValidatorQuestion; matters: ValidatorQuestion; inScope: ValidatorQuestion; }
export interface ValidatorVerdict extends ValidatorVerdictInput { pass: boolean; at: string; }
export type ValidatorRunResult = { ok: true; output: string } | { ok: false; reason: string };
export type ValidatorRunner = (cwd: string, task: string, signal?: AbortSignal, onUpdate?: (text: string) => void) => Promise<ValidatorRunResult>;

interface TraceEntry { ts: string; turn: number; kind: "call" | "result"; tool: string; target?: string; argsHash: string; status?: "ok" | "error"; }
// verdicts.json is shared with verifier-board and read from disk, so its entries are untrusted:
// each reader checks the fields it relies on (see validatorVerdictGate) instead of trusting a type.
interface Board { verdicts: Record<string, unknown>; generation?: unknown; }
const FINDING_ID = /^[a-z0-9][a-z0-9-]*$/;
const VERDICT_MAX_AGE_MS = Number(process.env.PI_KIT_VERDICT_MAX_AGE_MS) || 24 * 60 * 60 * 1000;
// Validator child bounds: a wedged child must not hang dispatch_validator and permanently
// block the phase via pending-validation.json. Mirror runSpecialistProcess's SIGTERM→SIGKILL
// escalation and add an idle watchdog (0 disables) that fires when the child goes silent.
const VALIDATOR_TERMINATE_GRACE_MS = 5000;
const VALIDATOR_IDLE_TIMEOUT_MS = (() => { const raw = Number(process.env.PI_KIT_VALIDATOR_IDLE_TIMEOUT_MS); return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 15 * 60 * 1000; })();

function shortHash(value: string): string { let hash = 2166136261; for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619); return (hash >>> 0).toString(16).padStart(8, "0"); }
function appendTrace(cwd: string, entry: TraceEntry): void { try { const file = path.join(cwd, ".pi", "trace.jsonl"); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, JSON.stringify(entry) + "\n", "utf8"); } catch { /* audit is best effort */ } }
function audit(cwd: string, tool: string, target: string, value: unknown, status: "ok" | "error"): void { let argsHash = "unhashable"; try { argsHash = shortHash(JSON.stringify(value)); } catch { /* pathological input */ } appendTrace(cwd, { ts: new Date().toISOString(), turn: 0, kind: "result", tool, target, argsHash, status }); }
function writeAtomically(file: string, content: string): void { fs.mkdirSync(path.dirname(file), { recursive: true }); const temp = `${file}.${process.pid}.${Date.now()}.tmp`; fs.writeFileSync(temp, content, "utf8"); fs.renameSync(temp, file); }
function findingDirectory(cwd: string, id: string): string { return path.join(cwd, ".pi", "engagement", "findings", id); }
function verdictFile(cwd: string, id: string): string { return path.join(findingDirectory(cwd, id), "verdict.json"); }
function pendingFile(cwd: string, id: string): string { return path.join(findingDirectory(cwd, id), "pending-validation.json"); }
function isStale(at: unknown): boolean { if (typeof at !== "string") return true; const parsed = Date.parse(at); return Number.isNaN(parsed) || parsed > Date.now() || Date.now() - parsed > VERDICT_MAX_AGE_MS; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function validQuestion(value: unknown): value is ValidatorQuestion { return isRecord(value) && typeof value.pass === "boolean" && typeof value.note === "string" && value.note.trim().length > 0; }
function validVerdict(value: unknown): value is ValidatorVerdict { const v = value; return isRecord(v) && typeof v.evidence === "string" && v.evidence.trim().length > 0 && typeof v.requirement === "string" && v.requirement.trim().length > 0 && typeof v.pass === "boolean" && typeof v.at === "string" && validQuestion(v.real) && validQuestion(v.matters) && validQuestion(v.inScope); }
function loadBoard(cwd: string): Board | null { const file = path.join(cwd, ".pi", "verdicts.json"); if (!fs.existsSync(file)) return { verdicts: {} }; try { const board: unknown = JSON.parse(fs.readFileSync(file, "utf8")); return isRecord(board) && isRecord(board.verdicts) ? { ...board, verdicts: board.verdicts } : null; } catch { return null; } }
// A non-numeric generation (a hand-edited board) restarts the count: `"7" + 1` would concatenate to "71".
function saveBoard(cwd: string, board: Board): void { board.generation = (typeof board.generation === "number" ? board.generation : 0) + 1; writeAtomically(path.join(cwd, ".pi", "verdicts.json"), JSON.stringify(board, null, 2)); }
// Cross-process advisory lock for board mutations (same O_EXCL + stale-takeover pattern as
// task-graph and verifier-board): a read-modify-write under a lock cannot lose a concurrent
// verdict. Lock name is shared with verifier-board so both writers serialize on one file.
const BOARD_LOCK_STALE_MS = 60_000;
function withBoardLock<T>(cwd: string, operation: () => T): { ok: true; value: T } | { ok: false; reason: string } {
  const lock = path.join(cwd, ".pi", "verdicts.lock");
  let fd: number | undefined;
  try {
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    try { fd = fs.openSync(lock, "wx"); } catch {
      try { if (Date.now() - fs.statSync(lock).mtimeMs > BOARD_LOCK_STALE_MS) fs.rmSync(lock, { force: true }); } catch { /* fail closed below */ }
      try { fd = fs.openSync(lock, "wx"); } catch { return { ok: false, reason: "verifier board is busy or unreadable" }; }
    }
    try { return { ok: true, value: operation() }; } finally {
      try { if (fd !== undefined) fs.closeSync(fd); } catch { /* release best effort */ }
      try { fs.rmSync(lock, { force: true }); } catch { /* stale lock is fail-closed */ }
    }
  } catch { return { ok: false, reason: "verifier board is unavailable" }; }
}

export function buildValidatorBundle(input: ValidatorBundleInput): ValidatorBundleResult {
  if (typeof input?.evidence !== "string" || !input.evidence.trim()) return { ok: false, reason: "evidence must be non-empty" };
  if (typeof input?.requirement !== "string" || !input.requirement.trim()) return { ok: false, reason: "requirement must be non-empty" };
  return { ok: true, task: `## Evidence\n\n${input.evidence}\n\n## Requirement\n\n${input.requirement}\n\n## Questions\n\n1. Is it real? Can it be reproduced from the evidence alone?\n2. Does it matter? Judge significance or severity independently.\n3. Does it match the requirement / stay in scope?\n` };
}

function markPending(cwd: string, id: string): void { writeAtomically(pendingFile(cwd, id), JSON.stringify({ at: new Date().toISOString() }, null, 2)); }
function clearPending(cwd: string, id: string): void { try { fs.rmSync(pendingFile(cwd, id), { force: true }); } catch { /* a lingering marker safely blocks */ } }
export function pendingValidatorFindings(cwd: string): string[] {
  const root = path.join(cwd, ".pi", "engagement", "findings");
  try {
    if (!fs.existsSync(root)) return [];
    return fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && FINDING_ID.test(entry.name) && fs.existsSync(path.join(root, entry.name, "pending-validation.json"))).map((entry) => entry.name);
  } catch { return ["(validator pending ledger unreadable)"]; }
}

function parseQuestion(value: string): ValidatorQuestion | null { const match = value.trim().match(/^(PASS|FAIL)\s*\n\s*Reason:\s*([\s\S]+)$/); const note = match?.[2]?.trim(); return !match || !note ? null : { pass: match[1] === "PASS", note }; }
function outputSections(output: string): Map<string, string> {
  const found = [...output.matchAll(/^## (Real|Matters|In Scope|Verdict|Summary)\s*$/gm)];
  const sections = new Map<string, string>();
  for (const [i, entry] of found.entries()) sections.set(entry[1] ?? "", output.slice((entry.index ?? 0) + entry[0].length, found[i + 1]?.index).trim());
  return sections;
}
export function parseValidatorOutput(output: unknown): Pick<ValidatorVerdictInput, "real" | "matters" | "inScope"> | { reason: string } {
  if (typeof output !== "string" || !output.trim()) return { reason: "validator produced no structured output" };
  const sections = outputSections(output); const real = parseQuestion(sections.get("Real") ?? ""); const matters = parseQuestion(sections.get("Matters") ?? ""); const inScope = parseQuestion(sections.get("In Scope") ?? "");
  if (!real || !matters || !inScope || !sections.get("Summary")?.trim() || !sections.has("Verdict")) return { reason: "validator output did not match the required structured format" };
  const expected = real.pass && matters.pass && inScope.pass ? "PASS" : "FAIL";
  if (sections.get("Verdict") !== expected) return { reason: "validator overall verdict did not match its three question results" };
  return { real, matters, inScope };
}

/**
 * The text of the newest assistant message's first text part. Child stream messages are unknown:
 * a non-array content or a non-object part is skipped, never dereferenced (shared with conductor).
 */
export function finalAssistantOutput(messages: readonly unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!isRecord(msg) || msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    const content: unknown[] = msg.content;
    const part = content.find((p): p is { type: "text"; text: string } => isRecord(p) && p.type === "text" && typeof p.text === "string");
    if (part?.text) return part.text;
  }
  return "";
}
function writePromptTempFile(prompt: string): { dir: string; file: string } { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-conductor-validator-")); const file = path.join(dir, "validator-system-prompt.md"); fs.writeFileSync(file, prompt, { encoding: "utf8", mode: 0o600 }); return { dir, file }; }

// pi (checked through 0.87) exposes no first-class registered-tool invocation from ExtensionAPI or ctx.
// The validator's prompt is the extension's own shipped role, never a project file: a repository (or
// the model under test) that writes .pi/agents/validator.md must not decide what the independent
// check is told (ORC-1, ORC-4; tests/conductor-validator-smoke.ts).
export const VALIDATOR_ROLE_FILE = fileURLToPath(new URL("../agents/validator.md", import.meta.url));
export const runValidatorProcess: ValidatorRunner = async (cwd, task, signal, onUpdate) => {
  let role: string;
  try { role = fs.readFileSync(VALIDATOR_ROLE_FILE, "utf8"); } catch { return { ok: false, reason: "the conductor extension's own validator role (agents/validator.md) is missing or unreadable" }; }
  let temp: { dir: string; file: string } | undefined;
  try {
    temp = writePromptTempFile(role.replace(/^---\n[\s\S]*?\n---\s*/, ""));
    const args = ["--mode", "json", "-p", "--no-session", "--tools", "read,grep,find,ls", "--append-system-prompt", temp.file];
    const result = await new Promise<{ code: number; stderr: string; messages: Array<{ role?: unknown; content?: unknown }> }>((resolve) => {
      // Launch through the running pi's own entry point with no shell (a task string containing shell
      // metacharacters must never reach a command interpreter), and through delegation-guard: the
      // validator is required verification, so it uses the "mandatory" kind, gets the ledger and the
      // required-protection list, and its own guard fails closed if a protection is missing.
      const guard = (globalThis as Record<symbol, unknown>)[Symbol.for("pi-kit.delegation")] as { prepareChild(request: Record<string, unknown>): { ok: true; env: Record<string, string | undefined>; slot: { attach(pid: number | undefined): void; settle(outcome: string): void } } | { ok: false; reason: string } } | undefined;
      if (!guard) { resolve({ code: 1, stderr: "validator not started: the delegation-guard extension is not loaded, so the validator cannot be given the mandatory protections", messages: [] }); return; }
      const prepared = guard.prepareChild({ cwd, kind: "mandatory", role: "validator", readOnly: true, isolation: "ambient", baseEnv: { ...process.env } });
      if (!prepared.ok) { resolve({ code: 1, stderr: `validator not started: ${prepared.reason}`, messages: [] }); return; }
      const cli = fileURLToPath(new URL("./cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
      const runtime = process.execPath.replace(/\\/g, "/").split("/").pop()?.toLowerCase().replace(/\.(?:exe|cmd|bat)$/, "") ?? "";
      const argv = ["node", "nodejs", "bun", "deno"].includes(runtime) ? [cli, ...args] : [...args];
      const proc = spawn(process.execPath, argv, { cwd, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: { ...prepared.env, PI_KIT_INTERNAL_CHILD: "1" } }); let buffer = ""; let stderr = "";
      // The task (raw evidence, possibly over 128 KiB) goes over stdin, which print mode merges into
      // the prompt, never argv: one argument is capped at MAX_ARG_STRLEN (spawn E2BIG) and argv is
      // readable by any local user through ps. An EPIPE from an early exit surfaces as the exit code.
      proc.stdin.on("error", () => {}); proc.stdin.end(`Task: ${task}`);
      prepared.slot.attach(proc.pid); proc.once("close", () => prepared.slot.settle("closed")); proc.once("error", () => prepared.slot.settle("error")); const messages: Array<{ role?: unknown; content?: unknown }> = [];
      let exited = false;
      let escalation: ReturnType<typeof setTimeout> | undefined;
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const stop = () => { if (exited) return; try { proc.kill("SIGTERM"); } catch { /* already gone */ } escalation = setTimeout(() => { if (!exited) { try { proc.kill("SIGKILL"); } catch { /* already gone */ } } }, VALIDATOR_TERMINATE_GRACE_MS); escalation.unref(); };
      const bumpIdle = () => { if (exited || VALIDATOR_IDLE_TIMEOUT_MS <= 0) return; if (idleTimer) clearTimeout(idleTimer); idleTimer = setTimeout(() => stop(), VALIDATOR_IDLE_TIMEOUT_MS); idleTimer.unref(); };
      const cleanup = () => { exited = true; if (escalation) clearTimeout(escalation); if (idleTimer) clearTimeout(idleTimer); signal?.removeEventListener("abort", stop); };
      const line = (raw: string) => { if (!raw.trim()) return; try { const event: unknown = JSON.parse(raw); if (isRecord(event) && (event.type === "message_end" || event.type === "tool_result_end") && isRecord(event.message)) { messages.push(event.message); onUpdate?.("[validator] received child progress"); } } catch { /* only JSON-stream assistant output is trusted */ } };
      proc.stdout.on("data", (data: Buffer) => { bumpIdle(); buffer += data.toString(); const lines = buffer.split("\n"); buffer = lines.pop() || ""; lines.forEach(line); }); proc.stderr.on("data", (data: Buffer) => { bumpIdle(); stderr += data.toString(); });
      proc.once("close", cleanup); proc.once("error", cleanup);
      proc.on("close", (code) => { if (buffer.trim()) line(buffer); resolve({ code: code ?? 1, stderr, messages }); }); proc.on("error", (error) => resolve({ code: 1, stderr: String(error), messages }));
      if (signal) { if (signal.aborted) stop(); else signal.addEventListener("abort", stop, { once: true }); }
      bumpIdle();
    });
    if (signal?.aborted) return { ok: false, reason: "validator cancelled" };
    if (result.code !== 0) return { ok: false, reason: result.stderr.trim() || `validator child exited ${result.code}` };
    const output = finalAssistantOutput(result.messages); return output ? { ok: true, output } : { ok: false, reason: "validator child returned no assistant output" };
  } catch (error) { return { ok: false, reason: `validator child failed: ${error instanceof Error ? error.message : String(error)}` }; }
  finally { if (temp) { try { fs.unlinkSync(temp.file); } catch { /* ignore */ } try { fs.rmdirSync(temp.dir); } catch { /* ignore */ } } }
};

// Exported for deterministic direct tests only; it is intentionally not model-callable.
export function recordValidatorVerdict(cwd: string, id: string, input: ValidatorVerdictInput): { ok: true; verdict: ValidatorVerdict } | { ok: false; reason: string } {
  if (!FINDING_ID.test(id)) { const result = { ok: false as const, reason: `invalid finding id: ${id}` }; audit(cwd, "conductor:record_validator_verdict", "invalid-finding-id", input, "error"); return result; }
  const candidate = input as Partial<ValidatorVerdictInput> | null;
  if (!candidate || typeof candidate.evidence !== "string" || !candidate.evidence.trim() || typeof candidate.requirement !== "string" || !candidate.requirement.trim() || !validQuestion(candidate.real) || !validQuestion(candidate.matters) || !validQuestion(candidate.inScope)) { const result = { ok: false as const, reason: "evidence, requirement, and all three question verdicts with reasons are required" }; audit(cwd, "conductor:record_validator_verdict", id, input, "error"); return result; }
  const at = new Date().toISOString();
  // Reconstruct instead of spreading raw runtime input, so surplus fields never persist.
  const verdict: ValidatorVerdict = { evidence: candidate.evidence, requirement: candidate.requirement, real: { pass: candidate.real.pass, note: candidate.real.note.trim() }, matters: { pass: candidate.matters.pass, note: candidate.matters.note.trim() }, inScope: { pass: candidate.inScope.pass, note: candidate.inScope.note.trim() }, pass: candidate.real.pass && candidate.matters.pass && candidate.inScope.pass, at };
  const locked = withBoardLock(cwd, () => {
    try {
      const board = loadBoard(cwd); if (!board) return { ok: false as const, reason: "verifier board unreadable or malformed" };
      writeAtomically(verdictFile(cwd, id), JSON.stringify(verdict, null, 2)); board.verdicts[`validator:${id}`] = { pass: verdict.pass, summary: `real=${verdict.real.pass}; matters=${verdict.matters.pass}; inScope=${verdict.inScope.pass}`, at }; saveBoard(cwd, board); clearPending(cwd, id);
      return { ok: true as const };
    } catch (error) { return { ok: false as const, reason: `failed to record validator verdict: ${error instanceof Error ? error.message : String(error)}` }; }
  });
  if (!locked.ok) { audit(cwd, "conductor:record_validator_verdict", id, input, "error"); return { ok: false as const, reason: locked.reason }; }
  if (!locked.value.ok) { audit(cwd, "conductor:record_validator_verdict", id, input, "error"); return { ok: false as const, reason: locked.value.reason }; }
  audit(cwd, "conductor:record_validator_verdict", id, input, "ok"); return { ok: true, verdict };
}

export async function dispatchValidator(cwd: string, id: string, input: ValidatorBundleInput, runner: ValidatorRunner = runValidatorProcess, signal?: AbortSignal, onUpdate?: (text: string) => void): Promise<{ ok: true; verdict: ValidatorVerdict } | { ok: false; reason: string }> {
  const bundle = buildValidatorBundle(input);
  if (!FINDING_ID.test(id)) { const result = { ok: false as const, reason: `invalid finding id: ${id}` }; audit(cwd, "conductor:dispatch_validator", "invalid-finding-id", input, "error"); return result; }
  if (!bundle.ok) { audit(cwd, "conductor:dispatch_validator", id, input, "error"); return bundle; }
  try { markPending(cwd, id); } catch (error) { const result = { ok: false as const, reason: `failed to mark validation pending: ${error instanceof Error ? error.message : String(error)}` }; audit(cwd, "conductor:dispatch_validator", id, input, "error"); return result; }
  const run = await runner(cwd, bundle.task, signal, onUpdate); if (!run.ok) { audit(cwd, "conductor:dispatch_validator", id, input, "error"); return run; }
  const parsed = parseValidatorOutput(run.output); if (!("real" in parsed)) { audit(cwd, "conductor:dispatch_validator", id, input, "error"); return { ok: false, reason: parsed.reason }; }
  const recorded = recordValidatorVerdict(cwd, id, { evidence: input.evidence, requirement: input.requirement, ...parsed }); audit(cwd, "conductor:dispatch_validator", id, input, recorded.ok ? "ok" : "error"); return recorded;
}

export function findingValidated(cwd: string, id: string): { validated: boolean; reason?: string } {
  if (!FINDING_ID.test(id)) return { validated: false, reason: "invalid finding id" }; if (fs.existsSync(pendingFile(cwd, id))) return { validated: false, reason: "validator verdict pending" };
  let verdict: unknown; try { verdict = JSON.parse(fs.readFileSync(verdictFile(cwd, id), "utf8")); } catch { return { validated: false, reason: "validator verdict missing or unreadable" }; }
  if (!validVerdict(verdict)) return { validated: false, reason: "validator verdict malformed" }; if (isStale(verdict.at)) return { validated: false, reason: "validator verdict stale" }; if (!verdict.real.pass) return { validated: false, reason: "validator found the claim not real" }; if (!verdict.inScope.pass) return { validated: false, reason: "validator found the claim out of scope" }; if (!verdict.matters.pass || !verdict.pass) return { validated: false, reason: "validator verdict failed" };
  const entry = loadBoard(cwd)?.verdicts[`validator:${id}`]; const rollup = isRecord(entry) ? entry : undefined; if (rollup?.pass !== true || typeof rollup.summary !== "string" || !rollup.summary.trim() || typeof rollup.at !== "string" || isStale(rollup.at)) return { validated: false, reason: "validator board roll-up missing, failing, malformed, or stale" }; return { validated: true };
}

function text(value: string) { return { content: [{ type: "text" as const, text: value }], details: undefined }; }
export function registerValidatorTools(pi: ExtensionAPI, options: { runner?: ValidatorRunner } = {}): void {
  const runner = options.runner ?? runValidatorProcess;
  pi.registerTool({ name: "dispatch_validator", label: "Validator: independent dispatch", description: "Run an isolated read-only validator with only raw evidence and requirement, then parse and record its verdict atomically.", parameters: Type.Object({ findingId: Type.String({ description: "Stable kebab-case finding identifier" }), evidence: Type.String({ description: "Raw evidence only: request/response, PoC, diff, or test output" }), requirement: Type.String({ description: "Requirement or scope stanza the evidence must satisfy" }) }),
    async execute(_id, params, signal, onUpdate, ctx) { const result = await dispatchValidator(ctx.cwd, params.findingId, { evidence: params.evidence, requirement: params.requirement }, runner, signal, (message) => onUpdate?.(text(message))); return text(result.ok ? `Validator:${params.findingId} ${result.verdict.pass ? "PASS" : "FAIL"} recorded.` : `Validator dispatch refused: ${result.reason}`); },
  });
}
