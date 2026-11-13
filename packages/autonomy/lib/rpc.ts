// pi RPC helpers (node_modules/@earendil-works/pi-coding-agent/docs/rpc.md). The supervisor talks
// JSON lines to `pi --mode rpc` over the container's stdin/stdout, so the agent needs no network
// for control.
//
// The auto-operator (operatorDecision) answers extension dialogs according to the run contract
// (permissions.unattended) and never hangs:
//   approval dialogs (confirm, or a select of allow/deny choices)
//       autoApprove on  -> answered affirmatively, at once (uiResponse)
//       autoApprove off -> the run blocks and the prompt is recorded for the operator
//   questions (input, editor, or a select that is not allow/deny) -> the run ALWAYS blocks with
//       the question recorded: a person's answer is never invented. `resume --answer` continues.
//   notices (notify, setStatus, ...) -> no reply.
// A blocked run stops its worker session; the answer reaches the next session's briefing.

import { isRecord, parseJson } from "../../core/lib/guard.ts";
import { classifyProviderError, redactProviderError } from "../../extensions/src/finish-reason-retry/provider-errors.ts";

/**
 * One JSON line from `pi --mode rpc`: an object with a string `type`. Every other key is pi's and
 * arrives unchecked (`unknown`), so readers narrow each field they use.
 */
export interface RpcFrame {
  readonly type: string;
  readonly [key: string]: unknown;
}

/** Whether a parsed RPC line is a frame (an object with a string `type`). */
export function isRpcFrame(value: unknown): value is RpcFrame {
  return isRecord(value) && typeof value["type"] === "string";
}

/** An extension_ui_request as far as the operator reads it; every field is pi's and unchecked. */
export interface UiRequest {
  readonly id?: unknown;
  readonly method?: unknown;
  readonly title?: unknown;
  readonly message?: unknown;
  readonly options?: unknown;
  readonly prefill?: unknown;
}

export type DialogKind = "approval" | "question" | "notice";

/** permissions.unattended of the run contract, as the operator reads it. */
export interface UnattendedPolicy {
  readonly authorised?: boolean;
  readonly autoApprove?: boolean;
}

/** A dialog the run cannot answer by itself: recorded for the operator, and the run blocks. */
export interface Blocker {
  kind: "approval" | "question" | "external";
  id: string;
  method: DialogMethod | "provider" | "review";
  question: string;
  options: string[];
}

/** The reply sent back to pi for one extension_ui_request. */
export type UiResponse =
  | { type: "extension_ui_response"; id: unknown; confirmed: true }
  | { type: "extension_ui_response"; id: unknown; cancelled: true }
  | { type: "extension_ui_response"; id: unknown; value: string };

export type OperatorDecision =
  | { action: "reply"; reply: UiResponse | null }
  | { action: "block"; blocker: Blocker }
  | { action: "ignore" };

export const OPERATOR_ANSWER =
  "Approved. Proceed with your best judgement within the cycle charter (autonomy/CHARTER.md); you do not need to check with me again for this task.";

const DIALOG_METHODS = ["confirm", "select", "input", "editor"] as const;
type DialogMethod = (typeof DIALOG_METHODS)[number];

/** The request's method when it is a dialog (it expects an answer), else null. */
function dialogMethod(req: UiRequest | null | undefined): DialogMethod | null {
  const method = req?.method;
  return DIALOG_METHODS.find((m) => m === method) ?? null;
}

/** The request's options as strings; anything but an array is no options. */
function optionList(req: UiRequest): string[] {
  return Array.isArray(req.options) ? req.options.map(String) : [];
}

const ALLOW_SESSION = /\ballow\b.*\bsession\b/i;
const AFFIRM = /^(allow|yes|approve|approved|continue|proceed|ok|accept|run|confirm)\b/i;
const NEGATIVE = /\b(deny|block|reject|cancel|no|stop|abort)\b/i;

/** "approval" | "question" | "notice" for one extension_ui_request. */
export function classifyDialog(req: UiRequest | null | undefined): DialogKind {
  const method = dialogMethod(req);
  if (method === null || !req) return "notice";
  if (method === "confirm") return "approval";
  if (method === "select") {
    const options = optionList(req);
    // The firewall's approval menus are "Allow once / Allow for this session / Deny ...". A question's
    // options (ask_human appends "Other (type an answer)") are never taken for an approval, even a Yes/No one.
    const allow = options.some((o) => /^allow\b/i.test(o.trim()));
    const deny = options.some((o) => /^(deny|block|reject)\b/i.test(o.trim()));
    return allow && deny ? "approval" : "question";
  }
  return "question"; // input, editor: free text is a question for a person
}

/**
 * What the supervisor does with one UI request (an extension_ui_request) under the run's
 * unattended policy (permissions.unattended).
 */
