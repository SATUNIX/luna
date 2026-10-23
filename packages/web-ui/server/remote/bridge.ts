// bridge.ts — pi sessions running in a terminal, made reachable from a phone.
//
// The `remote-control` extension, loaded in an interactive pi, opens a control connection with
// role "bridge" and registers its session. From then on it forwards that session's events
// (already slimmed) and the dialogs other extensions open, and it executes the few commands a
// phone may send: prompt, abort, set model, set thinking level, answer a dialog, and send a
// history snapshot. The host never writes the session file; the terminal's pi stays its only
// writer.
//
// Every frame from the extension is untrusted (it came over a socket): each field is checked,
// and one of the wrong type is ignored or refused, never stringified.
import { isRecord } from "../../../core/lib/guard.ts";
import type { ControlMessage } from "./control.ts";
import type { Dialog } from "./dialogs.ts";
import { slimEvent } from "./slim.ts";

const COMMAND_TIMEOUT_MS = 15_000;
const SNAPSHOT_TIMEOUT_MS = 20_000;
const REPLAY_LIMIT = 300;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const DIALOG_METHODS = ["select", "confirm", "input"] as const;
const NOTIFY_LEVELS = ["info", "warning", "error"] as const;

/** The control connection a bridge speaks over (a ControlConnection with role "bridge"). */
export interface BridgeConnection {
	send(obj: unknown): unknown;
}

/** A terminal session's details, as cleaned from the extension's registration and meta frames. */
export interface BridgeMeta {
	id: string | null;
	sessionFile: string | null;
	cwd: string | null;
	name: string | null;
	model: { provider: string | null; id: string | null } | null;
	thinking: string | null;
	busy: boolean;
	pid: number | null;
	piVersion: string | null;
	dialogs: boolean;
}

/** A terminal session as the session list and the event stream show it. */
export interface TerminalSessionSummary {
	id: string;
	cwd: string | null;
	sessionFile: string | null;
	name: string | null;
	startedAt: string;
	endedAt: null;
	lastActivityAt: string;
	status: "terminal";
	busy: boolean;
	model: BridgeMeta["model"];
	thinking: string | null;
	pendingDialogs: number;
	preview: string;
	entryCount: number;
	agent: null;
}

export type BridgeDialogMethod = (typeof DIALOG_METHODS)[number];

/** A dialog the terminal's pi opened, cleaned (every field bounded). */
export interface BridgeDialog extends Pick<Dialog, "id" | "title" | "message" | "placeholder" | "options" | "timeout" | "openedAt"> {
	method: BridgeDialogMethod;
}

export type NotifyLevel = (typeof NOTIFY_LEVELS)[number];

/** A slimmed session event: an object with a string `type`. */
export type BridgeEvent = Record<string, unknown> & { type: string };

/** What a terminal session tells its viewers. */
export type BridgeNotice =
	| { type: "event"; data: BridgeEvent; seq?: number }
	| { type: "meta"; meta: TerminalSessionSummary }
	| { type: "ui_request"; dialog: BridgeDialog }
	| { type: "ui_resolved"; id: string; by: string }
	| { type: "notify"; message: string; level: NotifyLevel }
	| { type: "lifecycle"; state: "detached"; reason: string };

export type BridgeListener = (notice: BridgeNotice) => void;

/** The commands a phone may send to a terminal session. */
export type BridgeCommandOp = "prompt" | "abort" | "set_model" | "set_thinking" | "models" | "ui_response" | "snapshot";

/** A command's fields; `t`, `id` and `op` belong to the frame and cannot be overridden. */
export interface BridgeCommandArgs {
	readonly [key: string]: unknown;
	readonly t?: never;
	readonly id?: never;
	readonly op?: never;
}

/** A command the terminal session refused or did not answer; `status` is the HTTP status to report. */
export class BridgeError extends Error {
	readonly status: number;
	constructor(message: string, status: number) {
		super(message);
		this.status = status;
	}
}

interface PendingCommand {
	readonly resolve: (data: unknown) => void;
	readonly reject: (error: BridgeError) => void;
	readonly timer: NodeJS.Timeout;
}

