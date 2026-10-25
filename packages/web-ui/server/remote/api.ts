// api.ts — the remote host's HTTPS request handler.
//
//   /v1/hello                 open    who this is (service, protocol, name, server id)
//   /v1/pair, /v1/pair/:id    open    pairing (one-time code + operator approval), rate limited
//   /v1/auth/challenge|token  open    signed-challenge login, rate limited
//   /api/...                  token   pi-console's API (handleApi), plus terminal sessions,
//                                     dialog answers and a slimmed event stream
//
// Everything a phone can do to pi goes through /api with a bearer token minted for a linked
// device (auth.ts). The token is checked before any routing, a state-changing request must be
// application/json, and request bodies are bounded. There are no cookies and no CORS headers:
// the only client is the app's native layer.
import fs from "node:fs";
import type http from "node:http";
import { type Infer, type Schema, boolean, isRecord, nullable, object, optional, parseJson, safeParse, string, unknownValue } from "../../../core/lib/guard.ts";
import type { SessionRecord } from "../sessions.ts";
import type { Authenticator, RateLimiter } from "./auth.ts";
import type { BridgeHub, BridgeNotice, BridgeSession, TerminalSessionSummary } from "./bridge.ts";
import { DEVICE_ID_RE, formatDeviceId } from "./codes.ts";
import type { DeviceRecord, DeviceRegistry } from "./devices.ts";
import type { DialogSource, DialogTracker } from "./dialogs.ts";
import { PairingError, type Pairings } from "./pairing.ts";
import { UpdateThrottle, slimEvent, slimMessage } from "./slim.ts";

const MAX_BODY_BYTES = 1_000_000;
const HISTORY_BYTES = 512 * 1024;
const HEARTBEAT_MS = 15_000;
const POLL_WAIT_MAX_MS = 25_000;

class ApiError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

/** How a dialog is answered: cancelled, a yes/no, or a value (a select option or typed text). */
export type DialogAnswer = { cancelled: true } | { confirmed: boolean } | { value: string };

/** What a phone-answered dialog showed, as far as the audit record needs it. */
export interface AnsweredDialog {
	readonly method: string;
	readonly title: string;
	readonly message?: string | undefined;
	readonly options?: readonly string[] | undefined;
}

const TIER_HEAD = /^(?:UNCERTAIN · )?(low|MEDIUM|HIGH|CRITICAL) · /;

/**
 * The audit record for a dialog a phone answered: which device, which session and dialog, the
 * tool-firewall tier when the dialog is an approval card (its first line names it), and the choice.
 * Typed text is recorded by length only: it may be anything the operator wrote.
 */
export function phoneAnswerRecord(device: Pick<DeviceRecord, "id" | "name">, session: string, dialogId: string, dialog: AnsweredDialog | undefined, answer: DialogAnswer): Record<string, unknown> {
	const head = `${dialog?.message ?? ""}\n${dialog?.title ?? ""}`.split("\n").map((l) => TIER_HEAD.exec(l.trim())?.[1]).find((t) => t !== undefined);
	let choice: string;
	if ("cancelled" in answer) choice = "cancelled";
	else if ("confirmed" in answer) choice = answer.confirmed ? "yes" : "no";
	else if (dialog?.options?.includes(answer.value)) choice = answer.value.slice(0, 120);
	else choice = `typed text (${answer.value.length} characters)`;
	return {
		event: "phone_dialog_answer",
		deviceId: device.id,
		device: device.name,
		session,
		dialogId,
		method: dialog?.method ?? "unknown",
		title: (dialog?.title ?? "").split("\n")[0]?.slice(0, 120) ?? "",
		...(head ? { tier: head.toLowerCase() } : {}),
		choice,
	};
}

/** A pi child this host (or pi-console's routes) started, as the remote API reads it. */
export interface LiveSession extends DialogSource {
	readonly publicId: string;
	readonly cwd: string | null;
	readonly sessionFile: string | null | undefined;
	/** Epoch milliseconds. */
	readonly startedAt: number;
	readonly agentName: string | null | undefined;
	readonly alive: boolean;
	/** The child's records to come (untrusted); returns the unsubscribe function. */
	subscribe(fn: (message: unknown) => void): () => unknown;
	respondUi(id: string, answer: DialogAnswer): unknown;
}

