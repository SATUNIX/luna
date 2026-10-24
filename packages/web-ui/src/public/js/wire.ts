// wire.ts — the JSON the console API returns and accepts, as the browser relies on it.
//
// Types only: this module has no runtime code and its compiled wire.js is an empty module. The
// shapes are written out here rather than imported because browser code cannot reach the server
// sources at run time; server/wire-contract.ts proves at compile time that the server's real types
// are assignable to these (internal/docs/adr/0002, decision 4), so the two cannot drift.
//
// Each type lists only what the client reads. A field the server may omit, or that the client
// reads defensively without depending on it, is optional. api.ts and sse.ts narrow the parsed
// JSON (`unknown`) to these types with cheap structural checks before anything reads it.

// ------------------------------------------------------------------ shared ---
export type AuthMode = "token" | "off";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type StreamingBehaviour = "steer" | "followUp";
export type AgentSource = "user" | "project";
export type SessionStatus = "idle" | "external" | "running" | "exited";

/** Every non-2xx answer. */
export interface ErrorResponse {
	readonly error: string;
}

// ----------------------------------------------------------- installation ---
/** GET /api/health (unauthenticated). */
export interface HealthResponse {
	readonly ok: boolean;
	readonly version: string;
	readonly uptimeSec: number;
	readonly auth: AuthMode;
}

/** GET /api/auth: only reachable with an accepted token, so success is the answer (nothing is read). */
export interface AuthCheckResponse {
	readonly authenticated?: boolean;
}

export interface ModelInfo {
	readonly id: string;
	readonly contextWindow?: number;
	readonly reasoning?: boolean;
}

export interface ProviderInfo {
	readonly name: string;
	readonly models: readonly ModelInfo[];
}

/** GET /api/models. */
export interface ModelsResponse {
	readonly providers: readonly ProviderInfo[];
	readonly default: { readonly provider: string; readonly model: string };
}

/** GET /api/config: the parts the Config view shows. */
export interface ConfigResponse {
	readonly app: {
		readonly version: string;
		readonly node: string;
		readonly platform: string;
		readonly host: string;
		readonly port: number;
	};
	readonly cli: {
		readonly binary: string;
		readonly piHome: string;
		readonly settingsFile: string;
		readonly modelsFile: string;
		readonly sessionsDir: string;
	};
	readonly settings: {
		readonly defaultProvider: string;
		readonly defaultModel: string;
		readonly theme: string | null;
		readonly defaultThinkingLevel: string | null;
		readonly packages: number;
	};
	readonly paths: {
		readonly agentDirs: readonly string[];
		readonly kitRoot: string;
		readonly lensDir: string | null;
	};
	readonly models: readonly ProviderInfo[];
	readonly lens: {
		readonly present: boolean;
		readonly sessionCount: number;
		readonly turn: { readonly files: number; readonly cycles?: number } | null;
	};
}

/** A prompt template or a skill shipped in the kit. */
export interface KitEntry {
	readonly name: string;
	readonly description: string;
}

/** GET /api/prompts. */
export interface PromptsResponse {
	readonly prompts: readonly KitEntry[];
}

/** GET /api/skills. */
export interface SkillsResponse {
	readonly skills: readonly KitEntry[];
}

/** GET /api/cwds. */
export interface CwdsResponse {
	readonly cwds: readonly string[];
}

// ------------------------------------------------------------------ agents ---
/** One agent definition, as listed. */
export interface AgentSummary {
	readonly name: string;
	readonly description: string;
	readonly tools: readonly string[];
	readonly source: AgentSource;
	readonly model?: string;
}

/** An agent with its system-prompt body, as the editor reads it. */
export interface AgentRecord extends AgentSummary {
	readonly body: string;
}

/** GET /api/agents. */
export interface AgentsResponse {
	readonly agents: readonly AgentSummary[];
	/** Tool names offered in the agent editor. */
	readonly tools: readonly string[];
}

/** GET, POST /api/agents[/:name] and PUT /api/agents/:name. */
export interface AgentResponse {
	readonly agent: AgentRecord | null;
}

/** DELETE /api/agents/:name (the client reads nothing from it). */
export interface DeleteAgentResponse {
	readonly deleted?: boolean;
	readonly name?: string;
	readonly source?: AgentSource;
}

/** The body of POST /api/agents and PUT /api/agents/:name. */
export interface AgentInput {
	name?: string | undefined;
	description?: string | undefined;
	tools?: string[] | undefined;
	model?: string | undefined;
	body?: string | undefined;
	source?: string | undefined;
}

// ---------------------------------------------------------------- sessions ---
/** One row of the session list: a session file, a live child, or both merged. */
export interface SessionSummary {
	readonly id: string;
	readonly cwd: string | null;
	readonly sessionFile: string | null;
	readonly startedAt: string | null;
	readonly lastActivityAt: string;
	readonly entryCount: number;
	readonly preview: string;
	readonly status: SessionStatus;
	readonly externalActive?: boolean;
	readonly agent?: string | null;
}

/** GET /api/sessions. */
export interface SessionsResponse {
	readonly sessions: readonly SessionSummary[];
}

/** GET /api/sessions/:id and POST /api/sessions. */
export interface SessionResponse {
	readonly session: SessionSummary;
}

