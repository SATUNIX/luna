// The host event log: one append-only JSON-lines file per state home, <stateHome>/events.jsonl,
// that every supervisor on the host appends to. It is the history of what the runs did (a run
// started or changed state, a cycle started or ended, a gate result, a push, a failure, a
// dispatch claim or submission), for a reader that wants the sequence rather than the current
// state. The current state is state.json and the host status file (lib/reporting.ts); the
// per-step events.jsonl under steps/NN/ (RunStore.event) is a run's own detail and is not this.
//
// Schema version 1. Every line is one JSON object with `v`, `at` (ISO time), `run` and `type`:
//
// | type             | fields                                                                  |
// |------------------|-------------------------------------------------------------------------|
// | run.started      | template                                                                |
// | run.status       | from, to, reason (null when none), by?                                  |
// | cycle.started    | n, resume, engineer?, item? (a dispatch cycle's engineer and claimed item) |
// | gate.result      | n, sha, green, failing (check or step ids, at most 20)                  |
// | cycle.ended      | n, outcome, gate (skipped, green, red), merged, reason, mergeReason?    |
// | push             | branch, sha (null when unknown), ok, error?                             |
// | failure          | code, detail                                                            |
// | dispatch.claim   | n, item, engineer, outcome                                              |
// | dispatch.submit  | n, item, engineer, sha                                                  |
// | harness.degraded | missing (optional harness commands the worker session lacks, at most 20) |
//
// Every field is bounded in encoded bytes (its UTF-8 JSON encoding, so escapes and multi-byte
// characters count): identifiers at ID_MAX, free text (reason, mergeReason, detail, error) and
// `failing` names made one visible line, then redacted through the one secret table, then clipped
// at TEXT_MAX and LIST_ITEM_MAX, lists at LIST_MAX items. The largest event's worst case is about
// 2.5 KiB, under MAX_LINE_BYTES. The writer validates its own line with the parser readers use, so
// a line it writes reads back.
//
// Writing is best effort: an event that cannot be written is logged by the caller's log and
// never fails a run. Pinned by tests/autonomy-events-smoke.ts.
import fs from "node:fs";
import path from "node:path";
import { type Infer, array, boolean, literal, nullable, number, object, optional, parseJson, refine, safeParse, string, union } from "../../core/lib/guard.ts";
import { appendFileSafe, openFileExclusive, rotateFileSafe, UnsafePathError } from "../../core/shared/safe-fs.ts";
import { oneVisibleLine } from "../../core/shared/visible-text.ts";
import { redactSecrets } from "./notebook.ts";

export const EVENTS_SCHEMA_VERSION = 1;
export const EVENTS_FILE = "events.jsonl";
/** The one older generation kept by rotation (rotateFileSafe's `<file>.1`). */
export const EVENTS_ROTATED = `${EVENTS_FILE}.1`;
/** Held (created O_EXCL) while one appender rotates, so two cannot rotate the same generation. */
export const EVENTS_ROTATE_LOCK = `${EVENTS_FILE}.lock`;
/** A rotation lock older than this was left by an appender that died; the next rotator removes it. */
const ROTATE_LOCK_STALE_MS = 60_000;
/** How often the reader reopens both files when a rotation happened while it opened them. */
const READ_ATTEMPTS = 3;
/** The live file is renamed to EVENTS_ROTATED before an append once it is larger than this. */
export const ROTATE_BYTES = 16 * 1024 * 1024;
/** A line longer than this is not an event (the writer's lines are far shorter); readers skip it. */
export const MAX_LINE_BYTES = 4096;
/** The most a reader takes from one file, from its end. */
const READ_CAP_BYTES = 64 * 1024 * 1024;
const ID_MAX = 200;
const TEXT_MAX = 500;
const LIST_MAX = 20;
const LIST_ITEM_MAX = 100;
const FREE_TEXT: ReadonlySet<string> = new Set(["reason", "mergeReason", "detail", "error"]);

// --- the schema -------------------------------------------------------------------------------
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const at = refine(string({ pattern: ISO, maxLength: 40 }), (s) => Number.isFinite(Date.parse(s)), "a valid time");
const id = string({ minLength: 1, maxLength: ID_MAX });
const text = string({ maxLength: TEXT_MAX });
const sha = string({ pattern: /^[0-9a-f]{4,64}$/ });
const cycle = number({ integer: true, min: 0, max: 1_000_000 });
const base = { v: literal(EVENTS_SCHEMA_VERSION), at, run: id };