/** A session file being followed; its records are untrusted. */
export interface SessionTailerLike {
	subscribe(fn: (message: unknown) => void): () => unknown;
}

/** The pi-console modules the remote API drives (remote-host.ts assembles them). */
export interface RemoteConsole {
	handleApi(req: http.IncomingMessage, res: http.ServerResponse, url: { pathname: string; search: string }, ctx: { authMode: "token" }): Promise<boolean>;
	listSessions(): readonly SessionRecord[];
	listLiveSessions(): readonly LiveSession[];
	getSession(id: string): LiveSession | null | undefined;
	acquireTailer(sessionFile: string): SessionTailerLike | null | undefined;
	releaseTailer(sessionFile: string, unsubscribe: () => unknown): void;
	isFileActive(sessionFile: string): boolean;
	entryToEvents(entry: unknown): readonly unknown[];
	parseSessionId(rawSegment: string): string;
	readonly MODEL_ARG_RE: RegExp;
	readonly THINKING_LEVELS: readonly string[];
	readonly STREAMING_BEHAVIOURS: readonly string[];
}

/** Who this host is, as /v1/hello and the pairing replies name it. */
export interface HostIdentity {
	readonly serverId: string;
	readonly name: string;
}

export type AuditSink = (record: Readonly<Record<string, unknown>>) => void;
export type Notify = (message: string, level?: string) => void;

export interface CreateApiOptions {
	readonly console: RemoteConsole;
	readonly auth: Authenticator;
	readonly devices: Pick<DeviceRegistry, "touch" | "remove">;
	readonly pairings: Pairings;
	readonly limiter: RateLimiter;
	readonly hub: BridgeHub;
	readonly dialogs: Pick<DialogTracker, "open" | "busy" | "has" | "resolve" | "listen">;
	readonly identity: HostIdentity;
	readonly version: string;
	readonly onAudit: AuditSink;
	readonly log: (line: string) => void;
	readonly notify?: Notify | undefined;
}

export type SessionStatus = "idle" | "external" | "running" | "terminal";

/** One entry of GET /api/sessions: a session on disk, a running child or a terminal session. */
export interface SessionView {
	id: string;
	cwd: string | null;
	sessionFile: string | null | undefined;
	startedAt: string | null;
	endedAt: string | null;
	lastActivityAt: string | null;
	entryCount: number;
	preview: string;
	status: SessionStatus;
	busy: boolean;
	pendingDialogs: number;
	agent?: string | null | undefined;
	name?: string | null;
	model?: TerminalSessionSummary["model"];
	thinking?: string | null;
}

export interface RemoteApi {
	handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void>;
	closeAllStreams(): void;
	mergedSessions(): SessionView[];
	streamCount(): number;
}

// Request bodies, one schema per route. A string field may be absent or null (both mean "not
// given"); a field of any other type is refused with 400 "invalid <field>", never coerced.
const text = optional(nullable(string()));
const flag = optional(nullable(boolean()));
/** POST /v1/pair. code and publicKey are checked by the pairing itself (any type is refused there). */
const PairBodySchema = object({ code: unknownValue(), publicKey: unknownValue(), name: text, proof: text, platform: text });
const ChallengeBodySchema = object({ deviceId: text });
const TokenBodySchema = object({ deviceId: text, nonce: text, signature: text });
const PromptBodySchema = object({ message: text, streamingBehavior: text });
const ModelBodySchema = object({ provider: text, modelId: text });
const ThinkingBodySchema = object({ level: text });
const AnswerBodySchema = object({ dialogId: text, cancelled: flag, confirmed: flag, value: text });
export type PairBody = Infer<typeof PairBodySchema>;
export type ChallengeBody = Infer<typeof ChallengeBodySchema>;
export type TokenBody = Infer<typeof TokenBodySchema>;
export type PromptBody = Infer<typeof PromptBodySchema>;
export type ModelBody = Infer<typeof ModelBodySchema>;
export type ThinkingBody = Infer<typeof ThinkingBodySchema>;
export type AnswerBody = Infer<typeof AnswerBodySchema>;

