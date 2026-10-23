// routes.ts — REST API and the SSE event stream for pi-console.
import * as fs from "node:fs";
import type { IncomingHttpHeaders } from "node:http";
import {
	literal,
	object,
	optional,
	safeParse,
	string,
	ValidationError,
	type OptionalSchema,
	type Schema,
} from "../../core/lib/guard.ts";
import { listAgents, type AgentDefinition } from "./agents.ts";
import {
	KNOWN_TOOLS,
	createAgent,
	deleteAgent,
	getAgent,
	updateAgent,
	type AgentRecord,
} from "./agentstore.ts";
import { configInfo, listPrompts, listSkills, type KitEntry } from "./configinfo.ts";
import { sessionLens, type SessionLens } from "./lens.ts";
import { listModels } from "./models.ts";
import { listCwds, listSessions } from "./sessions.ts";
import {
	createSession,
	getSession,
	listLiveSessions,
	type PiRpcProcess,
	type RpcCommand,
	type SessionMessage,
} from "./spawn.ts";
import { sessionStats, type SessionStats } from "./stats.ts";
import { readTodos } from "./todos.ts";
import {
	acquireTailer,
	isFileActive,
	releaseTailer,
	type ObservedMessage,
} from "./tailer.ts";
import { DEFAULT_CWD } from "./config.ts";
import { mediaType, type RequestLike } from "./security.ts";
import {
	ENTRY_ID_RE,
	HttpError,
	MODEL_ARG_RE,
	isStreamingBehaviour,
	isThinkingLevel,
	parseSessionId,
	requireObject,
	type ThinkingLevel,
} from "./validate.ts";

const VERSION = "0.1.0";

/** Largest JSON request body accepted, in bytes. */
export const MAX_BODY_BYTES = 1_000_000;

/** The parts of an http.IncomingMessage the routes read (a test double in the API smoke). */
export interface ApiRequest extends RequestLike {
	readonly url?: string | undefined;
	on(event: "data", listener: (chunk: Buffer) => void): unknown;
	on(event: "end", listener: () => void): unknown;
	on(event: "error", listener: (error: Error) => void): unknown;
}

/** The parts of an http.ServerResponse the routes use: JSON replies and the SSE stream. */
export interface ApiResponse {
	writeHead(status: number, headers: Record<string, string | number>): unknown;
	write(chunk: string): unknown;
	end(body?: string): unknown;
	on(event: "close" | "error", listener: () => void): unknown;
}

/** The request target, already split by the caller (server.ts, remote/api.ts). */
export interface ApiUrl {
	readonly pathname: string;
	/** The raw query ("?..."); when absent it is recovered from req.url. */
	readonly search?: string | undefined;
}

export interface ApiContext {
	/** Only reported by /api/health. */
	readonly authMode?: "token" | "off" | undefined;
}

/** The stream's own lifecycle record: what the session is doing when a viewer attaches. */
interface LifecycleMessage {
	readonly type: "lifecycle";
	readonly state: "running" | "watching" | "idle";
	readonly code: null;
}

function lifecycle(state: LifecycleMessage["state"]): LifecycleMessage {
	return { type: "lifecycle", state, code: null };
}

/** One message on a session's event stream: the stream's own, a live child's, or a tailer's. */
type StreamMessage = LifecycleMessage | SessionMessage | ObservedMessage;

/** One SSE frame's `data:` payload: a stream message tagged with its session. */
export type StreamPayload = StreamMessage & { readonly sessionId: string };

export type SessionStatus = "idle" | "external" | "running" | "exited";

/** One row of the session list: a session file, a live child, or both merged. */
export interface SessionSummary {
	readonly id: string;
	readonly cwd: string | null;
	readonly sessionFile: string | null;
	readonly startedAt: string | null;
	readonly endedAt: null;
	readonly lastActivityAt: string;
	readonly entryCount: number;
	readonly preview: string;
	readonly status: SessionStatus;
	readonly externalActive?: boolean;
	readonly agent?: string | null;
}

