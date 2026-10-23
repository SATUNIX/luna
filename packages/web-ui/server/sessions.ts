// sessions.ts — read-only discovery of pi's own session files.
// The web app NEVER writes these files; pi owns their lifecycle.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { array, isRecord, object, parseJson, string, union, unknownValue } from "../../core/lib/guard.ts";
import { SESSIONS_DIR } from "./config.ts";
import { lenient } from "./json.ts";

const PREVIEW_LEN = 160;

/** One pi session file as the session list shows it. */
export interface SessionRecord {
	id: string;
	cwd: string | null;
	sessionFile: string;
	startedAt: string | null;
	endedAt: null;
	lastActivityAt: string;
	entryCount: number;
	preview: string;
}

// Session files are pi's: each field is checked on its own and dropped when it has the wrong type.
const HeaderSchema = object({
	id: lenient(string()),
	cwd: lenient(string()),
	timestamp: lenient(string()),
});
const EntrySchema = object({
	type: lenient(string()),
	message: lenient(
		object({
			role: lenient(string()),
			content: lenient(union(string(), array(unknownValue()))),
		}),
	),
});

function parseLine(line: string): unknown {
	try {
		return parseJson(line);
	} catch {
		return null;
	}
}

function parseFirstLine(text: string): unknown {
	const nl = text.indexOf("\n");
	return parseLine(nl === -1 ? text : text.slice(0, nl));
}

function summarizeMessages(text: string): { entryCount: number; preview: string } {
	// Scan entries for the first user message to use as a preview.
	const lines = text.split("\n");
	let entryCount = 0;
	let preview = "";
	for (const line of lines) {
		if (!line.trim()) continue;
		entryCount++;
		if (preview) continue;
		const obj = lenient(EntrySchema).parse(parseLine(line));
		if (obj?.type !== "message") continue;
		const msg = obj.message ?? {};
		if (msg.role !== "user") continue;
		const content = msg.content;
		if (typeof content === "string") preview = content;
		else if (content) {
			for (const part of content) {
				if (isRecord(part) && part.type === "text" && typeof part.text === "string" && part.text) {
					preview = part.text;
					break;
				}
			}
		}
	}
	return {
		entryCount,
		preview: preview.replace(/\s+/g, " ").trim().slice(0, PREVIEW_LEN),
	};
}

/** All pi session files, newest first. */
export function listSessions(): SessionRecord[] {
	const sessions: SessionRecord[] = [];
	let dirs: fs.Dirent[];
	try {
		dirs = fs
			.readdirSync(SESSIONS_DIR, { withFileTypes: true })
			.filter((d) => d.isDirectory());
	} catch {
		return sessions;
	}
	for (const dir of dirs) {
		const dirPath = path.join(SESSIONS_DIR, dir.name);
		let files: string[];
		try {
			files = fs.readdirSync(dirPath).filter((f) => f.endsWith(".jsonl"));
		} catch {
			continue;
		}
		for (const file of files) {
			const filePath = path.join(dirPath, file);
			try {
				// One open file: the stat and the text describe the same file.
				let stat: fs.Stats;
				let text: string;
				const fd = fs.openSync(filePath, "r");
				try {
					stat = fs.fstatSync(fd);
					text = fs.readFileSync(fd, "utf8");
				} finally {
					fs.closeSync(fd);
				}
				const head = lenient(HeaderSchema).parse(parseFirstLine(text)) ?? {};
				const { entryCount, preview } = summarizeMessages(text);
				sessions.push({
					id: head.id || path.basename(file, ".jsonl"),
					cwd: head.cwd || null,
					sessionFile: filePath,
					startedAt: head.timestamp || null,
					endedAt: null,
					lastActivityAt: stat.mtime.toISOString(),
					entryCount,
					preview,
				});
			} catch {
				// unreadable file — skip
			}
		}
	}
	sessions.sort((a, b) =>
		b.lastActivityAt.localeCompare(a.lastActivityAt),
	);
	return sessions;
}

/** Distinct working directories seen in session records (plus the home dir). */
export function listCwds(): string[] {
	const set = new Set<string>();
	for (const s of listSessions()) {
		if (s.cwd) set.add(s.cwd);
	}
	set.add(os.homedir());
	return [...set].sort();
}
