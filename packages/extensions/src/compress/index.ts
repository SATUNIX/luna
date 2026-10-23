import type { ExtensionAPI, ExtensionContext, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";

// Self-containment rule: import only node:* builtins and typebox peer.
// No sibling imports. No toolchain-lib imports. See CONTRIBUTING.md.
//
// compress adds /compress: an instant, deterministic alternative to /compact.
// It runs pi's own compaction pipeline (same cut point, same kept recent window,
// same CompactionEntry), but answers session_before_compact with a summary built
// by plain string processing instead of an LLM call:
//   - keeps each user message and each assistant text reply, trimmed;
//   - drops tool output, thinking, and images;
//   - replaces fenced code blocks with a one-line placeholder;
//   - folds each turn's tool calls into one digest line (counts, files, errors);
//   - fits the result to a character budget, dropping the oldest middle turns
//     first and always keeping the first turn (the original ask).
//
// Only a compaction started by /compress carries the marker below, so /compact
// and automatic compaction keep pi's native LLM summary unchanged.

export const COMPRESS_MARKER = "[[pi-kit:compress]]";
const COMPRESSOR_ID = "pi-kit-compress";
const DEFAULT_MAX_CHARS = 16_000;
const MIN_MAX_CHARS = 4_000;
const TURN_FILES_LISTED = 6;
const TURN_COMMANDS_LISTED = 3;
const COMMAND_MAX_CHARS = 80;

// The fields of pi's messages (AgentMessage) this summary reads. pi's messages are assigned to
// these structural views, so a shape change in pi is a type error here rather than a silent miss.
type Block = { type?: string; text?: string; name?: string; arguments?: Record<string, unknown> };
type Msg = {
  role?: string;
  content?: string | Block[];
  toolName?: string;
  isError?: boolean;
  command?: string;
  exitCode?: number | undefined;
  customType?: string;
  summary?: string;
};
type Preparation = SessionBeforeCompactEvent["preparation"];

type Turn = {
  user: string[];
  assistant: string[];
  notes: string[];
  toolCounts: Map<string, number>;
  files: Set<string>;
  commands: string[];
  errors: string[];
};

export type CompressResult = {
  summary: string;
  details: {
    compressor: string;
    version: 1;
    readFiles: string[];
    modifiedFiles: string[];
    turns: number;
    omittedTurns: number;
  };
};

type Limits = { budget: number; user: number; assistant: number; note: number; files: number };

// Per-message caps scale with the budget so the two anchor turns (first and
// newest) still fit at the minimum budget.
function limits(): Limits {
  const raw = Number(process.env.PI_KIT_COMPRESS_MAX_CHARS);
  const budget = !Number.isFinite(raw) || raw <= 0 ? DEFAULT_MAX_CHARS : Math.max(MIN_MAX_CHARS, Math.floor(raw));
  return {
    budget,
    user: Math.min(600, Math.floor(budget * 0.06)),
    assistant: Math.min(900, Math.floor(budget * 0.09)),
    note: Math.min(1_000, Math.floor(budget * 0.1)),
    files: Math.floor(budget * 0.15),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// Keep the head and the tail: an ask states intent first, a reply states its
// conclusion last.
function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const head = Math.ceil(limit * 0.6);
  const tail = Math.max(0, limit - head);
  return `${text.slice(0, head)} […${text.length - head - tail} chars…] ${text.slice(text.length - tail)}`;
}

function stripCode(text: string): string {
  return text.replace(/```([^\n`]*)\n([\s\S]*?)(```|$)/g, (_m, lang: string, body: string) => {
    const lines = body.split("\n").filter((l) => l.trim()).length;
    const label = lang.trim() ? `${lang.trim()}, ` : "";
    return ` [code: ${label}${lines} lines] `;
  });
}

function textOf(content: Msg["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (b?.type === "text" ? b.text ?? "" : b?.type === "image" ? "[image]" : ""))
    .filter(Boolean)
    .join("\n");
}

function newTurn(): Turn {
  return { user: [], assistant: [], notes: [], toolCounts: new Map(), files: new Set(), commands: [], errors: [] };
}

// These two are hoisted out of the `case "assistant"` branch deliberately. pi-lens's ast-grep
// NAPI runner cannot evaluate a nested `inside:` under a `not:`, so the `no-case-declarations`
// rule false-positives on lexical declarations that sit inside a brace-scoped if/else *inside*
// the case (the AST is correctly scoped, but the runner drops the `not` guard and reports it).
// Keeping the bodies as top-level helpers removes the declarations from the case subtree, so
// the false positive stops blocking edits to this file. Behaviour is unchanged.
function addTextBlock(turn: Turn, text: string): void {
  const line = oneLine(stripCode(text));
  if (line) turn.assistant.push(line);
}

function addToolCall(turn: Turn, name: string, args: Record<string, unknown>): void {
  turn.toolCounts.set(name, (turn.toolCounts.get(name) ?? 0) + 1);
  if (typeof args.path === "string") turn.files.add(args.path);
  if (typeof args.command === "string") turn.commands.push(clip(oneLine(args.command), COMMAND_MAX_CHARS));
}

function groupTurns(messages: Msg[], lim: Limits): Turn[] {
  const turns: Turn[] = [];
  let current: Turn | undefined;
  const turn = (): Turn => {
    if (!current) {
      current = newTurn();
      turns.push(current);
    }
    return current;
  };

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    switch (msg.role) {
      case "user": {
        const text = oneLine(textOf(msg.content));
        if (!text) break;
        current = newTurn();
        turns.push(current);
        current.user.push(clip(text, lim.user));
        break;
      }
      case "assistant": {
        if (!Array.isArray(msg.content)) break;
        for (const block of msg.content) {
          if (block?.type === "text" && block.text) addTextBlock(turn(), block.text);
          else if (block?.type === "toolCall" && block.name) addToolCall(turn(), block.name, block.arguments ?? {});
        }
        break;
      }
      case "toolResult":
        if (msg.isError) turn().errors.push(msg.toolName ?? "tool");
        break;
      case "bashExecution":
        if (msg.command) {
          turn().notes.push(`User ran \`${clip(oneLine(msg.command), COMMAND_MAX_CHARS)}\` (exit ${msg.exitCode ?? "?"})`);
        }
        break;
      case "branchSummary":
        if (msg.summary) turn().notes.push(`Branch summary: ${clip(oneLine(msg.summary), lim.assistant)}`);
        break;
      case "custom": {
        const text = oneLine(textOf(msg.content));
        if (text) turn().notes.push(`Note (${msg.customType ?? "custom"}): ${clip(text, 200)}`);
        break;
      }
      default:
        break;
    }
  }
  return turns;
}

