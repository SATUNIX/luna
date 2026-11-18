// autonomy.ts — the read-only autonomy view behind GET /api/autonomy.
//
// The console reads what the autonomy supervisors already record under the state home
// (docs/autonomy.md): each run's state.json, the host event log events.jsonl (and its one rotated
// generation) and, when present, the reporting status file status.json. Nothing here writes, and
// no run can be controlled through it.
//
// packages/autonomy is not part of the published package (package.json `files`), and
// packages/core/pack-check.ts fails a compiled import that names an unpacked file, so the server
// cannot import the autonomy library at run time. It reads the files itself instead, with
// the same rules: the state home is resolved as lib/paths.ts stateHome() does, a run is summarised
// as lib/store.ts listRuns() does, an event line is checked against the event log's envelope
// (version 1, a known type, bounded fields, at most MAX_LINE_BYTES), and the status file must be
// schema version 1 of lib/reporting.ts. The `import type` lines below are erased at build time;
// they make `npm run test:typecheck` fail when those modules' types drift from what is read here,
// and tests/web-ui-api-smoke.ts checks the readers against files the autonomy library writes.
//
// Every value from these files is untrusted (a worker influences blocker questions, reasons and
// branch names): every string, from state.json, an event line or the status file, passes through
// the kit's redaction table (packages/core/shared/redact.ts) and is made one visible line and
// clipped, numbers must be finite, and one malformed run, line or status file is skipped and
// counted, never fatal to the response.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	array,
	boolean,
	isRecord,
	literal,
	nullable,
	number,
	object,
	parseJson,
	record,
	safeParse,
	string,
	type Infer,
} from "../../core/lib/guard.ts";
import { redactSecrets } from "../../core/shared/redact.ts";
import type { HostEvent, HostEventType } from "../../autonomy/lib/events.ts";
import type { StatusReport } from "../../autonomy/lib/reporting.ts";
import type { RunSummary } from "../../autonomy/lib/store.ts";

/** The response's own version; a change of shape that drops or retypes a field raises it. */
export const AUTONOMY_VIEW_VERSION = 1;
/** The most runs listed (newest first); `runsTotal` says how many there were. */
export const MAX_RUNS = 200;
/** The most host events returned: the newest ones, oldest first. */
export const MAX_EVENTS = 50;
/** state.json or status.json larger than this is skipped. */
const MAX_JSON_BYTES = 1024 * 1024;
/** How much of each event log file is read, from its end. */
const EVENT_TAIL_BYTES = 512 * 1024;
/** The event log's own line limit (lib/events.ts MAX_LINE_BYTES): a longer line is not an event. */
const MAX_LINE_BYTES = 4096;
const EVENTS_FILE = "events.jsonl";
const EVENTS_ROTATED = `${EVENTS_FILE}.1`;
const STATUS_FILE = "status.json";
/** Longest string kept from a run's state.json or an event field. */
const TEXT_MAX = 500;
const ID_MAX = 200;
const LIST_MAX = 20;

/** The event types of schema version 1 (lib/events.ts EVENT_TYPES; the type check below keeps them equal). */
export const AUTONOMY_EVENT_TYPES = [
	"run.started",
	"run.status",
	"cycle.started",
	"gate.result",
	"cycle.ended",
	"push",
	"failure",
	"dispatch.claim",
	"dispatch.submit",
	"harness.degraded",
] as const;
export type AutonomyEventType = (typeof AUTONOMY_EVENT_TYPES)[number];

/** A field of a host event: what the writer stores (identifiers, free text, counts, flags, lists of names). */
export type AutonomyEventField = string | number | boolean | null | readonly string[];

/** One host event log line, as written: the envelope plus its type's own fields. */
export interface AutonomyEvent {
	readonly v: 1;
	readonly at: string;
	readonly run: string;
	readonly type: AutonomyEventType;
	readonly [field: string]: AutonomyEventField;
}

/** One run, as lib/store.ts listRuns() summarises it, with its fields typed and the newest event's time. */
export interface AutonomyRun {
	readonly run: string;
	readonly template: string | null;
	readonly status: string | null;
	readonly updatedAt: string | null;
	readonly outcome: { readonly status: string; readonly reason: string } | null;
	readonly spentUsd: number | null;
	readonly budgetUsd: number | null;
	readonly step: number | null;
	readonly blocker: { readonly kind: string; readonly question: string; readonly waiting?: "waiting_budget" | "waiting_provider" } | null;
	/** Written by the previous (v0) supervisor: listed, but it cannot be driven. */
	readonly legacy?: true;
	/** The time of this run's newest event in the part of the event log that was read, or null. */
	readonly lastEventAt: string | null;
}

