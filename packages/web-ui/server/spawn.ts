// spawn.ts — manage one `pi --mode rpc` child process per session.
//
// Protocol: commands are single JSON objects written to the child's stdin, one per line
// (LF framing). The child answers with `{"type":"response",...}` records and streams
// `{"type":"<event>",...}` records on stdout. We correlate responses by an `id` field and
// fan every event out to subscribers (the SSE hub).
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { isRecord, parseJson } from "../../core/lib/guard.ts";
import { PI_BIN, RUNTIME_DIR, DEFAULT_CWD, SESSIONS_DIR } from "./config.ts";
import { agentBody, resolveAgent } from "./agents.ts";
import { HttpError, sanitizeSpawnConfig, type SpawnConfig, type StreamingBehaviour, type ThinkingLevel } from "./validate.ts";

const MAX_REPLAY_EVENTS = 500;
const RESPONSE_TIMEOUT_MS = 15000;
const KILL_GRACE_MS = 3000;

// The only pi RPC commands this server will ever write to a child. pi's RPC surface is much
// larger and includes `bash` (run a shell command directly), `switch_session` (open any path)
// and `export_html` (write to any path); the UI needs none of those, so anything else is
// refused here rather than trusted to be well-formed upstream.
export const ALLOWED_RPC_COMMANDS: ReadonlySet<string> = Object.freeze(
	new Set<RpcCommandType>([
		"prompt",
		"abort",
		"set_model",
		"set_thinking_level",
		"fork",
		"new_session",
		"get_state",
		"get_session_stats",
	]),
);

/** The commands the console writes to a child, one variant per allowlisted type. */
export type RpcCommand =
	| { type: "prompt"; message: string; streamingBehavior?: StreamingBehaviour }
	| { type: "abort" }
	| { type: "set_model"; provider?: string | undefined; modelId?: string | undefined }
	| { type: "set_thinking_level"; level: ThinkingLevel }
	| { type: "fork"; entryId?: string | undefined }
	| { type: "new_session" }
	| { type: "get_state" }
	| { type: "get_session_stats" };
export type RpcCommandType = RpcCommand["type"];

/**
 * One JSON line from the child: an object with a string `type`. Every other key is pi's and
 * arrives unchecked (`unknown`), so readers narrow each field they use.
 */
export interface PiFrame {
	readonly type: string;
	readonly [key: string]: unknown;
}

function isPiFrame(value: unknown): value is PiFrame {
	return isRecord(value) && typeof value.type === "string";
}

/** What subscribers (the SSE hub, the remote host) receive from a live session. */
export type SessionMessage =
	| { type: "event"; data: PiFrame }
	| { type: "lifecycle"; state: "error"; message: string }
	| { type: "lifecycle"; state: "exited"; code: number | null; signal: NodeJS.Signals | null; message?: string };
export type SessionEventMessage = Extract<SessionMessage, { type: "event" }>;
export type SessionSubscriber = (message: SessionMessage) => void;

/** The three answers pi accepts for an `extension_ui_request` dialog. */
export type UiAnswer = { cancelled: true } | { confirmed: boolean } | { value: string };

export interface SendOptions {
	readonly timeoutMs?: number;
}

interface PendingCommand {
	resolve: (data: unknown) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
	command: string;
}

interface ProcessOptions {
	cwd: string;
	agentFile: string | null;
	agentName: string | null;
}

// Secrets of this server that must never reach a pi child: the child (and the model driving
// it) can print its environment, which would put the console token into a session file.
const CHILD_ENV_DENYLIST = ["PI_CONSOLE_TOKEN", "PI_CONSOLE_TOKEN_FILE"];

function childEnv(): NodeJS.ProcessEnv {
	const denied = new Set(CHILD_ENV_DENYLIST);
	return Object.fromEntries(Object.entries(process.env).filter(([key]) => !denied.has(key)));
}

let registry = new Map<string, PiRpcProcess>(); // publicId -> PiRpcProcess

export class PiRpcProcess {
	readonly config: SpawnConfig;
	readonly agentName: string | null;
	agentFile: string | null;
	readonly cwd: string;
	readonly startedAt: number;
	/** The registry key until pi reports its own session id. */
	readonly localId: string;
	readonly child: ChildProcessByStdio<Writable, Readable, Readable>;
	readonly pending = new Map<string, PendingCommand>();
	readonly subscribers = new Set<SessionSubscriber>();
	/** The last MAX_REPLAY_EVENTS child events, for a viewer that attaches late. */
	readonly replay: SessionEventMessage[] = [];
	stdoutBuf = "";
	stderrBuf = "";
	nextId = 1;
	exited = false;
	exitCode: number | null = null;
	piSessionId: string | null = null;
	sessionFile: string | null = null;
	status: "running" | "exited" = "running";

