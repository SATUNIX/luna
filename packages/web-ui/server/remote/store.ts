// store.ts — the remote host's state directory and owner-only file helpers.
//
// Layout (directory 0700, secrets 0600):
//   identity.json   server id and display name
//   tls-key.pem     TLS private key (secret)
//   tls-cert.pem    self-signed certificate (phones pin its SHA-256)
//   devices.json    linked devices: public keys, names, timestamps (no secrets, kept private)
//   control.json    loopback control port and its secret (secret), present while running
//   audit.jsonl     pairing and authentication events (kept private)
//   host.log        the detached host's stdout/stderr
//   runtime/        temp agent prompts for sessions the host starts
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Infer, isRecord, number, object, optional, parseJson, safeParse, type Schema, string } from "../../../core/lib/guard.ts";

/** Where each file of a state directory lives (see the layout above). */
export interface StatePaths {
	readonly dir: string;
	readonly identity: string;
	readonly tlsKey: string;
	readonly tlsCert: string;
	readonly devices: string;
	readonly control: string;
	readonly audit: string;
	readonly log: string;
	readonly runtime: string;
}

/**
 * The fields of control.json a local client needs to reach the running host. The host writes
 * more (https, fingerprint, serverId, name, startedAt); readers that need those parse them
 * themselves. The file is owner-only but still read as untrusted input.
 */
export const ControlFileSchema = object({
	version: optional(number()),
	pid: optional(number({ integer: true })),
	port: number({ integer: true }),
	secret: string(),
});
export type ControlFile = Infer<typeof ControlFileSchema>;

/** One audit record as read back: whatever a writer put there, plus `at`. */
export type AuditRecord = Record<string, unknown>;

export function agentDir(env: NodeJS.ProcessEnv = process.env): string {
	return env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
	return env.PI_REMOTE_STATE_DIR || path.join(agentDir(env), "remote-control");
}

export function statePaths(dir: string): StatePaths {
	return {
		dir,
		identity: path.join(dir, "identity.json"),
		tlsKey: path.join(dir, "tls-key.pem"),
		tlsCert: path.join(dir, "tls-cert.pem"),
		devices: path.join(dir, "devices.json"),
		control: path.join(dir, "control.json"),
		audit: path.join(dir, "audit.jsonl"),
		log: path.join(dir, "host.log"),
		runtime: path.join(dir, "runtime"),
	};
}

/** Create the directory owner-only, and tighten it if it already exists. */
export function ensurePrivateDir(dir: string): void {
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	if (process.platform !== "win32") {
		try {
			const mode = fs.statSync(dir).mode & 0o777;
			if (mode & 0o077) fs.chmodSync(dir, 0o700);
		} catch {
			/* best effort */
		}
	}
}

/**
 * Write `content` to `file` atomically with mode 0600: a temp file created exclusively, then
 * renamed over the target, so a reader never sees half a file and the secret is never
 * readable by others, even briefly.
 */
export function writePrivateFile(file: string, content: string | Uint8Array): void {
	const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
	fs.writeFileSync(tmp, content, { mode: 0o600, flag: "wx" });
	try {
		fs.renameSync(tmp, file);
	} catch (error) {
		fs.rmSync(tmp, { force: true });
		throw error;
	}
}

/**
 * A JSON file's top-level object or array, or `fallback` when the file is missing, unreadable,
 * not JSON or a scalar. The contents are still untrusted: validate them before use, e.g. with
 * `readJsonFileAs`.
 */
export function readJsonFile(file: string): object | null;
export function readJsonFile<F>(file: string, fallback: F): object | F;
export function readJsonFile(file: string, fallback: unknown = null): unknown {
	try {
		const value = parseJson(fs.readFileSync(file, "utf8"));
		return value && typeof value === "object" ? value : fallback;
	} catch {
		return fallback;
	}
}

/** A JSON file validated by `schema`, or null when it is missing, unreadable or does not match. */
export function readJsonFileAs<T>(file: string, schema: Schema<T>): T | null {
	const value = readJsonFile(file);
	if (value === null) return null;
	const result = safeParse(schema, value, path.basename(file));
	return result.ok ? result.value : null;
}

/** Append one JSON line to the audit log (0600). Never throws. */
export function audit(file: string, record: Readonly<Record<string, unknown>>): void {
	try {
		const line = `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`;
		fs.appendFileSync(file, line, { mode: 0o600 });
	} catch {
		/* auditing must not take the host down */
	}
}

/** The last `limit` audit records (newest last). Lines that are not a JSON object are skipped. */
export function readAudit(file: string, limit = 20): AuditRecord[] {
	try {
		const text = fs.readFileSync(file, "utf8");
		return text
			.trim()
			.split("\n")
			.slice(-limit)
			.map((line): unknown => {
				try {
					return parseJson(line);
				} catch {
					return null;
				}
			})
			.filter(isRecord);
	} catch {
		return [];
	}
}