export function operatorDecision(req: UiRequest, policy: UnattendedPolicy = {}): OperatorDecision {
  const kind = classifyDialog(req);
  const method = dialogMethod(req);
  if (kind === "notice" || method === null) return { action: "ignore" };
  const question = [req.title, req.message].filter((x): x is string => typeof x === "string" && x.trim() !== "").join(": ").slice(0, 1000) || "(no text)";
  const blocker: Blocker = { kind, id: text(req.id), method, question, options: optionList(req).slice(0, 12) };
  if (kind === "approval" && policy.autoApprove === true && policy.authorised === true) return { action: "reply", reply: uiResponse(req) };
  return { action: "block", blocker };
}

/** The response for one extension_ui_request, or null for fire-and-forget methods. */
export function uiResponse(req: UiRequest): UiResponse | null {
  const id = req.id;
  switch (dialogMethod(req)) {
    case "confirm":
      return { type: "extension_ui_response", id, confirmed: true };
    case "select": {
      const options = optionList(req);
      const pick = options.find((o) => ALLOW_SESSION.test(o))
        ?? options.find((o) => AFFIRM.test(o.trim()) && !NEGATIVE.test(o))
        ?? options.find((o) => !NEGATIVE.test(o))
        ?? options[0];
      return pick === undefined ? { type: "extension_ui_response", id, cancelled: true } : { type: "extension_ui_response", id, value: pick };
    }
    case "input":
      return { type: "extension_ui_response", id, value: OPERATOR_ANSWER };
    case "editor":
      return { type: "extension_ui_response", id, value: typeof req.prefill === "string" && req.prefill.trim() ? req.prefill : OPERATOR_ANSWER };
    case null:
      return null; // notify, setStatus, setWidget, setTitle, set_editor_text: nothing to answer
  }
}

/**
 * Split a stream of chunks into complete JSON lines; malformed lines are reported, not thrown.
 * A line is malformed when it is not JSON or not a frame (an object with a string `type`); an
 * exception from onMessage also reports the line, as it always has.
 */
export function lineParser(onMessage: (msg: RpcFrame) => void, onBad: (line: string) => void = () => {}): (chunk: string | Buffer) => void {
  let buf = "";
  return (chunk) => {
    buf += typeof chunk === "string" ? chunk : chunk.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = parseJson(line);
        if (!isRpcFrame(msg)) throw new TypeError("not an RPC frame");
        onMessage(msg);
      } catch {
        onBad(line);
      }
    }
  };
}

/** Short, human-readable activity lines for the manager bundle (lib/manager.ts). */
export function activityLine(ev: RpcFrame & { readonly at?: number }): string | null {
  const t = new Date(ev.at ?? Date.now()).toISOString().slice(11, 19);
  switch (ev.type) {
    case "tool_execution_start":
      return `${t} tool ${text(ev["toolName"] ?? ev["tool"], "?")} ${clipArgs(ev["args"])}`;
    case "tool_execution_end":
      return ev["isError"] ? `${t} tool ${text(ev["toolName"], "?")} ERROR ${clipArgs(ev["result"])}` : null;
    case "extension_ui_request":
      return ev["method"] === "notify" ? `${t} notice(${text(ev["notifyType"], "info")}) ${text(ev["message"]).slice(0, 200)}` : null;
    case "extension_error":
      return `${t} extension error ${text(ev["error"] ?? ev["message"]).slice(0, 200)}`;
    case "auto_retry_start":
      return `${t} provider retry: ${text(ev["errorMessage"]).slice(0, 160)}`;
    case "compaction_start":
      return `${t} compaction`;
    case "agent_end":
      return `${t} agent run ended${ev["willRetry"] ? " (will retry)" : ""}`;
    default:
      return null;
  }
}

/** The count of clampable credit failures in a row for one worker session, kept by the caller. */
export interface ProviderLimitWatch {
  clamped: number;
}

/**
 * The provider's message when a frame reports a terminal credit or limit failure (an assistant
 * message that ended in error, or retries that gave up; a retry still under way may recover, so it does not count), else null. Such a session cannot make
 * progress, so the run parks as blocked with this reason instead of closing empty cycles.
 */
export function providerLimitError(ev: RpcFrame, watch: ProviderLimitWatch = { clamped: 0 }): string | null {
  let message: unknown;
  if (ev.type === "message_end" || ev.type === "message_update") {
    const m = ev["message"];
    if (isRecord(m) && m["role"] === "assistant" && m["stopReason"] === "error") message = m["errorMessage"];
  } else if (ev.type === "auto_retry_end" && ev["success"] === false) message = ev["finalError"];
  if (ev.type === "message_end" && isRecord(ev["message"]) && ev["message"]["role"] === "assistant" && ev["message"]["stopReason"] !== "error") watch.clamped = 0;
  if (typeof message !== "string") return null;
  const failure = classifyProviderError(message);
  if (failure.kind !== "credit") return null;
  // A 402 that names what the account can afford is retried by the worker with a smaller output maximum
  // (finish-reason-retry), once. The retry may not happen (no output maximum in the request to lower, the
  // same figure again) so the decision is not left to it: the second such failure in a row parks the run,
  // as does a retry that gave up. A reply that succeeds in between starts the count again.
  if (failure.clampTo !== undefined && ev.type !== "auto_retry_end") {
    watch.clamped += 1;
    if (watch.clamped < 2) return null;
  }
  return redactProviderError(message, 300);
}

