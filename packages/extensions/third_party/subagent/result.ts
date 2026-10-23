/**
 * Subagent — reading a finished child's result.
 *
 * A killed child may still have produced a real answer, so failure output prefers whatever
 * the child streamed and annotates why it stopped, rather than discarding it behind a bare
 * error string.
 */
import { isRecord, MAX_STORED_MESSAGE_TEXT, PER_TASK_OUTPUT_CAP } from "./config.ts";
import type { Msg, MsgPart, SingleResult } from "./types.ts";

// Thread a chain step's output into the next task. A function replacer is required: a string
// replacement interprets `$&`, `$'`, `$1`… inside the previous output and corrupts it.
export function substitutePrevious(task: string, previous: string): string {
  return task.replace(/\{previous\}/g, () => previous);
}

export function getFinalOutput(messages: Msg[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role === "assistant" && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === "text" && part.text) return part.text;
      }
    }
  }
  return "";
}

// A child that fails its own governance check exits with EX_CONFIG (delegation-guard).
export const EX_CONFIG = 78;

export function isFailedResult(result: SingleResult): boolean {
  return (
    result.exitCode !== 0 ||
    result.stopReason === "denied" ||
    result.stopReason === "error" ||
    result.stopReason === "aborted" ||
    result.stopReason === "stream-cap" ||
    result.stopReason === "timeout" ||
    result.stopReason === "wall-clock" ||
    result.stopReason === "stopped"
  );
}

export type FailureClass = "none" | "transient" | "limit" | "fatal";

// Classify a failure so the caller can decide whether an automatic retry is safe.
// `transient` means the child produced no usable output (so a retry cannot duplicate
// completed work); `limit` is a budget/watchdog kill; `fatal` is an operator stop, an
// abort, or a failure that already produced output.
export function classifyFailure(result: SingleResult): FailureClass {
  if (!isFailedResult(result)) return "none";
  const hasWork = Boolean(result.finalOutput) || result.messages.length > 0;
  if (result.stopReason === "aborted" || result.stopReason === "stopped") return "fatal";
  // A refused launch (no budget, missing protection, guard not loaded) or a child that failed its
  // governance check is a policy outcome, never a transient fault: retrying cannot help and, for a
  // budget denial, would only burn attempts.
  if (result.stopReason === "denied" || result.exitCode === EX_CONFIG) return "fatal";
  // `timeout`, `stream-cap` and `wall-clock` are all budget/watchdog kills: they must never be
  // auto-retried. Before this, `wall-clock` fell through to the generic tail and a kill with no
  // output was reported `transient`, so the runner re-ran a task the ceiling had just stopped,
  // contradicting SOURCE.md (limits are never auto-retried).
  if (result.stopReason === "timeout" || result.stopReason === "stream-cap" || result.stopReason === "wall-clock") return hasWork ? "fatal" : "limit";
  if (/launch failed/i.test(result.errorMessage ?? "")) return "transient";
  if (result.exitCode !== 0 && !hasWork) return "transient";
  return "fatal";
}

// Actionable next step for a failed child, so a bare "failed" is never a dead end.
function failureHint(result: SingleResult): string {
  if (result.stopReason === "denied") return "The launch was refused before any child started; the message says why (effort budget, missing protection or guard). Do the work directly or change the effort tier with /effort.";
  if (result.exitCode === EX_CONFIG) return "The child refused to run because a required protection was not loaded in it (delegation-guard). Reinstall the kit or re-apply the profile with /profile.";
  if (result.stopReason === "aborted") return "The parent cancelled (Esc). Pass background: true for work that should outlive the turn.";
  if (result.stopReason === "timeout") return "Raise PI_KIT_SUBAGENT_IDLE_TIMEOUT_MS, or set it to 0 to disable the idle watchdog.";
  if (result.stopReason === "wall-clock") return "Raise or unset PI_KIT_SUBAGENT_MAX_RUNTIME_MS for longer tasks.";
  if (result.stopReason === "stream-cap") return "Raise PI_KIT_SUBAGENT_STREAM_CAP_BYTES for exploration-heavy tasks.";
  if (result.stopReason === "stopped") return "Stopped by operator (/subagent-stop).";
  if (result.stderr.includes("Unknown agent")) return "Built-in roles come from the kit; add your own in ~/.pi/agent/agents, or pass agentScope \"both\" to include this project's .pi/agents.";
  return "";
}

