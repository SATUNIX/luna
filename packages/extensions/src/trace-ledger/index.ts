import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { appendFileSafe, rotateFileSafe } from "./shared/safe-fs.ts";
import { asResult, asUsage, cacheDrop, renderUsage, resultChars, summariseUsage, usageFromMessage, type ResultRecord, type UsageRecord } from "./usage.ts";

// trace-ledger: append-only action records in .pi/trace.jsonl; memory windows are bounded.
// EFF-6: before an append, a ledger over ROTATE_BYTES is renamed to trace.jsonl.1 (one old copy,
// replacing the previous one) and a fresh file is started. Never truncate this shared file:
// conductor and other processes also append outside this extension, and each opens the path per
// append, so after a rename they write to the fresh file.
// It is the FACTS layer for efficiency + anti-loop work: it records every tool call and
// result so later tooling (the Phase-3 progress-guard, or `/trace`) can ask "have we read
// this file already?" / "are we repeating the same command?". It is behaviour-only:
// it never blocks a tool and never injects context. Collector health and repeated
// reads are visible, while failed persistence remains explicitly best-effort.

const RECENT_WINDOW = 48; // in-memory window used for repeat detection
const REPEAT_WARN = 3; // same read target this many times -> one gentle notice
const READ_HINT = /^(read|grep|glob|ls|find|cat|search|rg)/i; // read/search tool families
const ROTATE_BYTES = 4 * 1024 * 1024; // same bound as tool-firewall's judgements file

interface Entry {
  ts: string;
  turn: number;
  kind: "call" | "result";
  eventId: string;
  runId: string;
  sessionId: string | null;
  processId: number;
  cwd: string;
  toolCallId: string | null;
  sequence: number;
  lostEntries: number;
  retention: "append-only/rotated-at-4MiB";
  targetRedacted: boolean;
  targetTruncated: boolean;
  targetOriginalLength: number;
  redactionPolicy: "common-secrets-v1-best-effort";
  tool: string;
  target?: string | undefined;
  argsHash: string;
  status?: "ok" | "error";
  /** Characters of text the tool returned (results only). */
  chars?: number;
}

function ledgerPath(cwd: string): string {
  return path.join(cwd, ".pi", "trace.jsonl");
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") + "}";
}

function argsHashOf(tool: string, input: unknown): string {
  try { return crypto.createHash("sha256").update(tool + " " + stableStringify(input)).digest("hex"); }
  catch { return "unhashable"; }
}

const TARGET_SCAN_CHARS = 1024;

export function targetOf(input: unknown): Pick<Entry, "target" | "targetRedacted" | "targetTruncated" | "targetOriginalLength" | "redactionPolicy"> {
  const o = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const value = o.path ?? o.file_path ?? o.filePath ?? o.filepath ?? o.file ?? o.pattern ?? o.command ?? o.query;
  const original = typeof value === "string" ? value : "";
  // Only 200 characters are stored, so only the first TARGET_SCAN_CHARS are redacted: the work per
  // call is bounded however long the command is. A secret cut at that point is still redacted,
  // because each value pattern runs to the end of the slice.
  const bounded = original.length > TARGET_SCAN_CHARS ? original.slice(0, TARGET_SCAN_CHARS) : original;
  // Best-effort display redaction, not a secret-detection or isolation boundary. The key pattern
  // starts only at a token start and bounds its runs, so it does not backtrack.
  const redacted = bounded
    .replace(/(authorization\s*[:=]\s*["']?(?:bearer|basic)\s+)[^\s"']+/gi, "$1[REDACTED]")
    .replace(/((?<![\w-])(?=[\w-]{0,64}(?:password|passwd|secret|token|api[_-]?key))[\w-]{1,128}(?:\s*[=:]\s*|\s+))("[^"]*"|'[^']*'|[^\s;&|]+)/gi, "$1[REDACTED]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{16,})\b/g, "[REDACTED]");
  const targetTruncated = redacted.length > 200 || bounded.length < original.length;
  return { target: typeof value === "string" ? redacted.slice(0, 200) + (targetTruncated ? "...[truncated]" : "") : undefined,
    targetRedacted: redacted !== bounded, targetTruncated, targetOriginalLength: original.length,
    redactionPolicy: "common-secrets-v1-best-effort" };
}

function isReadish(tool: string): boolean {
  return READ_HINT.test(tool) || tool.toLowerCase().includes("read");
}

function shortTarget(t: string): string {
  return t.length > 60 ? "…" + t.slice(-57) : t;
}

// The ledger lives in the workspace, which a cloned repository controls: every directory from the
// workspace root down and the file itself are opened without following symlinks (./shared/safe-fs.ts,
// tests/workspace-symlink-smoke.ts). A planted link makes the append fail, never redirect.
function appendEntry(cwd: string, entry: object): void {
  const p = ledgerPath(cwd);
  rotateFileSafe(p, ROTATE_BYTES, { root: cwd });
  appendFileSafe(p, JSON.stringify(entry) + "\n", { root: cwd });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The fields /trace summarises, as read back from a ledger other writers share. */
type LedgerRecord = Pick<Entry, "kind" | "tool" | "target" | "status">;

/** EFF-8: a record whose summarised fields have the wrong type is corrupt, not an Entry. */
function toLedgerRecord(value: unknown): LedgerRecord | null {
  if (!isRecord(value)) return null;
  const { kind, tool, target, status } = value;
  if ((kind !== "call" && kind !== "result") || typeof tool !== "string") return null;
  if (target !== undefined && typeof target !== "string") return null;
  if (status !== undefined && status !== "ok" && status !== "error") return null;
  return { kind, tool, target, ...(status === undefined ? {} : { status }) };
}

/** The ledger's last megabyte as lines: a bounded read of a file other writers share. */
function readTailLines(cwd: string): string[] {
  let fd: number;
  try {
    fd = fs.openSync(ledgerPath(cwd), "r");
  } catch {
    return []; // no ledger yet
  }
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - 1024 * 1024);
    const buffer = Buffer.alloc(size - start);
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, start);
    let text = buffer.subarray(0, bytes).toString("utf8");
    if (start > 0) text = text.slice(text.indexOf("\n") + 1);
    return text.split("\n").filter(Boolean);
  } finally { fs.closeSync(fd); }
}