/** A request body checked against its route's schema; the first wrong field is a 400. */
function bodyAs<T>(schema: Schema<T>, body: Record<string, unknown>): T {
	const result = safeParse(schema, body, "body");
	if (!result.ok) throw new ApiError(400, `invalid ${result.error.path.replace(/^body\./, "")}`);
	return result.value;
}

function splitUrl(raw: string | undefined): { pathname: string; search: string } {
	const url = raw || "/";
	const q = url.indexOf("?");
	return q === -1 ? { pathname: url, search: "" } : { pathname: url.slice(0, q), search: url.slice(q) };
}

export function clientAddress(req: http.IncomingMessage): string {
	const raw = req.socket.remoteAddress || "?";
	return raw.startsWith("::ffff:") ? raw.slice(7) : raw;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown, headers: http.OutgoingHttpHeaders = {}): void {
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

function mediaType(header: string | undefined): string {
	return (header ?? "")
		.split(";")[0]
		?.trim()
		.toLowerCase() ?? "";
}

function bearer(req: http.IncomingMessage): string | null {
	const match = /^Bearer ([A-Za-z0-9._~-]{20,200})$/.exec(req.headers.authorization || "");
	return match?.[1] ?? null;
}

function readJson(req: http.IncomingMessage, limit = MAX_BODY_BYTES): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		if (mediaType(req.headers["content-type"]) !== "application/json") {
			reject(new ApiError(415, "Content-Type must be application/json"));
			return;
		}
		const declared = Number(req.headers["content-length"]);
		if (Number.isFinite(declared) && declared > limit) {
			reject(new ApiError(413, "request body too large"));
			return;
		}
		const chunks: Buffer[] = [];
		let size = 0;
		let done = false;
		req.on("data", (chunk: Buffer) => {
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
			const body = Buffer.concat(chunks).toString("utf8");
			if (!body.trim()) {
				resolve({});
				return;
			}
			let value: unknown;
			try {
				value = parseJson(body);
			} catch {
				value = undefined;
			}
			if (isRecord(value)) resolve(value);
			else reject(new ApiError(400, "body must be a JSON object"));
		});
		req.on("error", (error) => {
			if (!done) {
				done = true;
				reject(error);
			}
		});
	});
}

interface StrOptions {
	readonly max?: number;
	readonly pattern?: RegExp;
	readonly required?: boolean;
}

/** A schema-checked string field: absent (undefined, null or "") is allowed unless required; bounded and matched otherwise. */
function str(value: string | null | undefined, name: string, options: StrOptions & { required: true }): string;
function str(value: string | null | undefined, name: string, options?: StrOptions): string | undefined;
function str(value: string | null | undefined, name: string, { max = 200, pattern, required = false }: StrOptions = {}): string | undefined {
	if (value === undefined || value === null || value === "") {
		if (required) throw new ApiError(400, `${name} is required`);
		return undefined;
	}
	if (value.length > max || (pattern && !pattern.test(value))) throw new ApiError(400, `invalid ${name}`);
	return value;
}

/** The HTTP status an error carries (ApiError, BridgeError, pi-console's HttpError), if any. */
function statusOf(error: unknown): number | undefined {
	if (typeof error !== "object" || error === null) return undefined;
	if ("status" in error && typeof error.status === "number" && error.status) return error.status;
	if ("statusCode" in error && typeof error.statusCode === "number") return error.statusCode;
	return undefined;
}

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * The text a client is told about a request that failed with a 4xx, 502 or 504: the message of
 * an Error (ApiError, BridgeError and HttpError all are), never a stringified thrown value,
 * which could carry anything (a custom toString, an embedded stack). Anything else gets a fixed
 * text; the host log has the detail.
 */
export function clientErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : "request failed";
}

interface EventStreamHandle {
	readonly deviceId: string;
	end(state?: string): void;
}

