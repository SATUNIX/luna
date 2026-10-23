// api.js — thin fetch wrappers around the pi-console REST API (relative paths only).
//
// Every answer is parsed as `unknown` and trusted only after a cheap structural check against
// its wire type (wire.ts); an answer that fails the check is refused like a failed request.
import { authHeaders } from "./auth.ts";
import type * as Wire from "./wire.ts";
import { isArrayOf, isRecord } from "./guards.ts";

/** A failed request: the server's own error message, or a generic one, plus the HTTP status. */
export class ApiError extends Error {
	readonly status: number;

	constructor(message: string, status: number) {
		super(message);
		this.status = status;
	}
}

type Guard<T> = (value: unknown) => value is T;
type Method = "GET" | "POST" | "PUT" | "DELETE";

let unauthorizedHandler: () => void = () => {};

/** Called whenever the server answers 401, so the app can ask for a fresh token. */
export function setUnauthorizedHandler(fn: (() => void) | null | undefined): void {
	unauthorizedHandler = typeof fn === "function" ? fn : () => {};
}

export function notifyUnauthorized(): void {
	unauthorizedHandler();
}

/** The server's `{error}` message, when the body carries one. */
function errorMessage(data: unknown): string | undefined {
	return isRecord(data) && typeof data.error === "string" && data.error ? data.error : undefined;
}

async function request<T>(
	method: Method,
	path: string,
	guard: Guard<T>,
	body?: unknown,
	{ quiet401 = false }: { readonly quiet401?: boolean } = {},
): Promise<T> {
	const headers: Record<string, string> = { ...authHeaders() };
	// No cookies are used, so none are sent: another localhost service's cookies stay out of it.
	const options: RequestInit = { method, headers, cache: "no-store", credentials: "omit" };
	if (method !== "GET") {
		// The server requires JSON on every state-changing request, bodiless ones included.
		headers["Content-Type"] = "application/json";
		options.body = JSON.stringify(body === undefined ? {} : body);
	}
	const res = await fetch(path, options);
	const text = await res.text();
	let data: unknown = null;
	if (text) {
		try {
			data = JSON.parse(text);
		} catch {
			data = null;
		}
	}
	if (!res.ok) {
		if (res.status === 401 && !quiet401) notifyUnauthorized();
		throw new ApiError(errorMessage(data) || `request failed (${res.status})`, res.status);
	}
	if (!guard(data)) throw new ApiError(`request failed (${res.status})`, res.status);
	return data;
}

// ------------------------------------------------------------- narrowing ---
// Each guard checks what the client cannot work without: the container fields and the
// identifying fields of list items. Pass-through and display-only fields stay as they came.

function isString(value: unknown): value is string {
	return typeof value === "string";
}

function isHealth(value: unknown): value is Wire.HealthResponse {
	return (
		isRecord(value) &&
		typeof value.version === "string" &&
		typeof value.uptimeSec === "number" &&
		(value.auth === "token" || value.auth === "off")
	);
}


function isProvider(value: unknown): value is Wire.ProviderInfo {
	return (
		isRecord(value) &&
		typeof value.name === "string" &&
		isArrayOf(value.models, (m): m is Wire.ModelInfo => isRecord(m) && typeof m.id === "string")
	);
}

function isModels(value: unknown): value is Wire.ModelsResponse {
	return (
		isRecord(value) &&
		isArrayOf(value.providers, isProvider) &&
		isRecord(value.default) &&
		typeof value.default.provider === "string" &&
		typeof value.default.model === "string"
	);
}

function isConfig(value: unknown): value is Wire.ConfigResponse {
	return (
		isRecord(value) &&
		isRecord(value.app) &&
		isRecord(value.cli) &&
		isRecord(value.settings) &&
		isRecord(value.paths) &&
		Array.isArray(value.paths.agentDirs) &&
		isRecord(value.lens) &&
		isArrayOf(value.models, isProvider)
	);
}

function isKitEntry(value: unknown): value is Wire.KitEntry {
	return isRecord(value) && typeof value.name === "string";
}

