import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PAUSE_CHOICE_NO, PAUSE_CHOICE_YES, RUN_CHOICE_ALLOW_RUN, RunApprovalBroker, runChoices, runRequestOf, type RunRequest } from "./run-broker.ts";

const POLL_MS = 1000;
const DEFAULT_TIMEOUT_MS = 900000;
// Malformed/foreign pending files are quarantined as `<file>.invalid` on purpose so an
// operator can inspect them, but a repetitive bad producer must not grow the pending
// directory without bound: keep at most this many, oldest evicted first.
export const MAX_INVALID_QUARANTINE = 50;
type Pending = Record<string, unknown>;
type UiContext = Pick<ExtensionContext, "ui">;
const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]+$/;

function root(cwd: string): string { return process.env.PI_KIT_HUMAN_CONSOLE_DIR?.trim() || path.join(cwd, ".pi", "human-console"); }
function pendingDir(cwd: string): string { return path.join(root(cwd), "pending"); }
function resolvedDir(cwd: string): string { return path.join(root(cwd), "resolved"); }
function auditPath(cwd: string): string { return path.join(cwd, ".pi", "human-console-audit.jsonl"); }
function ensure(cwd: string): void { fs.mkdirSync(pendingDir(cwd), { recursive: true }); fs.mkdirSync(resolvedDir(cwd), { recursive: true }); }
// Cap the deliberate `.invalid` quarantine by evicting the oldest by mtime. Best-effort:
// a missing directory is fine and per-file errors (e.g. an ENOENT race) are swallowed.
function pruneInvalid(cwd: string): void {
  const dir = pendingDir(cwd);
  let names: string[];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith(".invalid")); } catch { return; }
  if (names.length <= MAX_INVALID_QUARANTINE) return;
  const byMtime = names.map((name) => { const file = path.join(dir, name); let mtimeMs = 0; try { mtimeMs = fs.statSync(file).mtimeMs; } catch { /* race; treat as oldest */ } return { file, mtimeMs }; }).sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const { file } of byMtime.slice(0, byMtime.length - MAX_INVALID_QUARANTINE)) { try { fs.unlinkSync(file); } catch { /* already gone */ } }
}
function audit(cwd: string, event: Record<string, unknown>): void { const file = auditPath(cwd); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, `${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`); }
function sleep(ms: number, signal?: AbortSignal): Promise<void> { return new Promise((resolve) => { const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms); const onAbort = () => { clearTimeout(timer); resolve(); }; signal?.addEventListener("abort", onAbort, { once: true }); }); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
// A field of a value that may not be an object (or may be an array or class instance): undefined when there is none.
function prop(value: unknown, key: string): unknown { return typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined; }
// A request field as text, exactly as String() has always shown it.
function text(value: unknown): string { return String(value); }
function isString(value: unknown): value is string { return typeof value === "string"; }
function requester(ctx: unknown): Record<string, unknown> { return { pid: process.pid, sessionId: prop(ctx, "sessionId") || prop(prop(ctx, "sessionManager"), "sessionId") || null, agent: prop(prop(ctx, "agent"), "name") || prop(ctx, "agentName") || "root" }; }
function isSafeRequestId(value: unknown): value is string { return typeof value === "string" && SAFE_REQUEST_ID.test(value); }
function requestedTimeout(request: Pending, fallback?: number): number | undefined {
  const value = Number(request.timeoutMs);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
async function waitForUi<T>(prompt: Promise<T> | T, timeoutMs?: number, signal?: AbortSignal): Promise<{ settled: boolean; value?: T }> {
  if (signal?.aborted) return { settled: false };
  return new Promise((resolve) => {
    let done = false;
    const finish = (result: { settled: boolean; value?: T }) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve(result);
    };
    const abort = () => finish({ settled: false });
    const timer = timeoutMs === undefined ? undefined : setTimeout(abort, timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    Promise.resolve(prompt).then((value) => finish({ settled: true, value }), () => finish({ settled: true }));
  });
}

export async function brokerRequest(cwd: string, request: Pending, signal?: AbortSignal): Promise<{ resolved: boolean; approved: boolean; answer: string | null; timedOut: boolean }> {
  ensure(cwd);
  const id = isSafeRequestId(request.id) ? request.id : crypto.randomUUID();
  const timeoutMs = Math.max(1, Number(request.timeoutMs) || DEFAULT_TIMEOUT_MS);
  const pending = { ...request, id, createdAt: request.createdAt || new Date().toISOString(), timeoutMs };
  const pendingFile = path.join(pendingDir(cwd), `${id}.json`);
  fs.writeFileSync(pendingFile, JSON.stringify(pending));
  const deadline = Date.now() + timeoutMs;
  const file = path.join(resolvedDir(cwd), `${id}.json`);
  try {
    while (!signal?.aborted && Date.now() < deadline) {
      try {
        const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
        if (isRecord(value) && value.id === id) return { resolved: true, approved: value.approved === true, answer: typeof value.answer === "string" ? value.answer : null, timedOut: false };
      } catch { /* not resolved yet */ }
      await sleep(Math.min(POLL_MS, Math.max(1, deadline - Date.now())), signal);
    }
    return { resolved: false, approved: false, answer: null, timedOut: true };
  } finally {
    // Best-effort: do not leave a pending file behind after this requester gives up,
    // and never let the removal itself throw. A concurrent resolver may have taken it.
    try { fs.unlinkSync(pendingFile); } catch { /* already removed */ }
    // Also remove the resolved answer file the console wrote: otherwise every headless
    // ask_human call accumulates one resolved/<id>.json. ENOENT-tolerant for the same
    // reason as above — a concurrent resolver may already have taken it.
    try { fs.unlinkSync(file); } catch { /* already removed by another resolver */ }
  }
}

async function answerQuestion(ctx: UiContext, request: Pending, signal?: AbortSignal, timeoutMs?: number): Promise<{ approved: boolean; answer: string | null }> {
  const options: string[] = Array.isArray(request.options) ? request.options.filter(isString) : [];
  const question = text(request.question ?? "");
  if (options.length && ctx.ui?.select) {
    const other = "Other (type an answer)";
    const selection = await waitForUi(ctx.ui.select(question, [...options, other]), timeoutMs, signal);
    if (!selection.settled) return { approved: false, answer: null };
    const selected = selection.value;
    if (selected && selected !== other) return { approved: true, answer: selected };
  }
  const input = ctx.ui?.input ? await waitForUi(ctx.ui.input(question, text(request.context || "")), timeoutMs, signal) : { settled: true, value: null };
  if (!input.settled) return { approved: false, answer: null };
  const answer = input.value;
  return { approved: Boolean(answer), answer: typeof answer === "string" && answer.trim() ? answer : null };
}

// An approval with `choices` (tool-firewall: allow once / allow for the session / deny / deny
// and tell) is shown as a menu; the title and card go in the menu header. Choices starting
// with "Allow" approve; "Deny and tell…" also collects a note for the agent. Without choices
// (or without a select UI) it stays a yes/no confirm.
async function answerApproval(ctx: UiContext, request: Pending, timeoutMs: number | undefined): Promise<{ approved: boolean; answer: string | null; note?: string | null }> {
  const choices: string[] = Array.isArray(request.choices) ? request.choices.filter((x: unknown): x is string => typeof x === "string" && x.trim() !== "").slice(0, 6) : [];
  const title = text(request.title || "Approve tool call?");
  const body = text(request.body || "");
  if (choices.length && typeof ctx.ui?.select === "function") {
    const header = [title, body].filter(Boolean).join("\n");
    const picked = await waitForUi(ctx.ui.select(header, choices), timeoutMs);
    const choice = picked.settled && typeof picked.value === "string" ? picked.value : null;
    if (!choice) return { approved: false, answer: null };
    if (/^allow/i.test(choice)) return { approved: true, answer: choice };
    let note: string | null = null;
    if (/tell/i.test(choice) && typeof ctx.ui?.input === "function") {
      const typed = await waitForUi(ctx.ui.input("Tell the agent why (it sees this):", "e.g. don't touch production; use the staging host"), timeoutMs);
      note = typed.settled && typeof typed.value === "string" && typed.value.trim() ? typed.value.trim() : null;
    }
    return { approved: false, answer: choice, note };
  }
  const confirmation = ctx.ui?.confirm ? await waitForUi(ctx.ui.confirm(title, body), timeoutMs) : { settled: true, value: false };
  return { approved: confirmation.settled && confirmation.value === true, answer: null };
}

type Answer = { approved: boolean; answer: string | null; note?: string | null };
// The subagent extension publishes pause/resume for its live workflow runs here (see its control.ts);
// read loosely so this extension stays self-contained and works when that one is not loaded.
const WORKFLOW_CONTROL_KEY = Symbol.for("pi-kit.workflow-control");
// The pause is sent with origin "safety", so the run stays held for the operator: the agent's own
// workflow_control resume is refused; only the operator's Yes here or /workflow resume lifts it.
function controlWorkflowRun(runId: string, action: "pause" | "resume"): { ok: boolean; message: string } {
  const registry: unknown = Reflect.get(globalThis, WORKFLOW_CONTROL_KEY);
  const control = prop(registry, "control");
  if (typeof control !== "function") return { ok: false, message: "workflow run control is not available in this session" };
  try {
    const result: unknown = Reflect.apply(control, registry, [runId, action, action === "pause" ? "safety" : "operator"]);
    const message = prop(result, "message");
    return { ok: prop(result, "ok") === true, message: typeof message === "string" ? message : "" };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
function deadlineOf(request: Pending): number {
  const createdMs = Date.parse(text(request.createdAt)) || Date.now();
  return createdMs + (requestedTimeout(request, DEFAULT_TIMEOUT_MS) ?? DEFAULT_TIMEOUT_MS);
}
// Write the answer for a pending request and remove the pending file. The pending file may already
// be gone (another resolver, or a requester that gave up): a missing file is success, not an error.
function writeAnswer(cwd: string, id: string, file: string, result: Answer): void {
  fs.writeFileSync(path.join(resolvedDir(cwd), `${id}.json`), JSON.stringify({ id, decidedAt: new Date().toISOString(), approved: result.approved, answer: result.answer, note: result.note ?? null }));
  try { fs.unlinkSync(file); } catch { /* already removed by another resolver */ }
}
function stickyNote(runId: string, note?: string | null): string {
  return `denied for the rest of workflow run ${runId}${note ? `: ${note}` : ""}`;
}

export default function humanConsole(pi: ExtensionAPI) {
  const runBroker = new RunApprovalBroker();
  // A grouped request takes the shown request's answer, if it is still pending and in time.
  const answerMember = (ctx: ExtensionContext, id: string, result: Answer) => {
    const file = path.join(pendingDir(ctx.cwd), `${id}.json`);
    let parsed: unknown;
    try { parsed = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return; }
    if (!isRecord(parsed) || parsed.id !== id || Date.now() > deadlineOf(parsed)) return;
    writeAnswer(ctx.cwd, id, file, result);
  };
  const askToResume = async (ctx: ExtensionContext, runId: string, distinct: number) => {
    try {
      const paused = controlWorkflowRun(runId, "pause");
      audit(ctx.cwd, { event: "workflow_approvals_pause", runId, distinct, ok: paused.ok });
      if (!paused.ok) {
        ctx.ui?.notify?.(`human-console: workflow run ${runId} has had ${distinct} distinct approvals but could not be paused (${paused.message})`, "warning");
        return;
      }
      const header = `Workflow run ${runId} has had ${distinct} distinct actions approved, so it is paused: no new agents start.\nResume it?`;
      let resume = false;
      if (typeof ctx.ui?.select === "function") {
        const picked = await waitForUi(ctx.ui.select(header, [PAUSE_CHOICE_NO, PAUSE_CHOICE_YES]), DEFAULT_TIMEOUT_MS);
        resume = picked.settled && picked.value === PAUSE_CHOICE_YES;
      }
      if (resume) controlWorkflowRun(runId, "resume");
      audit(ctx.cwd, { event: "workflow_approvals_resume_answer", runId, resumed: resume });
    } finally {
      runBroker.pauseAnswered(runId);
    }
  };
  const processRunApproval = async (ctx: ExtensionContext, file: string, request: Pending, run: RunRequest) => {
    const deadline = deadlineOf(request);
    if (Date.now() > deadline) {
      runBroker.leave(run);
      try { fs.unlinkSync(file); } catch { /* already removed */ }
      return;
    }
    const offer = runBroker.offer(run);
    if (offer.kind === "wait") return;
    if (offer.kind === "resolve") {
      writeAnswer(ctx.cwd, run.id, file, offer.approved ? { approved: true, answer: RUN_CHOICE_ALLOW_RUN } : { approved: false, answer: null, note: stickyNote(run.runId) });
      audit(ctx.cwd, { event: offer.reason === "sticky_deny" ? "workflow_approval_sticky_deny" : "workflow_approval_run_grant", runId: run.runId, id: run.id, actionHash: run.hash });
      return;
    }
    let settled = false;
    try {
      const title = `${text(request.title || "Approve tool call?")} · workflow run ${run.runId}`;
      const result = await answerApproval(ctx, { ...request, title, choices: runChoices(run.high) }, Math.max(1, deadline - Date.now()));
      // No answer before the requester's deadline: it has already failed closed; decide nothing.
      if (!result.approved && result.answer === null && Date.now() >= deadline) {
        try { fs.unlinkSync(file); } catch { /* already removed */ }
        return;
      }
      const approved = result.approved;
      const outcome = runBroker.settle(run, { approved, runGrant: result.answer === RUN_CHOICE_ALLOW_RUN });
      settled = true;
      const answer: Answer = approved ? { approved, answer: result.answer } : { approved, answer: result.answer, note: stickyNote(run.runId, result.note) };
      writeAnswer(ctx.cwd, run.id, file, answer);
      for (const id of outcome.members) answerMember(ctx, id, answer);
      audit(ctx.cwd, { event: "workflow_approval_decided", runId: run.runId, id: run.id, actionHash: run.hash, approved, runGrant: approved && !run.high && result.answer === RUN_CHOICE_ALLOW_RUN, grouped: outcome.members.length, distinct: outcome.distinct });
      if (outcome.pause) await askToResume(ctx, run.runId, outcome.distinct);
    } finally {
      if (!settled) runBroker.abandon(run);
    }
  };
  let watcher: ReturnType<typeof setInterval> | null = null;
  let lastScanError: string | null = null;
  const processing = new Set<string>();
  const processOne = async (ctx: ExtensionContext, file: string) => {
    try {
      let parsed: unknown;
      try { parsed = JSON.parse(fs.readFileSync(file, "utf8")); } catch {
        audit(ctx.cwd, { event: "human_console_invalid_pending_json", file: path.basename(file) });
        try { fs.renameSync(file, `${file}.invalid`); } catch { /* leave it for operator inspection */ }
        return;
      }
      const request: Pending = isRecord(parsed) ? parsed : {};
      const id = request.id;
      if (!isSafeRequestId(id)) {
        audit(ctx.cwd, { event: "human_console_invalid_pending_id", file: path.basename(file) });
        try { fs.renameSync(file, `${file}.invalid`); } catch { /* leave it for operator inspection */ }
        return;
      }
      if (request.kind !== "approval" && request.kind !== "question") {
        audit(ctx.cwd, { event: "human_console_invalid_pending_kind", file: path.basename(file) });
        try { fs.renameSync(file, `${file}.invalid`); } catch { /* leave it for operator inspection */ }
        return;
      }
      const run = request.kind === "approval" ? runRequestOf(request) : null;
      if (run) {
        await processRunApproval(ctx, file, request, run);
        return;
      }
      const timeoutMs = requestedTimeout(request, DEFAULT_TIMEOUT_MS);
      let result: Answer;
      if (request.kind === "approval") result = await answerApproval(ctx, request, timeoutMs);
      else result = await answerQuestion(ctx, request, undefined, timeoutMs);
      const createdMs = Date.parse(String(request.createdAt)) || Date.now();
      if (Date.now() > createdMs + (timeoutMs ?? DEFAULT_TIMEOUT_MS)) {
        // The requester gave up at its deadline (brokerRequest unlinks both files in its
        // finally); do not recreate an orphan resolved file. Drop the pending file too so
        // the watcher does not re-answer it forever.
        try { fs.unlinkSync(file); } catch { /* already removed by another resolver */ }
        return;
      }
      // writeAnswer tolerates a pending file that is already gone: an unguarded unlinkSync
      // here is an unhandled rejection that kills pi.
      writeAnswer(ctx.cwd, id, file, result);
    } finally { processing.delete(file); }
  };
  const processPending = (ctx: ExtensionContext) => {
    try {
      ensure(ctx.cwd);
      pruneInvalid(ctx.cwd);
      for (const name of fs.readdirSync(pendingDir(ctx.cwd)).filter((f) => f.endsWith(".json"))) {
        const file = path.join(pendingDir(ctx.cwd), name);
        if (processing.has(file)) continue;
        processing.add(file);
        void processOne(ctx, file).catch(() => { /* never let a pending-file race crash the host */ });
      }
      if (lastScanError !== null) {
        lastScanError = null;
        try { console.error("[human-console] pending scan recovered"); } catch { /* stderr unavailable */ }
      }
    } catch (error) {
      // This runs from a 1 Hz setInterval and from session_start, so an escaping error is
      // an uncaught exception that kills pi. A pending path that cannot be created or
      // listed (e.g. a regular file where the directory belongs) is reported best-effort
      // and the watcher keeps running, so it recovers once the path is usable again.
      // Report each distinct failure once rather than once per 1 Hz tick.
      const message = `[human-console] pending scan failed: ${error instanceof Error ? error.message : String(error)}`;
      if (message !== lastScanError) {
        lastScanError = message;
        try { console.error(message); } catch { /* stderr unavailable */ }
      }
    }
  };
  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    processPending(ctx);
    watcher = setInterval(() => { processPending(ctx); }, POLL_MS); watcher.unref?.();
  });
  pi.on("session_shutdown", async () => { if (watcher) clearInterval(watcher); watcher = null; runBroker.clear(); });
  pi.registerTool({ name: "ask_human", label: "Ask human", description: "Ask the operator a concise clarifying question.", parameters: Type.Object({ question: Type.String(), options: Type.Optional(Type.Array(Type.String())), context: Type.Optional(Type.String()), timeoutMs: Type.Optional(Type.Number({ minimum: 1 })) }), async execute(_id, params, signal, _onUpdate, ctx) {
    let answer: string | null;
    // An interactive question is bounded too: a UI that never answers (a closed terminal, an RPC client that ignores
    // the request) must not park the agent for ever. Without a timeoutMs of its own it gets the console's timeout.
    if (ctx.hasUI && ctx.ui) answer = (await answerQuestion(ctx, { kind: "question", ...params }, signal, requestedTimeout(params, Math.max(1, Number(process.env.PI_KIT_HUMAN_CONSOLE_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS)))).answer;
    else {
      const id = crypto.randomUUID(); audit(ctx.cwd, { event: "ask_human_pending", id });
      const outcome = await brokerRequest(ctx.cwd, { id, kind: "question", requester: requester(ctx), ...params }, signal);
      answer = outcome.answer;
      audit(ctx.cwd, { event: outcome.timedOut ? "ask_human_timeout" : "ask_human_resolved", id });
    }
    return { content: [{ type: "text" as const, text: answer ? `Human answer: ${answer}` : "No human answered in time." }], details: { answer } };
  }});
}