export function createApi({ console: pc, auth, devices, pairings, limiter, hub, dialogs, identity, version, onAudit, log, notify }: CreateApiOptions): RemoteApi {
	const streams = new Map<http.ServerResponse, EventStreamHandle>();

	auth.onRevoke((deviceId) => {
		for (const stream of [...streams.values()]) if (stream.deviceId === deviceId) stream.end();
	});

	// --------------------------------------------------------------- open routes ---
	async function openRoute(req: http.IncomingMessage, res: http.ServerResponse, pathname: string, search: string, address: string): Promise<void> {
		if (!limiter.allow(address)) {
			sendJson(res, 429, { error: "too many requests; try again later" }, { "Retry-After": "60" });
			return;
		}
		const method = req.method || "GET";
		const parts = pathname.split("/").filter(Boolean); // ["v1", ...]

		if (parts[1] === "hello" && parts.length === 2 && method === "GET") {
			sendJson(res, 200, { service: "pi-remote", protocol: 1, version, name: identity.name, serverId: identity.serverId });
			return;
		}

		if (parts[1] === "pair" && parts.length === 2 && method === "POST") {
			// The proof is checked over these exact strings: a value of another type is refused, never stringified.
			const body = bodyAs(PairBodySchema, await readJson(req, 16_000));
			try {
				const request = pairings.claim({
					code: body.code,
					publicKey: body.publicKey,
					name: body.name ?? undefined,
					proof: body.proof ?? undefined,
					platform: body.platform ?? undefined,
					address,
				});
				notify?.(`link request from "${request.name}" (${address})`);
				sendJson(res, 202, {
					requestId: request.id,
					deviceId: request.deviceId,
					deviceIdDisplay: formatDeviceId(request.deviceId),
					state: request.state,
					serverId: identity.serverId,
					serverName: identity.name,
				});
				return;
			} catch (error) {
				if (!(error instanceof PairingError)) throw error;
				if (error.code === "bad_code" || error.code === "bad_proof" || error.code === "offer_burned") limiter.fail(address);
				sendJson(res, error.status, { error: error.message, code: error.code });
				return;
			}
		}

		if (parts[1] === "pair" && parts.length === 3 && method === "GET") {
			const requestId = parts[2] ?? "";
			if (!/^[A-Za-z0-9_-]{16,64}$/.test(requestId)) {
				sendJson(res, 404, { error: "unknown pairing request" });
				return;
			}
			const wait = Math.min(Number(new URLSearchParams(search).get("wait") || 0) * 1000 || 0, POLL_WAIT_MAX_MS);
			const result = await pairings.poll(requestId, wait);
			if (!result) {
				sendJson(res, 404, { error: "unknown pairing request" });
				return;
			}
			sendJson(res, 200, { ...result, serverId: identity.serverId, serverName: identity.name });
			return;
		}

		if (parts[1] === "auth" && parts[2] === "challenge" && parts.length === 3 && method === "POST") {
			if (limiter.isBlocked(address)) {
				sendJson(res, 429, { error: "too many failures; try again later" });
				return;
			}
			const body = bodyAs(ChallengeBodySchema, await readJson(req, 4_000));
			const deviceId = str(body.deviceId, "deviceId", { pattern: DEVICE_ID_RE, required: true });
			sendJson(res, 200, { ...auth.challenge(deviceId), serverId: identity.serverId });
			return;
		}

		if (parts[1] === "auth" && parts[2] === "token" && parts.length === 3 && method === "POST") {
			if (limiter.isBlocked(address)) {
				sendJson(res, 429, { error: "too many failures; try again later" });
				return;
			}
			const body = bodyAs(TokenBodySchema, await readJson(req, 8_000));
			const result = auth.exchange(body);
			if ("error" in result) {
				const blocked = limiter.fail(address);
				onAudit({ event: "auth_failure", deviceId: (body.deviceId ?? "").slice(0, 20), address, reason: result.error, blocked });
				if (blocked) notify?.(`blocked ${address} for 15 minutes after repeated failed logins`, "warning");
				sendJson(res, 401, { error: result.error });
				return;
			}
			devices.touch(result.device.id, address);
			onAudit({ event: "auth_ok", deviceId: result.device.id, address });
			sendJson(res, 200, {
				token: result.token,
				expiresInSec: result.expiresInSec,
				device: { id: result.device.id, name: result.device.name },
			});
			return;
		}

		sendJson(res, 404, { error: "not found" });
	}

	// --------------------------------------------------------- session helpers ---
	function diskSummary(id: string): SessionRecord | null {
		return pc.listSessions().find((s) => s.id === id) ?? null;
	}

	function procSummary(proc: LiveSession): Omit<SessionView, "busy" | "pendingDialogs"> {
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

	function mergedSessions(): SessionView[] {
		const byId = new Map<string, SessionView>();
		for (const s of pc.listSessions()) {
			const active = Boolean(s.sessionFile) && pc.isFileActive(s.sessionFile);
			byId.set(s.id, { ...s, status: active ? "external" : "idle", busy: false, pendingDialogs: 0 });
		}
		for (const proc of pc.listLiveSessions()) {
			if (!proc.alive) continue;
			const id = proc.publicId;
			const existing = byId.get(id);
			byId.set(id, {
				...(existing ?? procSummary(proc)),
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
				lastActivityAt: [existing?.lastActivityAt, summary.lastActivityAt].filter((t): t is string => Boolean(t)).sort().pop() ?? null,
			});
		}
		return [...byId.values()].sort((a, b) => (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? ""));
	}

	function readHistory(file: string): unknown[] {
		const events: unknown[] = [];
		try {
			const fd = fs.openSync(file, "r");
			let content = "";
			let partial = false;
			try {
				const size = fs.fstatSync(fd).size;
				const start = Math.max(0, size - HISTORY_BYTES);
				partial = start > 0;
				const buffer = Buffer.alloc(size - start);
				fs.readSync(fd, buffer, 0, buffer.length, start);
				content = buffer.toString("utf8");
			} finally {
				fs.closeSync(fd);
			}
			const lines = content.split("\n");
			if (partial) lines.shift();
			for (const line of lines) {
				if (!line.trim()) continue;
				try {
					events.push(...pc.entryToEvents(parseJson(line)));
				} catch {
					/* malformed line: skipped, as the tailer does */
				}
			}
		} catch {
			/* no file yet */
		}
		return events;
	}

	const slimObserved = (event: unknown): unknown =>
		isRecord(event) && event.type === "observed_message" ? { ...event, message: slimMessage(event.message) } : event;

	// ------------------------------------------------------------- event stream ---
	async function eventStream(res: http.ServerResponse, id: string, device: DeviceRecord): Promise<void> {
		res.writeHead(200, {
			"Content-Type": "text/event-stream; charset=utf-8",
			"Cache-Control": "no-store, no-transform",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no",
		});
		res.write(": connected\n\n");
		let ended = false;
		const cleanups: Array<() => unknown> = [];
		const send = (type: string, payload: Readonly<Record<string, unknown>> = {}): void => {
			if (ended) return;
			try {
				res.write(`event: ${type}\ndata: ${JSON.stringify({ sessionId: id, type, ...payload })}\n\n`);
			} catch {
				/* client gone; close handler cleans up */
			}
		};
		const throttle = new UpdateThrottle(250);
		const sendEvent = (event: unknown): void => {
			const slim = slimEvent(event);
			if (slim && throttle.pass(slim)) send("event", { data: slim });
		};
		const stream: EventStreamHandle = {
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
		const cleanup = (): void => {
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
			await terminalStream(bridged, send, throttle, cleanups, () => ended);
			return;
		}

		// A pi child this host (or pi-console's routes) started.
		const proc = pc.getSession(id);
		if (proc?.alive) {
			send("lifecycle", { state: "running", busy: dialogs.busy(proc) });
			// The child's buffered records: only events that carry data.
			const replay: unknown[] = [];
			for (const m of proc.replay ?? []) if (isRecord(m) && m.type === "event" && m.data) replay.push(m.data);
			let tail = replay;
			if (proc.sessionFile && fs.existsSync(proc.sessionFile)) {
				for (const event of readHistory(proc.sessionFile)) send("observed", { data: slimObserved(event) });
				// Persisted messages are in the file; what is still streaming is after the last message_end.
				let start = 0;
				for (let i = replay.length - 1; i >= 0; i--) {
					const data = replay[i];
					if (isRecord(data) && data.type === "message_end") {
						start = i + 1;
						break;
					}
				}
				tail = replay.slice(start);
			}
			for (const data of tail) if (!(isRecord(data) && data.type === "extension_ui_request")) sendEvent(data);
			send("history_end", {});
			for (const dialog of dialogs.open(proc)) send("ui_request", { dialog });
			cleanups.push(
				proc.subscribe((m) => {
					if (!isRecord(m)) return;
					if (m.type === "event") {
						const data: unknown = m.data || {};
						if (isRecord(data) && data.type === "extension_ui_request") {
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
		const sessionFile = summary?.sessionFile;
		const tailer = sessionFile ? pc.acquireTailer(sessionFile) : null;
		if (!sessionFile || !tailer) {
			// Not shared, not running and not on disk (a child that exited without a session
			// file, or an id from a stale list): there is nothing to show or to drive.
			send("lifecycle", { state: summary ? "idle" : "gone" });
			send("history_end", {});
			return;
		}
		send("lifecycle", { state: pc.isFileActive(sessionFile) ? "watching" : "idle" });
		const unsubscribe = tailer.subscribe((m) => {
			if (isRecord(m) && m.type === "observed") send("observed", { data: slimObserved(m.data) });
		});
		send("history_end", {});
		cleanups.push(() => pc.releaseTailer(sessionFile, unsubscribe));
	}

	/** The event stream of a terminal session: its snapshot, then live notices (none twice). */
	async function terminalStream(
		bridged: BridgeSession,
		send: (type: string, payload?: Readonly<Record<string, unknown>>) => void,
		throttle: UpdateThrottle,
		cleanups: Array<() => unknown>,
		isEnded: () => boolean,
	): Promise<void> {
		send("lifecycle", { state: "terminal", session: bridged.summary() });
		const buffered: BridgeNotice[] = [];
		let live = false;
		const forward = (m: BridgeNotice): void => {
			if (m.type === "event") {
				if (throttle.pass(m.data)) send("event", { data: m.data });
			} else if (m.type === "ui_request") send("ui_request", { dialog: m.dialog });
			else if (m.type === "ui_resolved") send("ui_resolved", { id: m.id, by: m.by });
			else if (m.type === "meta") send("meta", { session: m.meta });
			else if (m.type === "notify") send("notify", { message: m.message, level: m.level });
			else send("lifecycle", { state: m.state, reason: m.reason });
		};
		cleanups.push(
			bridged.subscribe((m) => {
				if (live) forward(m);
				else buffered.push(m);
			}),
		);
		// The snapshot is the terminal's reply: anything but an object is treated as empty.
		let snapshot: Record<string, unknown> = { messages: [], seq: -1 };
		try {
			const reply = await bridged.snapshot();
			if (isRecord(reply)) snapshot = reply;
		} catch (error) {
			send("notice", { message: `history unavailable: ${errorMessage(error)}` });
		}
		if (isEnded()) return;
		const messages: unknown[] = Array.isArray(snapshot.messages) ? snapshot.messages : [];
		for (const message of messages) {
			send("observed", { data: { type: "observed_message", message: slimMessage(message) } });
		}
		if (snapshot.streaming) send("streaming", { state: snapshot.streaming });
		send("history_end", {});
		for (const dialog of bridged.dialogs.values()) send("ui_request", { dialog });
		live = true;
		const seq = typeof snapshot.seq === "number" && Number.isInteger(snapshot.seq) ? snapshot.seq : -1;
		for (const m of buffered) if (!(m.type === "event" && m.seq !== undefined && m.seq <= seq)) forward(m);
	}

	// --------------------------------------------------------- terminal sessions ---
	/** A phone's command for a terminal session; false when the route is pi-console's (stats, todos, lens). */
	// Every dialog a phone answers is audited with the device, and the terminal is told, so an
	// approval given from a phone is never anonymous (SEC-5 compensating control).
	function recordPhoneAnswer(device: DeviceRecord, session: string, dialogId: string, dialog: AnsweredDialog | undefined, answer: DialogAnswer): void {
		const record = phoneAnswerRecord(device, session, dialogId, dialog, answer);
		onAudit(record);
		notify?.(`"${device.name}" (${formatDeviceId(device.id)}) answered${typeof record.tier === "string" ? ` a ${record.tier}-tier` : ""} dialog "${String(record.title)}" from the phone: ${String(record.choice)}`);
	}

	async function terminalRoute(req: http.IncomingMessage, res: http.ServerResponse, bridged: BridgeSession, sub: string | undefined, method: string, device: DeviceRecord): Promise<boolean> {
		if (sub === "prompt" && method === "POST") {
			const body = bodyAs(PromptBodySchema, await readJson(req));
			const message = body.message?.trim() ?? "";
			if (!message) throw new ApiError(400, "message is required");
			if (message.length > 100_000) throw new ApiError(413, "message too long");
			const streamingBehavior = str(body.streamingBehavior, "streamingBehavior", { max: 20 });
			if (streamingBehavior !== undefined && !pc.STREAMING_BEHAVIOURS.includes(streamingBehavior)) throw new ApiError(400, "invalid streamingBehavior");
			const data = await bridged.command("prompt", streamingBehavior === undefined ? { message } : { message, streamingBehavior });
			sendJson(res, 202, { queued: true, ...(isRecord(data) ? data : {}) });
			return true;
		}
		if (sub === "abort" && method === "POST") {
			await bridged.command("abort");
			sendJson(res, 202, { aborted: true });
			return true;
		}
		if (sub === "model" && method === "POST") {
			const body = bodyAs(ModelBodySchema, await readJson(req));
			const provider = str(body.provider, "provider", { pattern: pc.MODEL_ARG_RE, required: true });
			const modelId = str(body.modelId, "modelId", { pattern: pc.MODEL_ARG_RE, required: true });
			sendJson(res, 200, { model: await bridged.command("set_model", { provider, modelId }) });
			return true;
		}
		if (sub === "thinking" && method === "POST") {
			const body = bodyAs(ThinkingBodySchema, await readJson(req));
			const level = body.level ?? "";
			if (!pc.THINKING_LEVELS.includes(level)) throw new ApiError(400, "invalid thinking level");
			sendJson(res, 200, { thinking: await bridged.command("set_thinking", { level }), level });
			return true;
		}
		if (sub === "models" && method === "GET") {
			sendJson(res, 200, await bridged.command("models"));
			return true;
		}
		if (sub === "ui-response" && method === "POST") {
			const body = bodyAs(AnswerBodySchema, await readJson(req));
			const dialogId = str(body.dialogId, "dialogId", { max: 64, pattern: /^[A-Za-z0-9_-]+$/, required: true });
			const dialog = bridged.dialogs.get(dialogId);
			if (!dialog) throw new ApiError(404, "that dialog is no longer open");
			const answer = answerFrom(body);
			await bridged.command("ui_response", { dialogId, ...answer, by: { deviceId: device.id, display: formatDeviceId(device.id), name: device.name } });
			recordPhoneAnswer(device, bridged.id, dialogId, dialog, answer);
			sendJson(res, 200, { answered: true });
			return true;
		}
		if ((sub === undefined && method === "DELETE") || sub === "fork" || sub === "new") {
			throw new ApiError(409, "this session runs in a terminal: stop, fork or reset it there (or /remote detach)");
		}
		return false; // not handled here: stats, todos, lens fall through to pi-console
	}

	function answerFrom(body: AnswerBody): DialogAnswer {
		if (body.cancelled === true) return { cancelled: true };
		if (typeof body.confirmed === "boolean") return { confirmed: body.confirmed };
		if (typeof body.value === "string" && body.value.length <= 100_000) return { value: body.value };
		throw new ApiError(400, "an answer needs value, confirmed or cancelled");
	}

	// -------------------------------------------------------------- /api routes ---
	async function apiRoute(req: http.IncomingMessage, res: http.ServerResponse, pathname: string, search: string, device: DeviceRecord): Promise<void> {
		const method = req.method || "GET";
		const parts = pathname.split("/").filter(Boolean); // ["api", ...]

		if (parts[1] === "remote") {
			if (parts[2] === "whoami" && method === "GET") {
				sendJson(res, 200, {
					device: { id: device.id, display: formatDeviceId(device.id), name: device.name, pairedAt: device.pairedAt },
					server: { name: identity.name, serverId: identity.serverId, version },
				});
				return;
			}
			if (parts[2] === "device" && method === "DELETE") {
				devices.remove(device.id);
				auth.revokeDevice(device.id);
				onAudit({ event: "device_unlinked_itself", deviceId: device.id });
				notify?.(`"${device.name}" unlinked itself`);
				sendJson(res, 200, { unlinked: true });
				return;
			}
			sendJson(res, 404, { error: "not found" });
			return;
		}

		if (parts[1] === "sessions" && parts.length === 2 && method === "GET") {
			sendJson(res, 200, { sessions: mergedSessions() });
			return;
		}

		if (parts[1] === "sessions" && parts.length >= 3) {
			const id = pc.parseSessionId(parts[2] ?? "");
			const sub = parts[3];
			if (sub === "events" && method === "GET") {
				await eventStream(res, id, device);
				return;
			}

			const bridged = hub.get(id);
			if (bridged) {
				if (await terminalRoute(req, res, bridged, sub, method, device)) return;
			} else if (sub === "ui-response" && method === "POST") {
				const proc = pc.getSession(id);
				if (!proc?.alive) throw new ApiError(404, "session is not running");
				const body = bodyAs(AnswerBodySchema, await readJson(req));
				const dialogId = str(body.dialogId, "dialogId", { max: 100, pattern: /^[A-Za-z0-9._:-]+$/, required: true });
				if (!dialogs.has(proc, dialogId)) throw new ApiError(404, "that dialog is no longer open");
				const answer = answerFrom(body);
				const dialog = dialogs.open(proc).find((d) => d.id === dialogId);
				proc.respondUi(dialogId, answer);
				dialogs.resolve(proc, dialogId, "phone");
				recordPhoneAnswer(device, id, dialogId, dialog, answer);
				sendJson(res, 200, { answered: true });
				return;
			}
		}

		// Everything else is pi-console's API, unchanged.
		const handled = await pc.handleApi(req, res, { pathname, search }, { authMode: "token" });
		if (!handled) sendJson(res, 404, { error: "not found" });
	}

	// ------------------------------------------------------------------ entry ---
	async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		const { pathname, search } = splitUrl(req.url);
		const address = clientAddress(req);
		try {
			if (!(req.url || "").startsWith("/")) {
				sendJson(res, 400, { error: "bad request" });
				return;
			}
			if (pathname.startsWith("/v1/")) {
				await openRoute(req, res, pathname, search, address);
				return;
			}
			if (pathname.startsWith("/api/")) {
				const device = auth.verify(bearer(req));
				if (!device) {
					sendJson(res, 401, { error: "sign in again" }, { "WWW-Authenticate": 'Bearer realm="pi-remote"' });
					return;
				}
				const method = (req.method || "GET").toUpperCase();
				if (method !== "GET" && method !== "HEAD" && mediaType(req.headers["content-type"]) !== "application/json") {
					sendJson(res, 415, { error: "Content-Type must be application/json" });
					return;
				}
				await apiRoute(req, res, pathname, search, device);
				return;
			}
			sendJson(res, 404, { error: "not found" });
		} catch (error) {
			const status = statusOf(error);
			// A refusal (4xx) or a terminal session that failed or did not answer (502, 504) is
			// the client's to read; anything else is logged and answered with a fixed text.
			if ((status && status < 500) || status === 502 || status === 504) {
				if (!(error instanceof Error)) log(`request failed: ${req.method} ${pathname}: ${String(error)}`);
				sendJson(res, status, { error: clientErrorMessage(error) });
				return;
			}
			log(`request failed: ${req.method} ${pathname}: ${error instanceof Error && error.stack ? error.stack : String(error)}`);
			sendJson(res, 500, { error: "internal error (see the host log)" });
		}
	}

	function closeAllStreams(): void {
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
