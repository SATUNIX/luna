// store.js — the remote host's state directory and owner-only file helpers.
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

export function agentDir(env = process.env) {
	return env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

export function stateDir(env = process.env) {
	return env.PI_REMOTE_STATE_DIR || path.join(agentDir(env), "remote-control");
}

export function statePaths(dir) {
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
export function ensurePrivateDir(dir) {
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
export function writePrivateFile(file, content) {
	const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
	fs.writeFileSync(tmp, content, { mode: 0o600, flag: "wx" });
	try {
		fs.renameSync(tmp, file);
	} catch (error) {
		fs.rmSync(tmp, { force: true });
		throw error;
	}
}

export function readJsonFile(file, fallback = null) {
	try {
		const value = JSON.parse(fs.readFileSync(file, "utf8"));
		return value && typeof value === "object" ? value : fallback;
	} catch {
		return fallback;
	}
}

/** Append one JSON line to the audit log (0600). Never throws. */
export function audit(file, record) {
	try {
		const line = `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`;
		fs.appendFileSync(file, line, { mode: 0o600 });
	} catch {
		/* auditing must not take the host down */
	}
}

/** The last `limit` audit records (newest last). */
export function readAudit(file, limit = 20) {
	try {
		const text = fs.readFileSync(file, "utf8");
		return text
			.trim()
			.split("\n")
			.slice(-limit)
			.map((line) => {
				try {
					return JSON.parse(line);
				} catch {
					return null;
				}
			})
			.filter(Boolean);
	} catch {
		return [];
	}
}