function readEntries(cwd: string, tail: number): { entries: LedgerRecord[]; corrupt: number } {
  // Parse per line: one corrupt record must not abort the whole /trace summary.
  const entries: LedgerRecord[] = [];
  let corrupt = 0;
  for (const line of readTailLines(cwd)) {
    try {
      const raw: unknown = JSON.parse(line);
      if (isRecord(raw) && raw.kind === "usage") continue; // accounting records, read by /usage
      // A syntactically valid non-object (null, false, 0), or an object whose fields have the
      // wrong type, is corrupt: same skip/count path as a parse failure.
      const record = toLedgerRecord(raw);
      if (record) entries.push(record);
      else corrupt++;
    } catch { corrupt++; }
  }
  return { entries: entries.slice(-tail), corrupt };
}

/** Usage and result records of this run, plus its children's (same workspace, written since this run began). */
function readAccounting(cwd: string, runId: string, since: string): { usage: UsageRecord[]; results: ResultRecord[] } {
  const usage: UsageRecord[] = [];
  const results: ResultRecord[] = [];
  for (const line of readTailLines(cwd)) {
    let raw: unknown;
    try { raw = JSON.parse(line); } catch { continue; }
    if (!isRecord(raw) || typeof raw.ts !== "string") continue;
    if (raw.runId !== runId && !(typeof raw.childId === "string" && raw.ts >= since)) continue;
    const u = asUsage(raw);
    if (u) { usage.push(u); continue; }
    const r = asResult(raw);
    if (r) results.push(r);
  }
  return { usage, results };
}