const RunStarted = object({ ...base, type: literal("run.started"), template: id });
const RunStatusEvent = object({ ...base, type: literal("run.status"), from: id, to: id, reason: nullable(text), by: optional(id) });
const CycleStarted = object({ ...base, type: literal("cycle.started"), n: cycle, resume: boolean(), engineer: optional(id), item: optional(id) });
const GateResult = object({ ...base, type: literal("gate.result"), n: cycle, sha, green: boolean(), failing: array(string({ maxLength: LIST_ITEM_MAX }), { maxItems: LIST_MAX }) });
const CycleEnded = object({ ...base, type: literal("cycle.ended"), n: cycle, outcome: id, gate: literal("skipped", "green", "red"), merged: boolean(), reason: text, mergeReason: optional(text) });
const Push = object({ ...base, type: literal("push"), branch: id, sha: nullable(sha), ok: boolean(), error: optional(text) });
const Failure = object({ ...base, type: literal("failure"), code: id, detail: text });
const DispatchClaim = object({ ...base, type: literal("dispatch.claim"), n: cycle, item: id, engineer: id, outcome: id });
const DispatchSubmit = object({ ...base, type: literal("dispatch.submit"), n: cycle, item: id, engineer: id, sha });
const HarnessDegraded = object({ ...base, type: literal("harness.degraded"), missing: array(string({ maxLength: LIST_ITEM_MAX }), { maxItems: LIST_MAX }) });

const HostEventSchema = union(RunStarted, RunStatusEvent, CycleStarted, GateResult, CycleEnded, Push, Failure, DispatchClaim, DispatchSubmit, HarnessDegraded);

/** One line of the host event log. */
export type HostEvent = Infer<typeof HostEventSchema>;
export type HostEventType = HostEvent["type"];
export const EVENT_TYPES: readonly HostEventType[] = ["run.started", "run.status", "cycle.started", "gate.result", "cycle.ended", "push", "failure", "dispatch.claim", "dispatch.submit", "harness.degraded"];
/** The families a filter may name instead of a type (`cycle` matches cycle.started and cycle.ended). */
export const EVENT_FAMILIES: readonly string[] = [...new Set(EVENT_TYPES.map((t) => t.split(".")[0] ?? t))];

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** What an emitter supplies: the event without `v` and `at`, which the writer adds. */
export type EventInput = DistributiveOmit<HostEvent, "v" | "at">;

/** A parsed event, or null when `value` is not a version-1 event of a known type. */
export function parseEvent(value: unknown): HostEvent | null {
  const r = safeParse(HostEventSchema, value);
  return r.ok ? r.value : null;
}

// --- writing ----------------------------------------------------------------------------------
/** The bytes `s` takes inside a JSON line (UTF-8, escapes included, quotes not). */
const encodedBytes = (s: string): number => Buffer.byteLength(JSON.stringify(s)) - 2;

/** `s` cut at a code point so it encodes to at most `maxBytes` bytes, ending "..." when cut. Never longer than `maxBytes` characters. */
function clipped(s: string, maxBytes: number): string {
  if (encodedBytes(s) <= maxBytes) return s;
  let out = "";
  let used = 0;
  for (const ch of s) {
    const cost = encodedBytes(ch);
    if (used + cost > maxBytes - 3) break;
    out += ch;
    used += cost;
  }
  return `${out}...`;
}

/**
 * Free text as the log stores it: one visible line first, so a secret split by a hidden or
 * zero-width character is joined before the redaction table sees it, then redacted, then clipped.
 * Exported for the redaction corpus test (tests/redaction-corpus-smoke.ts).
 */
export function redactEventText(value: string, maxBytes = TEXT_MAX): string {
  return clipped(redactSecrets(oneVisibleLine(value)).text, maxBytes);
}

/** Each field bounded: free text and `failing` names redacted, every string one visible line and clipped, lists capped. */
function bounded(input: EventInput): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (typeof value === "string") out[key] = FREE_TEXT.has(key) ? redactEventText(value) : clipped(oneVisibleLine(value), ID_MAX);
    else if (Array.isArray(value)) out[key] = value.slice(0, LIST_MAX).map((item) => (typeof item === "string" ? redactEventText(item, LIST_ITEM_MAX) : item));
    else out[key] = value;
  }
  return out;
}