/** GET /api/autonomy. */
export interface AutonomyResponse {
	readonly schemaVersion: typeof AUTONOMY_VIEW_VERSION;
	/** When this answer was built. */
	readonly at: string;
	readonly runs: AutonomyRun[];
	/** Runs found before the MAX_RUNS cut. */
	readonly runsTotal: number;
	readonly events: AutonomyEvent[];
	/** The reporting status file (`pi-autonomy report --out <state home>/status.json`), or null. */
	readonly status: AutonomyStatus | null;
	/** What was left out because it could not be read or did not match: never a reason to fail. */
	readonly skipped: { readonly runs: number; readonly events: number; readonly status: number };
}

// ------------------------------------------------------------------ reading ---
/** C0 and C1 controls, the soft hyphen, the Arabic letter mark, zero-width and bidirectional formatting characters, line and paragraph separators, the byte-order mark. */
function isHidden(cp: number): boolean {
	return (
		cp <= 0x1f ||
		(cp >= 0x7f && cp <= 0x9f) ||
		cp === 0xad ||
		cp === 0x61c ||
		cp === 0x180e ||
		(cp >= 0x200b && cp <= 0x200f) ||
		(cp >= 0x2028 && cp <= 0x202e) ||
		(cp >= 0x2060 && cp <= 0x206f) ||
		cp === 0xfeff
	);
}

/**
 * One visible line with secrets redacted: the redaction table runs first (as lib/reporting.ts
 * safeLine does for the status file and alerts), then hidden characters become spaces, runs of
 * white space one space; clipped.
 */
function line(value: string, max: number): string {
	let out = "";
	for (const ch of redactSecrets(value).text) out += isHidden(ch.codePointAt(0) ?? 0) ? " " : ch;
	return out.replace(/\s+/g, " ").trim().slice(0, max);
}

const text = (value: unknown, max = TEXT_MAX): string | null => (typeof value === "string" ? line(value, max) : null);
const finite = (value: unknown): number | null =>
	typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

/** lib/paths.ts stateHome(): PI_AUTONOMY_HOME, else $XDG_STATE_HOME/pi-autonomy, else ~/.local/state/pi-autonomy. */
export function autonomyHome(env: NodeJS.ProcessEnv = process.env): string {
	return env.PI_AUTONOMY_HOME || path.join(env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "pi-autonomy");
}

type FileRead = { readonly kind: "text"; readonly text: string } | { readonly kind: "absent" } | { readonly kind: "refused" };

/**
 * A regular file's text, opened without following a link at its name and without waiting for a
 * writer (O_NONBLOCK: a FIFO at the name would otherwise block this synchronous open, and with it
 * the whole console). `tail` reads at most `maxBytes` from the end (dropping a cut first line);
 * otherwise a file over `maxBytes` is refused.
 */
function readFile(file: string, { maxBytes = MAX_JSON_BYTES, tail = false }: { maxBytes?: number; tail?: boolean } = {}): FileRead {
	let fd: number;
	try {
		fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
	} catch (error) {
		const code = error instanceof Error && "code" in error ? error.code : undefined;
		return code === "ENOENT" || code === "ENOTDIR" ? { kind: "absent" } : { kind: "refused" };
	}
	try {
		const st = fs.fstatSync(fd);
		if (!st.isFile()) return { kind: "refused" };
		if (st.size > maxBytes && !tail) return { kind: "refused" };
		const length = Math.min(st.size, maxBytes);
		const buf = Buffer.alloc(length);
		let got = 0;
		while (got < length) {
			const read = fs.readSync(fd, buf, got, length - got, st.size - length + got);
			if (read === 0) break;
			got += read;
		}
		const body = buf.subarray(0, got).toString("utf8");
		return { kind: "text", text: length < st.size ? body.slice(body.indexOf("\n") + 1) : body };
	} catch {
		return { kind: "refused" };
	} finally {
		fs.closeSync(fd);
	}
}

type JsonRead = { readonly kind: "value"; readonly value: unknown } | { readonly kind: "absent" } | { readonly kind: "refused" };

function readJson(file: string): JsonRead {
	const read = readFile(file);
	if (read.kind !== "text") return read;
	try {
		return { kind: "value", value: parseJson(read.text) };
	} catch {
		return { kind: "refused" };
	}
}

// --------------------------------------------------------------------- runs ---
type RunWithoutEvent = Omit<AutonomyRun, "lastEventAt">;

