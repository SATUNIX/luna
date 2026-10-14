// Shared helpers for the remote host tests (not a test itself).
//
// startRemoteHost() runs the REAL packages/web-ui/server/remote-host.js as a child process in a
// sandbox (temp HOME, agent dir, sessions dir, state dir), bound to loopback on an ephemeral
// port, with a stub executable standing in for `pi --mode rpc`. PhoneClient does what the
// Android app does: an EC P-256 key, certificate pinning, pairing, signed-challenge login,
// bearer-token API calls and event streams. ControlClient speaks the loopback control channel
// as the remote-control extension does. Nothing leaves 127.0.0.1.
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import { REPO, baseEnv, makeSandbox } from "./web-ui-test-harness.mjs";

export const REMOTE_HOST_JS = path.join(REPO, "packages", "web-ui", "server", "remote-host.js");

// A stub `pi --mode rpc` that also emits session events: a streamed answer for a normal prompt,
// and an approval dialog for a prompt that says "ask".
const STUB_SOURCE = `#!/usr/bin/env node
const fs = require("node:fs");
const log = process.env.STUB_LOG;
const record = (obj) => { if (log) fs.appendFileSync(log, JSON.stringify(obj) + "\\n"); };
const out = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
record({ event: "start", pid: process.pid, argv: process.argv.slice(2), env: Object.keys(process.env).filter((k) => k.startsWith("PI_REMOTE")) });
process.on("SIGTERM", () => process.exit(0));
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\\n")) !== -1) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let cmd; try { cmd = JSON.parse(line); } catch { continue; }
    record({ event: "cmd", cmd });
    if (cmd.type === "extension_ui_response") continue;
    const data = cmd.type === "get_state" ? { sessionId: "stub-" + process.pid, sessionFile: null } : {};
    out({ type: "response", id: cmd.id, command: cmd.type, success: true, data });
    if (cmd.type === "prompt" && /ask/.test(cmd.message)) {
      out({ type: "extension_ui_request", id: "dlg-" + process.pid, method: "select", title: "Allow bash: rm -rf build?", options: ["Allow once", "Deny"] });
    } else if (cmd.type === "prompt") {
      const partial = { role: "assistant", content: [{ type: "text", text: "" }] };
      out({ type: "agent_start" });
      out({ type: "message_start", message: { role: "user", content: [{ type: "text", text: cmd.message }], timestamp: 1 } });
      out({ type: "message_end", message: { role: "user", content: [{ type: "text", text: cmd.message }], timestamp: 1 } });
      out({ type: "message_start", message: partial });
      let text = "";
      for (const piece of ["Hello", " from", " the stub"]) {
        text += piece;
        const snapshot = { role: "assistant", content: [{ type: "text", text }] };
        out({ type: "message_update", message: snapshot, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: piece, partial: snapshot } });
      }
      out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], timestamp: 2 } });
      out({ type: "agent_end", messages: [] });
      out({ type: "agent_settled" });
    }
  }
});
process.stdin.on("end", () => process.exit(0));
setInterval(() => {}, 1000);
`;

export function makeRemoteSandbox(prefix = "pi-remote-") {
	const sandbox = makeSandbox(prefix);
	fs.writeFileSync(sandbox.stub, STUB_SOURCE, { mode: 0o755 });
	sandbox.stateDir = path.join(sandbox.root, "remote-state");
	return sandbox;
}

export function readControl(sandbox) {
	try {
		return JSON.parse(fs.readFileSync(path.join(sandbox.stateDir, "control.json"), "utf8"));
	} catch {
		return null;
	}
}

