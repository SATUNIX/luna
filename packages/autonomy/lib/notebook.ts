// The generations notebook ("Memento mode"): what one time-boxed worker generation hands the next.
//
// A worker writes a short JSON notebook (state, strategies tried, failures, things not to retry,
// next steps, and its own claims about progress). The supervisor parses it with type guards only,
// redacts secret-shaped values, clips each field, caps the whole notebook at a size budget (oldest
// `tried` entries go first) and reports every change it made. `measured` is never taken from the
// worker: only the supervisor fills it, from evidence it gathered itself.
//
// The notebook file is append-only: each generation adds one entry, earlier entries are never
// rewritten, and a file that does not parse is refused rather than replaced. Writes are atomic
// (temp file + rename) with mode 0600 in a 0700 directory.
//
// renderNotebook() puts the worker-written part inside untrusted() (templates/common.ts), so the next
// generation reads it as data; the supervisor's measurements are shown outside the fence.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isRecord, parseJson } from "../../core/lib/guard.ts";
import { untrusted } from "./templates/common.ts";

export const NOTEBOOK_SCHEMA = 1;
/** The default cap on one generation's worker-written notebook, in characters of its JSON form. */
export const NOTEBOOK_MAX_CHARS = 6000;

/** The worker-written lists, in the order the size cap drops from them (oldest entry first). */
export const NOTEBOOK_LISTS = ["tried", "failures", "next", "self_reported", "do_not_retry"] as const;
export type NotebookList = (typeof NOTEBOOK_LISTS)[number];

/** Per-field limits: characters for `state`, and items and characters per item for each list. */
export const FIELD_LIMITS = {
  stateChars: 1500,
  itemChars: 400,
  items: { tried: 40, failures: 20, do_not_retry: 20, next: 10, self_reported: 10 } satisfies Record<NotebookList, number>,
} as const;

/** What a worker may write. Every string has been redacted and clipped. */
export interface WorkerNotebook {
  state: string;
  tried: string[];
  failures: string[];
  do_not_retry: string[];
  next: string[];
  self_reported: string[];
}

/** One acceptance check result as the supervisor measured it. */
export interface MeasuredCheck {
  id: string;
  pass: boolean;
}

/** What the supervisor measured at the end of a generation. Never read from the worker. */
export interface Measured {
  checks: MeasuredCheck[];
  head: string | null;
  changedFiles: number;
  minutes: number;
  usd: number;
}

/** One generation's entry in the notebook file. */
export interface NotebookEntry extends WorkerNotebook {
  schema: typeof NOTEBOOK_SCHEMA;
  generation: number;
  at: string;
  measured: Measured | null;
  report: NotebookReport;
}

/** Everything the parser changed or dropped, so the supervisor can log it and the operator can see it. */
export interface NotebookReport {
  /** Length of the worker's notebook (JSON form) before and after redaction, clipping and the cap. */
  originalChars: number;
  finalChars: number;
  maxChars: number;
  /** Fields (`state`, `tried[3]`) that were clipped to their per-field limit. */
  clipped: string[];
  /** Entries dropped per list: over the item limit, or to meet the size cap. */
  dropped: Partial<Record<NotebookList, number>>;
  /** True when `state` itself had to be cut further to meet the size cap. */
  stateCut: boolean;
  /** Number of secret-shaped values replaced with [REDACTED]. */
  redactions: number;
  /** True when the worker supplied a `measured` key (always discarded). */
  measuredDropped: boolean;
  /**
   * Top-level keys the schema does not know (discarded), cleaned like worker text (controls
   * stripped, fence defused, secrets redacted and counted in `redactions`) and clipped to
   * UNKNOWN_KEY_CHARS; at most UNKNOWN_KEYS_SHOWN are listed.
   */
  unknownKeys: string[];
  /** Unknown keys beyond the ones listed in `unknownKeys`. */
  unknownKeysMore: number;
}

/** How many unknown keys the report lists, and how long each may be. */
export const UNKNOWN_KEYS_SHOWN = 20;
export const UNKNOWN_KEY_CHARS = 80;

export type NotebookParse =
  | { ok: true; notebook: WorkerNotebook; report: NotebookReport }
  | { ok: false; problems: string[] };