	constructor(config: SpawnConfig, argv: readonly string[], { cwd, agentFile, agentName }: ProcessOptions) {
		this.config = config;
		this.agentName = agentName || null;
		this.agentFile = agentFile || null;
		this.cwd = cwd;
		this.startedAt = Date.now();
		this.localId = `local-${crypto.randomBytes(6).toString("hex")}`;

		this.child = spawn(PI_BIN, argv, {
			cwd,
			env: childEnv(),
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});

		this.child.stdout.setEncoding("utf8");
		this.child.stdout.on("data", (chunk: string) => {
			this._onStdout(chunk);
		});
		this.child.stderr.setEncoding("utf8");
		this.child.stderr.on("data", (chunk: string) => {
			this.stderrBuf = (this.stderrBuf + chunk).slice(-4000);
		});
		// A write to a child that has already gone (it exited before reading, or between our
		// `exited` check and the write) fails asynchronously with EPIPE on stdin. Without a
		// listener that is an unhandled 'error' event and takes the whole server down; with
		// one, the commands still waiting fail and the `exit` handler does the rest.
		this.child.stdin.on("error", (err: NodeJS.ErrnoException) => {
			this._failPending(new HttpError(502, `the pi process is not accepting input (${err.code ?? "write error"})`));
		});
		this.child.on("error", (err) => {
			this._emit({
				type: "lifecycle",
				state: "error",
				message: err.message,
			});
			this._failPending(new HttpError(502, "the pi process could not be started or failed"));
			this._cleanup();
		});
		this.child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
			this.exited = true;
			this.exitCode = code;
			this.status = "exited";
			this._failPending(
				new HttpError(502, `pi child exited (code=${code}, signal=${signal})`),
			);
			const stderr = this.stderrBuf.trim().slice(0, 500);
			this._emit({
				type: "lifecycle",
				state: "exited",
				code,
				signal,
				...(stderr ? { message: stderr } : {}),
			});
			this._cleanup();
		});
	}

	// ---- stdout framing -------------------------------------------------------
	_onStdout(chunk: string): void {
		this.stdoutBuf += chunk;
		let nl: number;
		while ((nl = this.stdoutBuf.indexOf("\n")) !== -1) {
			const line = this.stdoutBuf.slice(0, nl).replace(/\r$/, "");
			this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
			if (!line.trim()) continue;
			let obj: unknown;
			try {
				obj = parseJson(line);
			} catch {
				continue; // ignore non-protocol noise
			}
			// Anything that is not an object with a string `type` is noise too.
			if (!isPiFrame(obj)) continue;
			if (obj.type === "response") this._onResponse(obj);
			else this._onEvent(obj);
		}
	}

	_onResponse(obj: PiFrame): void {
		// Every id this process issues is a string ("c<n>"), so no other id can match one.
		const id = typeof obj.id === "string" ? obj.id : null;
		let entry: PendingCommand | null = null;
		const byId = id === null ? undefined : this.pending.get(id);
		if (id !== null && byId) {
			entry = byId;
			this.pending.delete(id);
		} else {
			// Fall back to the oldest pending entry for this command.
			for (const [key, value] of this.pending) {
				if (value.command === obj.command) {
					entry = value;
					this.pending.delete(key);
					break;
				}
			}
		}
		if (!entry) return;
		clearTimeout(entry.timer);
		if (obj.success === false) {
			const error = typeof obj.error === "string" && obj.error ? obj.error : `command failed: ${typeof obj.command === "string" ? obj.command : entry.command}`;
			entry.reject(new HttpError(400, error.slice(0, 500)));
		} else entry.resolve(obj.data ?? obj);
	}

	_onEvent(obj: PiFrame): void {
		this._emit({ type: "event", data: obj });
	}

	_emit(message: SessionMessage): void {
		if (message.type === "event") {
			this.replay.push(message);
			if (this.replay.length > MAX_REPLAY_EVENTS) this.replay.shift();
		}
		for (const fn of this.subscribers) {
			try {
				fn(message);
			} catch {
				/* subscriber errors must not break the loop */
			}
		}
	}

	_failPending(err: Error): void {
		for (const [, entry] of this.pending) {
			clearTimeout(entry.timer);
			entry.reject(err);
		}
		this.pending.clear();
	}

	/** Idempotent teardown: drop the temp agent prompt and deregister the proc. */
	_cleanup(): void {
		if (this.agentFile) {
			try {
				fs.unlinkSync(this.agentFile);
			} catch {
				/* already gone or never created */
			}
			this.agentFile = null;
		}
		registry.delete(this.localId);
		if (this.piSessionId) registry.delete(this.piSessionId);
	}

	// ---- command interface ----------------------------------------------------
	/** Send one RPC command; resolves with its response data. */
	send(command: RpcCommand, { timeoutMs = RESPONSE_TIMEOUT_MS }: SendOptions = {}): Promise<unknown> {
		return new Promise<unknown>((resolve, reject) => {
			// The type says RpcCommand, but this is the last gate before the child: check the
			// value itself, so nothing outside the allowlist is written whatever a caller passes.
			const raw: unknown = command;
			const type: unknown = isRecord(raw) ? raw.type : undefined;
			if (typeof type !== "string" || !ALLOWED_RPC_COMMANDS.has(type)) {
				reject(
					new HttpError(
						403,
						`rpc command not allowed: ${String(type).slice(0, 40)}`,
					),
				);
				return;
			}
			if (this.exited) {
				reject(new HttpError(409, "pi child has exited"));
				return;
			}
			const id = `c${this.nextId++}`;
			// The server-assigned id wins over anything a caller put in the command.
			const payload = { ...command, id };
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new HttpError(504, `timeout waiting for response to ${command.type}`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer, command: command.type });
			const line = `${JSON.stringify(payload)}\n`;
			try {
				this.child.stdin.write(line);
			} catch (err) {
				clearTimeout(timer);
				this.pending.delete(id);
				reject(err instanceof Error ? err : new Error(String(err)));
			}
		});
	}

	/**
	 * Answer a dialog pi opened with `extension_ui_request` (select / confirm / input / editor).
	 * This is not an RPC command: pi sends no response record, and it ignores an id it did not
	 * issue. Only the three answer shapes the protocol defines are ever written. pi-console does
	 * not call this; the remote host does, for dialogs it saw this child open.
	 */
	respondUi(id: string, answer: UiAnswer): void {
		if (this.exited) throw new HttpError(409, "pi child has exited");
		// Both arguments come from a remote request: check the values, not just the types.
		const rawId: unknown = id;
		const raw: unknown = answer;
		if (typeof rawId !== "string" || !/^[A-Za-z0-9._:-]{1,100}$/.test(rawId)) throw new HttpError(400, "invalid dialog id");
		let record: { type: "extension_ui_response"; id: string } & ({ cancelled: true } | { confirmed: boolean } | { value: string });
		if (isRecord(raw) && raw.cancelled === true) record = { type: "extension_ui_response", id: rawId, cancelled: true };
		else if (isRecord(raw) && typeof raw.confirmed === "boolean") record = { type: "extension_ui_response", id: rawId, confirmed: raw.confirmed };
		else if (isRecord(raw) && typeof raw.value === "string" && raw.value.length <= 100_000) record = { type: "extension_ui_response", id: rawId, value: raw.value };
		else throw new HttpError(400, "an answer needs value, confirmed or cancelled");
		this.child.stdin.write(`${JSON.stringify(record)}\n`);
	}

	subscribe(fn: SessionSubscriber): () => boolean {
		this.subscribers.add(fn);
		return () => this.subscribers.delete(fn);
	}

	/** Register the pi-assigned session id once known and re-key the registry. */
	setPiSessionId(id: unknown, file: unknown): void {
		// Both come from the child's output: only non-empty strings are taken.
		if (typeof id === "string" && id) this.piSessionId = id;
		if (typeof file === "string" && file) this.sessionFile = file;
		if (this.piSessionId) {
			registry.delete(this.localId);
			registry.set(this.piSessionId, this);
		}
	}

	get publicId(): string {
		return this.piSessionId || this.localId;
	}

	get alive(): boolean {
		return !this.exited;
	}

	/** SIGTERM now, SIGKILL after `graceMs` if the child is still there. */
	kill({ graceMs = KILL_GRACE_MS }: { readonly graceMs?: number } = {}): void {
		if (this.exited) return;
		try {
			this.child.kill("SIGTERM");
		} catch {
			/* ignore */
		}
		setTimeout(() => {
			if (!this.exited) {
				try {
					this.child.kill("SIGKILL");
				} catch {
					/* ignore */
				}
			}
		}, graceMs).unref();
	}

	/** Resolves once the child has exited, or after `timeoutMs` at the latest. */
	whenExited(timeoutMs: number): Promise<void> {
		return new Promise<void>((resolve) => {
			if (this.exited) {
				resolve();
				return;
			}
			const timer = setTimeout(resolve, timeoutMs);
			timer.unref();
			this.child.once("exit", () => {
				clearTimeout(timer);
				resolve();
			});
		});
	}
}