function cleanMeta(raw: unknown): BridgeMeta {
	const meta = isRecord(raw) ? raw : {};
	const str = (v: unknown, max = 400): string | null => (typeof v === "string" ? v.slice(0, max) : null);
	return {
		id: str(meta.id, 200),
		sessionFile: str(meta.sessionFile, 4096),
		cwd: str(meta.cwd, 4096),
		name: str(meta.name, 200),
		model: isRecord(meta.model) ? { provider: str(meta.model.provider, 200), id: str(meta.model.id, 200) } : null,
		thinking: str(meta.thinking, 20),
		busy: meta.busy === true,
		pid: typeof meta.pid === "number" && Number.isInteger(meta.pid) ? meta.pid : null,
		piVersion: str(meta.piVersion, 40),
		dialogs: meta.dialogs !== false,
	};
}

function isBridgeEvent(value: unknown): value is BridgeEvent {
	return isRecord(value) && typeof value.type === "string";
}

export class BridgeSession {
	readonly hub: BridgeHub;
	readonly conn: BridgeConnection;
	meta: BridgeMeta;
	readonly id: string;
	readonly attachedAt: string;
	lastActivityAt: string;
	readonly subscribers = new Set<BridgeListener>();
	readonly pending = new Map<string, PendingCommand>();
	readonly dialogs = new Map<string, BridgeDialog>();
	readonly replay: BridgeNotice[] = [];
	nextId = 1;
	closed = false;

	constructor(hub: BridgeHub, conn: BridgeConnection, meta: BridgeMeta & { id: string }) {
		this.hub = hub;
		this.conn = conn;
		this.meta = meta;
		this.id = meta.id;
		this.attachedAt = new Date().toISOString();
		this.lastActivityAt = this.attachedAt;
	}

	summary(): TerminalSessionSummary {
		return {
			id: this.id,
			cwd: this.meta.cwd,
			sessionFile: this.meta.sessionFile,
			name: this.meta.name,
			startedAt: this.attachedAt,
			endedAt: null,
			lastActivityAt: this.lastActivityAt,
			status: "terminal",
			busy: this.meta.busy,
			model: this.meta.model,
			thinking: this.meta.thinking,
			pendingDialogs: this.dialogs.size,
			preview: "",
			entryCount: 0,
			agent: null,
		};
	}

	emit(message: BridgeNotice): void {
		if (message.type === "event") {
			this.replay.push(message);
			if (this.replay.length > REPLAY_LIMIT) this.replay.shift();
		}
		for (const fn of this.subscribers) {
			try {
				fn(message);
			} catch {
				/* one viewer failing must not stop the others */
			}
		}
	}

	subscribe(fn: BridgeListener): () => boolean {
		this.subscribers.add(fn);
		return () => this.subscribers.delete(fn);
	}

	/** Messages from the extension for this session. */
	onMessage(msg: ControlMessage): void {
		this.lastActivityAt = new Date().toISOString();
		switch (msg.t) {
			case "event": {
				const event = slimEvent(msg.event);
				if (!isBridgeEvent(event)) return;
				// agent_end can be followed by retries or queued work; only agent_settled means idle.
				if (event.type === "agent_start") this.meta.busy = true;
				if (event.type === "agent_settled") this.meta.busy = false;
				const { seq } = msg;
				this.emit(typeof seq === "number" && Number.isInteger(seq) ? { type: "event", data: event, seq } : { type: "event", data: event });
				return;
			}
			case "meta": {
				const update = isRecord(msg.meta) ? msg.meta : {};
				const next = cleanMeta({ ...this.meta, ...update, id: this.id });
				this.meta = next;
				this.emit({ type: "meta", meta: this.summary() });
				return;
			}
			case "ui": {
				const dialog = cleanDialog(msg.dialog);
				if (!dialog) return;
				this.dialogs.set(dialog.id, dialog);
				this.emit({ type: "ui_request", dialog });
				return;
			}
			case "notify": {
				const message = typeof msg.message === "string" ? msg.message.slice(0, 2000) : "";
				const level = NOTIFY_LEVELS.find((known) => known === msg.level) ?? "info";
				if (message) this.emit({ type: "notify", message, level });
				return;
			}
			case "ui_done": {
				// Only a string id names a dialog; anything else is ignored, never stringified.
				if (typeof msg.id !== "string") return;
				const id = msg.id;
				const by = typeof msg.by === "string" && msg.by ? msg.by.slice(0, 20) : "terminal";
				if (this.dialogs.delete(id)) this.emit({ type: "ui_resolved", id, by });
				return;
			}
			case "res": {
				if (typeof msg.id !== "string") return;
				const entry = this.pending.get(msg.id);
				if (!entry) return;
				this.pending.delete(msg.id);
				clearTimeout(entry.timer);
				// Only ok: true is success; an error text or status of the wrong type falls back to the default.
				if (msg.ok === true) entry.resolve(msg.data);
				else {
					const error = typeof msg.error === "string" && msg.error ? msg.error : "the terminal session refused the command";
					const status = typeof msg.status === "number" && Number.isInteger(msg.status) && msg.status >= 400 && msg.status <= 599 ? msg.status : 409;
					entry.reject(new BridgeError(error.slice(0, 300), status));
				}
				return;
			}
			default:
		}
	}

