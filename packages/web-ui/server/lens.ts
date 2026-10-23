// lens.ts — surface pi-lens's own state for a session (read-only).
//
// pi-lens persists per-session widget data and a shared cache under ~/.pi-lens.
// We only read small, well-known files — the directory itself can be very large.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { array, number, object, string, union, unknownValue } from "../../core/lib/guard.ts";
import { lenient, readJsonFile } from "./json.ts";

export const LENS_DIR =
	process.env.PI_LENS_DIR || path.join(os.homedir(), ".pi-lens");

/** A timestamp as pi-lens writes it (epoch milliseconds or an ISO string). */
export type LensTime = string | number;

export interface LensRunner {
	name: string;
	status?: string;
	count: number;
	durationMs: number;
}

export interface LensFile {
	filePath: string | null;
	blocking: number;
	errors: number;
	warnings: number;
	runners: LensRunner[];
	touchedAt: LensTime | null;
}

export interface LensTotals {
	blocking: number;
	errors: number;
	warnings: number;
}

/** What /api/sessions/:id/lens returns. */
export interface SessionLens {
	available: boolean;
	savedAt: string | null;
	files: LensFile[];
	totals: LensTotals;
	cache: { qualityWarnings: number; findings: number; qualityGeneratedAt: LensTime | null };
}

export interface LensStatus {
	dir: string;
	present: boolean;
	sessionCount: number;
	turn: { files: number; cycles?: number; lastUpdated?: LensTime } | null;
}

// pi-lens owns these files: each field is checked on its own and dropped when it has the wrong type.
const lensTime = () => lenient(union(number(), string()));
const CountsSchema = object({
	blocking: lenient(number()),
	errors: lenient(number()),
	warnings: lenient(number()),
});
const RunnerInfoSchema = object({
	status: lenient(string()),
	count: lenient(number()),
	durationMs: lenient(number()),
});
const LensFileSchema = object({
	filePath: lenient(string()),
	diagnosticCounts: lenient(CountsSchema),
	runners: lenient(array(unknownValue())),
	touchedAt: lensTime(),
});
const SessionFileSchema = object({
	savedAt: lensTime(),
	widget: lenient(object({ files: lenient(array(unknownValue())) })),
});
const CacheFileSchema = object({
	files: lenient(array(unknownValue())),
	generatedAt: lensTime(),
});
const TurnStateSchema = object({
	files: unknownValue(),
	turnCycles: lenient(number()),
	lastUpdated: lensTime(),
});

function runnerOf(runner: unknown): LensRunner | null {
	if (!Array.isArray(runner)) return null;
	const tuple: unknown[] = runner;
	const [name, rawInfo] = tuple;
	if (typeof name !== "string") return null;
	const info = lenient(RunnerInfoSchema).parse(rawInfo);
	return {
		name,
		...(info?.status === undefined ? {} : { status: info.status }),
		count: info?.count || 0,
		durationMs: info?.durationMs || 0,
	};
}

function lensFileOf(entry: unknown): LensFile | null {
	const parsed = lenient(LensFileSchema).parse(entry);
	if (!parsed) return null;
	const counts = parsed.diagnosticCounts ?? {};
	return {
		filePath: parsed.filePath ?? null,
		blocking: counts.blocking || 0,
		errors: counts.errors || 0,
		warnings: counts.warnings || 0,
		runners: (parsed.runners ?? []).map(runnerOf).filter((r): r is LensRunner => r !== null),
		touchedAt: parsed.touchedAt || null,
	};
}

/** An ISO string for a pi-lens timestamp, or null when it is not a valid date (toISOString throws then). */
function isoTime(value: LensTime | undefined): string | null {
	if (!value) return null;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function safeStat(file: string): fs.Stats | null {
	try {
		return fs.statSync(file);
	} catch {
		return null;
	}
}

function emptyLens(): SessionLens {
	return {
		available: false,
		savedAt: null,
		files: [],
		totals: { blocking: 0, errors: 0, warnings: 0 },
		cache: { qualityWarnings: 0, findings: 0, qualityGeneratedAt: null },
	};
}

/** Per-file diagnostics recorded for this session plus cache-level findings. */
export function sessionLens(sessionId: unknown): SessionLens {
	// Guard against path traversal: an id such as "../../secret" would otherwise
	// be normalised by path.join and read a JSON file outside LENS_DIR/sessions.
	if (typeof sessionId !== "string" || sessionId.length === 0) return emptyLens();
	const sessionsDir = path.join(LENS_DIR, "sessions");
	const root = path.resolve(sessionsDir);
	const resolved = path.resolve(sessionsDir, `${sessionId}.json`);
	if (!resolved.startsWith(root + path.sep)) return emptyLens();
	const rawValue = readJsonFile(resolved);
	const raw = lenient(SessionFileSchema).parse(rawValue);
	const files: LensFile[] = [];
	for (const entry of raw?.widget?.files ?? []) {
		const file = lensFileOf(entry);
		if (file) files.push(file);
	}

	const totals = files.reduce(
		(acc, f) => ({
			blocking: acc.blocking + f.blocking,
			errors: acc.errors + f.errors,
			warnings: acc.warnings + f.warnings,
		}),
		{ blocking: 0, errors: 0, warnings: 0 },
	);

	const quality = lenient(CacheFileSchema).parse(
		readJsonFile(path.join(LENS_DIR, "cache", "code-quality-warnings.json")),
	);
	const findings = lenient(CacheFileSchema).parse(
		readJsonFile(path.join(LENS_DIR, "cache", "turn-end-findings.json")),
	);

	return {
		available: Boolean(rawValue),
		savedAt: isoTime(raw?.savedAt),
		files,
		totals,
		cache: {
			qualityWarnings: quality?.files ? quality.files.length : 0,
			findings: findings?.files ? findings.files.length : 0,
			qualityGeneratedAt: quality?.generatedAt || null,
		},
	};
}

/** Global lens status: is the cache present and how big is it. */
export function lensStatus(): LensStatus {
	const dirStat = safeStat(LENS_DIR);
	const sessionDir = path.join(LENS_DIR, "sessions");
	let sessionCount = 0;
	try {
		sessionCount = fs
			.readdirSync(sessionDir)
			.filter((f) => f.endsWith(".json")).length;
	} catch {
		/* ignore */
	}
	const turnRaw = readJsonFile(path.join(LENS_DIR, "turn-state.json"));
	const turnState = turnRaw ? lenient(TurnStateSchema).parse(turnRaw) : undefined;
	const turnFiles = turnState?.files;
	return {
		dir: LENS_DIR,
		present: Boolean(dirStat),
		sessionCount,
		turn: turnRaw
			? {
					files: typeof turnFiles === "object" && turnFiles !== null ? Object.keys(turnFiles).length : 0,
					...(turnState?.turnCycles === undefined ? {} : { cycles: turnState.turnCycles }),
					...(turnState?.lastUpdated === undefined ? {} : { lastUpdated: turnState.lastUpdated }),
				}
			: null,
	};
}
