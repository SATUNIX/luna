import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFileExclusive, openFileExclusive, writeFileSafe } from "./shared/safe-fs.ts";
import {
	resolveSessionId,
	todoFilePath,
	readTodos as readTodoFile,
} from "./todo-read.ts";

// A compiled `pi` binary is its own process.execPath; only a JS runtime (node/bun/deno) needs
// the cli.js entry prepended. Prepending it unconditionally made a compiled pi read the script
// path as the child's first prompt (the WU-15 failure, fixed in subagent but copied here).
const PI_JS_RUNTIMES = new Set(["node", "nodejs", "bun", "deno"]);
function piChildArgv(cli: string, args: string[], execPath: string = process.execPath): string[] {
  const runtime = execPath.replace(/\\/g, "/").split("/").pop()?.toLowerCase().replace(/\.(?:exe|cmd|bat)$/, "") ?? "";
  return PI_JS_RUNTIMES.has(runtime) ? [cli, ...args] : [...args];
}

// verify-gate: checks that the task is actually done.
//
// /verify [focus] and the verify_completion tool run a general verification:
//   1. Definition of done: the goal (.pi/GOAL.yaml), the todo list (TODO.md),
//      the task graph (.pi/task-graph.json), the recent user requests, and an
//      optional operator focus.
//   2. Checks (optional): PI_KIT_VERIFY_CMD, else package.json "verify". No
//      check command is normal. It is never recorded as a pass on its own.
//   3. Review: an isolated, read-only reviewer child (pi -p --no-session, tools
//      read/grep/find/ls) gets only the definition of done, the git change
//      summary, and the check output. It never sees the builder's reasoning. It
//      returns a structured verdict per criterion, which is parsed strictly.
// Results go to the verifier board (.pi/verdicts.json) as "verify" (checks)
// and "review" (reviewer), plus a human-readable .pi/verify-report.md.
//
// Fail closed: when no check ran and no review ran, "verify" is recorded FAIL.
//
// PI_KIT_VERIFY_ON_TURN=1 keeps the fast automatic mode: after successful edits
// it runs only the check command at the final turn, as before.

const STATUS_KEY = "verify-gate";
const REVIEW_TOOLS = "read,grep,find,ls";
const CHILD_ENV_FLAG = "PI_KIT_VERIFY_REVIEWER_CHILD";
const DEFAULT_REVIEW_TIMEOUT_MS = 15 * 60 * 1000;
const REVIEW_STREAM_CAP = 16 * 1024 * 1024;