function renderTurn(t: Turn, index: number, lim: Limits, suffix = ""): string {
  const lines = [`### Turn ${index}${suffix}`];
  for (const u of t.user) lines.push(`User: ${u}`);
  for (const n of t.notes) lines.push(`- ${n}`);
  if (t.assistant.length) lines.push(`Assistant: ${clip(t.assistant.join(" "), lim.assistant)}`);
  if (t.toolCounts.size) {
    const counts = [...t.toolCounts].map(([name, n]) => (n > 1 ? `${name}×${n}` : name)).join(", ");
    const parts = [`Tools: ${counts}`];
    if (t.errors.length) parts.push(`${t.errors.length} failed (${[...new Set(t.errors)].join(", ")})`);
    if (t.files.size) {
      const files = [...t.files];
      parts.push(`files: ${files.slice(0, TURN_FILES_LISTED).join(", ")}${files.length > TURN_FILES_LISTED ? ` +${files.length - TURN_FILES_LISTED}` : ""}`);
    }
    if (t.commands.length) {
      parts.push(`ran: ${t.commands.slice(0, TURN_COMMANDS_LISTED).map((c) => `\`${c}\``).join(", ")}${t.commands.length > TURN_COMMANDS_LISTED ? ` +${t.commands.length - TURN_COMMANDS_LISTED}` : ""}`);
    }
    lines.push(parts.join(" · "));
  }
  return lines.join("\n");
}

function fileSection(tag: string, files: string[], maxChars: number): string {
  if (!files.length) return "";
  const shown: string[] = [];
  let used = 0;
  for (const f of files) {
    if (shown.length && used + f.length + 1 > maxChars) break;
    shown.push(f);
    used += f.length + 1;
  }
  const more = files.length > shown.length ? `\n(+${files.length - shown.length} more)` : "";
  return `<${tag}>\n${shown.join("\n")}${more}\n</${tag}>`;
}

// pi skips extension-generated compaction details when it tracks files, so
// carry the lists forward from an earlier /compress ourselves.
function previousCompressFiles(branchEntries: unknown): { read: string[]; modified: string[] } {
  if (!Array.isArray(branchEntries)) return { read: [], modified: [] };
  for (let i = branchEntries.length - 1; i >= 0; i--) {
    const e = branchEntries[i] as { type?: string; details?: Record<string, unknown> } | undefined;
    if (e?.type !== "compaction") continue;
    const d = e.details;
    if (d?.compressor !== COMPRESSOR_ID) break;
    const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
    return { read: strings(d.readFiles), modified: strings(d.modifiedFiles) };
  }
  return { read: [], modified: [] };
}

function fileLists(preparation: Partial<Preparation>, branchEntries: unknown): { readFiles: string[]; modifiedFiles: string[] } {
  const ops: Partial<Preparation["fileOps"]> = preparation?.fileOps ?? {};
  const set = (v: unknown) => (v instanceof Set ? [...v] : Array.isArray(v) ? v : []).filter((x): x is string => typeof x === "string");
  const prev = previousCompressFiles(branchEntries);
  const modified = new Set([...prev.modified, ...set(ops.written), ...set(ops.edited)]);
  const read = new Set([...prev.read, ...set(ops.read)].filter((f) => !modified.has(f)));
  return { readFiles: [...read].sort(), modifiedFiles: [...modified].sort() };
}

/** Build the deterministic summary. Pure: no I/O, no model call. */
export function buildCompressedSummary(event: SessionBeforeCompactEvent, note = "", objective = ""): CompressResult {
  const preparation: Partial<Preparation> = event?.preparation ?? {};
  const history: Msg[] = Array.isArray(preparation.messagesToSummarize) ? preparation.messagesToSummarize : [];
  const prefix: Msg[] = preparation.isSplitTurn && Array.isArray(preparation.turnPrefixMessages) ? preparation.turnPrefixMessages : [];
  const lim = limits();

  const turns = groupTurns(history, lim).map((t, i) => renderTurn(t, i + 1, lim));
  const prefixTurns = groupTurns(prefix, lim);
  const [firstPrefixTurn] = prefixTurns;
  if (firstPrefixTurn) {
    turns.push(renderTurn(firstPrefixTurn, turns.length + 1, lim, " (continues in the kept messages below)"));
    for (const extra of prefixTurns.slice(1)) turns.push(renderTurn(extra, turns.length + 1, lim));
  }

  const { readFiles, modifiedFiles } = fileLists(preparation, event?.branchEntries);
  const header = [
    "# Compressed context (/compress: deterministic, no model summary)",
    "Tool output, reasoning, and code blocks were removed. Long messages are trimmed ([…N chars…]).",
    "Messages after this summary are kept verbatim. Re-read files before relying on their contents.",
  ].join("\n");
  // The active objective is pinned above the conversation: a deterministic summary keeps only the
  // first turn and the newest ones, so a goal set mid-session (/goal writes .pi/GOAL.yaml) would
  // otherwise fall into the omitted middle.
  const objectiveSection = objective.trim() ? `## Active goal\n${clip(oneLine(objective), lim.note)}` : "";
  const noteSection = note.trim() ? `## Operator note\n${clip(note.trim(), lim.note)}` : "";
  const files = [
    fileSection("modified-files", modifiedFiles, Math.floor(lim.files * 0.5)),
    fileSection("read-files", readFiles, Math.floor(lim.files * 0.5)),
  ].filter(Boolean).join("\n\n");

  const fixed = [header, objectiveSection, noteSection, files, "## Conversation"].filter(Boolean).join("\n\n").length;
  let remaining = lim.budget - fixed;

  // Priority: first turn (the original ask), newest turn, earlier summary
  // (capped at 30% of what is left), then older turns from newest backwards.
  const kept = new Set<number>();
  // Every index used below is in range; a miss would be a bug here, so it throws as it always did.
  const turnAt = (i: number): string => {
    const text = turns[i];
    if (text === undefined) throw new Error(`turn ${i} is out of range`);
    return text;
  };
  const cost = (i: number) => turnAt(i).length + 2;
  for (const i of [0, turns.length - 1]) {
    if (i < 0 || kept.has(i)) continue;
    kept.add(i);
    remaining -= cost(i);
  }

  let previous = "";
  if (typeof preparation.previousSummary === "string" && preparation.previousSummary.trim() && remaining > 300) {
    const heading = "## Earlier summary\n";
    const text = preparation.previousSummary.replace(/\n\s*\n+/g, "\n").trim();
    previous = `${heading}${clip(text, Math.floor(remaining * 0.3) - heading.length - 20)}`;
    remaining -= previous.length + 2;
  }

  for (let i = turns.length - 2; i > 0 && remaining > 0; i--) {
    if (cost(i) > remaining) break;
    kept.add(i);
    remaining -= cost(i);
  }
  const omittedTurns = turns.length - kept.size;
  // Kept turns are turn 1 plus a contiguous newest run, so one marker covers the gap.
  const body: string[] = [];
  let markerPlaced = false;
  for (let i = 0; i < turns.length; i++) {
    if (kept.has(i)) body.push(turnAt(i));
    else if (!markerPlaced) {
      body.push(`[… ${omittedTurns} older turns omitted to fit the budget …]`);
      markerPlaced = true;
    }
  }
  const conversation = turns.length ? `## Conversation\n${body.join("\n\n")}` : "";

  const summary = [header, objectiveSection, noteSection, previous, conversation, files].filter(Boolean).join("\n\n");
  return {
    summary,
    details: { compressor: COMPRESSOR_ID, version: 1, readFiles, modifiedFiles, turns: turns.length, omittedTurns },
  };
}

// goal-core owns the mission goal: <cwd>/.pi/GOAL.yaml with a `goal:` line. Read-only, best effort.
function readActiveGoal(cwd: string | undefined): string {
  if (!cwd) return "";
  try {
    const raw = fs.readFileSync(path.join(cwd, ".pi", "GOAL.yaml"), "utf8");
    return oneLine((raw.match(/^goal:\s*(.*)$/m)?.[1] ?? raw).trim()).slice(0, 1_000);
  } catch {
    return "";
  }
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void {
  // Called from deferred compaction callbacks, which run after the compaction has finished and
  // the session may have been replaced or reloaded. A ctx captured before that is stale, and
  // touching it throws ("This extension ctx is stale after session replacement or reload");
  // because this runs inside the compaction error handler, throwing there crashes the session.
  // A dropped notification is always better than a crash.
  try {
    if (ctx.hasUI) ctx.ui.notify(message, level);
  } catch {
    /* stale ctx after reload — drop the notification */
  }
}

export default function (pi: ExtensionAPI) {
  // Holds the real reason when the hook cancels, because pi reports every
  // cancel as the generic "Compaction cancelled".
  let lastRefusal: string | undefined;

  pi.on("session_before_compact", async (event, ctx) => {
    const instructions = event?.customInstructions;
    if (typeof instructions !== "string" || !instructions.startsWith(COMPRESS_MARKER)) return undefined;
    lastRefusal = undefined;
    const preparation = event?.preparation;
    try {
      const hasHistory =
        (Array.isArray(preparation?.messagesToSummarize) && preparation.messagesToSummarize.length > 0) ||
        (preparation?.isSplitTurn && Array.isArray(preparation?.turnPrefixMessages) && preparation.turnPrefixMessages.length > 0);
      if (!hasHistory || typeof preparation?.firstKeptEntryId !== "string") {
        lastRefusal = "nothing older than the kept recent window (compaction.keepRecentTokens) to compress";
        return { cancel: true };
      }
      const { summary, details } = buildCompressedSummary(event, instructions.slice(COMPRESS_MARKER.length), readActiveGoal(ctx?.cwd));
      return {
        compaction: {
          summary,
          firstKeptEntryId: preparation.firstKeptEntryId,
          tokensBefore: preparation.tokensBefore,
          details,
        },
      };
    } catch (err) {
      // Cancel rather than fall through: a thrown handler would let pi run the
      // LLM summarizer with the marker text as its instructions.
      lastRefusal = `summary build failed: ${err instanceof Error ? err.message : String(err)}`;
      return { cancel: true };
    }
  });

  pi.registerCommand("compress", {
    description: "Instant deterministic compaction: keeps user asks and assistant replies, drops tool output. No model call. Optional note: /compress <note>",
    handler: async (args: string, ctx: ExtensionContext) => {
      const note = (args ?? "").trim();
      const started = Date.now();
      ctx.compact({
        customInstructions: `${COMPRESS_MARKER}${note}`,
        onComplete: (result) => {
          // `details` is what the session_before_compact hook returned; pi passes it through untyped.
          const d: Record<string, unknown> = isRecord(result?.details) ? result.details : {};
          const turns: unknown = d.turns ?? "?";
          const omittedTurns: unknown = d.omittedTurns;
          const omittedText = String(omittedTurns);
          const omitted = omittedTurns ? `, ${omittedText} oldest turns omitted` : "";
          notify(
            ctx,
            `compress: ${String(turns)} turns -> ${(result?.summary ?? "").length} chars${omitted} ` +
              `(was ~${result?.tokensBefore ?? "?"} tokens, ${Date.now() - started} ms)`,
          );
        },
        onError: (error: Error) => {
          const reason = lastRefusal ?? error.message;
          lastRefusal = undefined;
          notify(ctx, `compress: not compacted - ${reason}`, "warning");
        },
      });
    },
  });
}