/** The blocker a provider limit failure parks the run with. */
export function providerBlocker(reason: string): Blocker {
  return { kind: "external", id: "provider-limit", method: "provider", question: `The model provider refused requests for credit or key limits: ${reason}. Top up or raise the key's limit, then resume with --answer "continue".`, options: [] };
}

/** The blocker an unavailable reviewer parks a run with: the work is intact and was never judged. */
export function reviewBlocker(reason: string, sha: string): Blocker {
  return { kind: "external", id: "review-pending", method: "review", question: `No reviewer gave a usable verdict for the work at ${sha.slice(0, 12)} (${reason}). The work is kept and was not rejected. Check the review model and the provider, then resume with --answer "continue" to review it again.`, options: [] };
}

/** `String(value ?? fallback)` for a field pi sent unchecked (activity lines and blockers are display text). */
function text(value: unknown, fallback = ""): string {
  const shown: unknown = value ?? fallback;
  return String(shown);
}

function clipArgs(v: unknown): string {
  const s = typeof v === "string" ? v : JSON.stringify(v ?? "");
  return s.length > 160 ? `${s.slice(0, 160)}…` : s;
}

/** progress-guard / recovery-orchestrator escalations show up as notices; count them. */
export function isGuardEscalation(ev: RpcFrame): boolean {
  return ev.type === "extension_ui_request" && ev["method"] === "notify"
    && /progress-guard|recovery|stuck|loop detected|oscillat/i.test(text(ev["message"]));
}

/**
 * Commands the long-horizon harness must have registered. The list is a marker subset of what the
 * worker profile (long-horizon) registers: every name here is a harness command, so a kit that
 * failed to load (a bad package path, a broken extension) is distinguishable from a bare pi. pi
 * still starts, bare; the supervisor checks this list against `get_commands` at the start of every
 * session and stops the run rather than cycle without the harness. The check fails closed: a
 * missing command, a malformed reply or no reply at all is a failure.
 */
export const HARNESS_COMMANDS: readonly string[] = ["goal", "handoff", "verify", "firewall", "orchestrate", "trace"];

/** How long a worker session is given to answer the start-up get_commands check before it fails closed. */
export const HARNESS_CHECK_TIMEOUT_MS = 30_000;

/** Missing harness commands in a get_commands response (an empty list means the harness loaded). */
export function missingHarness(response: unknown, required: readonly string[] = HARNESS_COMMANDS): string[] {
  const data = isRecord(response) ? response["data"] : undefined;
  const list = (isRecord(data) ? data["commands"] : undefined) ?? data ?? [];
  const names = new Set((Array.isArray(list) ? list : []).map((c: unknown) => (isRecord(c) ? c["name"] : undefined)));
  return required.filter((name) => !names.has(name));
}

/**
 * One worker session's harness verdict. The supervisor makes a fresh check per session (reset),
 * settles it on the get_commands reply, and expires it when no reply arrives in time. It fails
 * closed: pending and failed both leave `verified` false, and only a full reply verifies. The
 * verdict is per session, so a previous session's failure cannot latch onto the next one.
 */
export class HarnessCheck {
  readonly required: readonly string[];
  private state: "pending" | "verified" | "failed" = "pending";
  private reason: string | null = null;

  constructor(required: readonly string[] = HARNESS_COMMANDS) {
    this.required = required;
  }

  /** Start a new session: pending, with no verdict yet. */
  reset(): void {
    this.state = "pending";
    this.reason = null;
  }

  /** Settle the check on a get_commands reply: true when every required command is present. Once settled (including by `expire()`), a later reply must not overwrite the verdict. */
  settle(response: unknown): boolean {
    if (this.state !== "pending") return this.state === "verified";
    const missing = missingHarness(response, this.required);
    if (missing.length === 0) {
      this.state = "verified";
      this.reason = null;
      return true;
    }
    this.state = "failed";
    this.reason = `the kit harness did not load (missing commands: ${missing.join(", ")})`;
    return false;
  }

  /** Fail closed when the reply has not arrived in time. A no-op once the check has settled. */
  expire(): void {
    if (this.state !== "pending") return;
    this.state = "failed";
    this.reason = `the kit harness check timed out after ${String(HARNESS_CHECK_TIMEOUT_MS)}ms`;
  }

  /** True only after a full get_commands reply settled this session. */
  get verified(): boolean { return this.state === "verified"; }

  /** Why the session is unusable, or null while pending or once verified. */
  get failure(): string | null { return this.reason; }
}
