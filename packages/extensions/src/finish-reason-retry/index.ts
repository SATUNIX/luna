import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isContextOverflow } from "@earendil-works/pi-ai/compat";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// pi's built-in auto-retry (settings.retry.enabled/maxRetries/baseDelayMs, see
// docs/settings.md "Retry") only retries an errored assistant message when its
// errorMessage matches a fixed regex in agent-session.js's _isRetryableError
// (overloaded, rate limit, 5xx, network/connection errors, timeouts, ...).
//
// OpenAI-completions-style providers (node_modules/@earendil-works/pi-ai's
// openai-completions.js mapStopReason) turn any finish_reason they don't
// recognize into stopReason "error" with errorMessage `Provider finish_reason:
// ${reason}`. OpenRouter (and other proxies) emit finish_reason "error" when the
// underlying model provider glitches mid-generation while still returning a 200 -
// a genuinely transient hiccup - but "Provider finish_reason: error" doesn't match
// any pattern in the built-in regex, so it surfaces as a hard failure that needs a
// manual "continue" instead of being retried.
//
// This rewrites just that one errorMessage so the existing regex matches, handing
// it to pi's own retry system - same exponential backoff, same attempt cap, and
// the counter already resets to 0 on the next successful assistant message
// (agent-session.js), so a run that errors again a few prompts later gets a fresh
// set of attempts rather than inheriting a used-up counter.
//
// Deliberately narrow: only the exact "error" finish_reason. content_filter and
// other unmapped finish_reasons are left alone - those are real terminal states,
// not glitches, and blindly retrying them could mask a genuine problem.
const TARGET_ERROR_MESSAGE = "Provider finish_reason: error";

// The literal the annotated message must contain for pi's `_isRetryableError` to
// classify it as retryable. Mirrors the `provider.?returned.?error` alternative in
// node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js's regex.
// The old annotation ("transient provider error") matched none of the alternatives,
// so this extension was a no-op: pi retried nothing.
const RETRYABLE_MARKER = "provider returned error";
export const RETRYABLE_PROVIDER_ERROR = /provider.?returned.?error/i;

/** Annotate the target error so pi's retry regex actually matches it. Exported for tests. */
export function toRetryableErrorMessage(errorMessage: string): string {
  return `${errorMessage} (${RETRYABLE_MARKER} — transient, retryable)`;
}

// --- exhausted context windows ----------------------------------------------------------------
// This extension is loaded in every kit profile except lite AND in every subagent child (it is one
// of the few extensions a child gets, see subagent/isolation.ts DEFAULT_CHILD_EXTENSIONS), which
// makes it the place where a full context window becomes visible instead of a cryptic provider
// error. What pi 0.85.1 actually does (agent-session.js _checkCompaction), verified in source:
//   - compaction.enabled=false returns first thing: threshold compaction AND overflow recovery are
//     both off, so a full window just ends the run with the provider's error.
//   - enabled: an overflow (or a "length" stop below the model's own max output) removes the failed
//     message, compacts and retries ONCE (_overflowRecoveryAttempted); a second overflow ends the run
//     with "Context overflow recovery failed after one compact-and-retry attempt". Bounded, no loop.
// In a `pi -p --mode json` child the print mode keeps exit code 0 on an assistant error and the
// parent only sees the raw provider text, so the reason and the way out are added to the message
// itself (message_end can replace it) and, for failed recoveries, to stderr.

/** pi-ai's own clamp on requested output (api/simple-options.js): window - input - 4096, at least 1. */
export const PI_CONTEXT_SAFETY_TOKENS = 4096;

/**
 * The output cap pi actually requests: the model's maxTokens, reduced so that input + output stays
 * inside the window with headroom. Derived from the model's real numbers, never a fixed constant.
 * Returns null when the window is unknown (then nothing can be said about headroom).
 */
export function derivedOutputCap(model: { contextWindow?: number; maxTokens?: number } | undefined, inputTokens: number): number | null {
  const window = model?.contextWindow ?? 0;
  if (!Number.isFinite(window) || window <= 0) return null;
  const maxTokens = model?.maxTokens ?? 0;
  const room = Math.max(1, window - Math.max(0, inputTokens) - PI_CONTEXT_SAFETY_TOKENS);
  return maxTokens > 0 ? Math.min(maxTokens, room) : room;
}

function agentDir(): string {
  const env = process.env.PI_CODING_AGENT_DIR;
  if (env) return env === "~" ? os.homedir() : env.startsWith("~/") ? path.join(os.homedir(), env.slice(2)) : env;
  return path.join(os.homedir(), ".pi", "agent");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function compactionBlock(file: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
    const c = isRecord(parsed) ? parsed.compaction : undefined;
    return isRecord(c) && !Array.isArray(c) ? c : {};
  } catch {
    return {};
  }
}

/** pi's effective compaction.enabled (global < trusted project, `?? true`) and where it came from. */
export function compactionEnabled(cwd: string, projectTrusted?: boolean): { enabled: boolean; file: string | null } {
  const globalFile = path.join(agentDir(), "settings.json");
  const projectFile = path.join(cwd, ".pi", "settings.json");
  const project = projectTrusted === false ? {} : compactionBlock(projectFile);
  if (Object.prototype.hasOwnProperty.call(project, "enabled") && project.enabled !== undefined) return { enabled: Boolean(project.enabled ?? true), file: projectFile };
  const global = compactionBlock(globalFile);
  if (Object.prototype.hasOwnProperty.call(global, "enabled") && global.enabled !== undefined) return { enabled: Boolean(global.enabled ?? true), file: globalFile };
  return { enabled: true, file: null };
}