// --- redaction ---------------------------------------------------------------
// Copied from packages/extensions/src/memory-vault/vault.ts (the autonomy package does not import
// extensions); tests/autonomy-notebook-smoke.ts fails when the two pattern lists differ.
const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bglpat-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{40,}/g,
  /\bsk-(?:ant-|proj-|or-)?[A-Za-z0-9_-]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\b((?:api[_-]?key|secret|token|password|passwd|pwd|auth)["']?\s*[:=]\s*["']?)[^\s"',;]{8,}/gi,
];

/** `text` with secret-shaped values replaced, and how many were replaced. */
export function redactSecrets(text: string): { text: string; count: number } {
  let out = text;
  let count = 0;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (m: string, prefix: unknown) => {
      count++;
      return typeof prefix === "string" && m.startsWith(prefix) ? `${prefix}[REDACTED]` : "[REDACTED]";
    });
  }
  return { text: out, count };
}

// --- parsing -----------------------------------------------------------------

const KNOWN_KEYS = new Set(["schema", "state", ...NOTEBOOK_LISTS]);

const LIST_KEYS: ReadonlySet<string> = new Set(NOTEBOOK_LISTS);

/**
 * Every Unicode control (Cc: C0, DEL, C1, which holds the single-byte CSI U+009B) and format (Cf:
 * zero-width, bidi embedding/override/isolate and marks, soft hyphen, BOM, U+180E, tag characters
 * U+E0000-U+E007F, ...) character, plus every Default_Ignorable_Code_Point (combining grapheme joiner,
 * variation selectors, Hangul fillers, ...), except tab and newline. Matched by Unicode property, not
 * by a list, so an invisible character cannot hide inside `<\u200b/untrusted>` or reorder text in a terminal.
 */
export const HIDDEN_CHARS = /[\p{Cf}\p{Cc}\p{Default_Ignorable_Code_Point}]/gu;
/** True when `ch` (one code point) is a character stripControls removes. */
export const isHiddenChar = (ch: string): boolean => ch !== "\n" && ch !== "\t" && /^[\p{Cf}\p{Cc}\p{Default_Ignorable_Code_Point}]$/u.test(ch);
const stripControls = (s: string): string => s.replace(HIDDEN_CHARS, (ch) => (ch === "\n" || ch === "\t" ? ch : ""));

/** A worker string cannot open or close the untrusted fence's tag: `<untrusted` becomes `(untrusted`. */
const defuseFence = (s: string): string => s.replace(/<(\s*\/?\s*untrusted)/gi, "($1");