/** One run directory's summary (listRuns' narrowing): null when it has no state.json, "skip" when it is unusable. */
function runSummary(home: string, run: string): RunWithoutEvent | null | "skip" {
	const read = readJson(path.join(home, run, "state.json"));
	if (read.kind === "absent") return null;
	if (read.kind === "refused" || !isRecord(read.value)) return "skip";
	const s = read.value;
	const usage = isRecord(s.usage) ? s.usage : undefined;
	const limits = isRecord(s.limits) ? s.limits : undefined;
	const budget = isRecord(limits?.budget) ? limits.budget : undefined;
	const rawOutcome = s.outcome;
	const outcome =
		isRecord(rawOutcome) && typeof rawOutcome.status === "string"
			? { status: line(rawOutcome.status, ID_MAX), reason: text(rawOutcome.reason) ?? "" }
			: null;
	const rawBlocker = s.blocker;
	let blocker: AutonomyRun["blocker"] = null;
	if (isRecord(rawBlocker) && typeof rawBlocker.kind === "string" && typeof rawBlocker.question === "string") {
		const { waiting } = rawBlocker;
		blocker = {
			kind: line(rawBlocker.kind, ID_MAX),
			question: line(rawBlocker.question, TEXT_MAX),
			...(waiting === "waiting_budget" || waiting === "waiting_provider" ? { waiting } : {}),
		};
	}
	return {
		run: line(run, ID_MAX),
		template: text(s.template ?? "self-improve", ID_MAX),
		status: text(s.status, ID_MAX),
		updatedAt: text(s.updatedAt ?? s.startedAt, 40),
		outcome,
		spentUsd: finite(usage?.usd),
		budgetUsd: finite(budget?.totalUsd),
		step: finite(s.step),
		blocker,
		...(s.schemaVersion === undefined ? { legacy: true as const } : {}),
	};
}

function listRunSummaries(home: string): { runs: RunWithoutEvent[]; skipped: number } {
	let names: string[];
	try {
		names = fs.readdirSync(home);
	} catch {
		return { runs: [], skipped: 0 };
	}
	const runs: RunWithoutEvent[] = [];
	let skipped = 0;
	for (const name of names) {
		const summary = runSummary(home, name);
		if (summary === "skip") skipped += 1;
		else if (summary) runs.push(summary);
	}
	runs.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
	return { runs, skipped };
}

// ------------------------------------------------------------------- events ---
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const EVENT_TYPE_SET: ReadonlySet<string> = new Set(AUTONOMY_EVENT_TYPES);
const isEventType = (value: unknown): value is AutonomyEventType => typeof value === "string" && EVENT_TYPE_SET.has(value);
const RESERVED_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

/** A field value as the writer stores it, made one line and clipped; undefined when it is not one. */
function eventField(value: unknown): AutonomyEventField | undefined {
	if (typeof value === "string") return line(value, TEXT_MAX);
	if (value === null || typeof value === "boolean") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	if (Array.isArray(value) && value.length <= LIST_MAX) {
		const items: string[] = [];
		for (const item of value) {
			if (typeof item !== "string") return undefined;
			items.push(line(item, ID_MAX));
		}
		return items;
	}
	return undefined;
}

/** One log line as an event, or null when it is not a version-1 event of a known type with plain fields. */
export function parseEventLine(raw: string): AutonomyEvent | null {
	if (Buffer.byteLength(raw) > MAX_LINE_BYTES) return null;
	let value: unknown;
	try {
		value = parseJson(raw);
	} catch {
		return null;
	}
	if (!isRecord(value) || value.v !== 1 || !isEventType(value.type)) return null;
	const { at, run, type } = value;
	if (typeof at !== "string" || at.length > 40 || !ISO.test(at) || !Number.isFinite(Date.parse(at))) return null;
	if (typeof run !== "string" || run.length < 1 || run.length > ID_MAX) return null;
	const fields: Record<string, AutonomyEventField> = {};
	for (const [key, field] of Object.entries(value)) {
		if (key === "v" || key === "at" || key === "run" || key === "type") continue;
		if (RESERVED_KEYS.has(key)) return null;
		const parsed = eventField(field);
		if (parsed === undefined) return null;
		fields[key] = parsed;
	}
	return { ...fields, v: 1, at, run: line(run, ID_MAX), type };
}

/** The tail of the rotated then the live log, parsed: the newest MAX_EVENTS, and each run's newest event time. */
function readRecentEvents(home: string): { events: AutonomyEvent[]; lastAt: Map<string, string>; skipped: number } {
	let dir = home;
	try {
		dir = fs.realpathSync(home);
	} catch {
		/* no state home yet: nothing to read */
	}
	const parsed: AutonomyEvent[] = [];
	let skipped = 0;
	for (const name of [EVENTS_ROTATED, EVENTS_FILE]) {
		const read = readFile(path.join(dir, name), { maxBytes: EVENT_TAIL_BYTES, tail: true });
		if (read.kind === "refused") skipped += 1;
		if (read.kind !== "text") continue;
		for (const raw of read.text.split("\n")) {
			if (!raw.trim()) continue;
			const event = parseEventLine(raw);
			if (event) parsed.push(event);
			else skipped += 1;
		}
	}
	const lastAt = new Map<string, string>();
	for (const event of parsed) {
		const seen = lastAt.get(event.run);
		if (seen === undefined || Date.parse(event.at) >= Date.parse(seen)) lastAt.set(event.run, event.at);
	}
	return { events: parsed.slice(-MAX_EVENTS), lastAt, skipped };
}

