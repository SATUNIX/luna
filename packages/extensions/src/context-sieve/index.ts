import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";

interface Contribution {
  id: string;
  priority: number;
  budgetTokens: number;
  content: string;
  // Where the contribution is injected (see channelOf). Producers may set it explicitly.
  channel?: "system" | "message";
}

const DEFAULT_BUDGET_TOKENS = 4096;
const DEFAULT_MESSAGE_BUDGET_TOKENS = 1200;
const CHARS_PER_TOKEN = 4;

// Upper bound on a single contribution file. Files above this are skipped before parse so a
// runaway/hostile producer cannot force a huge JSON parse on every before_agent_start.
export const MAX_CONTRIBUTION_BYTES = 262144;

// Filesystem timestamps can be coarse (kernel tick) and lag the wall clock by a few ms,
// and up to seconds on FAT/NFS. Only treat a file at least this much older than process
// start as a leftover, so a contribution written during session_start is always included
// regardless of load order.
const SESSION_EPOCH_GRACE_NS = 2_000_000_000n; // 2 s

// Process/module-load epoch: any contribution file whose mtime is meaningfully older than
// this (i.e. predates the epoch minus the grace/tolerance above) is a leftover from a prior
// session. Captured once when this extension module loads, before any session_start handler
// runs, so the rule no longer depends on whether a producer (goal-core, guidelines)
// re-materializes its file before or after this handler, and is robust to coarse filesystem
// timestamps.
const SESSION_EPOCH_NS = BigInt(Date.now()) * 1_000_000n - SESSION_EPOCH_GRACE_NS;

// Admission/coercion for a raw parsed contribution. Pure (no filesystem access) so it can be
// unit-tested directly. A non-object/non-string id or content rejects the file; a non-finite
// or absent priority is coerced to 0 (the file is still admitted -- absence of a priority is
// not a reason to drop a contribution). budgetTokens and channel pass through unchanged.
export function normalizeContribution(raw: unknown): Contribution | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.id !== "string" || obj.id.length === 0) return null;
  if (typeof obj.content !== "string") return null;
  const priority = typeof obj.priority === "number" && Number.isFinite(obj.priority) ? obj.priority : 0;
  return { ...(raw as Contribution), priority };
}

// Deterministic assembly order: higher priority first, ties broken by id so contributions
// with equal priority do not depend on readdir order.
export function compareContributions(a: Contribution, b: Contribution): number {
  if (b.priority !== a.priority) return b.priority - a.priority;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

// Two injection channels:
//  - "system": appended to the system prompt. Only for content that rarely changes
//    (guidelines, goal, mode notes): the system prompt sits in front of the whole history,
//    so any change to it invalidates the provider's prompt cache for every token after it.
//  - "message": one hidden custom message before the user's prompt. For per-turn content
//    (memory recall, delegation directives, loop/progress nudges). Appending a message keeps
//    the cached prefix intact; rewriting the system prompt every turn (the previous behaviour
//    for all contributions) threw the cache away on nearly every prompt.
const DYNAMIC_IDS = new Set(["memory-local", "memory-vault", "orchestrator", "progress-guard", "recovery-orchestrator", "autonomous-loop", "skill-router"]);

function channelOf(c: Contribution): "system" | "message" {
  if (c.channel === "system" || c.channel === "message") return c.channel;
  return DYNAMIC_IDS.has(c.id) ? "message" : "system";
}

// B-005: contribution files are scoped per session so concurrent sessions sharing a cwd
// (child agents do) cannot overwrite each other. The resolver is duplicated here (not
// imported) because every extension must stay independently extractable
// (packages/core/verify.ts self-containment lint).
const SESSION_ID_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

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

// Session-scoped directory when an id is known; the legacy flat directory otherwise.
function getContribDir(cwd: string, sessionId?: string): string {
  const base = path.join(cwd, ".pi", "ctx-contributions");
  return isSessionId(sessionId) ? path.join(base, "sessions", sessionId) : base;
}

function currentMtimeNs(file: string): bigint {
  try {
    return fs.statSync(file, { bigint: true }).mtimeNs;
  } catch {
    return -1n;
  }
}

// A contribution is skipped only when its file is meaningfully older than this process's
// module-load epoch (older than epoch minus the grace/tolerance), i.e. a leftover from a
// prior session. Contributions written this session -- including a producer that
// re-materializes byte-identical content during session_start -- are within the grace
// window (or newer) and are included, regardless of extension load order and coarse
// filesystem timestamps.
function readContributions(dir: string): Contribution[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return []; // no contributions directory yet
  }
  const files = names.filter(f => f.endsWith(".json"));
  const result: Contribution[] = [];
  for (const f of files) {
    if (f === "sieve-budget.json") continue;
    try {
      const file = path.join(dir, f);
      // Older than process start minus the grace/tolerance -> a prior-session leftover, skip it.
      // The grace keeps same-session writes (mtime possibly lagging the wall clock) included.
      if (currentMtimeNs(file) < SESSION_EPOCH_NS) continue;
      // One open file: the size that is checked is the size of the file that is read.
      const fd = fs.openSync(file, "r");
      let raw: string;
      try {
        if (fs.fstatSync(fd).size > MAX_CONTRIBUTION_BYTES) continue;
        raw = fs.readFileSync(fd, "utf8");
      } finally {
        fs.closeSync(fd);
      }
      const parsed: unknown = JSON.parse(raw);
      const contribution = normalizeContribution(parsed);
      if (contribution) result.push(contribution);
    } catch {
      // skip malformed contribution files
    }
  }
  return result;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function writeBudgetEvent(dir: string, event: { totalTokens: number; budget: number; dropped: string[]; included: string[]; truncated: string[]; message?: { tokens: number; included: string[]; injected: string[]; skippedUnchanged: boolean }; contextWindow?: number | null; windowClamped?: boolean }): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "sieve-budget.json"), JSON.stringify(event, null, 2));
  } catch {
    // Telemetry must never break prompt assembly.
  }
}