/**
 * The body of POST /api/sessions. Blank values (null, "") mean "use the default"; the server
 * checks each field again.
 */
export interface SpawnRequest {
	cwd?: string | null | undefined;
	agent?: string | null | undefined;
	agentSource?: AgentSource | null | undefined;
	provider?: string | null | undefined;
	model?: string | null | undefined;
	thinking?: ThinkingLevel | null | undefined;
}

export interface TokenTotals {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly total: number;
	readonly cost: number;
}

export interface ContextUsage {
	readonly tokens: number;
	readonly contextWindow: number;
	readonly percent: number;
}

/** Statistics computed from the session file. */
export interface DiskSessionStats {
	readonly live: false;
	readonly userMessages: number;
	readonly assistantMessages: number;
	readonly toolCalls: number;
	readonly totalMessages: number;
	readonly tokens: TokenTotals;
	readonly cost: number;
	readonly contextUsage: ContextUsage | null;
	readonly model: string | null;
	readonly provider: string | null;
}

/** A live child's own answer (pi's shape, passed through unchecked) plus `live` and `cost`. */
export interface LiveSessionStats {
	readonly [key: string]: unknown;
	readonly live: true;
	readonly cost: number;
}

export type SessionStats = DiskSessionStats | LiveSessionStats;

/** GET /api/sessions/:id/stats. */
export interface StatsResponse {
	readonly stats: SessionStats;
}

export type TodoState = "open" | "active" | "done";

export interface TodoItem {
	readonly id: number;
	readonly text: string;
	readonly state: TodoState;
}

/** GET /api/sessions/:id/todos. */
export interface TodosResponse {
	readonly exists: boolean;
	readonly todos: readonly TodoItem[];
}

export interface LensFile {
	readonly filePath: string | null;
	readonly blocking: number;
	readonly errors: number;
	readonly warnings: number;
}

export interface SessionLens {
	readonly available: boolean;
	/** An ISO date string, or null when nothing was captured. */
	readonly savedAt: string | null;
	readonly files: readonly LensFile[];
	readonly totals: { readonly blocking: number; readonly errors: number; readonly warnings: number };
	readonly cache: { readonly qualityWarnings: number; readonly findings: number };
}

/** GET /api/sessions/:id/lens. */
export interface LensResponse {
	readonly lens: SessionLens;
}

// Acknowledgements of session actions. The client reads nothing from them, so every field is
// optional: they are narrowed to "a JSON object" and no further.
/** POST /api/sessions/:id/prompt. */
export interface PromptResponse {
	readonly queued?: boolean;
}
/** POST /api/sessions/:id/abort. */
export interface AbortResponse {
	readonly aborted?: boolean;
}
/** DELETE /api/sessions/:id. */
export interface StopResponse {
	readonly stopping?: boolean;
}
/** POST /api/sessions/:id/model: pi's own answer, unchecked. */
export interface ModelResponse {
	readonly model?: unknown;
}
/** POST /api/sessions/:id/thinking: pi's own answer, unchecked. */
export interface ThinkingResponse {
	readonly thinking?: unknown;
	readonly level?: ThinkingLevel;
}
/** POST /api/sessions/:id/fork: pi's own answer, unchecked. */
export interface ForkResponse {
	readonly fork?: unknown;
}
/** POST /api/sessions/:id/new: pi's own answer, unchecked. */
export interface ResetResponse {
	readonly reset?: unknown;
}

// ------------------------------------------------------------ event stream ---
// GET /api/sessions/:id/events is a server-sent event stream. Each frame's `event:` name equals
// its payload's `type`; the payload always carries the session id.

/** One JSON line from a live pi child: a string `type`, everything else pi's and unchecked. */
export interface PiEvent {
	readonly type: string;
	readonly [key: string]: unknown;
}

/**
 * One UI event derived from a session file that another process (the CLI) is writing. The
 * pass-through fields are copied from the file unchecked, and absent when the entry lacks them.
 */
export type ObservedEvent =
	| { readonly type: "observed_message"; readonly message?: unknown; readonly timestamp?: unknown }
	| { readonly type: "observed_compaction"; readonly summary?: unknown; readonly timestamp?: unknown }
	| { readonly type: "observed_model_change"; readonly provider?: unknown; readonly modelId?: unknown }
	| { readonly type: "observed_thinking_level"; readonly level?: unknown }
	| { readonly type: "observed_activity"; readonly at: number };

export type LifecycleState = "running" | "watching" | "idle" | "exited" | "error";

/** `event: lifecycle`: what the session is doing (on attach), or how its child ended. */
export interface LifecyclePayload {
	readonly sessionId: string;
	readonly type: "lifecycle";
	readonly state: LifecycleState;
	readonly code?: number | null;
	readonly signal?: string | null;
	readonly message?: string;
}

/** `event: event`: a frame from the live child this console runs. */
export interface LiveEventPayload {
	readonly sessionId: string;
	readonly type: "event";
	readonly data: PiEvent;
}

/** `event: observed`: an event from a session file tailed on the client's behalf. */
export interface ObservedEventPayload {
	readonly sessionId: string;
	readonly type: "observed";
	readonly data: ObservedEvent;
}

export type StreamEventPayload = LiveEventPayload | ObservedEventPayload;
export type StreamPayload = StreamEventPayload | LifecyclePayload;