// ------------------------------------------------------------------- status ---
const num = nullable(number());
const str = string({ maxLength: TEXT_MAX });
const StatusSchema = object({
	schemaVersion: literal(1),
	generatedAt: string({ maxLength: 40 }),
	timeZone: string({ maxLength: 100 }),
	runs: array(
		object({
			run: str,
			status: str,
			step: num,
			reason: nullable(str),
			blocker: nullable(object({ kind: str, waiting: nullable(str), question: str })),
			lastCycle: nullable(
				object({ n: num, outcome: nullable(str), reason: nullable(str), gate: nullable(str), merged: nullable(boolean()) }),
			),
			source: str,
			spend: object({ todayUsd: number(), monthUsd: number(), totalUsd: num, budgetUsd: num }),
			updatedAt: nullable(str),
		}),
		{ maxItems: 1000 },
	),
	spend: record(object({ todayUsd: number(), monthUsd: number() }), { maxKeys: 100 }),
	keys: record(object({ at: str, limit: num, limit_remaining: num, usage: num }), { maxKeys: 100 }),
	openPrs: nullable(
		array(
			object({
				number: number(),
				title: str,
				head: str,
				base: str,
				draft: boolean(),
				ci: literal("green", "red", "pending", "none"),
				url: str,
			}),
			{ maxItems: 500 },
		),
	),
	lastAlert: nullable(object({ at: str, title: str, delivered: boolean(), httpStatus: num })),
});
/** The reporting status file (lib/reporting.ts StatusReport, schema version 1). */
export type AutonomyStatus = Infer<typeof StatusSchema>;

/** Deeper than the status schema goes: a value nested further is dropped (and the schema then fails). */
const STATUS_MAX_DEPTH = 8;

/**
 * The status file's value with every string and record key made one visible, redacted line, as
 * state.json fields are: the library writes some of them (branch names, PR titles) without
 * folding hidden characters. Runs before the schema check, so the schema sees what is sent.
 */
function cleanStatusValue(value: unknown, depth = 0): unknown {
	if (typeof value === "string") return line(value, TEXT_MAX);
	if (depth >= STATUS_MAX_DEPTH) return null;
	if (Array.isArray(value)) return value.map((item) => cleanStatusValue(item, depth + 1));
	if (isRecord(value)) {
		// Object.fromEntries defines properties, so a "__proto__" key stays an ordinary key.
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [line(key, ID_MAX), cleanStatusValue(item, depth + 1)]));
	}
	return value;
}

function readStatus(home: string): { status: AutonomyStatus | null; skipped: number } {
	const read = readJson(path.join(home, STATUS_FILE));
	if (read.kind === "absent") return { status: null, skipped: 0 };
	if (read.kind === "refused") return { status: null, skipped: 1 };
	const parsed = safeParse(StatusSchema, cleanStatusValue(read.value));
	return parsed.ok ? { status: parsed.value, skipped: 0 } : { status: null, skipped: 1 };
}

// --------------------------------------------------------------------- view ---
/** The whole answer for GET /api/autonomy, built from `home` (default: the state home). */
export function autonomyView(home: string = autonomyHome(), now: Date = new Date()): AutonomyResponse {
	const listed = listRunSummaries(home);
	const recent = readRecentEvents(home);
	const status = readStatus(home);
	return {
		schemaVersion: AUTONOMY_VIEW_VERSION,
		at: now.toISOString(),
		runs: listed.runs.slice(0, MAX_RUNS).map((run) => ({ ...run, lastEventAt: recent.lastAt.get(run.run) ?? null })),
		runsTotal: listed.runs.length,
		events: recent.events,
		status: status.status,
		skipped: { runs: listed.skipped, events: recent.skipped, status: status.skipped },
	};
}

// -------------------------------------------- agreement with lib/ (types only) ---
type Assert<T extends true> = T;
type Fits<T, U> = [T] extends [U] ? true : false;
type Same<T, U> = [T] extends [U] ? ([U] extends [T] ? true : false) : false;
export type AutonomyLibraryChecks = [
	// The same event types, and every event the library writes is one this reader accepts.
	Assert<Same<AutonomyEventType, HostEventType>>,
	Assert<Fits<HostEvent, AutonomyEvent>>,
	// A status file the library writes is one this reader's schema describes, and the reverse.
	Assert<Fits<StatusReport, AutonomyStatus>>,
	Assert<Fits<AutonomyStatus, StatusReport>>,
	// The run summary keeps listRuns' field names.
	Assert<Same<Exclude<keyof AutonomyRun, "lastEventAt">, keyof RunSummary>>,
];