export function getResultOutput(result: SingleResult): string {
  // A detached run has no answer yet by design; say so plainly instead of "(no output)".
  if (result.detached) {
    return `Subagent ${result.agent} is still running in the background (run ${result.runId ?? "?"}). The parent stopped waiting; the child will finish on its own and record its result in ${result.logPath ?? "its run log"}. Use subagent_status id=${result.runId ?? "<run>"} to follow it.`;
  }
  if (isFailedResult(result)) {
    const partial = result.finalOutput || getFinalOutput(result.messages);
    const detail = (result.errorMessage || result.stderr || "").trim();
    const hint = failureHint(result);
    // A budget/watchdog kill may still have produced a real answer before dying; surface
    // that and annotate why it stopped rather than discarding it behind the bare error.
    if (partial) {
      const notes = [detail, hint].filter(Boolean).join(" ");
      return notes ? `${partial}\n\n[${notes}]` : partial;
    }
    return [detail || "(no output)", hint].filter(Boolean).join("\n");
  }
  return result.finalOutput || getFinalOutput(result.messages) || "(no output)";
}

export function truncate(output: string): string {
  if (Buffer.byteLength(output, "utf8") <= PER_TASK_OUTPUT_CAP) return output;
  let t = output.slice(0, PER_TASK_OUTPUT_CAP);
  while (Buffer.byteLength(t, "utf8") > PER_TASK_OUTPUT_CAP) t = t.slice(0, -1);
  return `${t}\n\n[output truncated]`;
}

// Slice a string to at most `maxBytes` UTF-8 bytes without splitting a code point.
function sliceToBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let end = text.length;
  while (end > 0 && Buffer.byteLength(text.slice(0, end), "utf8") > maxBytes) {
    end -= Math.max(1, Math.floor(end / 16));
  }
  while (end > 0 && Buffer.byteLength(text.slice(0, end), "utf8") > maxBytes) end--;
  return text.slice(0, end);
}

// Keep only a bounded slice of each message's text in memory; the run log holds the
// complete stream and `SingleResult.finalOutput` holds the full final answer, so bounding
// the message list loses nothing the caller needs.
export function boundMessage(msg: Msg): Msg {
  if (!Array.isArray(msg.content)) return msg;
  let changed = false;
  const content = msg.content.map((part) => {
    if (part.type === "text" && typeof part.text === "string" && Buffer.byteLength(part.text, "utf8") > MAX_STORED_MESSAGE_TEXT) {
      changed = true;
      const kept = sliceToBytes(part.text, MAX_STORED_MESSAGE_TEXT);
      return { ...part, text: `${kept}\n\n[stored message truncated to ${Buffer.byteLength(kept, "utf8")} bytes; full stream in the run log]` };
    }
    return part;
  });
  return changed ? { ...msg, content } : msg;
}

const optional = (value: unknown, type: "string" | "number"): boolean => value === undefined || typeof value === type;

function isMsgPart(value: unknown): value is MsgPart {
  return isRecord(value) && typeof value.type === "string" && optional(value.text, "string") && optional(value.name, "string") && (value.arguments === undefined || isRecord(value.arguments));
}

// A message from a child's JSON event stream. The child is another process, so its output is
// checked before use: only the fields this extension reads, and only the types it relies on.
export function isMsg(value: unknown): value is Msg {
  if (!isRecord(value) || typeof value.role !== "string") return false;
  const { content, usage } = value;
  if (content !== undefined && typeof content !== "string" && !(Array.isArray(content) && content.every(isMsgPart))) return false;
  if (!optional(value.model, "string") || !optional(value.stopReason, "string") || !optional(value.errorMessage, "string")) return false;
  if (usage === undefined) return true;
  if (!isRecord(usage)) return false;
  if (!["input", "output", "cacheRead", "cacheWrite", "totalTokens"].every((key) => optional(usage[key], "number"))) return false;
  return usage.cost === undefined || (isRecord(usage.cost) && optional(usage.cost.total, "number"));
}