function fmt(n: number): string {
  return n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n);
}

const OVERFLOW_TAG = "[pi-kit context-exhausted]";

/** The operator-facing explanation prepended to an overflow error when nothing can recover it. Exported for tests. */
export function overflowExplanation(window: number | null, file: string | null): string {
  const size = window ? ` (${fmt(window)}-token window)` : "";
  return (
    `${OVERFLOW_TAG} The context window is full${size} and pi auto-compaction is OFF (compaction.enabled=false${file ? ` in ${file}` : ""}), so pi cannot recover this run. ` +
    "Turn it on with /compaction on, run /compact or /compress, or start a fresh session; a subagent should be given a smaller task."
  );
}

function tell(ctx: ExtensionContext | undefined, message: string, level: "info" | "warning" | "error" = "warning"): void {
  try {
    if (ctx?.hasUI) {
      ctx.ui.notify(message, level);
      return;
    }
  } catch {
    /* stale ctx: fall through to stderr */
  }
  try {
    process.stderr.write(`[pi-kit] ${message}\n`);
  } catch {
    /* no stderr */
  }
}

export default function (pi: ExtensionAPI) {
  let lastLengthNote = "";

  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return undefined;
    const message = event.message;

    // Truncated by the token limit. Explain the arithmetic (input + output <= window, with headroom)
    // so a clamped reply is not mistaken for the model choosing to stop; pi itself compacts and
    // retries once when auto-compaction is on and the stop is below the model's own maxTokens.
    if (message.stopReason === "length") {
      const model = ctx?.model as { contextWindow?: number; maxTokens?: number } | undefined;
      const input = (message.usage?.input ?? 0) + (message.usage?.cacheRead ?? 0);
      const cap = derivedOutputCap(model, input);
      const maxTokens = model?.maxTokens ?? 0;
      if (cap !== null && maxTokens > 0 && cap < maxTokens) {
        // A non-null cap means the model has a positive, finite window.
        const window = model?.contextWindow ?? 0;
        const note = `reply cut off at ${fmt(message.usage?.output ?? 0)} tokens: with ${fmt(input)} tokens of input in a ${fmt(window)} window only ${fmt(cap)} of the model's ${fmt(maxTokens)} output tokens fit (pi keeps ${fmt(PI_CONTEXT_SAFETY_TOKENS)} spare). ` +
          "The context is nearly full: compact it (/compact, /compress) or start a fresh session.";
        if (note !== lastLengthNote) {
          lastLengthNote = note;
          tell(ctx, note);
        }
      }
      return undefined;
    }

    if (message.stopReason !== "error") return undefined;

    // A full context window that nothing will recover: say so in the message itself.
    if (typeof message.errorMessage === "string" && !message.errorMessage.includes(OVERFLOW_TAG)) {
      const model = ctx?.model as { contextWindow?: number } | undefined;
      const contextWindow = model?.contextWindow ?? 0;
      const window = contextWindow > 0 ? contextWindow : 0;
      if (isContextOverflow(message, window)) {
        let trusted: boolean | undefined;
        try {
          trusted = typeof ctx?.isProjectTrusted === "function" ? ctx.isProjectTrusted() : undefined;
        } catch {
          trusted = undefined;
        }
        const state = compactionEnabled(ctx?.cwd ?? process.cwd(), trusted);
        if (!state.enabled) {
          const explanation = overflowExplanation(window || null, state.file);
          tell(ctx, explanation, "error");
          // Put the explanation in front of the provider's text, or behind it when a provider
          // pattern is anchored to the start of the message (Cerebras' "^413 (no body)"). pi's own
          // overflow classification must still hold on the rewritten message or it would start
          // treating a full window as an ordinary error.
          for (const errorMessage of [`${explanation} ${message.errorMessage}`, `${message.errorMessage} ${explanation}`]) {
            if (isContextOverflow({ ...message, errorMessage }, window)) return { message: { ...message, errorMessage } };
          }
        }
        return undefined;
      }
    }

    if (message.errorMessage !== TARGET_ERROR_MESSAGE) return undefined;
    const errorMessage = toRetryableErrorMessage(message.errorMessage);
    // Guard: never hand pi a message its own retry regex will not match (that was the
    // original bug). If the annotation ever drifts, stay a no-op instead of lying.
    if (!RETRYABLE_PROVIDER_ERROR.test(errorMessage)) return undefined;
    return { message: { ...message, errorMessage } };
  });

  // Fired when a manual or automatic compaction fails or is aborted. The overflow case is the run
  // ending after pi's one compact-and-retry attempt: give the operator (or the parent that spawned
  // this child) the way out instead of a bare "recovery failed".
  pi.on("session_compact_failed", async (event, ctx) => {
    if (event.aborted) return; // cancelled on purpose (another extension, or the operator)
    const why = event.errorMessage ? ` (${event.errorMessage})` : "";
    if (event.reason === "overflow") {
      tell(
        ctx,
        `The context window is full and pi's one compact-and-retry attempt failed${why}. The run has stopped and will not retry again. ` +
          "Try /compress (deterministic, no model call), start a fresh session with /new (run /handoff first to keep the thread), or switch to a larger-context model.",
        "error",
      );
    } else if (event.reason === "threshold") {
      tell(ctx, `Automatic compaction failed${why}; the context keeps growing. /compress needs no model call, or /new starts fresh.`, "warning");
    }
  });
}