/** Start remote-host.js; resolves once control.json names a live control port. */
export async function startRemoteHost(sandbox, { env = {} } = {}) {
	const child = spawn(process.execPath, [REMOTE_HOST_JS], {
		cwd: sandbox.cwd,
		env: baseEnv(sandbox, { PI_REMOTE_STATE_DIR: sandbox.stateDir, PI_REMOTE_BIND: "loopback", PI_REMOTE_PORT: "0", PI_REMOTE_NAME: "test-box", ...env }),
		stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (c) => (output += c));
	child.stderr.on("data", (c) => (output += c));
	const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
	const started = Date.now();
	for (;;) {
		const control = readControl(sandbox);
		if (control && control.pid === child.pid) {
			return {
				child,
				control,
				port: control.https.port,
				fingerprint: control.fingerprint,
				output: () => output,
				exited,
				async stop() {
					if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
					return Promise.race([exited, new Promise((r) => setTimeout(() => r("timeout"), 10_000))]);
				},
			};
		}
		if (child.exitCode !== null) throw new Error(`remote host exited early (${child.exitCode}):\n${output}`);
		if (Date.now() - started > 15_000) {
			child.kill("SIGKILL");
			throw new Error(`remote host did not start:\n${output}`);
		}
		await new Promise((r) => setTimeout(r, 50));
	}
}

// ------------------------------------------------------------ control client ---
export class ControlClient {
	static async connect(control, role = "admin", { secret = control.secret } = {}) {
		const client = new ControlClient();
		await client.open(control.port, role, secret);
		return client;
	}

	open(port, role, secret) {
		this.pending = new Map();
		this.events = [];
		this.listeners = new Set();
		this.nextId = 1;
		this.closed = false;
		return new Promise((resolve, reject) => {
			this.socket = net.connect({ host: "127.0.0.1", port });
			let buffer = "";
			let greeted = false;
			this.socket.setEncoding("utf8");
			this.socket.on("connect", () => this.send({ t: "hello", secret, role, pid: process.pid }));
			this.socket.on("data", (chunk) => {
				buffer += chunk;
				let nl;
				while ((nl = buffer.indexOf("\n")) !== -1) {
					const msg = JSON.parse(buffer.slice(0, nl));
					buffer = buffer.slice(nl + 1);
					if (!greeted) {
						greeted = true;
						if (msg.ok) resolve(this);
						else reject(new Error(msg.error || "hello refused"));
						continue;
					}
					if (msg.t === "res" && this.pending.has(msg.id)) {
						const { resolve: ok, reject: no } = this.pending.get(msg.id);
						this.pending.delete(msg.id);
						if (msg.ok) ok(msg.data);
						else no(Object.assign(new Error(msg.error), { status: msg.status }));
					} else {
						this.events.push(msg);
						for (const fn of this.listeners) fn(msg);
					}
				}
			});
			this.socket.on("close", () => {
				this.closed = true;
				if (!greeted) reject(new Error("connection closed before hello"));
			});
			this.socket.on("error", (error) => {
				if (!greeted) reject(error);
			});
		});
	}

	send(obj) {
		this.socket.write(`${JSON.stringify(obj)}\n`);
	}

	request(op, args = {}) {
		const id = `r${this.nextId++}`;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.send({ t: "req", id, op, ...args });
		});
	}

	/** Resolve with the first message (already received or future) that matches. */
	waitFor(predicate, timeoutMs = 5000) {
		const found = this.events.find(predicate);
		if (found) return Promise.resolve(found);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.listeners.delete(fn);
				reject(new Error("timed out waiting for a control message"));
			}, timeoutMs);
			const fn = (msg) => {
				if (!predicate(msg)) return;
				clearTimeout(timer);
				this.listeners.delete(fn);
				resolve(msg);
			};
			this.listeners.add(fn);
		});
	}

	close() {
		this.socket.destroy();
	}
}

// -------------------------------------------------------------- phone client ---
export function parseLink(link) {
	const url = new URL(link);
	const p = url.searchParams;
	return { hosts: p.get("h").split(","), port: Number(p.get("p")), fingerprint: p.get("f"), code: p.get("c"), name: p.get("n") };
}

export class PhoneClient {
	constructor({ host = "127.0.0.1", port, fingerprint, name = "Test Phone" }) {
		Object.assign(this, { host, port, fingerprint, name });
		const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
		this.privateKey = privateKey;
		this.publicKeyB64 = publicKey.export({ type: "spki", format: "der" }).toString("base64");
		this.token = null;
		this.deviceId = null;
		this.serverId = null;
	}