// Parsed JSON and other outside values stay `unknown` until guards like these narrow them.
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isArray(value: unknown): value is unknown[] {
	return Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Check command
// ---------------------------------------------------------------------------

// AG-04 fix: `npm run verify --if-present` exits 0 silently when the project has no
// `verify` script at all, so a project without one previously auto-recorded a PASS
// verdict having run no check whatsoever. Check the script actually exists first so a
// missing script is reported as "nothing was checked", not conflated with a real pass.
function hasVerifyScript(cwd: string): boolean {
	try {
		const pkg: unknown = JSON.parse(
			fs.readFileSync(path.join(cwd, "package.json"), "utf8"),
		);
		const scripts = isRecord(pkg) ? pkg.scripts : undefined;
		const verify = isRecord(scripts) ? scripts.verify : undefined;
		return typeof verify === "string" && verify.trim().length > 0;
	} catch {
		return false;
	}
}

export type CheckResult = {
	ran: boolean;
	ok: boolean;
	label: string;
	output: string;
};

/** The project's check command, if it declares one. Null means "no automated check". */
export function checkCommand(
	cwd: string,
): { label: string; command: string; args: string[] } | null {
	const configured = process.env.PI_KIT_VERIFY_CMD?.trim();
	if (configured)
		return {
			label: `configured check (${configured.slice(0, 60)})`,
			command: configured,
			args: [],
		};
	if (hasVerifyScript(cwd))
		return { label: "npm run verify", command: "npm", args: ["run", "verify"] };
	return null;
}

function runCheck(cwd: string, automatic = false): Promise<CheckResult> {
	const cmd = checkCommand(cwd);
	// Automatic mode keeps its historical contract for the implicit case: a real
	// package.json "verify" script must exist. An explicit PI_KIT_VERIFY_CMD override is
	// honored exactly as /verify does (Area 3 F6), so a project can opt in without one.
	if (automatic && !cmd) {
		return Promise.resolve({
			ran: false,
			ok: false,
			label: "npm run verify",
			output: 'no "verify" script in package.json — nothing was checked',
		});
	}
	if (!cmd) {
		return Promise.resolve({
			ran: false,
			ok: false,
			label: "no check command",
			output: 'no "verify" script in package.json and no PI_KIT_VERIFY_CMD',
		});
	}
	return new Promise((resolve) => {
		execFile(
			cmd.command,
			cmd.args,
			// eslint-disable-next-line no-restricted-syntax -- PI_KIT_VERIFY_CMD is an operator-set shell command line by design, and npm is a .cmd shim on Windows
			{ cwd, shell: true, timeout: 120_000, maxBuffer: 1024 * 1024 },
			(err, stdout, stderr) => {
				const output = (stdout + stderr).trim();
				resolve({
					ran: true,
					ok: !err,
					label: cmd.label,
					output: output.slice(0, 4000),
				});
			},
		);
	});
}

// ---------------------------------------------------------------------------
// Board file contract (shared with verifier-board and orchestrator)
// ---------------------------------------------------------------------------

// Cross-extension pending marker. Other board readers fail closed while a run is active.
// REL-5: each run writes its own .pi/verify-pending/<run>.json and removes only that file,
// so the first of two overlapping runs (another session, or /verify beside the turn_end
// check) cannot clear the marker while the other is still running. The legacy flat
// .pi/verify-pending.json is still read, so a marker from an older build keeps blocking.
function pendingMarkerPath(cwd: string): string {
	return path.join(cwd, ".pi", "verify-pending.json");
}
function pendingRunDir(cwd: string): string {
	return path.join(cwd, ".pi", "verify-pending");
}
function pendingRunFiles(cwd: string): string[] {
	try {
		const dir = pendingRunDir(cwd);
		return fs
			.readdirSync(dir)
			.filter((name) => name.endsWith(".json"))
			.map((name) => path.join(dir, name));
	} catch {
		return [];
	}
}

// A verify run is normally seconds to minutes; a marker older than this is a crash
// leftover (SIGKILL / process death skips the finally that clears it) and must not
// block mission completion forever. Consumers read markers through
// isVerifyPendingActive so the TTL is applied in one place.
const DEFAULT_VERIFY_PENDING_TTL_MS = 30 * 60 * 1000;
function verifyPendingTtlMs(): number {
	const n = Number(process.env.PI_KIT_VERIFY_PENDING_TTL_MS);
	return Number.isFinite(n) && n > 0
		? Math.floor(n)
		: DEFAULT_VERIFY_PENDING_TTL_MS;
}

/**
 * True when a verify run is genuinely in flight: a marker (the legacy flat file or
 * any per-run file) exists and is younger than the TTL. A missing, unreadable,
 * malformed, or stale marker is not active.
 * Exported so orchestrator/conductor's local pending checks can call it instead of
 * testing the file's bare existence.
 */
export function isVerifyPendingActive(cwd: string): boolean {
	return [pendingMarkerPath(cwd), ...pendingRunFiles(cwd)].some(isFreshPendingFile);
}

function isFreshPendingFile(file: string): boolean {
	try {
		const raw = fs.readFileSync(file, "utf8");
		const marker: unknown = JSON.parse(raw);
		// Date.parse converts a non-string argument with String() itself, so converting here
		// reads every value exactly as before while the parsed field stays `unknown`.
		const value: unknown = isRecord(marker) ? (marker.startedAt ?? "") : "";
		let startedAt = Date.parse(String(value));
		// Fall back to the file's own mtime when the payload is malformed, so a corrupt
		// crash leftover still ages out instead of blocking forever.
		if (Number.isNaN(startedAt)) startedAt = fs.statSync(file).mtimeMs;
		return Date.now() - startedAt <= verifyPendingTtlMs();
	} catch {
		return false;
	}
}

/** Back-compat alias; prefer isVerifyPendingActive. */
export function isVerifyPending(cwd: string): boolean {
	return isVerifyPendingActive(cwd);
}

/** Writes this run's own pending marker and returns its path, for clearVerifyPending. */
function setVerifyPending(cwd: string): string {
	const file = path.join(
		pendingRunDir(cwd),
		`${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.json`,
	);
	try {
		createFileExclusive(
			file,
			JSON.stringify({ startedAt: new Date().toISOString() }),
			{ root: cwd },
		);
	} catch {
		/* best effort */
	}
	return file;
}

function clearVerifyPending(file: string): void {
	try {
		fs.rmSync(file, { force: true });
	} catch {
		/* best effort */
	}
}

// Removes crash leftovers only: the legacy flat marker and run markers past the TTL. A
// marker that is still fresh may belong to another session's live run and is kept.
function pruneStalePending(cwd: string): void {
	for (const file of [pendingMarkerPath(cwd), ...pendingRunFiles(cwd)])
		if (fs.existsSync(file) && !isFreshPendingFile(file))
			clearVerifyPending(file);
}

// Atomic write: temp file + rename, so a concurrent reader never observes a
// partially-written board (writes were previously a direct writeFileSync). The board is
// workspace state, so nothing on the way is followed through a committed symlink
// (./shared/safe-fs.ts).
function writeFileAtomic(file: string, content: string, root: string): void {
	writeFileSafe(file, content, { root });
}

// The board as read from disk: verdicts other writers recorded (verifier-board, conductor's
// validator) and any other fields are written back unchanged, so they stay `unknown` here.
type BoardFile = {
	verdicts: Record<string, unknown>;
	generation?: unknown;
	[key: string]: unknown;
};

function isBoardFile(value: unknown): value is BoardFile {
	return (
		isRecord(value) &&
		// Reject null (typeof null === "object") so { verdicts: null } falls back to
		// the initialised { verdicts: {} } instead of crashing later mutations.
		isRecord(value.verdicts) &&
		!Array.isArray(value.verdicts)
	);
}

// Cross-process advisory lock around board mutations (O_EXCL lockfile + 60 s stale
// takeover, the same pattern verifier-board and task-graph use). Without it two writers
// can both read the board, apply their own verdict, and write back, silently dropping the
// other's (Area 3 F1). Lock name is shared with verifier-board and conductor's validator.
const BOARD_LOCK_STALE_MS = 60_000;
// REL-6: another writer holds the lock for milliseconds, so a busy lock is retried with a
// short bounded backoff (about 1.3 s in all) before the write is reported as failed.
const BOARD_LOCK_RETRY_DELAYS_MS = [10, 20, 40, 80, 160, 320, 640];
function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function acquireBoardLock(lock: string, root: string): number | undefined {
	for (let attempt = 0; ; attempt++) {
		const fd = openFileExclusive(lock, { root });
		if (fd !== null) return fd;
		try {
			if (Date.now() - fs.lstatSync(lock).mtimeMs > BOARD_LOCK_STALE_MS)
				fs.rmSync(lock, { force: true });
		} catch {
			/* retry below */
		}
		const delay = BOARD_LOCK_RETRY_DELAYS_MS[attempt];
		if (delay === undefined) return undefined;
		sleepSync(delay);
	}
}
function withBoardLock<T>(
	cwd: string,
	operation: () => T,
): { ok: true; value: T } | { ok: false; reason: string } {
	const lock = path.join(cwd, ".pi", "verdicts.lock");
	let fd: number | undefined;
	try {
		fd = acquireBoardLock(lock, cwd);
		if (fd === undefined)
			return { ok: false, reason: "verifier board is busy or unreadable" };
		try {
			return { ok: true, value: operation() };
		} finally {
			try {
				if (fd !== undefined) fs.closeSync(fd);
			} catch {
				/* release best effort */
			}
			try {
				fs.rmSync(lock, { force: true });
			} catch {
				/* stale lock is fail-closed */
			}
		}
	} catch {
		return { ok: false, reason: "verifier board is unavailable" };
	}
}

function updateBoard(cwd: string, mutate: (board: BoardFile) => void): void {
	const file = path.join(cwd, ".pi", "verdicts.json");
	let board: BoardFile = { verdicts: {} };
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
		if (isBoardFile(parsed)) board = parsed;
	} catch {
		/* fresh board */
	}
	mutate(board);
	// Monotonic generation counter (AG-04: "atomically persist verdict generations") —
	// a cheap, always-available freshness signal every consumer can compare against,
	// independent of wall-clock skew. A value that is not a number (a hand-edited board)
	// restarts the count: `"7" + 1` would concatenate to "71".
	board.generation =
		(typeof board.generation === "number" ? board.generation : 0) + 1;
	writeFileAtomic(file, JSON.stringify(board, null, 2), cwd);
}