	/** Send a command to the terminal's pi; resolves with its reply's data. */
	command(op: BridgeCommandOp, args: BridgeCommandArgs = {}, timeoutMs = COMMAND_TIMEOUT_MS): Promise<unknown> {
		if (this.closed) return Promise.reject(new BridgeError("the terminal session is no longer attached", 410));
		const id = `b${this.nextId++}`;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new BridgeError(`the terminal session did not answer (${op})`, 504));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			this.conn.send({ t: "cmd", id, op, ...args });
		});
	}

	snapshot(): Promise<unknown> {
		return this.command("snapshot", {}, SNAPSHOT_TIMEOUT_MS);
	}

	close(reason = "detached"): void {
		if (this.closed) return;
		this.closed = true;
		for (const entry of this.pending.values()) {
			clearTimeout(entry.timer);
			entry.reject(new BridgeError("the terminal session detached", 410));
		}
		this.pending.clear();
		for (const id of this.dialogs.keys()) this.emit({ type: "ui_resolved", id, by: "detach" });
		this.dialogs.clear();
		this.emit({ type: "lifecycle", state: "detached", reason });
		this.subscribers.clear();
	}
}

function cleanDialog(raw: unknown): BridgeDialog | null {
	if (!isRecord(raw)) return null;
	// The extension's dialog ids and methods are strings; anything else is refused, never stringified.
	const id = raw.id;
	if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
	const method = DIALOG_METHODS.find((known) => known === raw.method);
	if (method === undefined) return null;
	const rawOptions: unknown = raw.options;
	let options: string[] | undefined;
	if (Array.isArray(rawOptions)) {
		const list: unknown[] = rawOptions;
		if (!list.every((o): o is string => typeof o === "string")) return null;
		options = list.slice(0, 50).map((o) => o.slice(0, 500));
	}
	const str = (v: unknown, max: number): string | undefined => (typeof v === "string" ? v.slice(0, max) : undefined);
	const message = str(raw.message, 8000);
	const placeholder = str(raw.placeholder, 500);
	const timeout = typeof raw.timeout === "number" && Number.isFinite(raw.timeout) ? raw.timeout : undefined;
	// Absent fields are left out (JSON never carried them); the key order is the one phones have always seen.
	return {
		id,
		method,
		title: str(raw.title, 8000) || "",
		...(message === undefined ? {} : { message }),
		...(placeholder === undefined ? {} : { placeholder }),
		...(options === undefined ? {} : { options }),
		...(timeout === undefined ? {} : { timeout }),
		openedAt: new Date().toISOString(),
	};
}

export class BridgeHub {
	private readonly sessions = new Map<string, BridgeSession>();
	private readonly byConn = new Map<BridgeConnection, BridgeSession>();

	/** (Re)register the session a bridge connection exposes. */
	register(conn: BridgeConnection, rawMeta: unknown): BridgeSession {
		const meta = cleanMeta(rawMeta);
		const { id } = meta;
		if (!id || !ID_RE.test(id)) throw new Error("bridge registration needs a valid session id");
		const previous = this.byConn.get(conn);
		if (previous) this.unregister(conn, previous.id === id ? "re-registered" : "session replaced");
		const existing = this.sessions.get(id);
		if (existing && existing.conn !== conn) existing.close("attached elsewhere");
		const session = new BridgeSession(this, conn, { ...meta, id });
		this.sessions.set(id, session);
		this.byConn.set(conn, session);
		return session;
	}

	unregister(conn: BridgeConnection, reason = "detached"): void {
		const session = this.byConn.get(conn);
		if (!session) return;
		this.byConn.delete(conn);
		if (this.sessions.get(session.id) === session) this.sessions.delete(session.id);
		session.close(reason);
	}

	forConn(conn: BridgeConnection): BridgeSession | null {
		return this.byConn.get(conn) ?? null;
	}

	get(id: string): BridgeSession | null {
		return this.sessions.get(id) ?? null;
	}

	list(): BridgeSession[] {
		return [...this.sessions.values()];
	}

	closeAll(): void {
		for (const conn of [...this.byConn.keys()]) this.unregister(conn, "host stopping");
	}
}
