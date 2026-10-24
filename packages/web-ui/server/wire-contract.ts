// wire-contract.ts — compile-time proof that the server's JSON matches the browser's wire types.
//
// The browser cannot import server modules at run time, so src/public/js/wire.ts writes out the
// shapes the client relies on (internal/docs/adr/0002, decision 4). Each check below fails
// `npm run test:typecheck` when a server type stops being assignable to its wire type (a response
// or stream payload), or a wire request stops being acceptable to the server. Types only: nothing
// imports this file, and it compiles to an empty module.
import type * as Wire from "../src/public/js/wire.ts";
import type { AgentSource } from "./agents.ts";
import type { AgentInput, deleteAgent } from "./agentstore.ts";
import type { ConfigInfo, KitEntry } from "./configinfo.ts";
import type { SessionLens } from "./lens.ts";
import type { ModelList, ProviderInfo } from "./models.ts";
import type {
	AbortResponse,
	AgentResponse,
	AgentsResponse,
	AuthCheckResponse,
	CwdsResponse,
	ForkResponse,
	HealthResponse,
	LensResponse,
	ModelResponse,
	PromptResponse,
	PromptsResponse,
	ResetResponse,
	SessionResponse,
	SessionStatus,
	SessionSummary,
	SessionsResponse,
	SkillsResponse,
	StatsResponse,
	StopResponse,
	StreamPayload,
	ThinkingResponse,
} from "./routes.ts";
import type { SessionStats } from "./stats.ts";
import type { ObservedEvent } from "./tailer.ts";
import type { TodoList } from "./todos.ts";
import type { StreamingBehaviour, ThinkingLevel } from "./validate.ts";

type Assert<T extends true> = T;
/** True when `T` can be used where `U` is expected. */
type Fits<T, U> = [T] extends [U] ? true : false;
/** A request body as it arrives: JSON.stringify drops properties whose value is undefined. */
type Sent<T> = { [K in keyof T]: Exclude<T[K], undefined> };
/** True when the two unions name the same members. */
type Same<T, U> = [T] extends [U] ? ([U] extends [T] ? true : false) : false;

export type Checks = [
	// shared vocabularies
	Assert<Same<Wire.ThinkingLevel, ThinkingLevel>>,
	Assert<Same<Wire.StreamingBehaviour, StreamingBehaviour>>,
	Assert<Same<Wire.AgentSource, AgentSource>>,
	Assert<Same<Wire.SessionStatus, SessionStatus>>,

	// responses: server -> wire
	Assert<Fits<HealthResponse, Wire.HealthResponse>>,
	Assert<Fits<AuthCheckResponse, Wire.AuthCheckResponse>>,
	Assert<Fits<ConfigInfo, Wire.ConfigResponse>>,
	Assert<Fits<ModelList, Wire.ModelsResponse>>,
	Assert<Fits<ProviderInfo, Wire.ProviderInfo>>,
	Assert<Fits<KitEntry, Wire.KitEntry>>,
	Assert<Fits<PromptsResponse, Wire.PromptsResponse>>,
	Assert<Fits<SkillsResponse, Wire.SkillsResponse>>,
	Assert<Fits<CwdsResponse, Wire.CwdsResponse>>,
	Assert<Fits<AgentsResponse, Wire.AgentsResponse>>,
	Assert<Fits<AgentResponse, Wire.AgentResponse>>,
	Assert<Fits<ReturnType<typeof deleteAgent>, Wire.DeleteAgentResponse>>,
	Assert<Fits<SessionSummary, Wire.SessionSummary>>,
	Assert<Fits<SessionsResponse, Wire.SessionsResponse>>,
	Assert<Fits<SessionResponse, Wire.SessionResponse>>,
	Assert<Fits<SessionStats, Wire.SessionStats>>,
	Assert<Fits<StatsResponse, Wire.StatsResponse>>,
	Assert<Fits<TodoList, Wire.TodosResponse>>,
	Assert<Fits<SessionLens, Wire.SessionLens>>,
	Assert<Fits<LensResponse, Wire.LensResponse>>,
	Assert<Fits<PromptResponse, Wire.PromptResponse>>,
	Assert<Fits<AbortResponse, Wire.AbortResponse>>,
	Assert<Fits<StopResponse, Wire.StopResponse>>,
	Assert<Fits<ModelResponse, Wire.ModelResponse>>,
	Assert<Fits<ThinkingResponse, Wire.ThinkingResponse>>,
	Assert<Fits<ForkResponse, Wire.ForkResponse>>,
	Assert<Fits<ResetResponse, Wire.ResetResponse>>,

	// the event stream: server -> wire
	Assert<Fits<ObservedEvent, Wire.ObservedEvent>>,
	Assert<Fits<StreamPayload, Wire.StreamPayload>>,
	Assert<Fits<Extract<StreamPayload, { type: "lifecycle" }>, Wire.LifecyclePayload>>,
	Assert<Fits<Extract<StreamPayload, { type: "event" | "observed" }>, Wire.StreamEventPayload>>,

	// request bodies: wire -> server
	Assert<Fits<Sent<Wire.AgentInput>, AgentInput>>,
];
