import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// self-improvement (Epic 6 Sprint 6.2): the /improve cycle — mine -> synthesise -> score ->
// PROPOSE. It never calls a model and never auto-commits: it writes a reviewable proposal
// (a summary + a unified-diff preview of a "Learned notes" addition to AGENTS.md) into
// .pi/self-improvement/. The change is only applied when explicitly armed (`/improve arm`),
// which applies a proposal already written for review (bound by id and notes hash), never a
// freshly mined one, and only appends to an allowlisted path — matching the dream-mode safety
// rule (see docs/roadmap.md "Future Direction").

interface TraceEntry {
  kind?: "call" | "result";
  tool?: string;
  target?: string;
  status?: "ok" | "error";
}

/** A trace line's well-typed fields; null for a non-object. Fields of the wrong type are dropped. */
function toTraceEntry(value: unknown): TraceEntry | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { kind, tool, target, status }: { kind?: unknown; tool?: unknown; target?: unknown; status?: unknown } = value;
  const entry: TraceEntry = {};
  if (kind === "call" || kind === "result") entry.kind = kind;
  if (typeof tool === "string") entry.tool = tool;
  if (typeof target === "string") entry.target = target;
  if (status === "ok" || status === "error") entry.status = status;
  return entry;
}

const READ_HINT = /^(read|grep|glob|ls|find|cat|search|rg)/i;
const NOTES_HEADER = "## Learned notes (self-improvement)";
// Exactly the stamp writeProposal uses (`proposal-` + ISO time with ':' and '.' as '-'), so the
// lexically last id is also the newest one written.
const PROPOSAL_ID = /^proposal-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;

// Trace targets come from tool inputs (paths, glob/grep patterns, shell commands) and may be
// repo-controlled, so only path-like targets become notes: one token of path/glob characters,
// at most 160 long. Anything else (backticks, newlines, spaces, markdown) is dropped, so a
// target can never add lines or headings to AGENTS.md.
const PATH_LIKE = /^[\w./@~+*?=,:-]{1,160}$/;
export function pathLikeTarget(target: string): string | null {
  return PATH_LIKE.test(target) ? target : null;
}

