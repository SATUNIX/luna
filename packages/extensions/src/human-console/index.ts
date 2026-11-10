import { ExtensionEditorComponent, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadConsoleKey, requestDigest, signedAnswer, verifyAnswer } from "./console-auth.ts";
import { PAUSE_CHOICE_NO, PAUSE_CHOICE_YES, RUN_CHOICE_ALLOW_RUN, RunApprovalBroker, runChoices, runRequestOf, type RunRequest } from "./run-broker.ts";
import { cardTimeoutMs, inputHeld, showWhenFree } from "./shared/input-owner.ts";
import { appendFileSafe, ensureDirSafe, piWorkspaceOf, piWorkspaceOptions, writeFileSafe, type SafeWriteOptions } from "./shared/safe-fs.ts";

const POLL_MS = 1000;
const DEFAULT_TIMEOUT_MS = 900000;
// Malformed/foreign pending files are quarantined as `<file>.invalid` on purpose so an
// operator can inspect them, but a repetitive bad producer must not grow the pending
// directory without bound: keep at most this many, oldest evicted first.
export const MAX_INVALID_QUARANTINE = 50;
type Pending = Record<string, unknown>;
type UiContext = Pick<ExtensionContext, "ui" | "mode">;
const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]+$/;
// Every way an ask_human can end, each with its own text. The shared prefix is deliberate: three
// tests outside this extension pin "No human answered in time".
export type AskOutcome = "answered" | "dismissed" | "timeout" | "aborted" | "unavailable";
const NO_ANSWER_TEXT: Record<Exclude<AskOutcome, "answered">, string> = {
  dismissed: "No human answered in time (the question was dismissed without an answer).",
  timeout: "No human answered in time (the question timed out).",
  aborted: "No human answered in time (the turn was aborted).",
  unavailable: "No human answered in time (the human console is unavailable).",
};
function askText(outcome: AskOutcome, answer: string | null): string {
  return outcome === "answered" ? `Human answer: ${answer ?? ""}` : NO_ANSWER_TEXT[outcome];
}

