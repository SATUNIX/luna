// bridge.js — pi sessions running in a terminal, made reachable from a phone.
//
// The `remote-control` extension, loaded in an interactive pi, opens a control connection with
// role "bridge" and registers its session. From then on it forwards that session's events
// (already slimmed) and the dialogs other extensions open, and it executes the few commands a
// phone may send: prompt, abort, set model, set thinking level, answer a dialog, and send a
// history snapshot. The host never writes the session file; the terminal's pi stays its only
// writer.
import { slimEvent } from "./slim.js";

const COMMAND_TIMEOUT_MS = 15_000;
const SNAPSHOT_TIMEOUT_MS = 20_000;
const REPLAY_LIMIT = 300;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

function cleanMeta(raw) {
	const meta = raw && typeof raw === "object" ? raw : {};
	const str = (v, max = 400) => (typeof v === "string" ? v.slice(0, max) : null);
	return {
		id: str(meta.id, 200),
		sessionFile: str(meta.sessionFile, 4096),
		cwd: str(meta.cwd, 4096),
		name: str(meta.name, 200),
		model: meta.model && typeof meta.model === "object" ? { provider: str(meta.model.provider, 200), id: str(meta.model.id, 200) } : null,
		thinking: str(meta.thinking, 20),
		busy: Boolean(meta.busy),
		pid: Number.isInteger(meta.pid) ? meta.pid : null,
		piVersion: str(meta.piVersion, 40),
		dialogs: meta.dialogs !== false,
	};
}

export class BridgeSession {
	constructor(hub, conn, meta) {
		this.hub = hub;
		this.conn = conn;
		this.meta = meta;
		this.id = meta.id;
		this.attachedAt = new Date().toISOString();
		this.lastActivityAt = this.attachedAt;
		this.subscribers = new Set();
		this.pending = new Map();
		this.dialogs = new Map();
		this.replay = [];
		this.nextId = 1;
		this.closed = false;
	}

	summary() {
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

	emit(message) {
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

	subscribe(fn) {
		this.subscribers.add(fn);
		return () => this.subscribers.delete(fn);
	}

	/** Messages from the extension for this session. */
	onMessage(msg) {
		this.lastActivityAt = new Date().toISOString();
		switch (msg.t) {
			case "event": {
				const event = slimEvent(msg.event);
				if (!event || typeof event.type !== "string") return;
				// agent_end can be followed by retries or queued work; only agent_settled means idle.
				if (event.type === "agent_start") this.meta.busy = true;
				if (event.type === "agent_settled") this.meta.busy = false;
				this.emit({ type: "event", data: event, seq: Number.isInteger(msg.seq) ? msg.seq : undefined });
				return;
			}
			case "meta": {
				const next = cleanMeta({ ...this.meta, ...(msg.meta || {}), id: this.id });
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
				const level = ["info", "warning", "error"].includes(msg.level) ? msg.level : "info";
				if (message) this.emit({ type: "notify", message, level });
				return;
			}
			case "ui_done": {
				const id = String(msg.id ?? "");
				if (this.dialogs.delete(id)) this.emit({ type: "ui_resolved", id, by: String(msg.by || "terminal").slice(0, 20) });
				return;
			}
			case "res": {
				const entry = this.pending.get(String(msg.id));
				if (!entry) return;
				this.pending.delete(String(msg.id));
				clearTimeout(entry.timer);
				if (msg.ok) entry.resolve(msg.data);
				else entry.reject(Object.assign(new Error(String(msg.error || "the terminal session refused the command").slice(0, 300)), { status: msg.status || 409 }));
				return;
			}
			default:
		}
	}

	command(op, args = {}, timeoutMs = COMMAND_TIMEOUT_MS) {
		if (this.closed) return Promise.reject(Object.assign(new Error("the terminal session is no longer attached"), { status: 410 }));
		const id = `b${this.nextId++}`;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(Object.assign(new Error(`the terminal session did not answer (${op})`), { status: 504 }));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			this.conn.send({ t: "cmd", id, op, ...args });
		});
	}

	snapshot() {
		return this.command("snapshot", {}, SNAPSHOT_TIMEOUT_MS);
	}

	close(reason = "detached") {
		if (this.closed) return;
		this.closed = true;
		for (const entry of this.pending.values()) {
			clearTimeout(entry.timer);
			entry.reject(Object.assign(new Error("the terminal session detached"), { status: 410 }));
		}
		this.pending.clear();
		for (const id of this.dialogs.keys()) this.emit({ type: "ui_resolved", id, by: "detach" });
		this.dialogs.clear();
		this.emit({ type: "lifecycle", state: "detached", reason });
		this.subscribers.clear();
	}
}

function cleanDialog(raw) {
	if (!raw || typeof raw !== "object") return null;
	const id = String(raw.id ?? "");
	if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
	const method = String(raw.method ?? "");
	if (!["select", "confirm", "input"].includes(method)) return null;
	const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : undefined);
	return {
		id,
		method,
		title: str(raw.title, 8000) || "",
		message: str(raw.message, 8000),
		placeholder: str(raw.placeholder, 500),
		options: Array.isArray(raw.options) ? raw.options.slice(0, 50).map((o) => String(o).slice(0, 500)) : undefined,
		timeout: Number.isFinite(raw.timeout) ? raw.timeout : undefined,
		openedAt: new Date().toISOString(),
	};
}

export class BridgeHub {
	constructor() {
		this.sessions = new Map();
		this.byConn = new Map();
	}

	/** (Re)register the session a bridge connection exposes. */
	register(conn, rawMeta) {
		const meta = cleanMeta(rawMeta);
		if (!meta.id || !ID_RE.test(meta.id)) throw new Error("bridge registration needs a valid session id");
		const previous = this.byConn.get(conn);
		if (previous) this.unregister(conn, previous.id === meta.id ? "re-registered" : "session replaced");
		const existing = this.sessions.get(meta.id);
		if (existing && existing.conn !== conn) existing.close("attached elsewhere");
		const session = new BridgeSession(this, conn, meta);
		this.sessions.set(meta.id, session);
		this.byConn.set(conn, session);
		return session;
	}

	unregister(conn, reason = "detached") {
		const session = this.byConn.get(conn);
		if (!session) return;
		this.byConn.delete(conn);
		if (this.sessions.get(session.id) === session) this.sessions.delete(session.id);
		session.close(reason);
	}

	forConn(conn) {
		return this.byConn.get(conn) || null;
	}

	get(id) {
		return this.sessions.get(id) || null;
	}

	list() {
		return [...this.sessions.values()];
	}

	closeAll() {
		for (const conn of [...this.byConn.keys()]) this.unregister(conn, "host stopping");
	}
}