// Auto-wire record_verdict (Epic 4 Sprint 4.1): verify-gate writes its own result to the
// verifier-board's .pi/verdicts.json instead of relying on the model to call record_verdict.
// Same file contract as verifier-board (self-containment forbids importing it). Exported so
// the eval harness can exercise it directly. Returns null when the verdict was written, or
// the reason it was not, so callers can report a lost write (REL-6) instead of only logging it.
export function recordVerifyVerdict(
	cwd: string,
	source: string,
	pass: boolean,
	summary: string,
	stale = false,
): string | null {
	try {
		const locked = withBoardLock(cwd, () => {
			updateBoard(cwd, (board) => {
				board.verdicts[source] = stale
					? staleVerdict()
					: {
							pass,
							summary: summary.slice(0, 200),
							at: new Date().toISOString(),
						};
			});
		});
		if (!locked.ok) throw new Error(locked.reason);
		return null;
	} catch (error) {
		// Never let verdict bookkeeping crash verify itself, but don't go fully
		// silent either — a swallowed write failure here is exactly how a verdict silently
		// fails to persist.
		const message = `failed to record verdict for '${source}' (${pass ? "PASS" : "FAIL"}): ${error instanceof Error ? error.message : String(error)}`;
		console.error(`[verify-gate] ${message}`);
		return message;
	}
}

function removeVerdict(cwd: string, source: string): string | null {
	try {
		const locked = withBoardLock(cwd, () => {
			updateBoard(cwd, (board) => {
				board.verdicts = Object.fromEntries(
					Object.entries(board.verdicts).filter(([key]) => key !== source),
				);
			});
		});
		if (!locked.ok) throw new Error(locked.reason);
		return null;
	} catch (error) {
		const message = `failed to remove verdict '${source}': ${error instanceof Error ? error.message : String(error)}`;
		console.error(`[verify-gate] ${message}`);
		return message;
	}
}

// REL-6 (staleness half): a recorded verify/review PASS describes the workspace as it was
// when verification ran. A later successful `write` or `edit` tool result in this process
// makes that PASS stale, so it is turned into a FAIL ("stale") and completion stays blocked
// until verification runs again. A PASS that a run is about to record is checked against the
// edit count taken when that run started (VerificationOptions.editCount), so an edit made while
// the run is in progress also leaves a stale FAIL. Known limitation: a `bash` tool result
// (sed -i, git checkout, a formatter) and edits by another process are not seen as edits.
// Returns null when nothing needed changing or the board was updated, else the reason.
const VERIFY_GATE_SOURCES = ["verify", "review"];
function staleVerdict(): Record<string, unknown> {
	return {
		pass: false,
		stale: true,
		summary: "stale: the workspace changed after this verdict; run /verify again",
		at: new Date().toISOString(),
	};
}
function passingOwnSources(board: BoardFile): string[] {
	return VERIFY_GATE_SOURCES.filter((source) => {
		const verdict = board.verdicts[source];
		return isRecord(verdict) && verdict.pass === true;
	});
}
export function invalidateVerdictsAfterEdit(cwd: string): string | null {
	const file = path.join(cwd, ".pi", "verdicts.json");
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
		if (!isBoardFile(parsed) || passingOwnSources(parsed).length === 0)
			return null;
	} catch {
		return null; // no board: nothing recorded, completion already fails closed
	}
	try {
		const locked = withBoardLock(cwd, () => {
			updateBoard(cwd, (board) => {
				for (const source of passingOwnSources(board))
					board.verdicts[source] = staleVerdict();
			});
		});
		if (!locked.ok) throw new Error(locked.reason);
		return null;
	} catch (error) {
		const message = `failed to mark verdicts stale after an edit: ${error instanceof Error ? error.message : String(error)}`;
		console.error(`[verify-gate] ${message}`);
		return message;
	}
}

function firstLine(output: string): string {
	const lines = output
		.split(/\r?\n/)
		.filter((line) => line.trim() && !line.trim().startsWith(">"));
	const line =
		lines.find((line) => /error|fail|assert/i.test(line)) || lines[0];
	return (line || "verify run").slice(0, 200);
}

// ---------------------------------------------------------------------------
// Definition of done
// ---------------------------------------------------------------------------

export type DoneContext = {
	goal?: string | undefined;
	todos: Array<{ id: number; text: string; done: boolean }>;
	tasks: Array<{ id: string; title: string; status: string }>;
	requests: string[];
	focus?: string | undefined;
	changes?: string | undefined;
};

function readGoal(cwd: string): string | undefined {
	try {
		const raw = fs.readFileSync(path.join(cwd, ".pi", "GOAL.yaml"), "utf8");
		return (raw.match(/^goal:\s*(.*)$/m)?.[1] ?? raw).trim() || undefined;
	} catch {
		return undefined;
	}
}