/** The directory the log lives in: the state home with any link in the operator's own path resolved (a path the operator set is trusted; only the log's own name is checked). */
function logDir(home: string): string {
  try { return fs.realpathSync(home); } catch { return home; }
}

export const eventsPath = (home: string): string => path.join(logDir(home), EVENTS_FILE);

export interface AppendOptions {
  /** The event's time; now when absent. */
  at?: string;
  /** Rotation threshold in bytes (tests use a small one). */
  rotateBytes?: number;
}

/**
 * Append one event to <home>/events.jsonl. The file is opened with O_APPEND and O_NOFOLLOW and
 * the line goes out in one write(2): on a local POSIX file system concurrent appenders each land
 * a whole line, since an O_APPEND write of a few hundred bytes to a regular file is not split
 * (appendFileSafe). A symbolic link at the log's name, a file that is not the user's own regular
 * file, or a home that is not a directory is refused. A new file is mode 0600 and a home this
 * creates 0700. Before the append a file over `rotateBytes` is renamed to events.jsonl.1,
 * replacing the older one, under the rotation lock (rotateUnderLock).
 *
 * Never throws: a failure is passed to `log` and the event is dropped. Returns whether it was written.
 */
export function appendEvent(home: string, input: EventInput, log: (line: string) => void, { at: when, rotateBytes = ROTATE_BYTES }: AppendOptions = {}): boolean {
  try {
    const event = parseEvent({ v: EVENTS_SCHEMA_VERSION, at: when ?? new Date().toISOString(), ...bounded(input) });
    if (!event) { log(`event log: ${input.type} event dropped: it does not match the event schema`); return false; }
    const line = `${JSON.stringify(event)}\n`;
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) { log(`event log: ${input.type} event dropped: over ${MAX_LINE_BYTES} bytes`); return false; }
    const file = eventsPath(home);
    rotateUnderLock(file, rotateBytes);
    appendFileSafe(file, line, { mode: 0o600, dirMode: 0o700 });
    return true;
  } catch (e) {
    log(`event log: ${input.type} event not written: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

const lstatOrNull = (file: string): fs.Stats | null => fs.lstatSync(file, { throwIfNoEntry: false }) ?? null;

/**
 * Rotate `file` once it is over `maxBytes`, holding EVENTS_ROTATE_LOCK. The size is checked again
 * under the lock (rotateFileSafe), so of two appenders that both saw an oversized file only the
 * first renames it; without the lock the second would rename the first's fresh file over the
 * generation just rotated. An appender that finds the lock held skips rotating and appends to the
 * live file. A lock older than ROTATE_LOCK_STALE_MS is removed and taken; two appenders taking the
 * same stale lock at the same moment can both rotate (documented in docs/autonomy.md).
 */
function rotateUnderLock(file: string, maxBytes: number): void {
  const st = lstatOrNull(file);
  if (!st || st.size <= maxBytes) return;
  const lock = path.join(path.dirname(file), EVENTS_ROTATE_LOCK);
  let fd = openFileExclusive(lock, { mode: 0o600, dirMode: 0o700 });
  if (fd === null) {
    const held = lstatOrNull(lock);
    if (held && Date.now() - held.mtimeMs < ROTATE_LOCK_STALE_MS) return;
    try { fs.unlinkSync(lock); } catch { /* another appender removed it first */ }
    fd = openFileExclusive(lock, { mode: 0o600, dirMode: 0o700 });
    if (fd === null) return;
  }
  fs.closeSync(fd);
  try {
    rotateFileSafe(file, maxBytes);
  } finally {
    try { fs.unlinkSync(lock); } catch { /* already removed as stale by another appender */ }
  }
}

// --- reading ----------------------------------------------------------------------------------
export interface ReadEventsOptions {
  /** Only events at or after this instant (ISO time). */
  since?: string;
  /** Only this run's events. */
  run?: string;
  /** Only these types or families (`cycle` is cycle.started and cycle.ended). */
  types?: readonly string[];
  /** At most this many: the most recent ones, still in file order. */
  limit?: number;
}

export interface ReadEventsResult {
  /** Matching events in file order: the rotated file's, then the live file's. */
  events: HostEvent[];
  /** Lines that are not events (unparseable, over MAX_LINE_BYTES, unknown type or version). */
  skipped: number;
  /** The files read, in order (those that exist). */
  files: string[];
}

interface OpenLog { file: string; fd: number; ino: number }

/** `file` opened through O_NOFOLLOW (a link is refused), or null when there is none. */
function openLog(file: string): OpenLog | null {
  let fd: number;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)); }
  catch (e) {
    const code = e instanceof Error && "code" in e ? e.code : undefined;
    if (code === "ENOENT") return null;
    if (code === "ELOOP" || code === "EMLINK") throw new UnsafePathError(file, "the file is a symbolic link");
    throw e;
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new UnsafePathError(file, "not a regular file");
    return { file, fd, ino: st.ino };
  } catch (e) {
    fs.closeSync(fd);
    throw e;
  }
}

/** The text of an open log: at most the last READ_CAP_BYTES; a cut first line is dropped. */
function readOpen({ fd }: OpenLog): string {
  const size = fs.fstatSync(fd).size;
  const length = Math.min(size, READ_CAP_BYTES);
  const buf = Buffer.alloc(length);
  let got = 0;
  while (got < length) {
    const n = fs.readSync(fd, buf, got, length - got, size - length + got);
    if (n === 0) break;
    got += n;
  }
  const textRead = buf.subarray(0, got).toString("utf8");
  return length < size ? textRead.slice(textRead.indexOf("\n") + 1) : textRead;
}

/**
 * The rotated and live files, both opened, as one consistent pair: if a rotation renamed the live
 * file while they were being opened, the rotated name no longer holds the file opened under it, and
 * both are opened again (up to READ_ATTEMPTS times). Once both are open a later rotation does not
 * change what is read.
 */
function openPair(dir: string): Array<OpenLog | null> {
  for (let attempt = 1; ; attempt += 1) {
    const rotated = openLog(path.join(dir, EVENTS_ROTATED));
    let live: OpenLog | null;
    try { live = openLog(path.join(dir, EVENTS_FILE)); }
    catch (e) { if (rotated) fs.closeSync(rotated.fd); throw e; }
    const now = lstatOrNull(path.join(dir, EVENTS_ROTATED));
    if (attempt >= READ_ATTEMPTS || (now?.ino ?? null) === (rotated?.ino ?? null)) return [rotated, live];
    for (const f of [rotated, live]) if (f) fs.closeSync(f.fd);
  }
}

const typeMatches = (type: string, filters: readonly string[]): boolean => filters.some((f) => type === f || type.startsWith(`${f}.`));

/**
 * The host event log of `home`, filtered, in the order it was written. Reads events.jsonl.1 then
 * events.jsonl; a line that is not a valid event is counted in `skipped` and left out. Throws
 * UnsafePathError when either file is a symbolic link or not a regular file.
 */
export function readEvents(home: string, { since, run, types, limit }: ReadEventsOptions = {}): ReadEventsResult {
  const sinceMs = since === undefined ? null : Date.parse(since);
  if (sinceMs !== null && !Number.isFinite(sinceMs)) throw new Error(`since ${JSON.stringify(since)} is not a time`);
  const dir = logDir(home);
  const events: HostEvent[] = [];
  const files: string[] = [];
  let skipped = 0;
  const pair = openPair(dir);
  const contents: Array<[string, string]> = [];
  try {
    for (const f of pair) if (f) contents.push([f.file, readOpen(f)]);
  } finally {
    for (const f of pair) if (f) fs.closeSync(f.fd);
  }
  for (const [file, content] of contents) {
    files.push(file);
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) { skipped += 1; continue; }
      let raw: unknown;
      try { raw = parseJson(line); } catch { skipped += 1; continue; }
      const event = parseEvent(raw);
      if (!event) { skipped += 1; continue; }
      if (sinceMs !== null && Date.parse(event.at) < sinceMs) continue;
      if (run !== undefined && event.run !== run) continue;
      if (types?.length && !typeMatches(event.type, types)) continue;
      events.push(event);
    }
  }
  return { events: limit !== undefined && limit >= 0 && events.length > limit ? events.slice(events.length - limit) : events, skipped, files };
}

/** One line for a terminal: time, run, type and the event's own fields as key=value, every value one visible line. */
export function formatEvent(e: HostEvent): string {
  const fields = Object.entries(e)
    .filter(([k]) => !["v", "at", "run", "type"].includes(k))
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.map(String).join(",") : typeof v === "string" && /\s/.test(v) ? JSON.stringify(v) : String(v)}`);
  return oneVisibleLine([e.at, e.run, e.type, ...fields].join(" "));
}
