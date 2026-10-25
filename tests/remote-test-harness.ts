// Shared helpers for the remote host tests (not a test itself).
//
// startRemoteHost() runs the REAL packages/web-ui/server/remote-host.ts as a child process in a
// sandbox (temp HOME, agent dir, sessions dir, state dir), bound to loopback on an ephemeral
// port, with a stub executable standing in for `pi --mode rpc`. PhoneClient does what the
// Android app does: an EC P-256 key, certificate pinning, pairing, signed-challenge login,
// bearer-token API calls and event streams. ControlClient speaks the loopback control channel
// as the remote-control extension does. Nothing leaves 127.0.0.1.
import { type ChildProcessByStdio, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import type http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import type { Readable } from "node:stream";
import type tls from "node:tls";
import { pathToFileURL } from "node:url";
import { type ExitResult, type Sandbox, REPO, baseEnv, makeSandbox } from "./web-ui-test-harness.ts";

export const REMOTE_HOST_JS = path.join(REPO, "packages", "web-ui", "server", "remote-host.ts");
/** Preloaded into a test host: the pids it treats as the operator's terminal (remote-terminal-preload.ts). */
export const TERMINAL_PRELOAD = path.join(REPO, "tests", "remote-terminal-preload.ts");

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

/** A web-ui sandbox plus the remote host's state directory (PI_REMOTE_STATE_DIR). */
export interface RemoteSandbox extends Sandbox {
	stateDir: string;
}

export function makeRemoteSandbox(prefix = "pi-remote-"): RemoteSandbox {
	const sandbox = makeSandbox(prefix);
	fs.writeFileSync(sandbox.stub, STUB_SOURCE, { mode: 0o755 });
	const remote: RemoteSandbox = Object.assign(sandbox, { stateDir: path.join(sandbox.root, "remote-state") });
	return remote;
}

/** The HTTPS listener section of control.json. */
export interface ControlHttpsInfo {
	bind: string;
	bindMode: string;
	port: number;
	addresses: string[];
}

/** control.json, as remote-host.ts writes it while running. */
export interface ControlInfo {
	version: number;
	pid: number;
	/** Loopback control channel port. */
	port: number;
	/** Control channel secret (sent in the hello). */
	secret: string;
	https: ControlHttpsInfo;
	fingerprint: string;
	serverId: string;
	name: string;
	startedAt: string;
}

export function readControl(sandbox: RemoteSandbox): ControlInfo | null {
	try {
		return JSON.parse(fs.readFileSync(path.join(sandbox.stateDir, "control.json"), "utf8")) as ControlInfo;
	} catch {
		return null;
	}
}

export interface StartRemoteHostOptions {
	/** Extra environment on top of baseEnv() and the PI_REMOTE_* defaults. */
	env?: NodeJS.ProcessEnv;
	/**
	 * Processes the host treats as the operator's interactive terminal when they approve a phone
	 * (default: this test process). Any other process is judged for real (remote/peer.ts).
	 */
	terminalPids?: readonly number[];
}

/** A running remote-host.ts child. */
export interface RemoteHostHandle {
	child: ChildProcessByStdio<null, Readable, Readable>;
	control: ControlInfo;
	/** The HTTPS port (control.https.port). */
	port: number;
	fingerprint: string;
	/** Combined stdout and stderr so far. */
	output(): string;
	exited: Promise<ExitResult>;
	/** SIGTERM the host; resolves with the exit or "timeout" after 10 s (no SIGKILL). */
	stop(): Promise<ExitResult | "timeout">;
}

/** Start remote-host.ts; resolves once control.json names a live control port. */
export async function startRemoteHost(sandbox: RemoteSandbox, { env = {}, terminalPids = [process.pid] }: StartRemoteHostOptions = {}): Promise<RemoteHostHandle> {
	const child = spawn(process.execPath, ["--import", pathToFileURL(TERMINAL_PRELOAD).href, REMOTE_HOST_JS], {
		cwd: sandbox.cwd,
		env: baseEnv(sandbox, { PI_REMOTE_STATE_DIR: sandbox.stateDir, PI_REMOTE_BIND: "loopback", PI_REMOTE_PORT: "0", PI_REMOTE_NAME: "test-box", PI_REMOTE_TEST_TERMINAL_PIDS: terminalPids.join(","), ...env }),
		stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (c: string) => (output += c));
	child.stderr.on("data", (c: string) => (output += c));
	const exited = new Promise<ExitResult>((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
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
				async stop(): Promise<ExitResult | "timeout"> {
					if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
					return Promise.race([exited, new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 10_000))]);
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
/** A line on the control channel: a hello reply, a `res` to a request, or a pushed event. */
export interface ControlMessage {
	t?: string;
	id?: string;
	ok?: boolean;
	data?: unknown;
	error?: string;
	status?: number;
	[key: string]: unknown;
}

/** A failed control request: the host's error message plus its HTTP-like status. */
export interface ControlRequestError extends Error {
	status?: number;
}

interface PendingRequest {
	resolve: (data: unknown) => void;
	reject: (error: ControlRequestError) => void;
}

export interface ControlConnectOptions {
	/** Secret to present (default: the one in control.json). */
	secret?: string;
}

export class ControlClient {
	// Assigned in open(); `declare` keeps them out of the emitted class (no field initialisers).
	declare pending: Map<string, PendingRequest>;
	/** Every non-response message received, in order. */
	declare events: ControlMessage[];
	declare listeners: Set<(msg: ControlMessage) => void>;
	declare nextId: number;
	declare closed: boolean;
	declare socket: net.Socket;

	static async connect(control: Pick<ControlInfo, "port" | "secret">, role = "admin", { secret = control.secret }: ControlConnectOptions = {}): Promise<ControlClient> {
		const client = new ControlClient();
		await client.open(control.port, role, secret);
		return client;
	}

	open(port: number, role: string, secret: string): Promise<this> {
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
			this.socket.on("data", (chunk: string) => {
				buffer += chunk;
				let nl;
				while ((nl = buffer.indexOf("\n")) !== -1) {
					const msg = JSON.parse(buffer.slice(0, nl)) as ControlMessage;
					buffer = buffer.slice(nl + 1);
					if (!greeted) {
						greeted = true;
						if (msg.ok) resolve(this);
						else reject(new Error(msg.error || "hello refused"));
						continue;
					}
					// (An id-less "res" was never in pending, so the undefined check changes nothing.)
					const id = msg.t === "res" ? msg.id : undefined;
					const pending = id === undefined ? undefined : this.pending.get(id);
					if (id !== undefined && pending) {
						const { resolve: ok, reject: no } = pending;
						this.pending.delete(id);
						if (msg.ok) ok(msg.data);
						else {
							const error: ControlRequestError = new Error(msg.error);
							if (msg.status !== undefined) error.status = msg.status;
							no(error);
						}
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

	send(obj: Record<string, unknown>): void {
		this.socket.write(`${JSON.stringify(obj)}\n`);
	}

	/** Send a request; resolves with its `data` (`T` is the caller's expected shape), rejects with a ControlRequestError. */
	request<T = unknown>(op: string, args: Record<string, unknown> = {}): Promise<T> {
		const id = `r${this.nextId++}`;
		return new Promise<T>((resolve, reject) => {
			// The host's reply for this op carries a T; the channel itself is untyped JSON.
			this.pending.set(id, { resolve: resolve as (data: unknown) => void, reject });
			this.send({ t: "req", id, op, ...args });
		});
	}

	/** Resolve with the first message (already received or future) that matches. */
	waitFor(predicate: (msg: ControlMessage) => boolean, timeoutMs = 5000): Promise<ControlMessage> {
		const found = this.events.find(predicate);
		if (found) return Promise.resolve(found);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.listeners.delete(fn);
				reject(new Error("timed out waiting for a control message"));
			}, timeoutMs);
			const fn = (msg: ControlMessage): void => {
				if (!predicate(msg)) return;
				clearTimeout(timer);
				this.listeners.delete(fn);
				resolve(msg);
			};
			this.listeners.add(fn);
		});
	}

	close(): void {
		this.socket.destroy();
	}
}

// -------------------------------------------------------------- phone client ---
/** The fields of a pairing link (?h=&p=&f=&c=&n=). */
export interface ParsedLink {
	hosts: string[];
	port: number;
	fingerprint: string | null;
	code: string | null;
	name: string | null;
}

/** `value`, or a thrown Error naming `what` when it is null or undefined. */
function present<T>(value: T | null | undefined, what: string): T {
	if (value === null || value === undefined) throw new Error(`${what} is missing`);
	return value;
}

export function parseLink(link: string): ParsedLink {
	const url = new URL(link);
	const p = url.searchParams;
	// A link without `h` throws here, as it always has.
	return { hosts: present(p.get("h"), "the link's h parameter").split(","), port: Number(p.get("p")), fingerprint: p.get("f"), code: p.get("c"), name: p.get("n") };
}

export interface PhoneClientOptions {
	host?: string;
	port: number;
	/** The pinned certificate fingerprint (base64url SHA-256 of the DER certificate). */
	fingerprint: string;
	name?: string;
}

export interface PhoneRequestOptions {
	/** Bearer token (default: the one from the last successful login; null/empty sends none). */
	token?: string | null;
	headers?: http.OutgoingHttpHeaders;
	/** Sent verbatim instead of JSON.stringify(body). */
	rawBody?: string | Buffer;
}

/** A pinned HTTPS response; `json` is the parsed body (`T` is the caller's expected shape), or null when it is not JSON. */
export interface PhoneResponse<T = unknown> {
	status: number | undefined;
	json: T | null;
	text: string;
	headers: http.IncomingHttpHeaders;
}

export interface PairOptions {
	/** A proof to send instead of the correct one. */
	proof?: string;
	name?: string;
}

export interface LoginOptions {
	/** Fingerprint to sign into the auth payload (default: the pinned one). */
	fingerprint?: string;
	deviceId?: string | null;
}

/** The token response plus the nonce and signature that were sent; or the failed challenge response as is. */
export interface LoginResult extends PhoneResponse {
	nonce?: string;
	signature?: string;
}

interface ChallengeBody {
	serverId: string;
	nonce: string;
}

interface TokenBody {
	token: string;
}

/** One parsed SSE frame: the event name and its JSON data. */
export interface StreamFrame<T = unknown> {
	event: string;
	data: T;
}

export interface PhoneStream<T = unknown> {
	/** Every frame received so far, in order. */
	frames: StreamFrame<T>[];
	/** Resolves with the HTTP status once the response head arrives. */
	ready: Promise<number | undefined>;
	readonly closed: boolean;
	/** Resolve with the first frame (already received or future) that matches. */
	waitFor(predicate: (frame: StreamFrame<T>) => boolean, timeoutMs?: number): Promise<StreamFrame<T>>;
	close(): void;
}

export class PhoneClient {
	// Assigned in the constructor; `declare` keeps them out of the emitted class.
	declare host: string;
	declare port: number;
	declare fingerprint: string;
	declare name: string;
	declare privateKey: crypto.KeyObject;
	declare publicKeyB64: string;
	declare token: string | null;
	declare deviceId: string | null;
	declare serverId: string | null;

	constructor({ host = "127.0.0.1", port, fingerprint, name = "Test Phone" }: PhoneClientOptions) {
		Object.assign(this, { host, port, fingerprint, name });
		const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
		this.privateKey = privateKey;
		this.publicKeyB64 = publicKey.export({ type: "spki", format: "der" }).toString("base64");
		this.token = null;
		this.deviceId = null;
		this.serverId = null;
	}

	/** One HTTPS request with the certificate pinned. Resolves {status, json, text, headers}. */
	request<T = unknown>(method: string, pathName: string, body?: unknown, { token = this.token, headers = {}, rawBody }: PhoneRequestOptions = {}): Promise<PhoneResponse<T>> {
		return new Promise((resolve, reject) => {
			const payload = rawBody ?? (body === undefined ? undefined : JSON.stringify(body));
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
					// An https response's socket is a TLSSocket, and after the handshake it has the peer certificate.
					const peer = present((res.socket as tls.TLSSocket).getPeerX509Certificate(), "the peer certificate");
					const pin = crypto.createHash("sha256").update(peer.raw).digest("base64url");
					if (pin !== this.fingerprint) {
						res.destroy();
						reject(new Error("certificate pin mismatch"));
						return;
					}
					let text = "";
					res.setEncoding("utf8");
					res.on("data", (c: string) => (text += c));
					res.on("end", () => {
						let json: T | null = null;
						try {
							json = JSON.parse(text) as T;
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

	sign(payload: string): string {
		return crypto.sign("sha256", Buffer.from(payload, "utf8"), { key: this.privateKey, dsaEncoding: "der" }).toString("base64");
	}

	pairProof(code: string, fingerprint: string = this.fingerprint, name: string = this.name): string {
		return this.sign(["pirc-pair-v1", code, fingerprint, this.publicKeyB64, name].join("\n"));
	}

	async pair<T = unknown>(code: string, { proof, name = this.name }: PairOptions = {}): Promise<PhoneResponse<T>> {
		return this.request<T>("POST", "/v1/pair", {
			code,
			publicKey: this.publicKeyB64,
			name,
			platform: "android",
			proof: proof ?? this.pairProof(code.replace(/-/g, "").toUpperCase(), this.fingerprint, name),
		});
	}

	async login({ fingerprint = this.fingerprint, deviceId = this.deviceId }: LoginOptions = {}): Promise<LoginResult> {
		const challenge = await this.request<ChallengeBody>("POST", "/v1/auth/challenge", { deviceId });
		if (challenge.status !== 200) return challenge;
		// A 200 challenge always carries a JSON body (a missing one throws here, as it always has).
		const challengeBody = present(challenge.json, "the challenge body");
		this.serverId = challengeBody.serverId;
		const signature = this.sign(["pirc-auth-v1", deviceId, challengeBody.nonce, fingerprint, this.serverId].join("\n"));
		const res = await this.request<TokenBody>("POST", "/v1/auth/token", { deviceId, nonce: challengeBody.nonce, signature });
		if (res.status === 200) this.token = present(res.json, "the token body").token;
		return { ...res, nonce: challengeBody.nonce, signature };
	}

	/** Open an event stream; collects parsed frames into `frames`. */
	/** `T` is the caller's expected shape of every frame's data. */
	stream<T = unknown>(sessionId: string): PhoneStream<T> {
		const frames: StreamFrame<T>[] = [];
		const waiters = new Set<() => void>();
		let res: http.IncomingMessage | null = null;
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
		const ready = new Promise<number | undefined>((resolve, reject) => {
			req.on("response", (r) => {
				res = r;
				let buffer = "";
				r.setEncoding("utf8");
				r.on("data", (chunk: string) => {
					buffer += chunk;
					let boundary;
					while ((boundary = buffer.indexOf("\n\n")) !== -1) {
						const block = buffer.slice(0, boundary);
						buffer = buffer.slice(boundary + 2);
						let event = "message";
						const data: string[] = [];
						for (const line of block.split("\n")) {
							if (line.startsWith("event: ")) event = line.slice(7);
							else if (line.startsWith("data: ")) data.push(line.slice(6));
						}
						if (!data.length) continue;
						frames.push({ event, data: JSON.parse(data.join("\n")) as T });
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
			waitFor(predicate: (frame: StreamFrame<T>) => boolean, timeoutMs = 5000): Promise<StreamFrame<T>> {
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
			close(): void {
				req.destroy();
				res?.destroy();
			},
		};
	}
}

/** Poll `predicate` every 50 ms; resolves with its first truthy value, rejects after `timeoutMs`. */
export async function waitUntil<T>(predicate: () => T | Promise<T>, timeoutMs = 5000, label = "condition"): Promise<NonNullable<Awaited<T>>> {
	const start = Date.now();
	for (;;) {
		const value = await predicate();
		if (value) return value;
		if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
		await new Promise((r) => setTimeout(r, 50));
	}
}

export { makeRunner } from "./web-ui-test-harness.ts";