// The session's todo list (per-session file; see vendor/todo/todo-file.ts).
function readTodos(cwd: string, sessionId?: string): DoneContext["todos"] {
	try {
		return readTodoFile(todoFilePath(cwd, sessionId)).todos.map((t) => ({
			id: t.id,
			text: t.text.trim(),
			done: t.state === "done",
		}));
	} catch {
		return [];
	}
}

function readTasks(cwd: string): DoneContext["tasks"] {
	try {
		const graph: unknown = JSON.parse(
			fs.readFileSync(path.join(cwd, ".pi", "task-graph.json"), "utf8"),
		);
		const tasks: unknown = isRecord(graph) ? graph.tasks : undefined;
		if (!isArray(tasks)) return [];
		return tasks
			.filter(
				(t): t is Record<string, unknown> & { id: string; title: string } =>
					isRecord(t) && typeof t.id === "string" && typeof t.title === "string",
			)
			.map((t) => ({
				id: t.id,
				title: t.title,
				status: typeof t.status === "string" ? t.status : "unknown",
			}));
	} catch {
		return [];
	}
}

function recentRequests(entries: unknown, limit = 5): string[] {
	if (!isArray(entries)) return [];
	const out: string[] = [];
	for (let i = entries.length - 1; i >= 0 && out.length < limit; i--) {
		const entry = entries[i];
		const msg = isRecord(entry) ? entry.message : undefined;
		if (
			!isRecord(entry) ||
			entry.type !== "message" ||
			!isRecord(msg) ||
			msg.role !== "user"
		)
			continue;
		const content = msg.content;
		const text =
			typeof content === "string"
				? content
				: isArray(content)
					? content
							.filter(
								(c): c is Record<string, unknown> =>
									isRecord(c) && c.type === "text",
							)
							.map((c) => c.text)
							.join("\n")
					: "";
		const clean = text.trim();
		// Slash commands and extension diagnostics are not task requests.
		if (!clean || clean.startsWith("/") || clean.startsWith("[")) continue;
		out.unshift(clean.length > 800 ? `${clean.slice(0, 800)} …` : clean);
	}
	return out;
}

function git(cwd: string, args: string[]): Promise<string> {
	return new Promise((resolve) => {
		execFile(
			"git",
			args,
			{ cwd, timeout: 15_000, maxBuffer: 1024 * 1024, windowsHide: true },
			(err, stdout) => resolve(err ? "" : stdout.trim()),
		);
	});
}

async function changeSummary(cwd: string): Promise<string | undefined> {
	const status = await git(cwd, ["status", "--short"]);
	const stat = await git(cwd, ["diff", "--stat", "HEAD"]);
	const parts = [
		status && `git status --short:\n${status.slice(0, 3000)}`,
		stat && `git diff --stat HEAD:\n${stat.slice(0, 3000)}`,
	].filter(Boolean);
	return parts.length ? parts.join("\n\n") : undefined;
}

export async function collectDoneContext(
	cwd: string,
	entries?: unknown,
	focus?: string,
	sessionId?: string,
): Promise<DoneContext> {
	return {
		goal: readGoal(cwd),
		todos: readTodos(cwd, sessionId),
		tasks: readTasks(cwd),
		requests: recentRequests(entries),
		focus: focus?.trim() || undefined,
		changes: await changeSummary(cwd),
	};
}

export function hasDefinitionOfDone(done: DoneContext): boolean {
	return Boolean(
		done.goal ||
			done.focus ||
			done.todos.length ||
			done.tasks.length ||
			done.requests.length,
	);
}

// ---------------------------------------------------------------------------
// Reviewer
// ---------------------------------------------------------------------------

export const REVIEWER_PROMPT = [
	"You are an independent completion reviewer. You check whether the work meets its goal.",
	"You did not do the work. Do not trust claims that the work is done. Check the evidence yourself.",
	"Use only the read, grep, find, and ls tools. Do not change any file.",
	"",
	"Procedure:",
	"1. Make a list of acceptance criteria from the definition of done in the task. Include every todo and every task-graph item.",
	"2. For each criterion, look for evidence in the repository and in the check output.",
	"3. Mark a criterion PASS only when you found evidence. Mark it FAIL when the evidence shows it is not done or is wrong. Mark it UNKNOWN when you cannot find evidence.",
	"4. An unchecked todo or an open task is FAIL unless you found evidence that the work is done. Say so in the evidence.",
	"5. A failing check command is a FAIL criterion.",
	"",
	"Output exactly this format and nothing else:",
	"",
	"## Criteria",
	"- PASS | <criterion> | <evidence: file path, line, or check output>",
	"- FAIL | <criterion> | <evidence>",
	"- UNKNOWN | <criterion> | <what is missing>",
	"",
	"## Verdict",
	"PASS when every criterion is PASS. Otherwise FAIL.",
	"",
	"## Summary",
	"One to three sentences.",
	"",
	"## Next Actions",
	'- <one action for each FAIL or UNKNOWN criterion, or "none">',
].join("\n");

export function buildReviewTask(
	done: DoneContext,
	check?: CheckResult,
): string {
	const sections: string[] = ["# Definition of done"];
	if (done.focus) sections.push(`## Operator focus\n${done.focus}`);
	if (done.goal) sections.push(`## Goal\n${done.goal}`);
	if (done.requests.length)
		sections.push(
			`## Recent user requests (oldest first)\n${done.requests.map((r, i) => `${i + 1}. ${r}`).join("\n")}`,
		);
	if (done.todos.length)
		sections.push(
			`## Todo list\n${done.todos.map((t) => `- [${t.done ? "x" : " "}] #${t.id}: ${t.text}`).join("\n")}`,
		);
	if (done.tasks.length)
		sections.push(
			`## Task graph\n${done.tasks.map((t) => `- ${t.id} [${t.status}] ${t.title}`).join("\n")}`,
		);
	sections.push("# Evidence");
	sections.push(
		`## Changes\n${done.changes ?? "(not a git repository, or no changes detected)"}`,
	);
	if (check?.ran)
		sections.push(
			`## Check command: ${check.label} -> ${check.ok ? "PASSED" : "FAILED"}\n${check.output.slice(-3000) || "(no output)"}`,
		);
	else
		sections.push(
			"## Check command\nNone configured. Judge the criteria from the repository contents.",
		);
	return sections.join("\n\n");
}

