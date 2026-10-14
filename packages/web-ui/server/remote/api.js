// api.js — the remote host's HTTPS request handler.
//
//   /v1/hello                 open    who this is (service, protocol, name, server id)
//   /v1/pair, /v1/pair/:id    open    pairing (one-time code + operator approval), rate limited
//   /v1/auth/challenge|token  open    signed-challenge login, rate limited
//   /api/...                  token   pi-console's API (handleApi), plus terminal sessions,
//                                     dialog answers and a slimmed event stream
//
// Everything a phone can do to pi goes through /api with a bearer token minted for a linked
// device (auth.js). The token is checked before any routing, a state-changing request must be
// application/json, and request bodies are bounded. There are no cookies and no CORS headers:
// the only client is the app's native layer.
import fs from "node:fs";
import { DEVICE_ID_RE, formatDeviceId } from "./codes.js";
import { PairingError } from "./pairing.js";
import { UpdateThrottle, slimEvent, slimMessage } from "./slim.js";

const MAX_BODY_BYTES = 1_000_000;
const HISTORY_BYTES = 512 * 1024;
const HEARTBEAT_MS = 15_000;
const POLL_WAIT_MAX_MS = 25_000;

class ApiError extends Error {
	constructor(status, message) {
		super(message);
		this.status = status;
	}
}

function splitUrl(raw) {
	const url = raw || "/";
	const q = url.indexOf("?");
	return q === -1 ? { pathname: url, search: "" } : { pathname: url.slice(0, q), search: url.slice(q) };
}

export function clientAddress(req) {
	const raw = String(req.socket?.remoteAddress || "?");
	return raw.startsWith("::ffff:") ? raw.slice(7) : raw;
}

function sendJson(res, status, body, headers = {}) {
	if (res.headersSent) return;
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-store",
		"Content-Length": Buffer.byteLength(payload),
		...headers,
	});
	res.end(payload);
}

function mediaType(header) {
	return String(header ?? "")
		.split(";")[0]
		.trim()
		.toLowerCase();
}

function bearer(req) {
	const match = /^Bearer ([A-Za-z0-9._~-]{20,200})$/.exec(String(req.headers.authorization || ""));
	return match ? match[1] : null;
}

