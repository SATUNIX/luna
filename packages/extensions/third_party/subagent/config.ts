/**
 * Subagent — configuration and environment parsing.
 *
 * Every tunable lives here, read from the environment per call (not at module load) so an
 * operator can adjust a single run without restarting the parent.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const MAX_PARALLEL_TASKS = 8;
export const DEFAULT_CONCURRENCY = 4;
export const PER_TASK_OUTPUT_CAP = 50 * 1024;

// A child that reads files or runs commands streams every tool result back as JSONL, so a
// real exploration task accumulates far more than a trivial one. stdout and stderr are
// counted separately (see child-process.ts), so this is a per-stream budget. Raised from
// 64 MiB to 256 MiB after exploration-heavy children were routinely killed at 64 MiB.
export const DEFAULT_CHILD_STREAM_CAP = 256 * 1024 * 1024;

// Cap the text kept per stored message so parent memory stays bounded even when a child
// streams large tool results. The full stream is still written to the run log.
export const MAX_STORED_MESSAGE_TEXT = 200 * 1024;

// Per-run log + registry under <stateDir>/.pi/subagent. Keeps work inspectable live
// (`tail -f`) and recoverable after a kill or a parent abort instead of vanishing.
export const SUBAGENT_STATE_DIRNAME = ".pi/subagent";
export const MAX_LOG_BYTES = 64 * 1024 * 1024;
export const DEFAULT_MAX_RUN_LOGS = 50;
// runs.jsonl is compacted to the records of this many most recent runs when logs are pruned.
export const MAX_REGISTRY_RUNS = 500;

// A child that produces no bytes for this long is presumed hung. 0 disables. This is the
// single most effective guard against a wedged subagent: before it, a child stuck on a
// dead request hung the parent's tool call forever (there was no default watchdog).
export const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000;

// The idle watchdog keys on *output*, so a child that drips a byte at a time (a streamed
// trace, a periodic keepalive) can defeat it and run forever. This wall-clock ceiling is
// the backstop: a child is force-killed after this long regardless of how chatty it is.
// 0 disables. 30 minutes is deliberately generous for real implementer work while still
// bounding the pathological case that previously hung the parent's tool call indefinitely.
export const DEFAULT_MAX_RUNTIME_MS = 30 * 60 * 1000;

// While a child runs, the parent emits a liveness tick on this cadence so the TUI shows
// elapsed time / last activity instead of a silent, apparently-frozen tool call.
export const DEFAULT_HEARTBEAT_MS = 5000;

// A headless subagent has no UI to answer a tool-firewall "ask". Without a bound it would
// block on the human-console broker for the full 15-minute root default — the exact
// "counter stops, agent does not continue" freeze. Children get a shorter default so an
// unanswered approval fails closed and the child can report it, unless the operator has
// explicitly set PI_KIT_HUMAN_CONSOLE_TIMEOUT_MS.
export const DEFAULT_CHILD_APPROVAL_TIMEOUT_MS = 2 * 60 * 1000;

// Nesting: how many subagent levels may be spawned below the root session. 0 disables
// delegation entirely; 1 allows only root -> child; 2 (default) lets a child delegate once
// more. Guards against runaway recursive fan-out while enabling delegate-able roles.
export const DEFAULT_MAX_DEPTH = 2;
export const MAX_DEPTH_CEILING = 32;

// Automatic retries for *transient* failures only (spawn failure, or a non-zero exit with
// no usable output). A retry cannot duplicate completed work because transients by
// definition produced none; limits (timeout/stream-cap) and operator stops are not retried.
export const DEFAULT_RETRIES = 1;
export const RETRY_BACKOFF_MS = 2000;
// Cap the number of stored messages so a very long child cannot grow parent memory without
// bound. The full stream is in the run log and the final answer is kept separately.
export const MAX_STORED_MESSAGES = 400;

export function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

export function nativeSettingsPath(): string {
  return path.join(agentDir(), "settings.json");
}

export function falseValue(value: string | undefined): boolean {
  return /^(?:0|false|off|no)$/i.test(value?.trim() ?? "");
}

// Truthy unless explicitly disabled. `defaultWhenUnset` lets a flag default on (e.g. detach)
// while still allowing an explicit `=0`/`false`/`off`/`no` to turn it off.
export function envFlag(name: string, defaultWhenUnset = false): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return defaultWhenUnset;
  return !falseValue(raw);
}

// Event types emitted by `pi --mode json` that are per-token streaming deltas. They are
// omitted from the run log (the matching `message_end` carries the full content) so a long
// run does not write tens of thousands of synchronous lines and bloat the log to its cap.
export const LOG_SKIP_EVENT_TYPES = new Set([
  "message_start",
  "message_update",
  "thinking_start",
  "thinking_delta",
  "thinking_end",
  "text_start",
  "text_delta",
  "text_end",
  "toolcall_start",
  "toolcall_delta",
]);

// Whether to force every child onto the parent model, ignoring role `model:` frontmatter.
// Roles without a `model:` always use the parent model, so the default (false) only changes
// behaviour for roles that explicitly ask for a model — before, that frontmatter was silently
// ignored unless an env var was set.
export function loadInheritParentModel(): boolean {
  // Environment configuration is intentional for managed installs and takes priority.
  if (process.env.PI_KIT_SUBAGENT_INHERIT_MODEL !== undefined) {
    return !falseValue(process.env.PI_KIT_SUBAGENT_INHERIT_MODEL);
  }
  try {
    const saved: unknown = JSON.parse(fs.readFileSync(nativeSettingsPath(), "utf8"));
    return isRecord(saved) && isRecord(saved.warnings) && saved.warnings.subagentInheritModel === true;
  } catch {
    return false;
  }
}

// Read a non-negative integer from the environment, clamped to [min, max]. Returns the
// fallback when the variable is unset, empty, or not a finite number.
export function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// String(value) for a value parsed from YAML or JSON. Scalars and lists convert exactly as
// String() does; a mapping reads "[object Object]" as before, without relying on its toString.
export function toText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((item) => (item === null || item === undefined ? "" : toText(item))).join(",");
  if (typeof value === "object" && value !== null) return Object.prototype.toString.call(value);
  return String(value);
}