// Response bodies built in this file (the others are the producing module's own types). The
// client's view of them is src/public/js/wire.ts; wire-contract.ts keeps the two in step.
export interface HealthResponse {
	readonly ok: true;
	readonly version: string;
	readonly uptimeSec: number;
	readonly auth: "token" | "off";
}
export interface AuthCheckResponse { readonly authenticated: true }
export interface PromptsResponse { readonly prompts: KitEntry[] }
export interface SkillsResponse { readonly skills: KitEntry[] }
export interface CwdsResponse { readonly cwds: string[] }
export interface AgentsResponse { readonly agents: AgentDefinition[]; readonly tools: readonly string[] }
export interface AgentResponse { readonly agent: AgentRecord | null }
export interface SessionsResponse { readonly sessions: SessionSummary[] }
export interface SessionResponse { readonly session: SessionSummary }
export interface StopResponse { readonly stopping: true }
export interface StatsResponse { readonly stats: SessionStats }
export interface LensResponse { readonly lens: SessionLens }
export interface PromptResponse { readonly queued: true }
export interface AbortResponse { readonly aborted: true }
export interface ModelResponse { readonly model: unknown }
export interface ThinkingResponse { readonly thinking: unknown; readonly level: ThinkingLevel }
export interface ForkResponse { readonly fork: unknown }
export interface ResetResponse { readonly reset: unknown }

function sendJson(
	res: ApiResponse,
	status: number,
	body: unknown,
	extraHeaders: Record<string, string> = {},
): void {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-store",
		"Content-Length": Buffer.byteLength(payload),
		...extraHeaders,
	});
	res.end(payload);
}

/**
 * Read a bounded JSON object body. The size is enforced on the declared Content-Length
 * first and again on the bytes actually received (chunked bodies have no length), and the
 * bytes are decoded once at the end so a multi-byte character split across chunks survives.
 * The result is an object whose values are still unchecked: each route parses its own schema.
 */
function readBody(req: ApiRequest): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		const headers: IncomingHttpHeaders = req.headers ?? {};
		if (mediaType(headers["content-type"]) !== "application/json") {
			reject(new HttpError(415, "Content-Type must be application/json"));
			return;
		}
		const declared = Number(headers["content-length"]);
		if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
			reject(new HttpError(413, "request body too large"));
			return;
		}
		const chunks: Buffer[] = [];
		let size = 0;
		let settled = false;
		req.on("data", (chunk) => {
			if (settled) return;
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				settled = true;
				chunks.length = 0;
				reject(new HttpError(413, "request body too large"));
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			if (settled) return;
			settled = true;
			const text = Buffer.concat(chunks).toString("utf8");
			if (!text.trim()) {
				resolve({});
				return;
			}
			let parsed: unknown;
			try {
				parsed = JSON.parse(text);
			} catch {
				reject(new HttpError(400, "invalid JSON body"));
				return;
			}
			try {
				resolve(requireObject(parsed));
			} catch (error) {
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
		req.on("error", (error) => {
			if (settled) return;
			settled = true;
			reject(error);
		});
	});
}

// ------------------------------------------------------------- body schemas ---
// One schema per route body. A field of the wrong type is refused with a 400 and never coerced;
// keys a schema does not name are dropped, so nothing else in a body can reach a pi child.

/** validate.ts's optionalString rule: undefined, null and "" mean the field is absent. */
function blankable<T>(inner: Schema<T>): OptionalSchema<T> {
	return {
		optional: true,
		expected: `${inner.expected} (optional)`,
		parse: (value, path = "value") =>
			value === undefined || value === null || value === "" ? undefined : inner.parse(value, path),
	};
}

/** A value a type guard accepts as it is. */
function accepted<T>(expected: string, test: (value: unknown) => value is T): Schema<T> {
	return {
		expected,
		parse(value, path = "value") {
			if (!test(value)) throw new ValidationError(path, `expected ${expected}`);
			return value;
		},
	};
}

const ThinkingLevelSchema = accepted("thinking level", isThinkingLevel);
const StreamingBehaviourSchema = accepted("streaming behaviour", isStreamingBehaviour);
const ModelArgSchema = string({ pattern: MODEL_ARG_RE });

/**
 * `schema` applied to a request body. The failing field becomes a 400 with the message the route
 * has always given for it (`messages`), or "invalid <field>".
 */
