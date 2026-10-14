// control.js — the loopback control channel between the host and local pi processes.
//
// Newline-delimited JSON over TCP on 127.0.0.1. The first record must be
//   {"t":"hello","secret":"<from control.json>","role":"admin"|"bridge"}
// within five seconds, or the connection is dropped. control.json is owner-only (0600), so only
// processes of the operator's account can speak here: the same trust boundary as pi-console's
// token file. Records are split on LF only (never on U+2028/2029, which may appear in JSON
// strings), and a record larger than MAX_LINE closes the connection.
import net from "node:net";
import { safeEqual } from "./codes.js";

const HELLO_TIMEOUT_MS = 5_000;
const MAX_LINE = 32 * 1024 * 1024;

let nextConnId = 1;

export class ControlServer {
	/**
	 * @param {{secret:string, onAdmin:Function, onBridge:Function, onClose:Function, log?:Function}} opts
	 */
	constructor({ secret, onAdmin, onBridge, onClose, log = () => {} }) {
		this.secret = secret;
		this.onAdmin = onAdmin;
		this.onBridge = onBridge;
		this.onClose = onClose;
		this.log = log;
		this.conns = new Set();
		this.server = net.createServer((socket) => this.accept(socket));
		this.server.on("error", (error) => log(`control channel error: ${error.message}`));
	}

	listen(port = 0) {
		return new Promise((resolve, reject) => {
			this.server.once("error", reject);
			this.server.listen(port, "127.0.0.1", () => {
				this.server.off("error", reject);
				resolve(this.server.address().port);
			});
		});
	}

	accept(socket) {
		socket.setNoDelay(true);
		const conn = {
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
			close() {
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
		socket.on("data", (chunk) => {
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
				let msg;
				try {
					msg = JSON.parse(line);
				} catch {
					continue;
				}
				if (!msg || typeof msg !== "object") continue;
				this.dispatch(conn, msg, helloTimer);
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
				this.log(`control channel close handler failed: ${error.message}`);
			}
		};
		socket.on("close", finish);
		socket.on("error", finish);
	}

	dispatch(conn, msg, helloTimer) {
		if (!conn.role) {
			const ok =
				msg.t === "hello" &&
				typeof msg.secret === "string" &&
				safeEqual(msg.secret, this.secret) &&
				(msg.role === "admin" || msg.role === "bridge");
			if (!ok) {
				conn.send({ t: "hello", ok: false, error: "not authorised" });
				conn.close();
				return;
			}
			clearTimeout(helloTimer);
			conn.role = msg.role;
			conn.pid = Number.isInteger(msg.pid) ? msg.pid : null;
			conn.send({ t: "hello", ok: true });
			return;
		}
		try {
			if (conn.role === "admin") this.onAdmin(conn, msg);
			else this.onBridge(conn, msg);
		} catch (error) {
			this.log(`control channel handler failed: ${error.message}`);
			if (msg.t === "req") conn.send({ t: "res", id: msg.id, ok: false, error: "internal error" });
		}
	}

	close() {
		for (const conn of this.conns) conn.close();
		this.conns.clear();
		this.server.close();
	}
}