function isPrompts(value: unknown): value is Wire.PromptsResponse {
	return isRecord(value) && isArrayOf(value.prompts, isKitEntry);
}

function isSkills(value: unknown): value is Wire.SkillsResponse {
	return isRecord(value) && isArrayOf(value.skills, isKitEntry);
}

function isCwds(value: unknown): value is Wire.CwdsResponse {
	return isRecord(value) && isArrayOf(value.cwds, isString);
}

function isAgentSummary(value: unknown): value is Wire.AgentSummary {
	return (
		isRecord(value) &&
		typeof value.name === "string" &&
		(value.source === "user" || value.source === "project") &&
		isArrayOf(value.tools, isString)
	);
}

function isAgents(value: unknown): value is Wire.AgentsResponse {
	return isRecord(value) && isArrayOf(value.agents, isAgentSummary) && isArrayOf(value.tools, isString);
}

function isAgentRecord(value: unknown): value is Wire.AgentRecord {
	return isAgentSummary(value) && isRecord(value) && typeof value.body === "string";
}

function isAgent(value: unknown): value is Wire.AgentResponse {
	return isRecord(value) && (value.agent === null || isAgentRecord(value.agent));
}

function isSessionSummary(value: unknown): value is Wire.SessionSummary {
	return isRecord(value) && typeof value.id === "string" && typeof value.status === "string";
}

function isSessions(value: unknown): value is Wire.SessionsResponse {
	return isRecord(value) && isArrayOf(value.sessions, isSessionSummary);
}

function isSession(value: unknown): value is Wire.SessionResponse {
	return isRecord(value) && isSessionSummary(value.session);
}

function isStats(value: unknown): value is Wire.StatsResponse {
	return isRecord(value) && isRecord(value.stats) && typeof value.stats.live === "boolean";
}

function isTodos(value: unknown): value is Wire.TodosResponse {
	return (
		isRecord(value) &&
		typeof value.exists === "boolean" &&
		isArrayOf(
			value.todos,
			(t): t is Wire.TodoItem => isRecord(t) && typeof t.text === "string" && typeof t.state === "string",
		)
	);
}

// Acknowledgements (and the token check): the client reads nothing from them, so a JSON object whose optional flags
// (when present) have the declared type is enough.
function isOptionalBoolean(value: Record<string, unknown>, key: string): boolean {
	return value[key] === undefined || typeof value[key] === "boolean";
}

function isDeleteAgent(value: unknown): value is Wire.DeleteAgentResponse {
	return (
		isRecord(value) &&
		isOptionalBoolean(value, "deleted") &&
		(value.name === undefined || typeof value.name === "string") &&
		(value.source === undefined || value.source === "user" || value.source === "project")
	);
}

function isAuthCheck(value: unknown): value is Wire.AuthCheckResponse {
	return isRecord(value) && isOptionalBoolean(value, "authenticated");
}

function isPromptAck(value: unknown): value is Wire.PromptResponse {
	return isRecord(value) && isOptionalBoolean(value, "queued");
}

function isAbortAck(value: unknown): value is Wire.AbortResponse {
	return isRecord(value) && isOptionalBoolean(value, "aborted");
}

function isStopAck(value: unknown): value is Wire.StopResponse {
	return isRecord(value) && isOptionalBoolean(value, "stopping");
}

function isThinkingAck(value: unknown): value is Wire.ThinkingResponse {
	return isRecord(value) && (value.level === undefined || isThinkingLevel(value.level));
}

/** POST model / fork / new: the payload is pi's own answer, passed through unchecked. */
function isPiAnswer(value: unknown): value is Wire.ModelResponse & Wire.ForkResponse & Wire.ResetResponse {
	return isRecord(value);
}