function parseBody<T>(
	schema: Schema<T>,
	body: unknown,
	messages: ReadonlyMap<string, string> = new Map(),
): T {
	const result = safeParse(schema, body, "body");
	if (result.ok) return result.value;
	const field = result.error.path.replace(/^body\.?/, "");
	throw new HttpError(400, messages.get(field) ?? `invalid ${field}`);
}

/** POST /api/sessions. The content of each field is checked again by validate.ts's sanitizeSpawnConfig. */
const SpawnBodySchema = object({
	cwd: blankable(string()),
	thinking: blankable(ThinkingLevelSchema),
	agentSource: blankable(literal("user", "project")),
	agent: blankable(string()),
	provider: blankable(ModelArgSchema),
	model: blankable(ModelArgSchema),
});
const SPAWN_MESSAGES = new Map([
	["cwd", "cwd must be an absolute directory path"],
	["thinking", "invalid thinking level"],
	["agentSource", "invalid agent source"],
]);

/** PUT /api/agents/:name: only `source` is read here; agentstore.ts validates the agent fields. */
const AgentUpdateBodySchema = object({ source: optional(string()) });
const AGENT_MESSAGES = new Map([["source", "invalid agent source"]]);

const PromptBodySchema = object({
	message: string(),
	streamingBehavior: blankable(StreamingBehaviourSchema),
});
const PROMPT_MESSAGES = new Map([["message", "message is required"]]);

const ModelBodySchema = object({
	provider: blankable(ModelArgSchema),
	modelId: blankable(ModelArgSchema),
});

const ThinkingBodySchema = object({ level: ThinkingLevelSchema });
const THINKING_MESSAGES = new Map([["level", "invalid thinking level"]]);

const ForkBodySchema = object({
	entryId: blankable(string({ maxLength: 100, pattern: ENTRY_ID_RE })),
});

// ---------------------------------------------------------------- sessions ---
function procSummary(proc: PiRpcProcess): SessionSummary {
	return {
		id: proc.publicId,
		cwd: proc.cwd,
		sessionFile: proc.sessionFile,
		startedAt: new Date(proc.startedAt).toISOString(),
		endedAt: null,
		lastActivityAt: new Date().toISOString(),
		entryCount: 0,
		preview: "",
		status: proc.alive ? "running" : "exited",
		agent: proc.agentName,
	};
}

/** Disk sessions (idle) merged with live child processes (running).
 * A session recently written by ANOTHER process (e.g. the CLI) is marked "external" so the
 * UI can show it as live rather than idle. */
function mergedSessions(): SessionSummary[] {
	const byId = new Map<string, SessionSummary>();
	for (const s of listSessions()) {
		const externalActive =
			Boolean(s.sessionFile) && isFileActive(s.sessionFile);
		byId.set(s.id, {
			...s,
			status: externalActive ? "external" : "idle",
			externalActive,
		});
	}
	for (const proc of listLiveSessions()) {
		if (!proc.alive) continue; // exited children fall back to their on-disk view
		const id = proc.publicId;
		const existing = byId.get(id);
		if (existing) {
			byId.set(id, {
				...existing,
				status: "running",
				externalActive: false,
				cwd: existing.cwd || proc.cwd,
				agent: proc.agentName,
			});
		} else {
			byId.set(id, procSummary(proc));
		}
	}
	return [...byId.values()].sort((a, b) =>
		b.lastActivityAt.localeCompare(a.lastActivityAt),
	);
}

function findSummary(id: string): SessionSummary | null {
	return mergedSessions().find((s) => s.id === id) ?? null;
}

/** Resume an idle session by spawning a child bound to its session file.
 * Refuses when another process is actively writing the session (two writers would clash). */
async function ensureLive(id: string): Promise<PiRpcProcess | null> {
	const existing = getSession(id);
	if (existing?.alive) return existing;
	const summary = findSummary(id);
	if (!summary) return null;
	if (summary.sessionFile && !fs.existsSync(summary.sessionFile)) return null;
	if (summary.sessionFile && isFileActive(summary.sessionFile)) {
		throw new HttpError(
			409,
			"session is active in another process (CLI) — watch it here, or wait for it to finish",
		);
	}
	return createSession({
		cwd: summary.cwd || DEFAULT_CWD,
		resumeSessionFile: summary.sessionFile,
	});
}