// A stored note is applied only if it has one of buildProposal's two shapes (with a path-like
// read target), so a hand-written proposal file cannot carry free-form text into AGENTS.md.
const READ_NOTE = /^Read `([^`]+)` once — it was read \d+× in a recent session; cache the result instead of re-reading\.$/;
const VERIFY_NOTE = /^Verify after each change — \d+\/\d+ recent tool results errored; run the smallest check before continuing\.$/;
export function isGeneratedNote(note: string): boolean {
  const read = READ_NOTE.exec(note);
  if (read) return pathLikeTarget(read[1] ?? "") !== null;
  return VERIFY_NOTE.test(note);
}

// Bounded tail read (mirrors trace-ledger's /trace window): .pi/trace.jsonl can reach 4 MiB
// before trace-ledger rotates it, so mining must not load the whole file into memory. Read at
// most the last 1MB and drop the partial first line.
const TRACE_TAIL_BYTES = 1024 * 1024;

function readTraceTail(file: string): string | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - TRACE_TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, start);
    let text = buffer.subarray(0, bytes).toString("utf8");
    if (start > 0) text = text.slice(text.indexOf("\n") + 1);
    return text;
  } catch {
    return null;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function readTrace(cwd: string): TraceEntry[] {
  const text = readTraceTail(path.join(cwd, ".pi", "trace.jsonl"));
  if (text === null) return [];
  return text
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return toTraceEntry(JSON.parse(l));
      } catch {
        return null;
      }
    })
    .filter((e): e is TraceEntry => !!e);
}

export interface Proposal {
  hasSignal: boolean;
  notes: string[];
  summary: string;
  diff: string; // unified-diff preview of the AGENTS.md addition
}

function bulletText(line: string): string | null {
  // Tolerate CRLF: on Windows-authored AGENTS.md each split line ends with `\r`, which `$`
  // does not match before and `.` does not consume, so strip it before matching. Only the
  // match sees the normalised line; callers keep the original bytes for output.
  const match = /^\s*-\s+(.*)$/.exec(line.endsWith("\r") ? line.slice(0, -1) : line);
  const text = match?.[1];
  return text === undefined ? null : text.trim();
}

// The added lines are the multiset difference between the merged and current bodies. Using a
// count map (not a set) keeps repeated lines correct while ignoring lines the merge removed.
function addedLines(before: string, after: string): string[] {
  const counts = new Map<string, number>();
  for (const line of before.split("\n")) counts.set(line, (counts.get(line) ?? 0) + 1);
  const added: string[] = [];
  for (const line of after.split("\n")) {
    const remaining = counts.get(line) ?? 0;
    if (remaining > 0) counts.set(line, remaining - 1);
    else added.push(line);
  }
  return added;
}

// Single shared section model: buildProposal previews exactly the lines applyProposal writes.
// Existing bullets are kept first (stable order), new notes are unioned in and deduped, and a
// no-op returns the body untouched so re-arming cannot duplicate notes.
export function mergeNotes(body: string, notes: string[]): string {
  // Track the file's EOL so every line we emit uses it. Splitting on bare "\n" would leave a
  // trailing "\r" on each untouched CRLF line, so rebuilding the header/bullets with "\n" would
  // produce a mixed-ending file. Normalise input lines with /\r?\n/ and join all output with eol.
  const eol = body.includes("\r\n") ? "\r\n" : "\n";
  const lines = body.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => line.trim() === NOTES_HEADER);

  if (headerIndex === -1) {
    if (notes.length === 0) return body;
    const trimmed = body.replace(/\s+$/, "");
    return `${trimmed}${eol}${NOTES_HEADER}${eol}${notes.map((n) => `- ${n}`).join(eol)}${eol}`;
  }

  // Extent of the existing bullet run: only true bullet lines are consumed, so the first
  // non-bullet line (a blank separator or the next section) and everything after it are kept
  // verbatim by lines.slice(end). This keeps the change purely additive.
  let end = headerIndex + 1;
  const existing: string[] = [];
  while (end < lines.length) {
    const text = bulletText(lines[end] ?? "");
    if (text === null) break;
    existing.push(text);
    end += 1;
  }

  const seen = new Set(existing);
  const merged = [...existing];
  for (const note of notes) {
    if (!seen.has(note)) {
      seen.add(note);
      merged.push(note);
    }
  }
  if (merged.length === existing.length) return body;

  const replacement = [NOTES_HEADER, ...merged.map((text) => `- ${text}`)];
  return [...lines.slice(0, headerIndex), ...replacement, ...lines.slice(end)].join(eol);
}

// Deterministically derive improvement notes from recorded inefficiencies.
export function buildProposal(cwd: string): Proposal {
  const entries = readTrace(cwd);
  const calls = entries.filter((e) => e.kind === "call" && e.tool);
  const notes: string[] = [];

  // Repeated reads -> a "read once" note naming the worst offenders.
  const readCounts = new Map<string, number>();
  for (const e of calls) {
    const target = e.tool && e.target && READ_HINT.test(e.tool) ? pathLikeTarget(e.target) : null;
    if (target !== null) readCounts.set(target, (readCounts.get(target) ?? 0) + 1);
  }
  const worstReads = [...readCounts.entries()].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]).slice(0, 3);
  for (const [target, n] of worstReads) notes.push(`Read \`${target}\` once — it was read ${n}× in a recent session; cache the result instead of re-reading.`);

  // High error rate -> a verify-before-continue note.
  const results = entries.filter((e) => e.kind === "result");
  const errors = results.filter((e) => e.status === "error").length;
  if (results.length >= 5 && errors / results.length >= 0.3) {
    notes.push(`Verify after each change — ${errors}/${results.length} recent tool results errored; run the smallest check before continuing.`);
  }

  const hasSignal = notes.length > 0;
  const summary = hasSignal
    ? `Mined ${calls.length} tool calls; ${notes.length} improvement note(s) proposed.`
    : `Mined ${calls.length} tool calls; nothing actionable — no proposal.`;

  // Unified-diff preview of exactly what applyProposal will write: both share mergeNotes, so
  // the reviewed diff cannot drift from the applied file. No signal (or all notes already
  // present) adds no lines.
  const agents = path.join(cwd, "AGENTS.md");
  let body: string;
  try {
    body = fs.readFileSync(agents, "utf8");
  } catch {
    body = "# AGENTS.md\n";
  }
  const added = addedLines(body, mergeNotes(body, notes));
  const diff = [
    "--- a/AGENTS.md",
    "+++ b/AGENTS.md",
    "@@ append @@",
    ...added.map((l) => `+${l}`),
  ].join("\n");

  return { hasSignal, notes, summary, diff };
}

export function notesHash(notes: string[]): string {
  return crypto.createHash("sha256").update(JSON.stringify(notes)).digest("hex");
}

function proposalDir(cwd: string): string {
  return path.join(cwd, ".pi", "self-improvement");
}

// Write the reviewable proposal (.md) plus the exact notes it previews (.json, with their hash),
// so `/improve arm` can apply what was reviewed instead of mining again. Returns the proposal id.
export function writeProposal(cwd: string, proposal: Proposal, id: string): string {
  const dir = proposalDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const hash = notesHash(proposal.notes);
  fs.writeFileSync(
    path.join(dir, `${id}.md`),
    [`# Self-improvement proposal`, "", `Id: ${id}`, `Notes hash: ${hash}`, "", proposal.summary, "", "## Proposed AGENTS.md diff", "", "```diff", proposal.diff, "```", ""].join("\n"),
    "utf8",
  );
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, hash, notes: proposal.notes }, null, 2) + "\n", "utf8");
  return id;
}