	/** One HTTPS request with the certificate pinned. Resolves {status, json, text, headers}. */
	request(method, pathName, body, { token = this.token, headers = {}, rawBody } = {}) {
		return new Promise((resolve, reject) => {
			const payload = rawBody !== undefined ? rawBody : body === undefined ? undefined : JSON.stringify(body);
			const req = https.request(
				{
					host: this.host,
					port: this.port,
					method,
					path: pathName,
					agent: false, // a fresh handshake per request, so the pin is checked every time
					rejectUnauthorized: false,
					headers: {
						...(payload !== undefined ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
						...(token ? { Authorization: `Bearer ${token}` } : {}),
						...headers,
					},
				},
				(res) => {
					const pin = crypto.createHash("sha256").update(res.socket.getPeerX509Certificate().raw).digest("base64url");
					if (pin !== this.fingerprint) {
						res.destroy();
						reject(new Error("certificate pin mismatch"));
						return;
					}
					let text = "";
					res.setEncoding("utf8");
					res.on("data", (c) => (text += c));
					res.on("end", () => {
						let json = null;
						try {
							json = JSON.parse(text);
						} catch {
							/* not JSON */
						}
						resolve({ status: res.statusCode, json, text, headers: res.headers });
					});
				},
			);
			req.on("error", reject);
			if (payload !== undefined) req.write(payload);
			req.end();
		});
	}

	sign(payload) {
		return crypto.sign("sha256", Buffer.from(payload, "utf8"), { key: this.privateKey, dsaEncoding: "der" }).toString("base64");
	}

	pairProof(code, fingerprint = this.fingerprint, name = this.name) {
		return this.sign(["pirc-pair-v1", code, fingerprint, this.publicKeyB64, name].join("\n"));
	}

	async pair(code, { proof, name = this.name } = {}) {
		return this.request("POST", "/v1/pair", {
			code,
			publicKey: this.publicKeyB64,
			name,
			platform: "android",
			proof: proof ?? this.pairProof(code.replace(/-/g, "").toUpperCase(), this.fingerprint, name),
		});
	}

	async login({ fingerprint = this.fingerprint, deviceId = this.deviceId } = {}) {
		const challenge = await this.request("POST", "/v1/auth/challenge", { deviceId });
		if (challenge.status !== 200) return challenge;
		this.serverId = challenge.json.serverId;
		const signature = this.sign(["pirc-auth-v1", deviceId, challenge.json.nonce, fingerprint, this.serverId].join("\n"));
		const res = await this.request("POST", "/v1/auth/token", { deviceId, nonce: challenge.json.nonce, signature });
		if (res.status === 200) this.token = res.json.token;
		return { ...res, nonce: challenge.json.nonce, signature };
	}

	/** Open an event stream; collects parsed frames into `frames`. */
	stream(sessionId) {
		const frames = [];
		const waiters = new Set();
		let res = null;
		let closed = false;
		const req = https.request({
			host: this.host,
			port: this.port,
			method: "GET",
			path: `/api/sessions/${encodeURIComponent(sessionId)}/events`,
			agent: false,
			rejectUnauthorized: false,
			headers: { Authorization: `Bearer ${this.token}`, Accept: "text/event-stream" },
		});
		const ready = new Promise((resolve, reject) => {
			req.on("response", (r) => {
				res = r;
				let buffer = "";
				r.setEncoding("utf8");
				r.on("data", (chunk) => {
					buffer += chunk;
					let boundary;
					while ((boundary = buffer.indexOf("\n\n")) !== -1) {
						const block = buffer.slice(0, boundary);
						buffer = buffer.slice(boundary + 2);
						let event = "message";
						const data = [];
						for (const line of block.split("\n")) {
							if (line.startsWith("event: ")) event = line.slice(7);
							else if (line.startsWith("data: ")) data.push(line.slice(6));
						}
						if (!data.length) continue;
						frames.push({ event, data: JSON.parse(data.join("\n")) });
						for (const fn of waiters) fn();
					}
				});
				r.on("end", () => {
					closed = true;
					for (const fn of waiters) fn();
				});
				resolve(r.statusCode);
			});
			req.on("error", reject);
		});
		req.end();
		return {
			frames,
			ready,
			get closed() {
				return closed;
			},
			waitFor(predicate, timeoutMs = 5000) {
				return new Promise((resolve, reject) => {
					const check = () => {
						const hit = frames.find(predicate);
						if (hit) {
							waiters.delete(check);
							clearTimeout(timer);
							resolve(hit);
						} else if (closed) {
							waiters.delete(check);
							clearTimeout(timer);
							reject(new Error("stream closed before the expected frame"));
						}
					};
					const timer = setTimeout(() => {
						waiters.delete(check);
						reject(new Error(`timed out waiting for a frame; got ${frames.map((f) => f.event).join(",")}`));
					}, timeoutMs);
					waiters.add(check);
					check();
				});
			},
			close() {
				req.destroy();
				res?.destroy();
			},
		};
	}
}

export async function waitUntil(predicate, timeoutMs = 5000, label = "condition") {
	const start = Date.now();
	for (;;) {
		const value = await predicate();
		if (value) return value;
		if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
		await new Promise((r) => setTimeout(r, 50));
	}
}

export { makeRunner } from "./web-ui-test-harness.mjs";