export type ReviewCriterion = {
	status: "PASS" | "FAIL" | "UNKNOWN";
	criterion: string;
	evidence: string;
};
export type ParsedReview = {
	criteria: ReviewCriterion[];
	pass: boolean;
	summary: string;
	nextActions: string[];
};

function sections(output: string): Map<string, string> {
	const found = [
		...output.matchAll(/^##\s+(Criteria|Verdict|Summary|Next Actions)\s*$/gim),
	];
	const map = new Map<string, string>();
	for (let i = 0; i < found.length; i++) {
		const match = found[i];
		const name = match?.[1];
		if (!match || name === undefined) continue;
		const start = (match.index ?? 0) + match[0].length;
		map.set(name.toLowerCase(), output.slice(start, found[i + 1]?.index).trim());
	}
	return map;
}

function criterionStatus(
	value: string | undefined,
): ReviewCriterion["status"] | undefined {
	const status = value?.toUpperCase();
	return status === "PASS" || status === "FAIL" || status === "UNKNOWN"
		? status
		: undefined;
}

/** Strict parse. A malformed or self-contradicting review is rejected, never read as a pass. */
export function parseReviewOutput(
	output: unknown,
): { ok: true; review: ParsedReview } | { ok: false; reason: string } {
	if (typeof output !== "string" || !output.trim())
		return { ok: false, reason: "reviewer produced no output" };
	const s = sections(output);
	const criteria: ReviewCriterion[] = [];
	for (const line of (s.get("criteria") ?? "").split(/\r?\n/)) {
		const m = line.match(
			/^\s*[-*]\s*\**(PASS|FAIL|UNKNOWN)\**\s*\|\s*([^|]+?)\s*(?:\|\s*(.*))?$/i,
		);
		const status = criterionStatus(m?.[1]);
		const criterion = m?.[2];
		if (status && criterion !== undefined)
			criteria.push({
				status,
				criterion: criterion.trim(),
				evidence: (m?.[3] ?? "").trim(),
			});
	}
	if (!criteria.length)
		return { ok: false, reason: "reviewer output has no parseable criteria" };
	const verdict = (s.get("verdict") ?? "")
		.match(/\b(PASS|FAIL)\b/i)?.[1]
		?.toUpperCase();
	if (!verdict)
		return { ok: false, reason: "reviewer output has no PASS/FAIL verdict" };
	const expected = criteria.every((c) => c.status === "PASS") ? "PASS" : "FAIL";
	if (verdict !== expected)
		return {
			ok: false,
			reason: `reviewer verdict ${verdict} contradicts its criteria (expected ${expected})`,
		};
	const summary = (s.get("summary") ?? "").trim();
	const nextActions = (s.get("next actions") ?? "")
		.split(/\r?\n/)
		.map((l) => l.replace(/^\s*[-*]\s*/, "").trim())
		.filter((l) => l && l.toLowerCase() !== "none");
	return {
		ok: true,
		review: { criteria, pass: verdict === "PASS", summary, nextActions },
	};
}

export type ReviewRunResult =
	| { ok: true; output: string }
	| { ok: false; reason: string };
export type ReviewRunner = (
	cwd: string,
	task: string,
	options: { model?: string | undefined; signal?: AbortSignal | undefined },
) => Promise<ReviewRunResult>;

function envInt(name: string, fallback: number): number {
	const n = Number(process.env[name]);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** Default runner: an isolated `pi -p --mode json --no-session` child with read-only tools. */
export const runReviewerProcess: ReviewRunner = async (
	cwd,
	task,
	{ model, signal },
) => {
	let tmpDir: string | undefined;
	try {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-verify-reviewer-"));
		const promptFile = path.join(tmpDir, "reviewer.md");
		const taskFile = path.join(tmpDir, "task.md");
		createFileExclusive(promptFile, REVIEWER_PROMPT, { root: tmpDir, mode: 0o600 });
		createFileExclusive(taskFile, task, { root: tmpDir, mode: 0o600 });
		const args = [
			"--mode",
			"json",
			"-p",
			"--no-session",
			"--tools",
			REVIEW_TOOLS,
			"--append-system-prompt",
			promptFile,
		];
		if (model) args.push("--model", model);
		args.push(
			`Review the completion of the work described in the file ${taskFile}. Read that file first.`,
		);
		const cli = fileURLToPath(
			new URL(
				"./cli.js",
				import.meta.resolve("@earendil-works/pi-coding-agent"),
			),
		);
		const timeoutMs = envInt(
			"PI_KIT_VERIFY_REVIEW_TIMEOUT_MS",
			DEFAULT_REVIEW_TIMEOUT_MS,
		);

		// The reviewer reads the repository, so it must run under the same boundary as its parent:
		// delegation-guard supplies the mandatory protections and refuses the launch when it cannot.
		// The review is required verification (it runs at every effort tier), so it uses the
		// "mandatory" launch kind, which never draws on the discretionary delegation budget.
		const guard = (globalThis as Record<symbol, unknown>)[Symbol.for("pi-kit.delegation")] as
			| { prepareChild(request: Record<string, unknown>): { ok: true; args: string[]; env: Record<string, string | undefined>; slot: { attach(pid: number | undefined): void; settle(outcome: string): void } } | { ok: false; reason: string } }
			| undefined;
		if (!guard)
			return {
				ok: false,
				reason:
					"reviewer not started: the delegation-guard extension is not loaded, so the reviewer cannot be given the mandatory protections",
			};
		const prepared = guard.prepareChild({ cwd, kind: "mandatory", role: "reviewer", readOnly: true, baseEnv: { ...process.env } });
		if (!prepared.ok) return { ok: false, reason: `reviewer not started: ${prepared.reason}` };

		return await new Promise<ReviewRunResult>((resolve) => {
			const proc = spawn(process.execPath, piChildArgv(cli, [...prepared.args, ...args]), {
				cwd,
				shell: false,
				windowsHide: true,
				stdio: ["ignore", "pipe", "pipe"],
				// The child must not steer itself or start another review.
				env: {
					...prepared.env,
					[CHILD_ENV_FLAG]: "1",
					PI_KIT_INTERNAL_CHILD: "1",
					PI_KIT_ORCH_DISABLE: "1",
					PI_KIT_VERIFY_ON_TURN: "0",
				},
			});
			prepared.slot.attach(proc.pid);
			proc.once("close", () => prepared.slot.settle("closed"));
			proc.once("error", () => prepared.slot.settle("error"));
			let buffer = "";
			let stderr = "";
			let bytes = 0;
			let lastText = "";
			let killed: string | undefined;
			let escalation: ReturnType<typeof setTimeout> | undefined;
			const kill = (reason: string) => {
				if (killed) return;
				killed = reason;
				proc.kill("SIGTERM");
				escalation = setTimeout(() => proc.kill("SIGKILL"), 5000);
				escalation.unref();
			};
			const timer = setTimeout(
				() =>
					kill(
						`reviewer timed out after ${timeoutMs} ms (PI_KIT_VERIFY_REVIEW_TIMEOUT_MS)`,
					),
				timeoutMs,
			);
			timer.unref();
			const onAbort = () => kill("reviewer aborted");
			if (signal?.aborted) onAbort();
			else signal?.addEventListener("abort", onAbort, { once: true });

			const line = (raw: string) => {
				if (!raw.trim()) return;
				try {
					const event: unknown = JSON.parse(raw);
					const message = isRecord(event) && event.type === "message_end" ? event.message : undefined;
					if (isRecord(message) && message.role === "assistant") {
						const content: unknown[] = Array.isArray(message.content) ? message.content : [];
						const text = content
							.map((c) => (isRecord(c) && c.type === "text" && typeof c.text === "string" ? c.text : ""))
							.filter(Boolean)
							.join("\n");
						if (text.trim()) lastText = text;
					}
				} catch {
					/* only JSON events are trusted */
				}
			};
			const onData = (chunk: Buffer, isErr: boolean) => {
				bytes += chunk.length;
				if (bytes > REVIEW_STREAM_CAP) {
					kill(`reviewer output exceeded ${REVIEW_STREAM_CAP} bytes`);
					return;
				}
				if (isErr) {
					stderr += chunk.toString();
					return;
				}
				buffer += chunk.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				lines.forEach(line);
			};
			proc.stdout.on("data", (c: Buffer) => onData(c, false));
			proc.stderr.on("data", (c: Buffer) => onData(c, true));
			const finish = (code: number | null) => {
				clearTimeout(timer);
				if (escalation) clearTimeout(escalation);
				signal?.removeEventListener("abort", onAbort);
				if (buffer.trim()) line(buffer);
				if (killed) {
					resolve({ ok: false, reason: killed });
					return;
				}
				if (code !== 0 && !lastText) {
					resolve({
						ok: false,
						reason: stderr.trim().slice(0, 300) || `reviewer exited ${code}`,
					});
					return;
				}
				resolve(
					lastText
						? { ok: true, output: lastText }
						: { ok: false, reason: "reviewer returned no assistant text" },
				);
			};
			proc.on("close", finish);
			proc.on("error", (err) => {
				stderr += String(err);
				finish(1);
			});
		});
	} catch (error) {
		return {
			ok: false,
			reason: `reviewer launch failed: ${error instanceof Error ? error.message : String(error)}`,
		};
	} finally {
		if (tmpDir)
			try {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
	}
};

// ---------------------------------------------------------------------------
// Verification run
// ---------------------------------------------------------------------------

export type VerificationReport = {
	pass: boolean;
	check: CheckResult;
	review: { ran: true; review: ParsedReview } | { ran: false; reason: string };
	done: DoneContext;
	/** Verdict writes that failed (REL-6): the board may still show an older verdict. */
	boardErrors: string[];
	/** A write or edit happened while this run was in progress, so its PASS was recorded as stale. */
	stale: boolean;
	reportFile: string;
	text: string;
};

export type VerificationOptions = {
	focus?: string | undefined;
	entries?: unknown;
	sessionId?: string | undefined;
	model?: string | undefined;
	runner?: ReviewRunner;
	signal?: AbortSignal | undefined;
	/** Count of successful write/edit tool results so far; a change during the run makes it stale. */
	editCount?: () => number;
};

function renderReport(
	r: Omit<VerificationReport, "reportFile" | "text">,
	at: Date,
): string {
	const lines = [
		`# Verification report`,
		"",
		`- When: ${at.toISOString()}`,
		`- Result: **${r.pass ? "PASS" : "FAIL"}**`,
	];
	lines.push(
		`- Check: ${r.check.ran ? `${r.check.label} ${r.check.ok ? "passed" : "FAILED"}` : "none ran"}`,
	);
	lines.push(
		`- Review: ${r.review.ran ? (r.review.review.pass ? "PASS" : "FAIL") : `did not run (${r.review.reason})`}`,
	);
	lines.push("", "## Definition of done");
	if (r.done.focus) lines.push(`- Focus: ${r.done.focus}`);
	if (r.done.goal) lines.push(`- Goal: ${r.done.goal}`);
	if (r.done.todos.length)
		lines.push(
			`- Todos: ${r.done.todos.filter((t) => t.done).length}/${r.done.todos.length} marked done`,
		);
	if (r.done.tasks.length)
		lines.push(
			`- Tasks: ${r.done.tasks.filter((t) => t.status === "done").length}/${r.done.tasks.length} done`,
		);
	if (r.done.requests.length)
		lines.push(`- Recent requests: ${r.done.requests.length}`);
	if (r.review.ran) {
		lines.push("", "## Criteria");
		for (const c of r.review.review.criteria)
			lines.push(
				`- ${c.status} | ${c.criterion}${c.evidence ? ` | ${c.evidence}` : ""}`,
			);
		if (r.review.review.summary)
			lines.push("", "## Summary", r.review.review.summary);
		if (r.review.review.nextActions.length)
			lines.push(
				"",
				"## Next actions",
				...r.review.review.nextActions.map((a) => `- ${a}`),
			);
	}
	if (r.stale)
		lines.push(
			"",
			"## Stale",
			"A write or edit happened while this verification ran, so its PASS was recorded as a stale FAIL. Run /verify again.",
		);
	if (r.boardErrors.length)
		lines.push(
			"",
			"## Verifier board NOT updated",
			"The board may still show an older verdict. Re-run verification once the board is free.",
			...r.boardErrors.map((e) => `- ${e}`),
		);
	if (r.check.ran && !r.check.ok)
		lines.push(
			"",
			"## Check output (tail)",
			"```",
			r.check.output.slice(-2000),
			"```",
		);
	return lines.join("\n") + "\n";
}

export async function runVerification(
	cwd: string,
	options: VerificationOptions = {},
): Promise<VerificationReport> {
	const pendingFile = setVerifyPending(cwd);
	const boardErrors: string[] = [];
	const note = (error: string | null): void => {
		if (error) boardErrors.push(error);
	};
	const editsAtStart = options.editCount?.();
	let stale = false;
	// A PASS is only recorded when no write/edit happened since this run started.
	const record = (source: string, pass: boolean, summary: string): string | null => {
		const changed =
			options.editCount !== undefined && options.editCount() !== editsAtStart;
		if (pass && changed) stale = true;
		return recordVerifyVerdict(cwd, source, pass, summary, pass && changed);
	};
	try {
		const check = await runCheck(cwd);
		if (check.ran)
			note(record(
				"verify",
				check.ok,
				check.ok ? `${check.label} passed` : firstLine(check.output),
			));

		const done = await collectDoneContext(
			cwd,
			options.entries,
			options.focus,
			options.sessionId,
		);
		let review: VerificationReport["review"];
		if (process.env.PI_KIT_VERIFY_REVIEW === "0")
			review = {
				ran: false,
				reason: "review disabled (PI_KIT_VERIFY_REVIEW=0)",
			};
		else if (!options.runner && !options.model)
			review = { ran: false, reason: "no model selected for the reviewer" };
		else if (!hasDefinitionOfDone(done))
			review = {
				ran: false,
				reason: "no goal, todos, tasks, requests, or focus to review against",
			};
		else {
			const run = await (options.runner ?? runReviewerProcess)(
				cwd,
				buildReviewTask(done, check),
				{ model: options.model, signal: options.signal },
			);
			if (!run.ok) review = { ran: false, reason: run.reason };
			else {
				const parsed = parseReviewOutput(run.output);
				review = parsed.ok
					? { ran: true, review: parsed.review }
					: { ran: false, reason: parsed.reason };
			}
		}

		if (review.ran) {
			const r = review.review;
			const failing = r.criteria.filter((c) => c.status !== "PASS");
			const summary = r.pass
				? `${r.criteria.length}/${r.criteria.length} criteria met${r.summary ? `: ${r.summary}` : ""}`
				: `${failing.length} of ${r.criteria.length} criteria not met: ${failing.map((c) => `${c.status} ${c.criterion}`).join("; ")}`;
			note(record("review", r.pass, summary));
		} else {
			note(record(
				"review",
				false,
				`review did not run: ${review.reason}`,
			));
		}

		if (!check.ran) {
			// Fail closed when nothing at all was checked. When a real review ran, a
			// missing check command is not a failure, so drop any stale check verdict.
			if (review.ran) note(removeVerdict(cwd, "verify"));
			else
				note(record(
					"verify",
					false,
					`${check.output} — nothing was checked (reviewer: ${review.reason})`,
				));
		}

		const pass =
			!stale && (!check.ran || check.ok) && review.ran && review.review.pass;
		const at = new Date();
		const base = { pass, check, review, done, boardErrors, stale };
		const reportFile = path.join(cwd, ".pi", "verify-report.md");
		const report = renderReport(base, at);
		try {
			writeFileAtomic(reportFile, report, cwd);
		} catch {
			/* the board still carries the verdicts */
		}
		return { ...base, reportFile, text: report };
	} finally {
		clearVerifyPending(pendingFile);
	}
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

function modelId(ctx: Pick<ExtensionContext, "model">): string | undefined {
	const override = process.env.PI_KIT_VERIFY_REVIEW_MODEL?.trim();
	if (override) return override;
	const m = ctx?.model;
	return m?.provider && m?.id ? `${m.provider}/${m.id}` : undefined;
}

function shortResult(report: VerificationReport): string {
	const head = `verify: ${report.pass ? "PASS" : "FAIL"}`;
	const check = report.check.ran
		? `check ${report.check.ok ? "passed" : "FAILED"} (${report.check.label})`
		: "no check command";
	const review = report.review.ran
		? `review ${report.review.review.pass ? "PASS" : "FAIL"} (${report.review.review.criteria.filter((c) => c.status === "PASS").length}/${report.review.review.criteria.length} criteria)`
		: `review did not run: ${report.review.reason}`;
	const board = report.boardErrors.length
		? `\nverifier board NOT updated: ${report.boardErrors.join("; ")}`
		: "";
	return `${head}\n${check}\n${review}${board}\nreport: ${report.reportFile}`;
}

export default function (pi: ExtensionAPI) {
	let projectCwd = "";
	let dirty = false;
	let editCount = 0;
	const edits = (): number => editCount;
	let correctionSent = false;
	let running = false;
	const isReviewerChild = process.env[CHILD_ENV_FLAG] === "1";

	pi.on("session_start", async (_event, ctx) => {
		projectCwd = ctx.cwd;
		// A marker left by a crashed/SIGKILLed prior session is stale — clear it so it
		// cannot permanently block completion. A genuinely active run is left alone.
		pruneStalePending(ctx.cwd);
		dirty = false;
		correctionSent = false;
	});

	pi.on("input", async (event) => {
		if (event.source !== "extension") correctionSent = false;
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.isError || !["write", "edit"].includes(event.toolName)) return;
		dirty = true;
		editCount++;
		const lost = invalidateVerdictsAfterEdit(projectCwd || ctx?.cwd || "");
		if (lost) ctx?.ui?.notify?.(`verify: ${lost}`, "error");
	});

	pi.registerCommand("verify", {
		description:
			"Check that the goal, todos, and requests are done: runs the project check (if any) and an independent read-only reviewer. /verify [focus]",
		handler: async (args, ctx) => {
			const cwd = projectCwd || ctx.cwd;
			if (running) {
				ctx.ui?.notify?.(
					"verify: a verification is already running",
					"warning",
				);
				return;
			}
			running = true;
			ctx.ui?.setStatus?.(STATUS_KEY, "running…");
			const job = (async () => {
				try {
					const report = await runVerification(cwd, {
						focus: args,
						entries: ctx.sessionManager?.getBranch?.(),
						model: isReviewerChild ? undefined : modelId(ctx),
						sessionId: resolveSessionId(ctx.sessionManager),
						editCount: edits,
					});
					ctx.ui?.setStatus?.(STATUS_KEY, report.pass ? "pass" : "FAIL");
					ctx.ui?.notify?.(shortResult(report), report.pass ? "info" : "error");
				} catch (error) {
					ctx.ui?.setStatus?.(STATUS_KEY, "error");
					ctx.ui?.notify?.(
						`verify: error - ${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
				} finally {
					running = false;
				}
			})();
			// The reviewer can take minutes. In interactive mode, do not hold the prompt.
			if (ctx.hasUI)
				ctx.ui?.notify?.(
					"verify: running the check and the reviewer in the background",
					"info",
				);
			else await job;
		},
	});

	if (!isReviewerChild) {
		pi.registerTool({
			name: "verify_completion",
			label: "Verify: completion review",
			description:
				"Run an independent check that the task is done. It runs the project check command if one exists, then a read-only reviewer that compares the repository against the goal, todo list, task graph, and recent user requests. Use it before you report that the work is complete. It records the result on the verifier board.",
			parameters: Type.Object({
				focus: Type.Optional(
					Type.String({
						description:
							"The acceptance criteria or scope to check. Leave empty to use the goal, todos, and recent requests.",
					}),
				),
			}),
			async execute(_id, params, signal, _onUpdate, ctx) {
				const cwd = projectCwd || ctx.cwd;
				if (running)
					return {
						content: [
							{
								type: "text" as const,
								text: "verify_completion: a verification is already running. Wait for it, then call verdict_status.",
							},
						],
						details: undefined,
					};
				running = true;
				try {
					const report = await runVerification(cwd, {
						focus: params.focus,
						entries: ctx.sessionManager?.getBranch?.(),
						model: modelId(ctx),
						signal,
						sessionId: resolveSessionId(ctx.sessionManager),
						editCount: edits,
					});
					return {
						content: [{ type: "text" as const, text: report.text }],
						details: undefined,
					};
				} finally {
					running = false;
				}
			},
		});
	}

	pi.on("turn_end", async (event, ctx) => {
		if (process.env.PI_KIT_VERIFY_ON_TURN !== "1") return;
		if (!dirty) return;
		// Wait until the assistant has finished its tool sequence. Running checks
		// between reads/edits sees incomplete work and can steer the model mid-task.
		if (
			event.message?.role !== "assistant" ||
			event.message.stopReason !== "stop"
		)
			return;
		dirty = false;
		const cwd = projectCwd || ctx.cwd;

		if (!checkCommand(cwd)) {
			ctx.ui.setStatus(STATUS_KEY, "no script");
			// Auto mode only applies when a check command can be resolved: a package.json
			// "verify" script or an explicit PI_KIT_VERIFY_CMD override (Area 3 F6).
			// Explicit /verify still records FAIL when nothing can be checked.
			return;
		}

		ctx.ui.setStatus(STATUS_KEY, "running…");
		const pendingFile = setVerifyPending(cwd);
		const editsAtStart = editCount;
		try {
			const { ok, output, label } = await runCheck(cwd, true);
			const stale = ok && editCount !== editsAtStart;
			ctx.ui.setStatus(STATUS_KEY, stale ? "stale" : ok ? "pass" : "FAIL");
			const boardError = recordVerifyVerdict(
				cwd,
				"verify",
				ok,
				ok ? `${label} passed` : firstLine(output),
				stale,
			);
			// REL-6: a lost write leaves the previous verdict on the board; say so.
			if (boardError)
				ctx.ui.notify(
					`verify: ${boardError}. The verifier board may still show an older verdict.`,
					"error",
				);
			// The verifier owns automatic run results in either extension load order.
			// Orchestrator defers its board diagnostic for these dirty final turns.
			if (!ok && !correctionSent) {
				correctionSent = true;
				pi.sendMessage(
					{
						customType: "verify-gate-result",
						display: true,
						content: `[verify-gate diagnostic] ${label} failed after your edits:\n${output.slice(0, 1500)}\nFix the reported failure if possible; otherwise report the blocker. Do not fabricate verification results.`,
					},
					{ triggerTurn: true, deliverAs: "followUp" },
				);
			}
		} finally {
			clearVerifyPending(pendingFile);
		}
	});
}