// AG-07 fixes (the narrow contribution-budgeting mechanism, not the broader
// unimplemented "budgets the whole prompt/history/tool-output" claim - see the review's
// own triage: "medium because the narrow contribution mechanism is real"):
//  - PI_KIT_CTX_BUDGET_TOKENS being unset/non-numeric previously parsed to NaN, and
//    `used + len > NaN` is always false in JS, so an invalid env value silently disabled
//    budgeting entirely (allow-everything) instead of falling back to a safe default.
//  - each contribution's own declared `budgetTokens` was read into the type but never
//    applied - a single oversized contribution could consume the entire global budget.
//  - a contribution that didn't fit in the REMAINING budget was dropped whole rather
//    than truncated to fit, even when most of it would have fit.
function positiveIntOr(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

// Share of the model's context window the injected contributions may take: the system-prompt channel
// defaults to at most 10% of it, the hidden per-turn message to at most 3%, and even an explicit
// operator budget is held under half the window (a budget larger than that leaves no room for the
// conversation and is a misconfiguration, not a preference).
const SYSTEM_WINDOW_SHARE = 0.1;
const MESSAGE_WINDOW_SHARE = 0.03;
const MAX_WINDOW_SHARE = 0.5;
const MIN_BUDGET_TOKENS = 64;

/** The model's context window, or null when it is unknown (no model, or contextWindow <= 0). Never 0. */
export function knownContextWindow(ctx: unknown): number | null {
  try {
    const raw = Number((ctx as { model?: { contextWindow?: unknown } } | undefined)?.model?.contextWindow);
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Resolve one budget in tokens. `configured` is the env value (absolute, when valid); `fallback` the
 * built-in default. With a known window the default is scaled to `share` of it and any budget is
 * capped at half of it; with an unknown window the configured numbers are used unchanged.
 */
export function budgetFor(configured: unknown, fallback: number, share: number, window: number | null): { tokens: number; clamped: boolean } {
  const explicit = typeof configured === "string" ? configured.trim() !== "" && positiveIntOr(configured, 0) > 0 : typeof configured === "number" && configured > 0;
  const wanted = positiveIntOr(configured, fallback);
  if (window === null) return { tokens: wanted, clamped: false };
  const base = explicit ? wanted : Math.min(wanted, Math.max(MIN_BUDGET_TOKENS, Math.floor(window * share)));
  const tokens = Math.min(base, Math.max(1, Math.floor(window * MAX_WINDOW_SHARE)));
  return { tokens, clamped: tokens < wanted };
}

// Conservative upper bound on the marker's own rendered length (template text plus a
// realistic digit count for the omitted-character count), so the returned text can never
// itself exceed maxChars even though the exact omitted count isn't known until after
// slicing.
const TRUNCATION_MARKER_MAX_LEN = 60;

function truncateToChars(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  if (maxChars <= TRUNCATION_MARKER_MAX_LEN) return { text: "", truncated: true }; // no room for a useful fragment
  const keep = maxChars - TRUNCATION_MARKER_MAX_LEN;
  const marker = `\n[... truncated ${text.length - keep} more characters ...]`;
  return { text: text.slice(0, keep) + marker, truncated: true };
}

function assembleWithBudget(
  contributions: Contribution[],
  budgetChars: number,
): { assembled: string[]; included: string[]; dropped: string[]; truncatedIds: string[] } {
  const sorted = [...contributions].sort(compareContributions);
  let used = 0;
  const assembled: string[] = [];
  const included: string[] = [];
  const dropped: string[] = [];
  const truncatedIds: string[] = [];

  for (const contrib of sorted) {
    const remaining = budgetChars - used;
    if (remaining <= 0) {
      dropped.push(contrib.id);
      continue;
    }
    // Respect this contribution's own declared budget in addition to the global one.
    const ownBudgetChars = positiveIntOr(contrib.budgetTokens, Infinity) * CHARS_PER_TOKEN;
    const cap = Math.min(remaining, ownBudgetChars);
    const { text, truncated } = truncateToChars(contrib.content, cap);
    if (text.length === 0) {
      dropped.push(contrib.id);
      continue;
    }
    assembled.push(text);
    included.push(contrib.id);
    if (truncated) truncatedIds.push(contrib.id);
    used += text.length;
  }

  return { assembled, included, dropped, truncatedIds };
}

export default function (pi: ExtensionAPI) {
  let contribDir = "";
  // The text of each message-channel contribution as last injected this session, by id. A
  // contribution whose text is unchanged is not injected again: its earlier copy is already in
  // the conversation history, and repeating it would only grow the context. The comparison is
  // per contribution, so one changing contribution does not re-inject every unchanged one.
  // Reset when compaction may have summarised the earlier copies away.
  const lastInjected = new Map<string, string>();

  pi.on("session_compact", async () => {
    lastInjected.clear();
  });

  pi.on("session_start", async (_event, ctx) => {
    lastInjected.clear();
    contribDir = getContribDir(ctx.cwd, resolveSessionId(ctx.sessionManager));
    fs.mkdirSync(contribDir, { recursive: true });
    // Never delete another session's contributions; readContributions ignores files
    // meaningfully older than SESSION_EPOCH_NS (process start minus the grace window)
    // instead of importing their directives. This is startup containment, not full
    // producer/task identity for later concurrent writes.
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const dir = contribDir;
    const contributions = readContributions(dir);
    if (contributions.length === 0) return undefined;

    // The budgets are absolute token counts, but a fixed 4096 + 1200 is a third of a 16k window and
    // most of an 8k one (the lite profile is for exactly those). Size them against the model's real
    // context window; an unknown window (no model, contextWindow <= 0) keeps the configured numbers
    // and is recorded as unknown, never as 0.
    const window = knownContextWindow(ctx);
    const sysBudget = budgetFor(process.env.PI_KIT_CTX_BUDGET_TOKENS, DEFAULT_BUDGET_TOKENS, SYSTEM_WINDOW_SHARE, window);
    const messageBudget = budgetFor(process.env.PI_KIT_CTX_MESSAGE_BUDGET_TOKENS, DEFAULT_MESSAGE_BUDGET_TOKENS, MESSAGE_WINDOW_SHARE, window);
    const budgetTokens = sysBudget.tokens;
    const messageBudgetTokens = messageBudget.tokens;
    const windowClamped = sysBudget.clamped || messageBudget.clamped;
    const system = assembleWithBudget(contributions.filter((c) => channelOf(c) === "system"), budgetTokens * CHARS_PER_TOKEN);
    const message = assembleWithBudget(contributions.filter((c) => channelOf(c) === "message"), messageBudgetTokens * CHARS_PER_TOKEN);
    const messageText = message.assembled.join("\n\n");
    const fresh: string[] = [];
    const injected: string[] = [];
    const unchanged: string[] = [];
    const current = new Map<string, string>();
    message.included.forEach((id, i) => {
      const text = message.assembled[i] ?? "";
      current.set(id, text);
      if (lastInjected.get(id) === text) {
        unchanged.push(id);
      } else {
        fresh.push(text);
        injected.push(id);
      }
    });
    // A contribution that is gone is forgotten, so it is injected again if it comes back.
    for (const id of [...lastInjected.keys()]) if (!current.has(id)) lastInjected.delete(id);
    const skippedUnchanged = messageText !== "" && injected.length === 0;

    writeBudgetEvent(dir, {
      totalTokens: estimateTokens(system.assembled.join("\n\n")),
      budget: budgetTokens,
      dropped: [...system.dropped, ...message.dropped],
      included: [...system.included, ...message.included],
      truncated: [...system.truncatedIds, ...message.truncatedIds],
      message: { tokens: estimateTokens(messageText), included: message.included, injected, skippedUnchanged },
      contextWindow: window,
      windowClamped,
    });

    const result: { systemPrompt?: string; message?: { customType: string; content: string; display: boolean } } = {};
    if (system.assembled.length > 0) result.systemPrompt = event.systemPrompt + "\n\n" + system.assembled.join("\n\n");
    if (injected.length > 0) {
      for (const id of injected) lastInjected.set(id, current.get(id) ?? "");
      const stillCurrent = unchanged.length > 0 ? `\n\n(Still current, injected earlier in this conversation: ${unchanged.join(", ")}.)` : "";
      result.message = { customType: "context-sieve", content: `[Context for this request — injected automatically, not written by the user]\n\n${fresh.join("\n\n")}${stillCurrent}`, display: false };
    }
    return result.systemPrompt || result.message ? result : undefined;
  });

  // Pi's supported compaction return contract can cancel or replace the whole
  // summary; it cannot amend summarizer instructions. A truncated transcript is
  // not a summary and discards later corrections. Leave native summarization and
  // its full prepared transcript intact. Current contributions remain available
  // to ordinary prompt assembly; do not import an unscoped GOAL.yaml here.
  pi.on("session_before_compact", async () => undefined);
}