export type LoadedProposal = { ok: true; id: string; notes: string[] } | { ok: false; reason: string };

// Load a written proposal by id (or the lexically last stamped id when none is given). Each
// stored note must match a buildProposal template, and the notes' hash must match both the .json
// record and the hash printed in the .md. The hash is only a consistency check between the two
// files (anyone who can write them can recompute it); the template check is what bounds content.
export function loadProposal(cwd: string, requestedId?: string): LoadedProposal {
  const dir = proposalDir(cwd);
  let id = requestedId;
  if (id === undefined) {
    let names: string[];
    try { names = fs.readdirSync(dir); } catch { names = []; }
    id = names.filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -5)).filter((n) => PROPOSAL_ID.test(n)).sort().pop();
    if (id === undefined) return { ok: false, reason: "no written proposal to apply; run /improve first and review it" };
  }
  if (!PROPOSAL_ID.test(id)) return { ok: false, reason: `invalid proposal id '${id}'` };
  let record: unknown;
  let reviewed: string;
  try {
    record = JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), "utf8"));
    reviewed = fs.readFileSync(path.join(dir, `${id}.md`), "utf8");
  } catch {
    return { ok: false, reason: `proposal ${id} not found or unreadable` };
  }
  if (!record || typeof record !== "object") return { ok: false, reason: `proposal ${id} is malformed` };
  const notes: unknown = Reflect.get(record, "notes");
  const hash: unknown = Reflect.get(record, "hash");
  if (!Array.isArray(notes) || typeof hash !== "string") return { ok: false, reason: `proposal ${id} is malformed` };
  const clean: string[] = [];
  for (const note of notes) {
    if (typeof note !== "string" || /[\r\n]/.test(note) || !isGeneratedNote(note)) return { ok: false, reason: `proposal ${id} has an invalid note` };
    clean.push(note);
  }
  if (notesHash(clean) !== hash || !reviewed.includes(`Notes hash: ${hash}`)) {
    return { ok: false, reason: `proposal ${id} does not match its reviewed hash` };
  }
  return { ok: true, id, notes: clean };
}

function parseArm(args: string): { armed: boolean; id?: string } {
  const [verb, id] = args.trim().split(/\s+/);
  if (verb?.toLowerCase() !== "arm") return { armed: false };
  return id ? { armed: true, id } : { armed: true };
}

// Apply the proposal by merging the notes into the AGENTS.md "Learned notes" section
// (allowlisted path). The write goes through the same mergeNotes model the preview uses.
export function applyProposal(cwd: string, proposal: Proposal): string {
  const agents = path.join(cwd, "AGENTS.md");
  let body: string;
  try {
    body = fs.readFileSync(agents, "utf8");
  } catch {
    body = "# AGENTS.md\n";
  }
  fs.writeFileSync(agents, mergeNotes(body, proposal.notes), "utf8");
  return agents;
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("improve", {
    description: "Self-improvement cycle: mine traces → propose a reviewable diff. `/improve arm [id]` applies a written proposal (default: the newest) to AGENTS.md.",
    handler: async (args, ctx) => {
      const c = ctx as ExtensionContext;
      const cwd = c.cwd ?? process.cwd();
      const arm = parseArm(args);

      // Arming applies exactly a proposal already written for review; it never mines again.
      if (arm.armed) {
        const loaded = loadProposal(cwd, arm.id);
        if (!loaded.ok) {
          if (c.hasUI) c.ui.notify(`self-improvement: not applied — ${loaded.reason}.`, "warning");
          return;
        }
        const applied = applyProposal(cwd, { hasSignal: loaded.notes.length > 0, notes: loaded.notes, summary: "", diff: "" });
        if (c.hasUI) c.ui.notify(`self-improvement: ARMED — applied ${loaded.notes.length} note(s) from ${loaded.id} to ${path.relative(cwd, applied)}. Review the diff and commit.`, "warning");
        return;
      }

      const proposal = buildProposal(cwd);
      // Always write the reviewable proposal artifact (summary + diff preview + notes record).
      const id = writeProposal(cwd, proposal, `proposal-${new Date().toISOString().replace(/[:.]/g, "-")}`);
      const proposalFile = path.relative(cwd, path.join(proposalDir(cwd), `${id}.md`));
      if (!proposal.hasSignal) {
        if (c.hasUI) c.ui.notify(`self-improvement: ${proposal.summary} (see ${proposalFile})`, "info");
        return;
      }
      if (c.hasUI) c.ui.notify(`self-improvement: ${proposal.summary} Proposal written to ${proposalFile} (NOT applied). Run '/improve arm ${id}' to apply it.`, "info");
    },
  });
}