/** Build the pi argv for a spawn request. */
function buildArgv(config: SpawnConfig): string[] {
	const argv = ["--mode", "rpc"];
	if (config.resumeSessionFile) {
		// Resuming: let the session's own recorded model/thinking apply unless overridden.
		argv.push("--session", config.resumeSessionFile);
		if (config.provider) argv.push("--provider", config.provider);
		if (config.model) argv.push("--model", config.model);
		if (config.thinking) argv.push("--thinking", config.thinking);
	} else {
		if (config.provider) argv.push("--provider", config.provider);
		if (config.model) argv.push("--model", config.model);
		argv.push("--thinking", config.thinking || "medium");
	}
	// Deliberately no --session-dir: pi then uses its native <sessionDir>/<encoded-cwd>/ layout,
	// which is exactly what sessions.ts scans (so spawned sessions appear in the list).
	return argv;
}

/**
 * Spawn a new pi RPC child.
 * config: { cwd, agent, agentSource, provider, model, thinking }
 * Every field is validated (validate.ts) before it can reach argv or the filesystem.
 */
export async function createSession(input: unknown): Promise<PiRpcProcess> {
	const config = sanitizeSpawnConfig(input, { defaultCwd: DEFAULT_CWD, sessionsDir: SESSIONS_DIR });
	const cwd = config.cwd;

	const argv = buildArgv(config);
	let agentFile: string | null = null;
	let agentName: string | null = null;

	if (config.agent) {
		const agent = resolveAgent(config.agent, config.agentSource);
		if (!agent) throw new HttpError(400, `unknown agent: ${config.agent}`);
		const body = agentBody(fs.readFileSync(agent.path, "utf8"));
		fs.mkdirSync(RUNTIME_DIR, { recursive: true });
		agentFile = path.join(
			RUNTIME_DIR,
			`agent-${agent.name}-${crypto.randomBytes(4).toString("hex")}.md`,
		);
		fs.writeFileSync(agentFile, body, "utf8");
		agentName = agent.name;
		argv.push("--append-system-prompt", agentFile);
	}

	const proc = new PiRpcProcess(config, argv, { cwd, agentFile, agentName });
	registry.set(proc.localId, proc);

	// Learn the pi session id right away when possible.
	try {
		const state = await proc.send({ type: "get_state" }, { timeoutMs: 6000 });
		if (isRecord(state)) proc.setPiSessionId(state.sessionId, state.sessionFile);
	} catch {
		// get_state may not answer until the session materialises; a lazy link happens later.
	}

	proc.subscribe((msg) => {
		if (msg.type === "event" && msg.data.type === "session_meta") {
			proc.setPiSessionId(msg.data.sessionId, msg.data.sessionFile);
		}
	});

	return proc;
}

export function getSession(id: string): PiRpcProcess | null {
	const keyed = registry.get(id);
	if (keyed) return keyed;
	for (const proc of registry.values()) {
		if (proc.piSessionId === id || proc.publicId === id) return proc;
	}
	return null;
}

export function listLiveSessions(): PiRpcProcess[] {
	return [...new Set(registry.values())];
}

/**
 * Stop every child: SIGTERM, then SIGKILL after `graceMs`. Resolves when they have all
 * exited (bounded), so a shutdown never leaves a pi process behind, including one that
 * ignores SIGTERM. Temp agent-prompt files are removed even for a child that outlived the wait.
 */
export async function killAll({ graceMs = 1500 }: { readonly graceMs?: number } = {}): Promise<void> {
	const procs = listLiveSessions();
	registry = new Map();
	for (const proc of procs) proc.kill({ graceMs });
	await Promise.all(procs.map((proc) => proc.whenExited(graceMs + 1000)));
	for (const proc of procs) proc._cleanup();
}
