/**
 * memory-vault — per-turn recaps (the automatic memory).
 *
 * After each substantive agent turn a small model writes a Claude-Code-style recap — what was
 * done and what comes next — which is appended to the project's daily recap log. Decisions and
 * stated preferences it flags can be promoted into durable memory notes.
 */
import { MEMORY_TYPES, type MemoryType, type Recap } from "./vault.ts";

export interface TurnDigest {
  prompt: string;
  answer: string;
  tools: string[];
  files: string[];
  outputChars: number;
}

interface Part {
  type?: string;
  text?: string;
  name?: string;
  arguments?: Record<string, unknown>;
}

interface Message {
  role?: string;
  content?: string | Part[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// The agent-run messages reach us as unknown (pi's AgentMessage shape varies across the supported
// range and its type is not bundled here), so narrow each to the small shape digestTurn reads.
function toPart(value: unknown): Part {
  if (!isRecord(value)) return {};
  return {
    ...(typeof value.type === "string" ? { type: value.type } : {}),
    ...(typeof value.text === "string" ? { text: value.text } : {}),
    ...(typeof value.name === "string" ? { name: value.name } : {}),
    ...(isRecord(value.arguments) ? { arguments: value.arguments } : {}),
  };
}

function toMessage(value: unknown): Message {
  if (!isRecord(value)) return {};
  const content = value.content;
  return {
    ...(typeof value.role === "string" ? { role: value.role } : {}),
    ...(typeof content === "string" ? { content } : Array.isArray(content) ? { content: content.map(toPart) } : {}),
  };
}

const textOf = (content: Message["content"]): string =>
  typeof content === "string"
    ? content
    : (content ?? []).flatMap((p) => (p.type === "text" && p.text ? [p.text] : [])).join("\n");

// Summarise the messages of one agent run (from the user's prompt to the final answer).
export function digestTurn(rawMessages: readonly unknown[]): TurnDigest | null {
  const messages = rawMessages.map(toMessage);
  let start = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      start = i;
      break;
    }
  }
  const first = messages[start];
  if (start < 0 || !first) return null;
  const prompt = textOf(first.content).trim();
  const tools: string[] = [];
  const files = new Set<string>();
  let answer = "";
  let outputChars = 0;
  for (const m of messages.slice(start + 1)) {
    const content = m.content;
    if (m.role !== "assistant" || typeof content === "string") continue;
    for (const p of content ?? []) {
      if (p.type === "toolCall" && p.name) {
        const argPath = p.arguments?.path;
        const target = argPath ?? p.arguments?.file_path ?? p.arguments?.command;
        tools.push(typeof target === "string" ? `${p.name} ${target.slice(0, 80)}` : p.name);
        if ((p.name === "edit" || p.name === "write") && typeof argPath === "string") files.add(argPath);
      }
    }
    const text = textOf(content);
    if (text.trim()) {
      answer = text;
      outputChars += text.length;
    }
  }
  return { prompt, answer, tools, files: [...files], outputChars };
}

// Trivial turns (a greeting, a one-line answer with no tool use) are not worth a recap.
export function isTrivial(d: TurnDigest): boolean {
  if (!d.prompt || d.prompt.startsWith("/")) return true;
  return d.tools.length === 0 && d.outputChars < 600;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…[${s.length - n} more chars]` : s);

export const RECAP_SYSTEM = [
  "You write terse work recaps for a developer's notes, like a teammate's end-of-step summary.",
  "Given one exchange between a user and a coding agent, return ONLY a JSON object:",
  '{"title": "<=8 words, what this step was about",',
  ' "did": "1-2 sentences: what was actually done or found (past tense, concrete)",',
  ' "next": "1 sentence: the open next step, or empty string if none",',
  ' "decisions": ["durable decisions made, if any"],',
  ' "memory_candidates": [{"type": "decision|preference|gotcha|fact", "title": "...", "body": "..."}]}',
  "memory_candidates: only information worth remembering in FUTURE sessions — an explicit user",
  "preference, a design decision with its reason, or a non-obvious gotcha. Usually none: return [].",
  "Never include secrets, tokens or credentials. No markdown, no commentary, JSON only.",
].join("\n");

export function recapPrompt(d: TurnDigest, project: string): string {
  return [
    `Project: ${project}`,
    `User request:\n${clip(d.prompt, 4000)}`,
    `Agent actions (${d.tools.length}):\n${d.tools.slice(0, 40).join("\n") || "(none)"}`,
    `Agent final answer:\n${clip(d.answer, 8000)}`,
  ].join("\n\n");
}

export interface MemoryCandidate {
  type: MemoryType;
  title: string;
  body: string;
}

export interface ParsedRecap {
  recap: Recap;
  candidates: MemoryCandidate[];
}

// Tolerates prose or code fences around the JSON object; returns null when unusable.
export function parseRecap(raw: string, d: TurnDigest): ParsedRecap | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  // Model output: validate every field before use.
  if (!isRecord(obj)) return null;
  const title = typeof obj.title === "string" ? obj.title : "";
  const did = typeof obj.did === "string" ? obj.did : "";
  if (!title.trim() || !did.trim()) return null;
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim()) : []);
  const rawCandidates = Array.isArray(obj.memory_candidates) ? obj.memory_candidates : [];
  const candidates: MemoryCandidate[] = rawCandidates
    .filter(isRecord)
    .filter((c) => typeof c.title === "string" && typeof c.body === "string" && c.title.trim() && c.body.trim())
    .map((c) => ({
      type: typeof c.type === "string" && (MEMORY_TYPES as readonly string[]).includes(c.type) ? (c.type as MemoryType) : "fact",
      title: String(c.title).trim(),
      body: String(c.body).trim(),
    }))
    .slice(0, 3);
  return {
    recap: { title: title.trim(), did: did.trim(), next: typeof obj.next === "string" ? obj.next.trim() : "", decisions: strings(obj.decisions), files: d.files },
    candidates,
  };
}

// Candidates promoted automatically: decisions, preferences and gotchas. Plain "facts" from a
// single turn are too often transient to keep without the user asking.
export const AUTO_PROMOTE_TYPES = new Set<MemoryType>(["decision", "preference", "gotcha"]);

export type Completer = (system: string, prompt: string, signal?: AbortSignal) => Promise<string>;