const CLIP_MARK = " [...clipped]";
/** `s` cut to at most `max` characters, the marker included. */
const cut = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, Math.max(0, max - CLIP_MARK.length))}${CLIP_MARK}`.slice(0, max));

const sizeOf = (nb: WorkerNotebook): number => JSON.stringify(nb).length;

/**
 * Parse a worker's notebook: JSON text or an already-parsed value. Wrong types are refused with a
 * problem per field; unknown keys and a worker-supplied `measured` are dropped and reported.
 */
export function parseNotebook(input: unknown, { maxChars = NOTEBOOK_MAX_CHARS }: { maxChars?: number } = {}): NotebookParse {
  let value: unknown = input;
  if (typeof input === "string") {
    try { value = parseJson(input); } catch (e) { return { ok: false, problems: [`notebook is not JSON: ${e instanceof Error ? e.message : String(e)}`] }; }
  }
  if (!isRecord(value)) return { ok: false, problems: ["notebook must be a JSON object"] };
  const problems: string[] = [];
  if (Object.hasOwn(value, "schema") && value.schema !== NOTEBOOK_SCHEMA) problems.push(`schema must be ${NOTEBOOK_SCHEMA}`);
  const state = value.state;
  if (typeof state !== "string") problems.push("state must be a string");
  const lists: Partial<Record<NotebookList, string[]>> = {};
  for (const key of NOTEBOOK_LISTS) {
    const v = Object.hasOwn(value, key) ? value[key] : undefined;
    if (v === undefined) { lists[key] = []; continue; }
    if (!Array.isArray(v)) { problems.push(`${key} must be an array of strings`); continue; }
    const items: string[] = [];
    v.forEach((item: unknown, i: number) => {
      if (typeof item === "string") items.push(item);
      else problems.push(`${key}[${i}] must be a string`);
    });
    lists[key] = items;
  }
  if (problems.length || typeof state !== "string") return { ok: false, problems };

  const report: NotebookReport = {
    originalChars: 0, finalChars: 0, maxChars, clipped: [], dropped: {}, stateCut: false, redactions: 0,
    measuredDropped: Object.hasOwn(value, "measured"),
    unknownKeys: [], unknownKeysMore: 0,
  };
  const scrub = (s: string, oneLine: boolean): string => {
    const r = redactSecrets(defuseFence(stripControls(s)));
    report.redactions += r.count;
    return (oneLine ? r.text.replace(/\s*\n\s*/g, " ") : r.text).trim();
  };
  const clean = (s: string, max: number, at: string, oneLine: boolean): string => {
    const text = scrub(s, oneLine);
    if (text.length > max) report.clipped.push(at);
    return cut(text, max);
  };
  const unknown = Object.keys(value).filter((k) => !KNOWN_KEYS.has(k) && k !== "measured").sort();
  report.unknownKeys = unknown.slice(0, UNKNOWN_KEYS_SHOWN).map((k) => cut(scrub(k, true), UNKNOWN_KEY_CHARS));
  report.unknownKeysMore = unknown.length - report.unknownKeys.length;
  const raw: WorkerNotebook = { state, tried: [], failures: [], do_not_retry: [], next: [], self_reported: [] };
  for (const key of NOTEBOOK_LISTS) raw[key] = lists[key] ?? [];
  report.originalChars = sizeOf(raw);

  const nb: WorkerNotebook = { state: clean(state, FIELD_LIMITS.stateChars, "state", false), tried: [], failures: [], do_not_retry: [], next: [], self_reported: [] };
  for (const key of NOTEBOOK_LISTS) {
    const items = (lists[key] ?? []).map((s, i) => clean(s, FIELD_LIMITS.itemChars, `${key}[${i}]`, true)).filter((s) => s.length > 0);
    const limit = FIELD_LIMITS.items[key];
    // Over the item limit, the newest entries are kept: the list is in the order the worker wrote it.
    if (items.length > limit) report.dropped[key] = items.length - limit;
    nb[key] = items.slice(-limit);
  }
  // The size cap: drop the oldest entries, `tried` first, then the other lists in NOTEBOOK_LISTS order.
  for (const key of NOTEBOOK_LISTS) {
    while (sizeOf(nb) > maxChars && nb[key].length > 0) {
      nb[key].shift();
      report.dropped[key] = (report.dropped[key] ?? 0) + 1;
    }
  }
  if (sizeOf(nb) > maxChars) {
    const over = sizeOf(nb) - maxChars;
    nb.state = cut(nb.state, Math.max(0, nb.state.length - over - 16));
    report.stateCut = true;
  }
  report.finalChars = sizeOf(nb);
  return { ok: true, notebook: nb, report };
}

/** Validate the supervisor's measurements (a programming error, not worker input, when wrong). */
function checkMeasured(m: Measured): Measured {
  const n = (v: number, what: string): number => {
    if (!Number.isFinite(v) || v < 0) throw new Error(`measured.${what} must be a finite number >= 0`);
    return v;
  };
  return {
    checks: m.checks.map((c) => ({ id: c.id.replace(/[^\w.:-]/g, "_").slice(0, 80), pass: c.pass })),
    head: m.head === null ? null : m.head.replace(/[^0-9a-f]/gi, "").slice(0, 64) || null,
    changedFiles: n(m.changedFiles, "changedFiles"),
    minutes: n(m.minutes, "minutes"),
    usd: n(m.usd, "usd"),
  };
}

// --- the notebook file ---------------------------------------------------------

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
const isNonNegative = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

function isMeasured(v: unknown): v is Measured {
  return isRecord(v) && Array.isArray(v.checks) && v.checks.every((c: unknown) => isRecord(c) && typeof c.id === "string" && typeof c.pass === "boolean")
    && (v.head === null || typeof v.head === "string") && isNonNegative(v.changedFiles) && isNonNegative(v.minutes) && isNonNegative(v.usd);
}

function isReport(v: unknown): v is NotebookReport {
  return isRecord(v) && isNonNegative(v.originalChars) && isNonNegative(v.finalChars) && isNonNegative(v.maxChars) && isStringArray(v.clipped)
    && isRecord(v.dropped) && Object.entries(v.dropped).every(([k, n]) => LIST_KEYS.has(k) && isNonNegative(n))
    && typeof v.stateCut === "boolean" && isNonNegative(v.redactions) && typeof v.measuredDropped === "boolean" && isStringArray(v.unknownKeys) && isNonNegative(v.unknownKeysMore);
}

function isEntry(v: unknown): v is NotebookEntry {
  return isRecord(v) && v.schema === NOTEBOOK_SCHEMA && typeof v.generation === "number" && Number.isInteger(v.generation) && v.generation >= 1
    && typeof v.at === "string" && typeof v.state === "string" && NOTEBOOK_LISTS.every((k) => isStringArray(v[k]))
    && (v.measured === null || isMeasured(v.measured)) && isReport(v.report);
}

/** The entries of a notebook file, oldest first; [] when it does not exist. Throws when it exists but does not parse. */
export function readNotebook(file: string): NotebookEntry[] {
  let text: string;
  try { text = fs.readFileSync(file, "utf8"); } catch (e) {
    if (isRecord(e) && e.code === "ENOENT") return [];
    throw e;
  }
  const value: unknown = parseJson(text);
  if (!isRecord(value) || value.schema !== NOTEBOOK_SCHEMA || !Array.isArray(value.generations)) throw new Error(`${file}: not a schema-${NOTEBOOK_SCHEMA} notebook file`);
  const entries: NotebookEntry[] = [];
  value.generations.forEach((g: unknown, i: number) => {
    if (!isEntry(g) || g.generation !== i + 1) throw new Error(`${file}: generation entry ${i + 1} is malformed or out of order`);
    entries.push(g);
  });
  return entries;
}

/** Write `value` as JSON to `file` atomically, mode 0600, in a 0700 directory. */
function writePrivateJsonAtomic(file: string, value: unknown): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  const fd = fs.openSync(tmp, "wx", 0o600);
  try {
    fs.fchmodSync(fd, 0o600); // the creation mode is subject to the umask; make it exact
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  try { fs.renameSync(tmp, file); } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
}

export interface AppendOptions {
  maxChars?: number;
  now?: () => Date;
}

export type AppendResult =
  | { ok: true; entry: NotebookEntry }
  | { ok: false; problems: string[] };

/**
 * Parse the worker's notebook and append it to `file` as the next generation, with the supervisor's
 * `measured` (or null). Earlier entries are kept exactly as they were. A malformed worker notebook is
 * not appended (the result carries the problems); a notebook file that does not parse throws.
 */
export function appendGeneration(file: string, workerInput: unknown, measured: Measured | null, { maxChars = NOTEBOOK_MAX_CHARS, now = () => new Date() }: AppendOptions = {}): AppendResult {
  const existing = readNotebook(file);
  const parsed = parseNotebook(workerInput, { maxChars });
  if (!parsed.ok) return parsed;
  const entry: NotebookEntry = {
    schema: NOTEBOOK_SCHEMA, generation: existing.length + 1, at: now().toISOString(), ...parsed.notebook,
    measured: measured === null ? null : checkMeasured(measured), report: parsed.report,
  };
  writePrivateJsonAtomic(file, { schema: NOTEBOOK_SCHEMA, generations: [...existing, entry] });
  return { ok: true, entry };
}

// --- the worker's copy ---------------------------------------------------------------

/** Where a worker writes its notebook, relative to the workspace. `.pi/` is never committed (image/entrypoint.sh). */
export const WORKER_NOTEBOOK = ".pi/generation-notebook.json";
/** The most a worker's notebook file may hold before it is refused unread. */
export const WORKER_NOTEBOOK_MAX_BYTES = 64 * 1024;

export type TakenNotebook = { ok: true; text: string } | { ok: false; problem: string };

/**
 * Read the worker's notebook out of its workspace and remove it there, so the next generation does
 * not find it outside the fence. The worker is stopped first (engine.ts), and the file is opened
 * without following links: a symlink, a non-directory `.pi`, anything but a regular file, or a file
 * over WORKER_NOTEBOOK_MAX_BYTES is refused unread, so the supervisor never reads a host file for it.
 */
export function takeWorkerNotebook(workDir: string, { maxBytes = WORKER_NOTEBOOK_MAX_BYTES }: { maxBytes?: number } = {}): TakenNotebook {
  const dir = path.join(workDir, path.dirname(WORKER_NOTEBOOK));
  const file = path.join(workDir, WORKER_NOTEBOOK);
  let st: fs.Stats;
  try { st = fs.lstatSync(dir); } catch { return { ok: false, problem: `the worker wrote no notebook (${WORKER_NOTEBOOK} is missing)` }; }
  if (!st.isDirectory()) return { ok: false, problem: `refused: ${path.dirname(WORKER_NOTEBOOK)} in the workspace is not a plain directory` };
  let fd: number;
  try {
    // O_NONBLOCK: a FIFO planted in place of the file must not hang the supervisor.
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (e) {
    const code = isRecord(e) ? e.code : undefined;
    if (code === "ENOENT") return { ok: false, problem: `the worker wrote no notebook (${WORKER_NOTEBOOK} is missing)` };
    removeQuietly(file);
    return { ok: false, problem: code === "ELOOP" ? `refused: ${WORKER_NOTEBOOK} is a symbolic link` : `refused: ${WORKER_NOTEBOOK} could not be opened (${String(code)})` };
  }
  try {
    const f = fs.fstatSync(fd);
    if (!f.isFile()) return { ok: false, problem: `refused: ${WORKER_NOTEBOOK} is not a regular file` };
    if (f.size > maxBytes) return { ok: false, problem: `refused: ${WORKER_NOTEBOOK} is ${f.size} bytes (the limit is ${maxBytes})` };
    const buf = Buffer.alloc(f.size);
    const n = f.size ? fs.readSync(fd, buf, 0, f.size, 0) : 0;
    return { ok: true, text: buf.subarray(0, n).toString("utf8") };
  } finally {
    fs.closeSync(fd);
    removeQuietly(file);
  }
}

/** Unlink `file` (a link itself, never its target); a missing file is not an error. */
function removeQuietly(file: string): void {
  try { fs.unlinkSync(file); } catch { /* already gone, or not a file: the next generation's briefing does not read it */ }
}

// --- rendering ---------------------------------------------------------------

/**
 * The briefing block for the next generation: the supervisor's measurements as plain lines, then the
 * worker-written notebook inside untrusted(). The worker's own claims carry a `[hypothesis]` prefix.
 */
export function renderNotebook(entry: NotebookEntry): string {
  const lines: string[] = [`Notebook from generation ${entry.generation}.`];
  const m = entry.measured;
  if (m) {
    const passed = m.checks.filter((c) => c.pass).map((c) => c.id);
    const failed = m.checks.filter((c) => !c.pass).map((c) => c.id);
    lines.push("Measured by the supervisor at the end of that generation:",
      `- checks passing: ${passed.length ? passed.join(", ") : "none"}; failing: ${failed.length ? failed.join(", ") : "none"}`,
      `- head ${m.head ?? "unknown"}, ${m.changedFiles} file(s) changed, ${m.minutes} minute(s), $${m.usd.toFixed(2)}`);
  } else {
    lines.push("The supervisor measured nothing for that generation.");
  }
  const section = (title: string, items: readonly string[], prefix = ""): string[] => (items.length ? [`${title}:`, ...items.map((s) => `- ${prefix}${s}`)] : []);
  const body = [
    "State:", entry.state || "(none)",
    ...section("Tried", entry.tried),
    ...section("Failures", entry.failures),
    ...section("Do not retry", entry.do_not_retry),
    ...section("Next", entry.next),
    ...section("Self-reported (not verified)", entry.self_reported, "[hypothesis] "),
  ].join("\n");
  // The fence's own limit sits above the notebook cap, so the cap (reported) is what bounds the text.
  lines.push(untrusted(`notebook generation ${entry.generation}`, body, Math.max(entry.report.maxChars, body.length) + 200));
  return lines.join("\n");
}