/** Recover the raw query string ("?...") when the caller did not pass one. */
function searchOf(req: ApiRequest): string {
	const raw = req.url || "";
	const q = raw.indexOf("?");
	return q === -1 ? "" : raw.slice(q);
}

/** An error's message for the server's own log. */
function describeError(error: unknown): string {
	return error instanceof Error && error.message ? error.message : String(error);
}

/**
 * Route one /api request. Returns true when the request was handled.
 *
 * Authentication, Host/Origin checks and content-type enforcement happen in server.ts
 * (security.ts evaluateRequest) before this is called; this function validates the
 * request's content and never forwards anything to a pi child except the fixed command
 * shapes built below (spawn.ts additionally enforces an allowlist of RPC command types).
 * `ctx.authMode` is only reported by /api/health.
 */
export async function handleApi(
	req: ApiRequest,
	res: ApiResponse,
	url: ApiUrl,
	ctx: ApiContext = {},
): Promise<boolean> {
	const { pathname } = url;
	if (!pathname.startsWith("/api/")) return false;

	const parts = pathname.split("/").filter(Boolean); // ["api", ...]
	const [, section, segment, sub] = parts;
	const method = req.method || "GET";
	// `??`: an explicitly supplied empty search is honoured, while callers that only
	// forward a pathname still get the query from req.url.
	const search = url.search ?? searchOf(req);
	const query = new URLSearchParams((search || "").replace(/^\?/, ""));

	try {
		if (section === "health" && parts.length === 2 && method === "GET") {
			return (
				sendJson(res, 200, {
					ok: true,
					version: VERSION,
					uptimeSec: Math.round(process.uptime()),
					// Tells the page whether to ask for a token: "token" unless the operator
					// explicitly started the server with PI_CONSOLE_AUTH=off.
					auth: ctx.authMode === "off" ? "off" : "token",
				} satisfies HealthResponse),
				true
			);
		}

		// Reaching this route means the request already passed the token check, so the
		// login page uses it to validate a token the operator typed in.
		if (section === "auth" && parts.length === 2 && method === "GET") {
			return sendJson(res, 200, { authenticated: true } satisfies AuthCheckResponse), true;
		}

		if (section === "config" && parts.length === 2 && method === "GET") {
			return sendJson(res, 200, configInfo()), true;
		}

		if (section === "prompts" && parts.length === 2 && method === "GET") {
			return sendJson(res, 200, { prompts: listPrompts() } satisfies PromptsResponse), true;
		}

		if (section === "skills" && parts.length === 2 && method === "GET") {
			return sendJson(res, 200, { skills: listSkills() } satisfies SkillsResponse), true;
		}

		if (section === "models" && parts.length === 2 && method === "GET") {
			return sendJson(res, 200, listModels()), true;
		}

		if (section === "cwds" && parts.length === 2 && method === "GET") {
			return sendJson(res, 200, { cwds: listCwds() } satisfies CwdsResponse), true;
		}

		// ------------------------------------------------------------- agents ----
		if (section === "agents") {
			if (parts.length === 2) {
				if (method === "GET")
					return (
						sendJson(res, 200, { agents: listAgents(), tools: KNOWN_TOOLS } satisfies AgentsResponse),
						true
					);
				if (method === "POST") {
					// agentstore.ts owns the agent schema and parses the body itself.
					const body = await readBody(req);
					const agent = createAgent(body);
					return sendJson(res, 201, { agent } satisfies AgentResponse), true;
				}
			}
			if (parts.length === 3) {
				let name: string;
				try {
					name = decodeURIComponent(segment ?? "");
				} catch {
					// Malformed percent-encoding is the client's mistake, not a server failure.
					throw new HttpError(400, "invalid agent name");
				}
				const source = query.get("source") || undefined;
				if (method === "GET") {
					const agent = getAgent(name, source);
					if (!agent)
						return sendJson(res, 404, { error: "agent not found" }), true;
					return sendJson(res, 200, { agent } satisfies AgentResponse), true;
				}
				if (method === "PUT") {
					const body = await readBody(req);
					// A body source of the wrong type is refused, not read as "absent" (which would
					// fall back to the query's source).
					const fields = parseBody(AgentUpdateBodySchema, body, AGENT_MESSAGES);
					const agent = updateAgent(name, {
						...body,
						source: fields.source || source,
					});
					return sendJson(res, 200, { agent } satisfies AgentResponse), true;
				}
				if (method === "DELETE") {
					return sendJson(res, 200, deleteAgent(name, source)), true;
				}
			}
		}

		// ----------------------------------------------------------- sessions ----
		if (section === "sessions" && parts.length === 2) {
			if (method === "GET")
				return sendJson(res, 200, { sessions: mergedSessions() } satisfies SessionsResponse), true;
			if (method === "POST") {
				const body = await readBody(req);
				const proc = await createSession(
					parseBody(SpawnBodySchema, body, SPAWN_MESSAGES),
				);
				return sendJson(res, 201, { session: procSummary(proc) } satisfies SessionResponse), true;
			}
		}

		if (section === "sessions" && parts.length >= 3) {
			const id = parseSessionId(segment);

			if (parts.length === 3 && method === "GET") {
				const summary = findSummary(id);
				if (!summary)
					return sendJson(res, 404, { error: "session not found" }), true;
				return sendJson(res, 200, { session: summary } satisfies SessionResponse), true;
			}

			if (parts.length === 3 && method === "DELETE") {
				const proc = getSession(id);
				if (!proc)
					return sendJson(res, 404, { error: "session is not running" }), true;
				proc.kill();
				return sendJson(res, 202, { stopping: true } satisfies StopResponse), true;
			}

			if (sub === "events" && method === "GET") return handleSse(res, id), true;

			if (sub === "stats" && method === "GET") {
				const summary = findSummary(id);
				if (!summary)
					return sendJson(res, 404, { error: "session not found" }), true;
				const proc = getSession(id);
				return (
					sendJson(res, 200, { stats: await sessionStats(summary, proc) } satisfies StatsResponse), true
				);
			}

			if (sub === "todos" && method === "GET") {
				const summary = findSummary(id);
				if (!summary)
					return sendJson(res, 404, { error: "session not found" }), true;
				return (
					sendJson(res, 200, readTodos(summary.cwd || DEFAULT_CWD, id)), true
				);
			}

			if (sub === "lens" && method === "GET") {
				return sendJson(res, 200, { lens: sessionLens(id) } satisfies LensResponse), true;
			}

			if (sub === "prompt" && method === "POST") {
				const body = await readBody(req);
				// Validate everything before ensureLive(), which can spawn a child.
				const fields = parseBody(PromptBodySchema, body, PROMPT_MESSAGES);
				const message = fields.message.trim();
				if (!message)
					return sendJson(res, 400, { error: "message is required" }), true;
				const proc = await ensureLive(id);
				if (!proc)
					return sendJson(res, 404, { error: "session not found" }), true;
				const cmd: RpcCommand = fields.streamingBehavior === undefined
					? { type: "prompt", message }
					: { type: "prompt", message, streamingBehavior: fields.streamingBehavior };
				proc.send(cmd).catch(() => {});
				return sendJson(res, 202, { queued: true } satisfies PromptResponse), true;
			}

			if (sub === "abort" && method === "POST") {
				const proc = getSession(id);
				if (!proc)
					return sendJson(res, 404, { error: "session is not running" }), true;
				proc.send({ type: "abort" }).catch(() => {});
				return sendJson(res, 202, { aborted: true } satisfies AbortResponse), true;
			}

			if (sub === "model" && method === "POST") {
				const body = await readBody(req);
				const { provider, modelId } = parseBody(ModelBodySchema, body);
				if (provider === undefined || modelId === undefined)
					return (
						sendJson(res, 400, { error: "provider and modelId are required" }),
						true
					);
				const proc = await ensureLive(id);
				if (!proc)
					return sendJson(res, 404, { error: "session not found" }), true;
				const data = await proc.send({
					type: "set_model",
					provider,
					modelId,
				});
				return sendJson(res, 200, { model: data } satisfies ModelResponse), true;
			}

			if (sub === "thinking" && method === "POST") {
				const body = await readBody(req);
				// The value itself must be a level: ["high"] or {toString} is refused, never coerced.
				const { level } = parseBody(ThinkingBodySchema, body, THINKING_MESSAGES);
				const proc = await ensureLive(id);
				if (!proc)
					return sendJson(res, 404, { error: "session not found" }), true;
				const data = await proc.send({ type: "set_thinking_level", level });
				return sendJson(res, 200, { thinking: data, level } satisfies ThinkingResponse), true;
			}

			if (sub === "fork" && method === "POST") {
				const body = await readBody(req);
				const { entryId } = parseBody(ForkBodySchema, body);
				const proc = await ensureLive(id);
				if (!proc)
					return sendJson(res, 404, { error: "session not found" }), true;
				const data = await proc.send(
					entryId === undefined ? { type: "fork" } : { type: "fork", entryId },
				);
				return sendJson(res, 200, { fork: data } satisfies ForkResponse), true;
			}

			if (sub === "new" && method === "POST") {
				const proc = await ensureLive(id);
				if (!proc)
					return sendJson(res, 404, { error: "session not found" }), true;
				const data = await proc.send({ type: "new_session" });
				return sendJson(res, 200, { reset: data } satisfies ResetResponse), true;
			}
		}

		return (
			sendJson(res, 404, { error: `no route for ${method} ${pathname}` }), true
		);
	} catch (err) {
		// Only an HttpError carries a message written for the client. Anything else is unexpected: its text can hold file
		// paths and internals, so the client gets a generic answer and the detail goes to the server's own log.
		if (!(err instanceof HttpError)) {
			process.stderr.write(`pi-console: request failed: ${describeError(err)}\n`);
			return sendJson(res, 500, { error: "internal error (see the console log)" }), true;
		}
		const status = err.statusCode || 400;
		return (
			sendJson(
				res,
				status,
				{ error: err.message },
				// An oversized body may still be arriving: do not keep the connection for reuse.
				status === 413 ? { Connection: "close" } : {},
			),
			true
		);
	}
}