function readJson(req, limit = MAX_BODY_BYTES) {
	return new Promise((resolve, reject) => {
		if (mediaType(req.headers["content-type"]) !== "application/json") {
			return reject(new ApiError(415, "Content-Type must be application/json"));
		}
		const declared = Number(req.headers["content-length"]);
		if (Number.isFinite(declared) && declared > limit) return reject(new ApiError(413, "request body too large"));
		const chunks = [];
		let size = 0;
		let done = false;
		req.on("data", (chunk) => {
			if (done) return;
			size += chunk.length;
			if (size > limit) {
				done = true;
				reject(new ApiError(413, "request body too large"));
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			if (done) return;
			done = true;
			const text = Buffer.concat(chunks).toString("utf8");
			if (!text.trim()) return resolve({});
			try {
				const value = JSON.parse(text);
				if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
				resolve(value);
			} catch {
				reject(new ApiError(400, "body must be a JSON object"));
			}
		});
		req.on("error", (error) => {
			if (!done) {
				done = true;
				reject(error);
			}
		});
	});
}

const str = (value, name, { max = 200, pattern, required = false } = {}) => {
	if (value === undefined || value === null || value === "") {
		if (required) throw new ApiError(400, `${name} is required`);
		return undefined;
	}
	if (typeof value !== "string" || value.length > max || (pattern && !pattern.test(value))) throw new ApiError(400, `invalid ${name}`);
	return value;
};

/**
 * @param {object} deps
 * @param {object} deps.console  pi-console modules: handleApi, listSessions, listLiveSessions,
 *   getSession, acquireTailer, releaseTailer, isFileActive, entryToEvents, parseSessionId,
 *   MODEL_ARG_RE, THINKING_LEVELS, STREAMING_BEHAVIOURS
 */
export function createApi({ console: pc, auth, devices, pairings, limiter, hub, dialogs, identity, version, onAudit, log, notify }) {
	const streams = new Map(); // res -> {deviceId, end}

	auth.onRevoke((deviceId) => {
		for (const stream of [...streams.values()]) if (stream.deviceId === deviceId) stream.end();
	});

	// --------------------------------------------------------------- open routes ---
	async function openRoute(req, res, pathname, search, address) {
		if (!limiter.allow(address)) return sendJson(res, 429, { error: "too many requests; try again later" }, { "Retry-After": "60" });
		const method = req.method || "GET";
		const parts = pathname.split("/").filter(Boolean); // ["v1", ...]

		if (parts[1] === "hello" && parts.length === 2 && method === "GET") {
			return sendJson(res, 200, { service: "pi-remote", protocol: 1, version, name: identity.name, serverId: identity.serverId });
		}

		if (parts[1] === "pair" && parts.length === 2 && method === "POST") {
			const body = await readJson(req, 16_000);
			try {
				const request = pairings.claim({
					code: body.code,
					publicKey: body.publicKey,
					name: body.name,
					proof: body.proof,
					platform: body.platform,
					address,
				});
				notify?.(`link request from "${request.name}" (${address})`);
				return sendJson(res, 202, {
					requestId: request.id,
					deviceId: request.deviceId,
					deviceIdDisplay: formatDeviceId(request.deviceId),
					state: request.state,
					serverId: identity.serverId,
					serverName: identity.name,
				});
			} catch (error) {
				if (!(error instanceof PairingError)) throw error;
				if (error.code === "bad_code" || error.code === "bad_proof" || error.code === "offer_burned") limiter.fail(address);
				return sendJson(res, error.status, { error: error.message, code: error.code });
			}
		}

		if (parts[1] === "pair" && parts.length === 3 && method === "GET") {
			const requestId = parts[2];
			if (!/^[A-Za-z0-9_-]{16,64}$/.test(requestId)) return sendJson(res, 404, { error: "unknown pairing request" });
			const wait = Math.min(Number(new URLSearchParams(search).get("wait") || 0) * 1000 || 0, POLL_WAIT_MAX_MS);
			const result = await pairings.poll(requestId, wait);
			if (!result) return sendJson(res, 404, { error: "unknown pairing request" });
			return sendJson(res, 200, { ...result, serverId: identity.serverId, serverName: identity.name });
		}

		if (parts[1] === "auth" && parts[2] === "challenge" && parts.length === 3 && method === "POST") {
			if (limiter.isBlocked(address)) return sendJson(res, 429, { error: "too many failures; try again later" });
			const body = await readJson(req, 4_000);
			const deviceId = str(body.deviceId, "deviceId", { pattern: DEVICE_ID_RE, required: true });
			return sendJson(res, 200, { ...auth.challenge(deviceId), serverId: identity.serverId });
		}

		if (parts[1] === "auth" && parts[2] === "token" && parts.length === 3 && method === "POST") {
			if (limiter.isBlocked(address)) return sendJson(res, 429, { error: "too many failures; try again later" });
			const body = await readJson(req, 8_000);
			const result = auth.exchange({ deviceId: body.deviceId, nonce: body.nonce, signature: body.signature });
			if (result.error) {
				const blocked = limiter.fail(address);
				onAudit({ event: "auth_failure", deviceId: String(body.deviceId || "").slice(0, 20), address, reason: result.error, blocked });
				if (blocked) notify?.(`blocked ${address} for 15 minutes after repeated failed logins`, "warning");
				return sendJson(res, 401, { error: result.error });
			}
			devices.touch(result.device.id, address);
			onAudit({ event: "auth_ok", deviceId: result.device.id, address });
			return sendJson(res, 200, {
				token: result.token,
				expiresInSec: result.expiresInSec,
				device: { id: result.device.id, name: result.device.name },
			});
		}

		return sendJson(res, 404, { error: "not found" });
	}

	// --------------------------------------------------------- session helpers ---
	function diskSummary(id) {
		return pc.listSessions().find((s) => s.id === id) || null;
	}

	function procSummary(proc) {
		return {
			id: proc.publicId,
			cwd: proc.cwd,
			sessionFile: proc.sessionFile,
			startedAt: new Date(proc.startedAt).toISOString(),
			endedAt: null,
			lastActivityAt: new Date().toISOString(),
			entryCount: 0,
			preview: "",
			status: "running",
			agent: proc.agentName,
		};
	}

	function mergedSessions() {
		const byId = new Map();
		for (const s of pc.listSessions()) {
			const active = Boolean(s.sessionFile) && pc.isFileActive(s.sessionFile);
			byId.set(s.id, { ...s, status: active ? "external" : "idle", busy: false, pendingDialogs: 0 });
		}
		for (const proc of pc.listLiveSessions()) {
			if (!proc.alive) continue;
			const id = proc.publicId;
			const existing = byId.get(id);
			byId.set(id, {
				...(existing || procSummary(proc)),
				status: "running",
				cwd: existing?.cwd || proc.cwd,
				agent: proc.agentName,
				busy: dialogs.busy(proc),
				pendingDialogs: dialogs.open(proc).length,
			});
		}
		for (const bridged of hub.list()) {
			const existing = byId.get(bridged.id);
			const summary = bridged.summary();
			byId.set(bridged.id, {
				...summary,
				preview: existing?.preview || "",
				entryCount: existing?.entryCount || 0,
				startedAt: existing?.startedAt || summary.startedAt,
				lastActivityAt: [existing?.lastActivityAt, summary.lastActivityAt].filter(Boolean).sort().pop(),
			});
		}
		return [...byId.values()].sort((a, b) => String(b.lastActivityAt || "").localeCompare(String(a.lastActivityAt || "")));
	}

	function readHistory(file) {
		const events = [];
		try {
			const fd = fs.openSync(file, "r");
			let text = "";
			let partial = false;
			try {
				const size = fs.fstatSync(fd).size;
				const start = Math.max(0, size - HISTORY_BYTES);
				partial = start > 0;
				const buffer = Buffer.alloc(size - start);
				fs.readSync(fd, buffer, 0, buffer.length, start);
				text = buffer.toString("utf8");
			} finally {
				fs.closeSync(fd);
			}
			const lines = text.split("\n");
			if (partial) lines.shift();
			for (const line of lines) {
				if (!line.trim()) continue;
				try {
					events.push(...pc.entryToEvents(JSON.parse(line)));
				} catch {
					/* malformed line: skipped, as the tailer does */
				}
			}
		} catch {
			/* no file yet */
		}
		return events;
	}

	const slimObserved = (event) =>
		event && event.type === "observed_message" ? { ...event, message: slimMessage(event.message) } : event;

	// ------------------------------------------------------------- event stream ---
	async function eventStream(req, res, id, device) {
		res.writeHead(200, {
			"Content-Type": "text/event-stream; charset=utf-8",
			"Cache-Control": "no-store, no-transform",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no",
		});
		res.write(": connected\n\n");
		let ended = false;
		const cleanups = [];
		const send = (type, payload = {}) => {
			if (ended) return;
			try {
				res.write(`event: ${type}\ndata: ${JSON.stringify({ sessionId: id, type, ...payload })}\n\n`);
			} catch {
				/* client gone; close handler cleans up */
			}
		};
		const throttle = new UpdateThrottle(250);
		const sendEvent = (event) => {
			const slim = slimEvent(event);
			if (slim && throttle.pass(slim)) send("event", { data: slim });
		};
		const stream = {
			deviceId: device.id,
			end: (state = "revoked") => {
				if (ended) return;
				send("lifecycle", { state });
				ended = true;
				res.end();
			},
		};
		streams.set(res, stream);
		const heartbeat = setInterval(() => {
			if (!ended) res.write(": ping\n\n");
		}, HEARTBEAT_MS);
		const cleanup = () => {
			if (!streams.has(res)) return;
			streams.delete(res);
			ended = true;
			clearInterval(heartbeat);
			for (const fn of cleanups) {
				try {
					fn();
				} catch {
					/* ignore */
				}
			}
		};
		res.on("close", cleanup);
		res.on("error", cleanup);

		// A pi running in a terminal, attached with /remote.
		const bridged = hub.get(id);
		if (bridged) {
			send("lifecycle", { state: "terminal", session: bridged.summary() });
			const buffered = [];
			let live = false;
			const forward = (m) => {
				if (m.type === "event") {
					if (throttle.pass(m.data)) send("event", { data: m.data });
				} else if (m.type === "ui_request") send("ui_request", { dialog: m.dialog });
				else if (m.type === "ui_resolved") send("ui_resolved", { id: m.id, by: m.by });
				else if (m.type === "meta") send("meta", { session: m.meta });
				else if (m.type === "notify") send("notify", { message: m.message, level: m.level });
				else if (m.type === "lifecycle") send("lifecycle", { state: m.state, reason: m.reason });
			};
			cleanups.push(bridged.subscribe((m) => (live ? forward(m) : buffered.push(m))));
			let snapshot = { messages: [], seq: -1 };
			try {
				snapshot = (await bridged.snapshot()) || snapshot;
			} catch (error) {
				send("notice", { message: `history unavailable: ${error.message}` });
			}
			if (ended) return;
			for (const message of Array.isArray(snapshot.messages) ? snapshot.messages : []) {
				send("observed", { data: { type: "observed_message", message: slimMessage(message) } });
			}
			if (snapshot.streaming) send("streaming", { state: snapshot.streaming });
			send("history_end", {});
			for (const dialog of bridged.dialogs.values()) send("ui_request", { dialog });
			live = true;
			const seq = Number.isInteger(snapshot.seq) ? snapshot.seq : -1;
			for (const m of buffered) if (!(m.type === "event" && Number.isInteger(m.seq) && m.seq <= seq)) forward(m);
			return;
		}

		// A pi child this host (or pi-console's routes) started.
		const proc = pc.getSession(id);
		if (proc && proc.alive) {
			send("lifecycle", { state: "running", busy: dialogs.busy(proc) });
			const replay = (proc.replay || []).filter((m) => m.type === "event" && m.data);
			let tail = replay;
			if (proc.sessionFile && fs.existsSync(proc.sessionFile)) {
				for (const event of readHistory(proc.sessionFile)) send("observed", { data: slimObserved(event) });
				// Persisted messages are in the file; what is still streaming is after the last message_end.
				let start = 0;
				for (let i = replay.length - 1; i >= 0; i--) {
					if (replay[i].data.type === "message_end") {
						start = i + 1;
						break;
					}
				}
				tail = replay.slice(start);
			}
			for (const m of tail) if (m.data.type !== "extension_ui_request") sendEvent(m.data);
			send("history_end", {});
			for (const dialog of dialogs.open(proc)) send("ui_request", { dialog });
			cleanups.push(
				proc.subscribe((m) => {
					if (m.type === "event") {
						const data = m.data || {};
						if (data.type === "extension_ui_request") {
							if (data.method === "notify" && typeof data.message === "string") {
								send("notify", { message: data.message.slice(0, 2000), level: data.notifyType || "info" });
							}
							return; // dialogs arrive through the tracker below
						}
						sendEvent(data);
					} else if (m.type === "lifecycle") {
						send("lifecycle", { state: m.state, code: m.code, message: m.message });
					}
				}),
			);
			cleanups.push(dialogs.listen(proc, (m) => send(m.type, m.type === "ui_request" ? { dialog: m.dialog } : { id: m.id, by: m.by })));
			return;
		}

		// A session on disk: replay its file and follow it (a CLI may be writing it).
		const summary = diskSummary(id);
		const tailer = summary?.sessionFile ? pc.acquireTailer(summary.sessionFile) : null;
		if (!tailer) {
			// Not shared, not running and not on disk (a child that exited without a session
			// file, or an id from a stale list): there is nothing to show or to drive.
			send("lifecycle", { state: summary ? "idle" : "gone" });
			send("history_end", {});
			return;
		}
		send("lifecycle", { state: pc.isFileActive(summary.sessionFile) ? "watching" : "idle" });
		const unsubscribe = tailer.subscribe((m) => {
			if (m.type === "observed") send("observed", { data: slimObserved(m.data) });
		});
		send("history_end", {});
		cleanups.push(() => pc.releaseTailer(summary.sessionFile, unsubscribe));
	}

	// --------------------------------------------------------- terminal sessions ---
	async function terminalRoute(req, res, bridged, sub, method) {
		if (sub === "prompt" && method === "POST") {
			const body = await readJson(req);
			const message = typeof body.message === "string" ? body.message.trim() : "";
			if (!message) throw new ApiError(400, "message is required");
			if (message.length > 100_000) throw new ApiError(413, "message too long");
			const streamingBehavior = str(body.streamingBehavior, "streamingBehavior", { max: 20 });
			if (streamingBehavior !== undefined && !pc.STREAMING_BEHAVIOURS.includes(streamingBehavior)) throw new ApiError(400, "invalid streamingBehavior");
			const data = await bridged.command("prompt", { message, streamingBehavior });
			return sendJson(res, 202, { queued: true, ...(data || {}) });
		}
		if (sub === "abort" && method === "POST") {
			await bridged.command("abort");
			return sendJson(res, 202, { aborted: true });
		}
		if (sub === "model" && method === "POST") {
			const body = await readJson(req);
			const provider = str(body.provider, "provider", { pattern: pc.MODEL_ARG_RE, required: true });
			const modelId = str(body.modelId, "modelId", { pattern: pc.MODEL_ARG_RE, required: true });
			return sendJson(res, 200, { model: await bridged.command("set_model", { provider, modelId }) });
		}
		if (sub === "thinking" && method === "POST") {
			const body = await readJson(req);
			const level = String(body.level || "");
			if (!pc.THINKING_LEVELS.includes(level)) throw new ApiError(400, "invalid thinking level");
			return sendJson(res, 200, { thinking: await bridged.command("set_thinking", { level }), level });
		}
		if (sub === "models" && method === "GET") {
			return sendJson(res, 200, await bridged.command("models"));
		}
		if (sub === "ui-response" && method === "POST") {
			const body = await readJson(req);
			const dialogId = str(body.dialogId, "dialogId", { max: 64, pattern: /^[A-Za-z0-9_-]+$/, required: true });
			if (!bridged.dialogs.has(dialogId)) throw new ApiError(404, "that dialog is no longer open");
			const answer = answerFrom(body);
			await bridged.command("ui_response", { dialogId, ...answer });
			return sendJson(res, 200, { answered: true });
		}
		if ((sub === undefined && method === "DELETE") || sub === "fork" || sub === "new") {
			throw new ApiError(409, "this session runs in a terminal: stop, fork or reset it there (or /remote detach)");
		}
		return null; // not handled here: stats, todos, lens fall through to pi-console
	}

	function answerFrom(body) {
		if (body.cancelled === true) return { cancelled: true };
		if (typeof body.confirmed === "boolean") return { confirmed: body.confirmed };
		if (typeof body.value === "string" && body.value.length <= 100_000) return { value: body.value };
		throw new ApiError(400, "an answer needs value, confirmed or cancelled");
	}

	// -------------------------------------------------------------- /api routes ---
	async function apiRoute(req, res, pathname, search, device) {
		const method = req.method || "GET";
		const parts = pathname.split("/").filter(Boolean); // ["api", ...]

		if (parts[1] === "remote") {
			if (parts[2] === "whoami" && method === "GET") {
				return sendJson(res, 200, {
					device: { id: device.id, display: formatDeviceId(device.id), name: device.name, pairedAt: device.pairedAt },
					server: { name: identity.name, serverId: identity.serverId, version },
				});
			}
			if (parts[2] === "device" && method === "DELETE") {
				devices.remove(device.id);
				auth.revokeDevice(device.id);
				onAudit({ event: "device_unlinked_itself", deviceId: device.id });
				notify?.(`"${device.name}" unlinked itself`);
				return sendJson(res, 200, { unlinked: true });
			}
			return sendJson(res, 404, { error: "not found" });
		}

		if (parts[1] === "sessions" && parts.length === 2 && method === "GET") {
			return sendJson(res, 200, { sessions: mergedSessions() });
		}

		if (parts[1] === "sessions" && parts.length >= 3) {
			const id = pc.parseSessionId(parts[2]);
			const sub = parts[3];
			if (sub === "events" && method === "GET") return eventStream(req, res, id, device);

			const bridged = hub.get(id);
			if (bridged) {
				const handled = await terminalRoute(req, res, bridged, sub, method);
				if (handled !== null) return handled;
			} else if (sub === "ui-response" && method === "POST") {
				const proc = pc.getSession(id);
				if (!proc || !proc.alive) throw new ApiError(404, "session is not running");
				const body = await readJson(req);
				const dialogId = str(body.dialogId, "dialogId", { max: 100, pattern: /^[A-Za-z0-9._:-]+$/, required: true });
				if (!dialogs.has(proc, dialogId)) throw new ApiError(404, "that dialog is no longer open");
				proc.respondUi(dialogId, answerFrom(body));
				dialogs.resolve(proc, dialogId, "phone");
				return sendJson(res, 200, { answered: true });
			}
		}

		// Everything else is pi-console's API, unchanged.
		const handled = await pc.handleApi(req, res, { pathname, search }, { authMode: "token" });
		if (!handled) sendJson(res, 404, { error: "not found" });
	}

	// ------------------------------------------------------------------ entry ---
	async function handle(req, res) {
		const { pathname, search } = splitUrl(req.url);
		const address = clientAddress(req);
		try {
			if (!(req.url || "").startsWith("/")) return sendJson(res, 400, { error: "bad request" });
			if (pathname.startsWith("/v1/")) return await openRoute(req, res, pathname, search, address);
			if (pathname.startsWith("/api/")) {
				const device = auth.verify(bearer(req));
				if (!device) return sendJson(res, 401, { error: "sign in again" }, { "WWW-Authenticate": 'Bearer realm="pi-remote"' });
				const method = String(req.method || "GET").toUpperCase();
				if (method !== "GET" && method !== "HEAD" && mediaType(req.headers["content-type"]) !== "application/json") {
					return sendJson(res, 415, { error: "Content-Type must be application/json" });
				}
				return await apiRoute(req, res, pathname, search, device);
			}
			return sendJson(res, 404, { error: "not found" });
		} catch (error) {
			const status = error.status || error.statusCode;
			if (status && status < 500) return sendJson(res, status, { error: error.message });
			if (status === 504 || status === 502) return sendJson(res, status, { error: error.message });
			log(`request failed: ${req.method} ${pathname}: ${error && error.stack ? error.stack : error}`);
			return sendJson(res, 500, { error: "internal error (see the host log)" });
		}
	}

	function closeAllStreams() {
		for (const [res, stream] of [...streams]) {
			try {
				stream.end("host_stopping");
			} catch {
				res.destroy();
			}
		}
		streams.clear();
	}

	return { handle, closeAllStreams, mergedSessions, streamCount: () => streams.size };
}