const THINKING_LEVELS: readonly string[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

function isThinkingLevel(value: unknown): value is Wire.ThinkingLevel {
	return typeof value === "string" && THINKING_LEVELS.includes(value);
}

function isLens(value: unknown): value is Wire.LensResponse {
	return (
		isRecord(value) &&
		isRecord(value.lens) &&
		typeof value.lens.available === "boolean" &&
		Array.isArray(value.lens.files)
	);
}

// ------------------------------------------------------------------- api ---
const enc = encodeURIComponent;

const agentPath = (name: string, source?: string | null): string =>
	`/api/agents/${enc(name)}${source ? `?source=${enc(source)}` : ""}`;

export const api = {
	health: (): Promise<Wire.HealthResponse> => request("GET", "/api/health", isHealth),
	// Validates the token currently held (or just typed) without triggering the 401 handler.
	authCheck: (): Promise<Wire.AuthCheckResponse> =>
		request("GET", "/api/auth", isAuthCheck, undefined, { quiet401: true }),
	config: (): Promise<Wire.ConfigResponse> => request("GET", "/api/config", isConfig),
	prompts: (): Promise<Wire.PromptsResponse> => request("GET", "/api/prompts", isPrompts),
	skills: (): Promise<Wire.SkillsResponse> => request("GET", "/api/skills", isSkills),
	models: (): Promise<Wire.ModelsResponse> => request("GET", "/api/models", isModels),
	cwds: (): Promise<Wire.CwdsResponse> => request("GET", "/api/cwds", isCwds),

	agents: (): Promise<Wire.AgentsResponse> => request("GET", "/api/agents", isAgents),
	agent: (name: string, source?: string | null): Promise<Wire.AgentResponse> =>
		request("GET", agentPath(name, source), isAgent),
	createAgent: (payload: Wire.AgentInput): Promise<Wire.AgentResponse> =>
		request("POST", "/api/agents", isAgent, payload),
	updateAgent: (name: string, payload: Wire.AgentInput): Promise<Wire.AgentResponse> =>
		request("PUT", `/api/agents/${enc(name)}`, isAgent, payload),
	deleteAgent: (name: string, source?: string | null): Promise<Wire.DeleteAgentResponse> =>
		request("DELETE", agentPath(name, source), isDeleteAgent),

	sessions: (): Promise<Wire.SessionsResponse> => request("GET", "/api/sessions", isSessions),
	session: (id: string): Promise<Wire.SessionResponse> =>
		request("GET", `/api/sessions/${enc(id)}`, isSession),
	sessionStats: (id: string): Promise<Wire.StatsResponse> =>
		request("GET", `/api/sessions/${enc(id)}/stats`, isStats),
	sessionTodos: (id: string): Promise<Wire.TodosResponse> =>
		request("GET", `/api/sessions/${enc(id)}/todos`, isTodos),
	sessionLens: (id: string): Promise<Wire.LensResponse> =>
		request("GET", `/api/sessions/${enc(id)}/lens`, isLens),

	createSession: (config: Wire.SpawnRequest): Promise<Wire.SessionResponse> =>
		request("POST", "/api/sessions", isSession, config),
	prompt: (
		id: string,
		message: string,
		streamingBehavior?: Wire.StreamingBehaviour,
	): Promise<Wire.PromptResponse> =>
		request("POST", `/api/sessions/${enc(id)}/prompt`, isPromptAck, {
			message,
			streamingBehavior,
		}),
	abort: (id: string): Promise<Wire.AbortResponse> =>
		request("POST", `/api/sessions/${enc(id)}/abort`, isAbortAck),
	stop: (id: string): Promise<Wire.StopResponse> =>
		request("DELETE", `/api/sessions/${enc(id)}`, isStopAck),
	setModel: (id: string, provider: string, modelId: string): Promise<Wire.ModelResponse> =>
		request("POST", `/api/sessions/${enc(id)}/model`, isPiAnswer, { provider, modelId }),
	setThinking: (id: string, level: Wire.ThinkingLevel): Promise<Wire.ThinkingResponse> =>
		request("POST", `/api/sessions/${enc(id)}/thinking`, isThinkingAck, { level }),
	fork: (id: string, entryId?: string): Promise<Wire.ForkResponse> =>
		request("POST", `/api/sessions/${enc(id)}/fork`, isPiAnswer, { entryId }),
	newSessionInPlace: (id: string): Promise<Wire.ResetResponse> =>
		request("POST", `/api/sessions/${enc(id)}/new`, isPiAnswer),
};