export default function (pi: ExtensionAPI) {
  let turn = 0;
  let sequence = 0;
  let lostEntries = 0;
  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  // A kit child (subagent, workflow agent) writes the same workspace ledger; its records say so.
  const childId = process.env.PI_KIT_INTERNAL_CHILD === "1" ? `child-${process.pid}` : null;
  let pendingResultChars: Record<string, number> = {};
  let lastUsage: UsageRecord | undefined;
  let failureNotified = false;

  function health(ctx: ExtensionContext, failed: boolean): void {
    const message = `trace-ledger: ${failed ? "collection failed; " : ""}lost=${lostEntries}; append-only, rotated to .1 at 4 MiB`;
    if (ctx.hasUI) {
      ctx.ui.setStatus?.("trace-ledger", message);
      if (failed && !failureNotified) ctx.ui.notify(message, "error");
    } else if (failed && !failureNotified) process.stderr.write(message + "\n");
    if (failed) failureNotified = true;
  }

  function metadata(ctx: ExtensionContext, toolCallId?: string) {
    return { eventId: crypto.randomUUID(), runId, childId, sessionId: ctx.sessionManager?.getSessionId?.() ?? null,
      processId: process.pid, cwd: ctx.cwd, toolCallId: toolCallId ?? null, sequence: ++sequence, lostEntries,
      retention: "append-only/rotated-at-4MiB" as const };
  }

  function persist(ctx: ExtensionContext, entry: object): void {
    try { appendEntry(ctx.cwd ?? process.cwd(), entry); if (failureNotified) health(ctx, false); }
    catch { lostEntries += 1; health(ctx, true); }
  }
  const recent: Entry[] = [];
  const warned = new Set<string>();

  function remember(entry: Entry): void {
    recent.push(entry);
    if (recent.length > RECENT_WINDOW) recent.shift();
  }

  pi.on("session_start", async (_event, ctx) => {
    turn = 0;
    recent.length = 0;
    warned.clear();
    health(ctx, false);
  });

  pi.on("tool_call", async (event, ctx) => {
    const c = ctx;
    const ev = event as { toolName?: string; input?: unknown; toolCallId?: string };
    const tool = ev.toolName ?? "unknown";
    const details = targetOf(ev.input);
    const target = details.target;
    const entry: Entry = { ...metadata(c, ev.toolCallId), ...details, ts: new Date().toISOString(), turn, kind: "call", tool, argsHash: argsHashOf(tool, ev.input) };
    persist(c, entry);
    remember(entry);

    // Gentle repeat-read notice (behaviour-only, de-duplicated, never blocks).
    if (target && isReadish(tool)) {
      const count = recent.filter((e) => e.kind === "call" && e.target === target && isReadish(e.tool)).length;
      if (count >= REPEAT_WARN && !warned.has(target) && c.hasUI) {
        c.ui.notify(`trace-ledger: '${shortTarget(target)}' read ${count}x — you likely have enough. Act, or delegate the lookup. (/trace)`, "warning");
        warned.add(target);
        const oldest = warned.values().next().value;
        if (warned.size > RECENT_WINDOW && oldest !== undefined) warned.delete(oldest);
      }
    }
    return undefined; // never block
  });

  pi.on("tool_result", async (event, ctx) => {
    const c = ctx;
    const ev = event as { toolName?: string; input?: unknown; isError?: boolean; toolCallId?: string; content?: unknown };
    const tool = ev.toolName ?? "unknown";
    const chars = resultChars(ev.content);
    pendingResultChars[tool] = (pendingResultChars[tool] ?? 0) + chars;
    const entry: Entry = {
      chars,
      ...metadata(c, ev.toolCallId),
      ...targetOf(ev.input),
      ts: new Date().toISOString(),
      turn,
      kind: "result",
      tool,
      argsHash: argsHashOf(tool, ev.input),
      status: ev.isError ? "error" : "ok",
    };
    persist(c, entry);
    remember(entry);
    return undefined; // never modify the result
  });

  pi.on("turn_end", async () => { turn += 1; });

  // One record per model request, as the provider reported it. The tool results returned since the
  // previous request are the ones this request carried, so their size is attributed to it.
  pi.on("message_end", async (event, ctx) => {
    const record = usageFromMessage((event as { message?: unknown }).message, { runId, childId, resultChars: pendingResultChars });
    if (!record) return undefined;
    pendingResultChars = {};
    persist(ctx, { ...metadata(ctx), turn, tool: "model", ...record });
    if (cacheDrop(lastUsage, record) && ctx.hasUI) {
      ctx.ui.setStatus?.("trace-ledger-cache", "cache: hit rate dropped (prompt prefix changed or cache expired); see /usage");
    } else if (lastUsage && ctx.hasUI && record.cacheRead > 0) ctx.ui.setStatus?.("trace-ledger-cache", undefined);
    if (record.input + record.cacheRead + record.cacheWrite > 0) lastUsage = record;
    return undefined;
  });

  pi.registerCommand("usage", {
    description: "Where this session's tokens and money went: by model, child and tool, cache hit rate, the largest results.",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      try {
        const { usage, results } = readAccounting(ctx.cwd ?? process.cwd(), runId, startedAt);
        ctx.ui.notify(renderUsage(summariseUsage(usage, results)), "info");
      } catch { ctx.ui.notify("usage: the ledger could not be read", "error"); }
    },
  });

  pi.registerCommand("trace", {
    description: "Summarize the action ledger (.pi/trace.jsonl): call counts, errors, and repeated reads.",
    handler: async (_args, ctx) => {
      const c = ctx as ExtensionContext;
      if (!c.hasUI) return;
      let entries: LedgerRecord[];
      let corrupt: number;
      try { ({ entries, corrupt } = readEntries(c.cwd ?? process.cwd(), 200)); }
      catch { health(c, true); c.ui.notify("trace-ledger: cannot summarize unreadable/corrupt records; evidence retained", "error"); return; }
      if (entries.length === 0) {
        c.ui.notify("trace-ledger: no actions recorded yet.", "info");
        return;
      }
      const calls = entries.filter((e) => e.kind === "call");
      const errors = entries.filter((e) => e.kind === "result" && e.status === "error").length;
      const reads = calls.filter((e) => e.target && isReadish(e.tool));
      const distinctFiles = new Set(reads.map((e) => e.target)).size;
      const repeatCounts = new Map<string, number>();
      for (const e of reads) repeatCounts.set(e.target as string, (repeatCounts.get(e.target as string) ?? 0) + 1);
      const topRepeats = [...repeatCounts.entries()]
        .filter(([, n]) => n >= 2)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([t, n]) => `${shortTarget(t)} ×${n}`);
      const lines = [
        `trace-ledger (last ${entries.length} entries${corrupt ? `; ${corrupt} corrupt line(s) skipped` : ""}; lost=${lostEntries}; append-only, rotated to .1 at 4 MiB):`,
        `  tool calls: ${calls.length} | errors: ${errors} | distinct files read: ${distinctFiles}`,
        topRepeats.length ? `  repeated reads: ${topRepeats.join(", ")}` : "  repeated reads: none",
      ];
      c.ui.notify(lines.join("\n"), "info");
    },
  });
}
