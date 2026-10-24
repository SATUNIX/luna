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
  kind: "approval" | "question";
  id: string;
  method: DialogMethod;
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
 * Commands the long-horizon harness must have registered. If the kit fails to load (a bad
 * package path, a broken extension) pi still starts, bare; the supervisor checks this list
 * against `get_commands` at the start of every session and stops the run rather than cycle
 * without the harness.
 */
export const HARNESS_COMMANDS: readonly string[] = ["goal", "subagents", "handoff", "verify", "firewall:status", "orchestrate", "trace"];

/** Missing harness commands in a get_commands response (an empty list means the harness loaded). */
export function missingHarness(response: unknown, required: readonly string[] = HARNESS_COMMANDS): string[] {
  const data = isRecord(response) ? response["data"] : undefined;
  const list = (isRecord(data) ? data["commands"] : undefined) ?? data ?? [];
  const names = new Set((Array.isArray(list) ? list : []).map((c: unknown) => (isRecord(c) ? c["name"] : undefined)));
  return required.filter((name) => !names.has(name));
}