// Open SSE responses, so shutdown can end them (otherwise server.close() waits on them).
const openStreams = new Set<ApiResponse>();

/** End every open event stream (shutdown). Their close handlers release subscriptions. */
export function closeAllStreams(): void {
	for (const res of [...openStreams]) {
		try {
			res.end();
		} catch {
			/* already gone */
		}
	}
	openStreams.clear();
}

function handleSse(res: ApiResponse, id: string): void {
	res.writeHead(200, {
		"Content-Type": "text/event-stream; charset=utf-8",
		"Cache-Control": "no-store, no-transform",
		Connection: "keep-alive",
		"X-Accel-Buffering": "no",
	});
	res.write(": connected\n\n");
	openStreams.add(res);

	const write = (message: StreamMessage): void => {
		try {
			res.write(
				`event: ${message.type}\ndata: ${JSON.stringify({ sessionId: id, ...message } satisfies StreamPayload)}\n\n`,
			);
		} catch {
			/* client vanished */
		}
	};

	const proc = getSession(id);
	const summary = findSummary(id);
	let unsubscribe: () => void = () => {};
	let cleanupTailer: (() => void) | null = null;

	if (proc?.alive) {
		write(lifecycle("running"));
		for (const message of proc.replay) write(message);
		unsubscribe = proc.subscribe(write);
	} else if (summary?.sessionFile) {
		// No child of ours: follow the session file so a session running in the CLI is live here.
		const { sessionFile } = summary;
		const tailer = acquireTailer(sessionFile);
		if (tailer) {
			write(lifecycle("watching"));
			const unsubscribeTailer = tailer.subscribe(write);
			unsubscribe = unsubscribeTailer;
			cleanupTailer = () => {
				releaseTailer(sessionFile, unsubscribeTailer);
			};
		} else {
			write(lifecycle("idle"));
		}
	} else {
		write(lifecycle("idle"));
	}

	const heartbeat = setInterval(() => {
		try {
			res.write(": ping\n\n");
		} catch {
			/* ignore */
		}
	}, 15000);

	let cleaned = false;
	const cleanup = (): void => {
		if (cleaned) return; // 'error' and 'close' can both fire
		cleaned = true;
		unsubscribe();
		if (cleanupTailer) cleanupTailer();
		clearInterval(heartbeat);
		openStreams.delete(res);
	};
	res.on("close", cleanup);
	res.on("error", cleanup);
}
