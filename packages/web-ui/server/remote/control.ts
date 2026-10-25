// control.ts — the loopback control channel between the host and local pi processes.
//
// Newline-delimited JSON over TCP on 127.0.0.1. The first record must be
//   {"t":"hello","secret":"<from control.json>","role":"admin"|"bridge"}
// within five seconds, or the connection is dropped. control.json is owner-only (0600), so only
// processes of the operator's account can speak here: the same trust boundary as pi-console's
// token file. Records are split on LF only (never on U+2028/2029, which may appear in JSON
// strings), and a record larger than MAX_LINE closes the connection.
import net from "node:net";
import { isRecord } from "../../../core/lib/guard.ts";
import { safeEqual } from "./codes.ts";

const HELLO_TIMEOUT_MS = 5_000;
const MAX_LINE = 32 * 1024 * 1024;

let nextConnId = 1;

export type ControlRole = "admin" | "bridge";

/**
 * One record received from a local client after its hello. It came over a socket, so every field
 * is unchecked: the handler validates what it reads.
 */
export type ControlMessage = Record<string, unknown>;

/** One accepted control connection. */
export interface ControlConnection {
	readonly id: number;
	/** Set by a valid hello; null until then. */
	role: ControlRole | null;
	readonly socket: net.Socket;
	closed: boolean;
	/** The pid the client announced in its hello (not verified), or null. */
	pid?: number | null;
	// Per-connection state the host attaches to admin connections.
	subscribed?: boolean;
	onPairRequest?: (request: unknown) => void;
	onOfferClosed?: (offer: { readonly id: string }, reason: string) => void;
	onRequestClosed?: (request: unknown) => void;
	/** Write one record; false when the connection is closed or the write failed or is buffered. */
	send(obj: unknown): boolean;
	close(): void;
}

export type ControlHandler = (conn: ControlConnection, msg: ControlMessage) => void;

export interface ControlServerOptions {
	readonly secret: string;
	readonly onAdmin: ControlHandler;
	readonly onBridge: ControlHandler;
	readonly onClose: (conn: ControlConnection) => void;
	readonly log?: (line: string) => void;
}

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export class ControlServer {
	private readonly secret: string;
	private readonly onAdmin: ControlHandler;
	private readonly onBridge: ControlHandler;
	private readonly onClose: (conn: ControlConnection) => void;
	private readonly log: (line: string) => void;
	readonly conns = new Set<ControlConnection>();
	readonly server: net.Server;

	constructor({ secret, onAdmin, onBridge, onClose, log = () => {} }: ControlServerOptions) {
		this.secret = secret;
		this.onAdmin = onAdmin;
		this.onBridge = onBridge;
		this.onClose = onClose;
		this.log = log;
		this.server = net.createServer((socket) => this.accept(socket));
		this.server.on("error", (error) => log(`control channel error: ${error.message}`));
	}

	/** Listen on 127.0.0.1; resolves with the port. */
	listen(port = 0): Promise<number> {
		return new Promise((resolve, reject) => {
			this.server.once("error", reject);
			this.server.listen(port, "127.0.0.1", () => {
				this.server.off("error", reject);
				const address = this.server.address();
				if (address === null || typeof address === "string") reject(new Error("control channel has no TCP address"));
				else resolve(address.port);
			});
		});
	}

	private accept(socket: net.Socket): void {
		socket.setNoDelay(true);
		const conn: ControlConnection = {
			id: nextConnId++,
			role: null,
			socket,
			closed: false,
			send(obj) {
				if (conn.closed) return false;
				try {
					return socket.write(`${JSON.stringify(obj)}\n`);
				} catch {
					return false;
				}
			},
			close(): void {
				if (conn.closed) return;
				conn.closed = true;
				socket.destroy();
			},
		};
		this.conns.add(conn);
		const helloTimer = setTimeout(() => {
			if (!conn.role) conn.close();
		}, HELLO_TIMEOUT_MS);

		let buffer = "";
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			if (buffer.length > MAX_LINE) {
				this.log(`control channel: record too large from connection ${conn.id}; closed`);
				conn.close();
				return;
			}
			let nl;
			while ((nl = buffer.indexOf("\n")) !== -1) {
				const line = buffer.slice(0, nl).replace(/\r$/, "");
				buffer = buffer.slice(nl + 1);
				if (!line.trim()) continue;
				let msg: unknown;
				try {
					msg = JSON.parse(line);
				} catch {
					continue;
				}
				if (!msg || typeof msg !== "object") continue;
				// An array is still a record here (one with no fields), so before hello it is refused.
				this.dispatch(conn, isRecord(msg) ? msg : {}, helloTimer);
				if (conn.closed) return;
			}
		});
		const finish = () => {
			clearTimeout(helloTimer);
			if (!this.conns.delete(conn)) return;
			conn.closed = true;
			try {
				this.onClose(conn);
			} catch (error) {
				this.log(`control channel close handler failed: ${errorMessage(error)}`);
			}
		};
		socket.on("close", finish);
		socket.on("error", finish);
	}

	private dispatch(conn: ControlConnection, msg: ControlMessage, helloTimer: NodeJS.Timeout): void {
		if (!conn.role) {
			const role = msg.role === "admin" || msg.role === "bridge" ? msg.role : null;
			const ok = msg.t === "hello" && typeof msg.secret === "string" && safeEqual(msg.secret, this.secret) && role !== null;
			if (!ok) {
				conn.send({ t: "hello", ok: false, error: "not authorised" });
				conn.close();
				return;
			}
			clearTimeout(helloTimer);
			conn.role = role;
			conn.pid = typeof msg.pid === "number" && Number.isInteger(msg.pid) ? msg.pid : null;
			conn.send({ t: "hello", ok: true });
			return;
		}
		try {
			if (conn.role === "admin") this.onAdmin(conn, msg);
			else this.onBridge(conn, msg);
		} catch (error) {
			this.log(`control channel handler failed: ${errorMessage(error)}`);
			if (msg.t === "req") conn.send({ t: "res", id: msg.id, ok: false, error: "internal error" });
		}
	}

	close(): void {
		for (const conn of this.conns) conn.close();
		this.conns.clear();
		this.server.close();
	}
}
