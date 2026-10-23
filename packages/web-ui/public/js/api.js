// Generated from packages/web-ui/src/public/js/api.ts by `npm run build:web` (internal/docs/adr/0002).
// Edit the TypeScript source, not this file.
// api.js — thin fetch wrappers around the pi-console REST API (relative paths only).
//
// Every answer is parsed as `unknown` and trusted only after a cheap structural check against
// its wire type (wire.ts); an answer that fails the check is refused like a failed request.
import { authHeaders } from "./auth.js";
import { isArrayOf, isRecord } from "./guards.js";
/** A failed request: the server's own error message, or a generic one, plus the HTTP status. */
export class ApiError extends Error {
    status;
    constructor(message, status) {
        super(message);
        this.status = status;
    }
}
let unauthorizedHandler = () => { };
/** Called whenever the server answers 401, so the app can ask for a fresh token. */
export function setUnauthorizedHandler(fn) {
    unauthorizedHandler = typeof fn === "function" ? fn : () => { };
}
export function notifyUnauthorized() {
    unauthorizedHandler();
}
/** The server's `{error}` message, when the body carries one. */
function errorMessage(data) {
    return isRecord(data) && typeof data.error === "string" && data.error ? data.error : undefined;
}
async function request(method, path, guard, body, { quiet401 = false } = {}) {
    const headers = { ...authHeaders() };
    // No cookies are used, so none are sent: another localhost service's cookies stay out of it.
    const options = { method, headers, cache: "no-store", credentials: "omit" };
    if (method !== "GET") {
        // The server requires JSON on every state-changing request, bodiless ones included.
        headers["Content-Type"] = "application/json";
        options.body = JSON.stringify(body === undefined ? {} : body);
    }
    const res = await fetch(path, options);
    const text = await res.text();
    let data = null;
    if (text) {
        try {
            data = JSON.parse(text);
        }
        catch {
            data = null;
        }
    }
    if (!res.ok) {
        if (res.status === 401 && !quiet401)
            notifyUnauthorized();
        throw new ApiError(errorMessage(data) || `request failed (${res.status})`, res.status);
    }
    if (!guard(data))
        throw new ApiError(`request failed (${res.status})`, res.status);
    return data;
}
// ------------------------------------------------------------- narrowing ---
// Each guard checks what the client cannot work without: the container fields and the
// identifying fields of list items. Pass-through and display-only fields stay as they came.
function isString(value) {
    return typeof value === "string";
}
function isHealth(value) {
    return (isRecord(value) &&
        typeof value.version === "string" &&
        typeof value.uptimeSec === "number" &&
        (value.auth === "token" || value.auth === "off"));
}
function isProvider(value) {
    return (isRecord(value) &&
        typeof value.name === "string" &&
        isArrayOf(value.models, (m) => isRecord(m) && typeof m.id === "string"));
}
function isModels(value) {
    return (isRecord(value) &&
        isArrayOf(value.providers, isProvider) &&
        isRecord(value.default) &&
        typeof value.default.provider === "string" &&
        typeof value.default.model === "string");
}
function isConfig(value) {
    return (isRecord(value) &&
        isRecord(value.app) &&
        isRecord(value.cli) &&
        isRecord(value.settings) &&
        isRecord(value.paths) &&
        Array.isArray(value.paths.agentDirs) &&
        isRecord(value.lens) &&
        isArrayOf(value.models, isProvider));
}
function isKitEntry(value) {
    return isRecord(value) && typeof value.name === "string";
}
function isPrompts(value) {
    return isRecord(value) && isArrayOf(value.prompts, isKitEntry);
}
function isSkills(value) {
    return isRecord(value) && isArrayOf(value.skills, isKitEntry);
}
function isCwds(value) {
    return isRecord(value) && isArrayOf(value.cwds, isString);
}
function isAgentSummary(value) {
    return (isRecord(value) &&
        typeof value.name === "string" &&
        (value.source === "user" || value.source === "project") &&
        isArrayOf(value.tools, isString));
}
function isAgents(value) {
    return isRecord(value) && isArrayOf(value.agents, isAgentSummary) && isArrayOf(value.tools, isString);
}
function isAgentRecord(value) {
    return isAgentSummary(value) && isRecord(value) && typeof value.body === "string";
}
function isAgent(value) {
    return isRecord(value) && (value.agent === null || isAgentRecord(value.agent));
}
function isSessionSummary(value) {
    return isRecord(value) && typeof value.id === "string" && typeof value.status === "string";
}
function isSessions(value) {
    return isRecord(value) && isArrayOf(value.sessions, isSessionSummary);
}
function isSession(value) {
    return isRecord(value) && isSessionSummary(value.session);
}
function isStats(value) {
    return isRecord(value) && isRecord(value.stats) && typeof value.stats.live === "boolean";
}
function isTodos(value) {
    return (isRecord(value) &&
        typeof value.exists === "boolean" &&
        isArrayOf(value.todos, (t) => isRecord(t) && typeof t.text === "string" && typeof t.state === "string"));
}
// Acknowledgements (and the token check): the client reads nothing from them, so a JSON object whose optional flags
// (when present) have the declared type is enough.
function isOptionalBoolean(value, key) {
    return value[key] === undefined || typeof value[key] === "boolean";
}
function isDeleteAgent(value) {
    return (isRecord(value) &&
        isOptionalBoolean(value, "deleted") &&
        (value.name === undefined || typeof value.name === "string") &&
        (value.source === undefined || value.source === "user" || value.source === "project"));
}
function isAuthCheck(value) {
    return isRecord(value) && isOptionalBoolean(value, "authenticated");
}
function isPromptAck(value) {
    return isRecord(value) && isOptionalBoolean(value, "queued");
}
function isAbortAck(value) {
    return isRecord(value) && isOptionalBoolean(value, "aborted");
}
function isStopAck(value) {
    return isRecord(value) && isOptionalBoolean(value, "stopping");
}
function isThinkingAck(value) {
    return isRecord(value) && (value.level === undefined || isThinkingLevel(value.level));
}
/** POST model / fork / new: the payload is pi's own answer, passed through unchecked. */
function isPiAnswer(value) {
    return isRecord(value);
}
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];
function isThinkingLevel(value) {
    return typeof value === "string" && THINKING_LEVELS.includes(value);
}
function isLens(value) {
    return (isRecord(value) &&
        isRecord(value.lens) &&
        typeof value.lens.available === "boolean" &&
        Array.isArray(value.lens.files));
}
// ------------------------------------------------------------------- api ---
const enc = encodeURIComponent;
const agentPath = (name, source) => `/api/agents/${enc(name)}${source ? `?source=${enc(source)}` : ""}`;
export const api = {
    health: () => request("GET", "/api/health", isHealth),
    // Validates the token currently held (or just typed) without triggering the 401 handler.
    authCheck: () => request("GET", "/api/auth", isAuthCheck, undefined, { quiet401: true }),
    config: () => request("GET", "/api/config", isConfig),
    prompts: () => request("GET", "/api/prompts", isPrompts),
    skills: () => request("GET", "/api/skills", isSkills),
    models: () => request("GET", "/api/models", isModels),
    cwds: () => request("GET", "/api/cwds", isCwds),
    agents: () => request("GET", "/api/agents", isAgents),
    agent: (name, source) => request("GET", agentPath(name, source), isAgent),
    createAgent: (payload) => request("POST", "/api/agents", isAgent, payload),
    updateAgent: (name, payload) => request("PUT", `/api/agents/${enc(name)}`, isAgent, payload),
    deleteAgent: (name, source) => request("DELETE", agentPath(name, source), isDeleteAgent),
    sessions: () => request("GET", "/api/sessions", isSessions),
    session: (id) => request("GET", `/api/sessions/${enc(id)}`, isSession),
    sessionStats: (id) => request("GET", `/api/sessions/${enc(id)}/stats`, isStats),
    sessionTodos: (id) => request("GET", `/api/sessions/${enc(id)}/todos`, isTodos),
    sessionLens: (id) => request("GET", `/api/sessions/${enc(id)}/lens`, isLens),
    createSession: (config) => request("POST", "/api/sessions", isSession, config),
    prompt: (id, message, streamingBehavior) => request("POST", `/api/sessions/${enc(id)}/prompt`, isPromptAck, {
        message,
        streamingBehavior,
    }),
    abort: (id) => request("POST", `/api/sessions/${enc(id)}/abort`, isAbortAck),
    stop: (id) => request("DELETE", `/api/sessions/${enc(id)}`, isStopAck),
    setModel: (id, provider, modelId) => request("POST", `/api/sessions/${enc(id)}/model`, isPiAnswer, { provider, modelId }),
    setThinking: (id, level) => request("POST", `/api/sessions/${enc(id)}/thinking`, isThinkingAck, { level }),
    fork: (id, entryId) => request("POST", `/api/sessions/${enc(id)}/fork`, isPiAnswer, { entryId }),
    newSessionInPlace: (id) => request("POST", `/api/sessions/${enc(id)}/new`, isPiAnswer),
};