function root(cwd: string): string { return process.env.PI_KIT_HUMAN_CONSOLE_DIR?.trim() || path.join(cwd, ".pi", "human-console"); }
function pendingDir(cwd: string): string { return path.join(root(cwd), "pending"); }
function resolvedDir(cwd: string): string { return path.join(root(cwd), "resolved"); }
function auditPath(cwd: string): string { return path.join(cwd, ".pi", "human-console-audit.jsonl"); }
// The console directory is either the operator's (PI_KIT_HUMAN_CONSOLE_DIR) or under the workspace.
// A request or answer there is workspace state, so its write is bounded by that root. The runner sets
// the variable to the workspace's own console for every workflow child, so a directory under a .pi is
// never trusted as a root: a committed symlink there would be followed.
function writeOptions(file: string): SafeWriteOptions {
  const configured = process.env.PI_KIT_HUMAN_CONSOLE_DIR?.trim();
  return configured && piWorkspaceOf(configured) === undefined ? { root: configured } : piWorkspaceOptions(file);
}
function ensure(cwd: string): void { for (const dir of [pendingDir(cwd), resolvedDir(cwd)]) ensureDirSafe(dir, writeOptions(dir)); }
// Cap the deliberate `.invalid` quarantine by evicting the oldest by mtime. Best-effort:
// a missing directory is fine and per-file errors (e.g. an ENOENT race) are swallowed.
function pruneInvalid(dir: string, names: readonly string[]): void {
  if (names.length <= MAX_INVALID_QUARANTINE) return;
  const byMtime = names.map((name) => { const file = path.join(dir, name); let mtimeMs = 0; try { mtimeMs = fs.statSync(file).mtimeMs; } catch { /* race; treat as oldest */ } return { file, mtimeMs }; }).sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const { file } of byMtime.slice(0, byMtime.length - MAX_INVALID_QUARANTINE)) { try { fs.unlinkSync(file); } catch { /* already gone */ } }
}
function audit(cwd: string, event: Record<string, unknown>): void {
  // Best-effort: a console whose audit log cannot be written still has to report an outcome.
  try { appendFileSafe(auditPath(cwd), `${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`, { root: cwd }); } catch { /* the audit log must never break a request */ }
}
function sleep(ms: number, signal?: AbortSignal): Promise<void> { return new Promise((resolve) => { const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms); const onAbort = () => { clearTimeout(timer); resolve(); }; signal?.addEventListener("abort", onAbort, { once: true }); }); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
// A field of a value that may not be an object (or may be an array or class instance): undefined when there is none.
function prop(value: unknown, key: string): unknown { return typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined; }
// A request field as text, exactly as String() has always shown it.
function text(value: unknown): string { return String(value); }
function isString(value: unknown): value is string { return typeof value === "string"; }
function requester(ctx: unknown): Record<string, unknown> { return { pid: process.pid, sessionId: prop(ctx, "sessionId") || prop(prop(ctx, "sessionManager"), "sessionId") || null, agent: prop(prop(ctx, "agent"), "name") || prop(ctx, "agentName") || "root" }; }
function isSafeRequestId(value: unknown): value is string { return typeof value === "string" && SAFE_REQUEST_ID.test(value); }
function requestedTimeout(request: Pending, fallback: number): number {
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

// `aborted` and `unavailable` are present only when they apply: the deadline result keeps the exact
// shape existing callers and tests pin (tests/firewall-overlay-queue-smoke.ts).
export interface BrokerOutcome { resolved: boolean; approved: boolean; answer: string | null; /** True only when the requester's deadline passed. */ timedOut: boolean; aborted?: boolean; unavailable?: boolean }

export async function brokerRequest(cwd: string, request: Pending, signal?: AbortSignal): Promise<BrokerOutcome> {
  const id = isSafeRequestId(request.id) ? request.id : crypto.randomUUID();
  const timeoutMs = Math.max(1, Number(request.timeoutMs) || DEFAULT_TIMEOUT_MS);
  const pending = { ...request, id, createdAt: request.createdAt || new Date().toISOString(), timeoutMs };
  // Only an answer authenticated with the console key and bound to these exact bytes counts
  // (console-auth.ts): without a usable key no answer could be accepted, so say so at once.
  const key = loadConsoleKey({ create: false });
  if (!key.ok) {
    audit(cwd, { event: "human_console_key_unusable", id, why: key.why });
    return { resolved: false, approved: false, answer: null, timedOut: false, unavailable: true };
  }
  const pendingFile = path.join(pendingDir(cwd), `${id}.json`);
  const pendingText = JSON.stringify(pending);
  const digest = requestDigest(pendingText);
  try {
    ensure(cwd);
    writeFileSafe(pendingFile, pendingText, writeOptions(pendingFile));
  } catch (error) {
    // Fail closed: a request that cannot be filed is not approved, and the host must not crash.
    audit(cwd, { event: "human_console_unavailable", id, why: error instanceof Error ? error.message : String(error) });
    return { resolved: false, approved: false, answer: null, timedOut: false, unavailable: true };
  }
  const deadline = Date.now() + timeoutMs;
  const file = path.join(resolvedDir(cwd), `${id}.json`);
  try {
    while (!signal?.aborted && Date.now() < deadline) {
      let value: unknown;
      try { value = JSON.parse(fs.readFileSync(file, "utf8")); } catch { value = undefined; /* not resolved yet */ }
      if (isRecord(value)) {
        const checked = verifyAnswer(key.key, { id, requestDigest: digest }, value);
        if (checked.ok) return { resolved: true, approved: checked.approved, answer: checked.answer, timedOut: false };
        // A forged or foreign answer is dropped and the wait goes on: at worst this times out.
        audit(cwd, { event: "human_console_answer_rejected", id, why: checked.why });
        try { fs.unlinkSync(file); } catch { /* already removed */ }
      }
      await sleep(Math.min(POLL_MS, Math.max(1, deadline - Date.now())), signal);
    }
    // An aborted turn is not a deadline: the caller reports the abort distinctly and no card is owed.
    if (signal?.aborted) return { resolved: false, approved: false, answer: null, timedOut: false, aborted: true };
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

// Each card of a request is handed what is left of its time and the signal, so pi itself dismisses it.
// The wrapper's timer alone would leave an expired dialog focused, a late Enter lost and the next card
// stacked on top of it.
function cardBudget(timeoutMs: number, signal?: AbortSignal): () => { timeout: number; signal?: AbortSignal } {
  const deadline = Date.now() + timeoutMs;
  return () => ({ timeout: Math.max(1, deadline - Date.now()), ...(signal ? { signal } : {}) });
}

// The multiline card in the terminal. ctx.ui.editor takes no timeout or signal, so the same editor is
// opened as a custom dialog that this extension can close itself at the deadline or on an abort.
async function editorCard(ui: ExtensionContext["ui"], question: string, prefill: string, card: { timeout: number; signal?: AbortSignal }): Promise<{ settled: boolean; value?: string | undefined }> {
  if (card.signal?.aborted) return { settled: false };
  let expired = false;
  try {
    const value = await ui.custom<string | undefined>((tui, _theme, keybindings, done) => {
      const close = (result: string | undefined) => {
        clearTimeout(timer);
        card.signal?.removeEventListener("abort", expire);
        done(result);
      };
      const expire = () => { expired = true; close(undefined); };
      const component = new ExtensionEditorComponent(tui, keybindings, question, prefill, close, () => close(undefined));
      const timer = setTimeout(expire, card.timeout);
      card.signal?.addEventListener("abort", expire, { once: true });
      return component;
    });
    return expired ? { settled: false } : { settled: true, value };
  } catch {
    return { settled: true };
  }
}

type Asked = { outcome: AskOutcome; answer: string | null };
// A card that settles with no value (Esc or cancel) is dismissed at once. A typed blank is not an
// answer either, but the operator may have meant to write something, so it is asked once more with
// the draft kept (A2: prefilled in the terminal's editor card, the placeholder of ctx.ui.input
// elsewhere). A second blank is dismissed.
async function answerQuestion(ctx: UiContext, request: Pending, signal: AbortSignal | undefined, timeoutMs: number): Promise<Asked> {
  const options: string[] = Array.isArray(request.options) ? request.options.filter(isString) : [];
  const question = text(request.question ?? "");
  const nextCard = cardBudget(timeoutMs, signal);
  if (options.length && ctx.ui?.select) {
    const other = "Other (type an answer)";
    const card = nextCard();
    const selection = await waitForUi(ctx.ui.select(question, [...options, other], card), card.timeout, signal);
    if (!selection.settled) return { outcome: signal?.aborted ? "aborted" : "timeout", answer: null };
    const selected = selection.value;
    if (typeof selected === "string" && selected !== other) {
      return selected.trim() ? { outcome: "answered", answer: selected } : { outcome: "dismissed", answer: null };
    }
    if (selected !== other) return { outcome: "dismissed", answer: null };
  }
  let draft: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const card = nextCard();
    const typed = ctx.mode === "tui" && typeof ctx.ui?.custom === "function"
      ? await editorCard(ctx.ui, question, draft ?? "", card)
      : ctx.ui?.input
        ? await waitForUi(ctx.ui.input(question, draft ?? text(request.context || ""), card), card.timeout, signal)
        : { settled: true, value: null };
    if (!typed.settled) return { outcome: signal?.aborted ? "aborted" : "timeout", answer: null };
    if (typeof typed.value !== "string") return { outcome: "dismissed", answer: null };
    if (typed.value.trim()) return { outcome: "answered", answer: typed.value };
    draft = typed.value;
  }
  return { outcome: "dismissed", answer: null };
}

// An approval with `choices` (tool-firewall: allow once / allow for the session / deny / deny
// and tell) is shown as a menu; the title and card go in the menu header. Choices starting
// with "Allow" approve; "Deny and tell…" also collects a note for the agent. Without choices
// (or without a select UI) it stays a yes/no confirm.
async function answerApproval(ctx: UiContext, request: Pending, timeoutMs: number, signal?: AbortSignal): Promise<{ approved: boolean; answer: string | null; note?: string | null }> {
  const choices: string[] = Array.isArray(request.choices) ? request.choices.filter((x: unknown): x is string => typeof x === "string" && x.trim() !== "").slice(0, 6) : [];
  const title = text(request.title || "Approve tool call?");
  const body = text(request.body || "");
  const nextCard = cardBudget(timeoutMs, signal);
  if (choices.length && typeof ctx.ui?.select === "function") {
    const header = [title, body].filter(Boolean).join("\n");
    const card = nextCard();
    const picked = await waitForUi(ctx.ui.select(header, choices, card), card.timeout, signal);
    const choice = picked.settled && typeof picked.value === "string" ? picked.value : null;
    if (!choice) return { approved: false, answer: null };
    if (/^allow/i.test(choice)) return { approved: true, answer: choice };
    let note: string | null = null;
    if (/tell/i.test(choice) && typeof ctx.ui?.input === "function") {
      const noteCard = nextCard();
      const typed = await waitForUi(ctx.ui.input("Tell the agent why (it sees this):", "e.g. don't touch production; use the staging host", noteCard), noteCard.timeout, signal);
      note = typed.settled && typeof typed.value === "string" && typed.value.trim() ? typed.value.trim() : null;
    }
    return { approved: false, answer: choice, note };
  }
  const confirmCard = nextCard();
  const confirmation = ctx.ui?.confirm ? await waitForUi(ctx.ui.confirm(title, body, confirmCard), confirmCard.timeout, signal) : { settled: true, value: false };
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
// createdAt comes from a file. A date that does not parse is expired, not given a new deadline on each
// poll; every requester stamps one, so only a damaged or foreign request lacks it.
function deadlineOf(request: Pending): number {
  const createdMs = Date.parse(text(request.createdAt));
  if (Number.isNaN(createdMs)) return 0;
  return createdMs + requestedTimeout(request, DEFAULT_TIMEOUT_MS);
}
// A timer can fire a moment before the wall clock reaches it, so a card that ran out on its own timeout
// may end just short of the deadline. Inside this margin nobody answered.
const TIMER_MARGIN_MS = 5;
const pastDeadline = (deadline: number): boolean => Date.now() + TIMER_MARGIN_MS >= deadline;
// How long a card may stay open: the time left, and never more than the request asked for, so a future
// createdAt cannot stretch it.
function cardMs(request: Pending, deadline: number): number {
  return Math.max(1, Math.min(deadline - Date.now(), requestedTimeout(request, DEFAULT_TIMEOUT_MS)));
}
// Write the answer for a pending request and remove the pending file. The pending file may already
// be gone (another resolver, or a requester that gave up): a missing file is success, not an error.
// The answer is signed with the console key over the request's digest (console-auth.ts); without a
// usable key nothing is written, since the requester would refuse an unsigned answer anyway.
function writeAnswer(cwd: string, id: string, file: string, result: Answer, digest: string): void {
  const key = loadConsoleKey({ create: true });
  if (!key.ok) {
    audit(cwd, { event: "human_console_key_unusable", id, why: key.why });
    try { console.error(`[human-console] cannot sign the answer to ${id}: ${key.why}`); } catch { /* stderr unavailable */ }
    return;
  }
  const record = signedAnswer(key.key, { id, requestDigest: digest, approved: result.approved, answer: result.answer, note: result.note ?? null }, { decidedAt: new Date().toISOString() });
  const resolvedFile = path.join(resolvedDir(cwd), `${id}.json`);
  writeFileSafe(resolvedFile, JSON.stringify(record), writeOptions(resolvedFile));
  try { fs.unlinkSync(file); } catch { /* already removed by another resolver */ }
}
// A pending file as read: its parsed value and the digest of its exact bytes, which the answer is bound to.
function readPending(file: string): { value: unknown; digest: string } {
  const bytes = fs.readFileSync(file);
  return { value: JSON.parse(bytes.toString("utf8")), digest: requestDigest(bytes) };
}
function stickyNote(runId: string, note?: string | null): string {
  return `denied for the rest of workflow run ${runId}${note ? `: ${note}` : ""}`;
}

export default function humanConsole(pi: ExtensionAPI) {
  const runBroker = new RunApprovalBroker();
  // Requests the operator has been told are waiting behind an overlay: one notice each, not one a poll.
  const heldNoticed = new Set<string>();
  // Dismisses open deferred cards when the session ends.
  let cards = new AbortController();
  const noteHeld = (ctx: ExtensionContext, id: string, request: Pending, holder: string) => {
    if (heldNoticed.has(id)) return;
    heldNoticed.add(id);
    const what = request.kind === "question" ? "A child's question" : `A child's approval (${text(request.toolName || "tool call")})`;
    ctx.ui?.notify?.(`human-console: ${what} is waiting; close ${holder} to see it. It is refused at its timeout if ${holder} stays open.`, "warning");
    audit(ctx.cwd, { event: "human_console_held", id, holder });
  };
  // A request nobody can answer any more: the requester has failed closed, so drop its file and say so.
  const expire = (ctx: ExtensionContext, id: string, file: string) => {
    if (heldNoticed.delete(id)) ctx.ui?.notify?.("human-console: a child's request ran out of time and was refused.", "warning");
    audit(ctx.cwd, { event: "human_console_expired", id });
    try { fs.unlinkSync(file); } catch { /* already removed by another resolver */ }
  };
  // A grouped request takes the shown request's answer, if it is still pending and in time.
  const answerMember = (ctx: ExtensionContext, id: string, result: Answer) => {
    const file = path.join(pendingDir(ctx.cwd), `${id}.json`);
    let read: { value: unknown; digest: string };
    try { read = readPending(file); } catch { return; }
    const parsed = read.value;
    if (!isRecord(parsed) || parsed.id !== id || Date.now() > deadlineOf(parsed)) return;
    writeAnswer(ctx.cwd, id, file, result, read.digest);
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
        // Keys meant for an open overlay must not answer this. A hold that outlasts it leaves the run
        // paused, the same as No: /workflow resume still lifts it.
        const asked = await showWhenFree((card) => waitForUi(ctx.ui.select(header, [PAUSE_CHOICE_NO, PAUSE_CHOICE_YES], card), card.timeout, card.signal), {
          signal: cards.signal,
          timeoutMs: DEFAULT_TIMEOUT_MS,
          onHeld: (holder) => ctx.ui?.notify?.(`human-console: workflow run ${runId} is paused and asks to resume; close ${holder} to answer.`, "warning"),
        });
        resume = asked.kind === "shown" && asked.value.settled && asked.value.value === PAUSE_CHOICE_YES;
      }
      if (resume) controlWorkflowRun(runId, "resume");
      audit(ctx.cwd, { event: "workflow_approvals_resume_answer", runId, resumed: resume });
    } finally {
      runBroker.pauseAnswered(runId);
    }
  };
  const processRunApproval = async (ctx: ExtensionContext, file: string, request: Pending, run: RunRequest, digest: string) => {
    const deadline = deadlineOf(request);
    if (Date.now() > deadline) {
      runBroker.leave(run);
      expire(ctx, run.id, file);
      return;
    }
    const offer = runBroker.offer(run);
    if (offer.kind === "wait") return;
    if (offer.kind === "resolve") {
      writeAnswer(ctx.cwd, run.id, file, offer.approved ? { approved: true, answer: RUN_CHOICE_ALLOW_RUN } : { approved: false, answer: null, note: stickyNote(run.runId) }, digest);
      audit(ctx.cwd, { event: offer.reason === "sticky_deny" ? "workflow_approval_sticky_deny" : "workflow_approval_run_grant", runId: run.runId, id: run.id, actionHash: run.hash });
      return;
    }
    // No card while an overlay owns the keyboard (see processOne); give the slot back and retry.
    const holder = inputHeld();
    if (holder) {
      noteHeld(ctx, run.id, request, holder);
      runBroker.abandon(run);
      return;
    }
    let settled = false;
    const { signal } = cards;
    try {
      const title = `${text(request.title || "Approve tool call?")} · workflow run ${run.runId}${run.step === undefined ? "" : ` · step ${run.step}`}`;
      const result = await answerApproval(ctx, { ...request, title, choices: runChoices(run.high) }, cardMs(request, deadline), signal);
      // The session ended under the card: nobody answered, and the requester's own deadline decides.
      if (signal.aborted) return;
      // No answer before the requester's deadline: it has already failed closed; decide nothing.
      if (!result.approved && result.answer === null && pastDeadline(deadline)) {
        expire(ctx, run.id, file);
        return;
      }
      const approved = result.approved;
      const outcome = runBroker.settle(run, { approved, runGrant: result.answer === RUN_CHOICE_ALLOW_RUN });
      settled = true;
      const answer: Answer = approved ? { approved, answer: result.answer } : { approved, answer: result.answer, note: stickyNote(run.runId, result.note) };
      writeAnswer(ctx.cwd, run.id, file, answer, digest);
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
      let digest: string;
      try { ({ value: parsed, digest } = readPending(file)); } catch {
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
        await processRunApproval(ctx, file, request, run, digest);
        return;
      }
      // A deferred request may have run out behind an overlay. Its requester has failed closed, so
      // there is nothing to ask; this runs before the hold check so that the drop is not held up.
      const deadline = deadlineOf(request);
      if (deadline - Date.now() <= 0) {
        expire(ctx, id, file);
        return;
      }
      // An open overlay owns the keyboard (V-02): `select` would take focus from it, and keys typed
      // into it could answer a child's card. Leave the pending file for a later poll; the requester's
      // own deadline still fails closed. The check is per request, not per scan, so that a run grant
      // or a sticky deny, which needs no card, is not stalled behind the workflow panel.
      const holder = inputHeld();
      if (holder) {
        noteHeld(ctx, id, request, holder);
        return;
      }
      // The card runs for the time left, not the full timeout: past the deadline an answer is discarded.
      const { signal } = cards;
      let result: Answer;
      if (request.kind === "approval") result = await answerApproval(ctx, request, cardMs(request, deadline), signal);
      else {
        const asked = await answerQuestion(ctx, request, signal, cardMs(request, deadline));
        result = { approved: asked.outcome === "answered", answer: asked.answer };
      }
      // The session ended under the card: nobody answered, and the requester's own deadline decides.
      if (signal.aborted) return;
      if (pastDeadline(deadline)) {
        // The requester gave up at its deadline (brokerRequest unlinks both files in its
        // finally); do not recreate an orphan resolved file. Drop the pending file too so
        // the watcher does not re-answer it forever.
        expire(ctx, id, file);
        return;
      }
      // writeAnswer tolerates a pending file that is already gone: an unguarded unlinkSync
      // here is an unhandled rejection that kills pi.
      writeAnswer(ctx.cwd, id, file, result, digest);
    } finally { processing.delete(file); }
  };
  const processPending = (ctx: ExtensionContext) => {
    try {
      ensure(ctx.cwd);
      const dir = pendingDir(ctx.cwd);
      const entries = fs.readdirSync(dir);
      pruneInvalid(dir, entries.filter((f) => f.endsWith(".invalid")));
      const names = entries.filter((f) => f.endsWith(".json"));
      // A request its requester has taken back needs no further notice.
      for (const id of heldNoticed) if (!names.includes(`${id}.json`)) heldNoticed.delete(id);
      for (const name of names) {
        const file = path.join(dir, name);
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
    cards = new AbortController();
    // The interactive console is the only creator of the answer key (console-auth.ts): requesters
    // started after this find it; one started before reports that the console must start first.
    const key = loadConsoleKey({ create: true });
    if (!key.ok) try { console.error(`[human-console] the answer key cannot be used, so no answer can be signed: ${key.why}`); } catch { /* stderr unavailable */ }
    processPending(ctx);
    watcher = setInterval(() => { processPending(ctx); }, POLL_MS); watcher.unref?.();
  });
  pi.on("session_shutdown", async () => { if (watcher) clearInterval(watcher); watcher = null; cards.abort(); heldNoticed.clear(); runBroker.clear(); });
  pi.registerTool({ name: "ask_human", label: "Ask human", description: "Ask the operator a concise clarifying question.", parameters: Type.Object({ question: Type.String(), options: Type.Optional(Type.Array(Type.String())), context: Type.Optional(Type.String()), timeoutMs: Type.Optional(Type.Number({ minimum: 1 })) }), async execute(_id, params, signal, _onUpdate, ctx) {
    let outcome: AskOutcome;
    let answer: string | null;
    // Only the declared fields: pi's validator keeps undeclared arguments, and the model must not reach
    // kind, workflowRun, actionHash, createdAt or a card's text through them.
    const question: Pending = { question: params.question, ...(params.options === undefined ? {} : { options: params.options }), ...(params.context === undefined ? {} : { context: params.context }), ...(params.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs }) };
    // An interactive question is bounded too: a UI that never answers (a closed terminal, an RPC client that ignores
    // the request) must not park the agent for ever. Without a timeoutMs of its own it gets the console's timeout.
    if (ctx.hasUI && ctx.ui) {
      // An open overlay owns the keyboard here too (see processOne): `select` would take focus and Enter
      // would return the first option as the human's answer. The wait and the card share the timeout.
      const asked = await showWhenFree((card) => answerQuestion(ctx, { kind: "question", ...question }, signal, card.timeout), {
        signal,
        timeoutMs: requestedTimeout(params, cardTimeoutMs()),
        rawTimeout: true,
        onHeld: (holder) => ctx.ui.notify?.(`human-console: a question is waiting; close ${holder} to see it.`, "warning"),
      });
      if (asked.kind === "shown") {
        outcome = asked.value.outcome;
        answer = asked.value.answer;
      } else {
        outcome = asked.kind;
        answer = null;
      }
    } else {
      const id = crypto.randomUUID(); audit(ctx.cwd, { event: "ask_human_pending", id });
      const broker = await brokerRequest(ctx.cwd, { ...question, id, kind: "question", requester: requester(ctx) }, signal);
      if (broker.unavailable) outcome = "unavailable";
      else if (broker.resolved) outcome = broker.answer?.trim() ? "answered" : "dismissed";
      else if (broker.aborted) outcome = "aborted";
      else if (broker.timedOut) outcome = "timeout";
      else outcome = "dismissed";
      answer = outcome === "answered" ? broker.answer : null;
      audit(ctx.cwd, { event: broker.timedOut ? "ask_human_timeout" : "ask_human_resolved", id, outcome });
    }
    return { content: [{ type: "text" as const, text: askText(outcome, answer) }], details: { answer, outcome } };
  }});
}
