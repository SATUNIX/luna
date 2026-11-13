/**
 * Agent-state files: what a running Luna agent is doing, in one small JSON file per agent.
 *
 * The files are the contract between whatever runs an agent (a Luna session, an autonomous run) and
 * whatever shows it (the herdr extension, the web console, a script): the reader needs no running
 * process and no API, only the directory. One writer here keeps the shape in one place.
 *
 *   <state dir>/luna/agents/<id>.json      override the directory with LUNA_AGENT_STATE_DIR
 *
 * `state` is one of AGENT_STATES. `waitingFor` is set only while `blocked`; `tail` is the last few
 * hundred characters of what the agent said or did, capped so a file stays small and carries no log.
 * Nothing here is a security boundary: a file is a status report, never an instruction to anyone.
 *
 * Extensions are self-contained, so each consumer holds a generated copy (`npm run gen:shared`).
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { writeFileSafe } from "./safe-fs.ts";

export const AGENT_STATES = ["working", "blocked", "done", "failed", "stopped", "parked"] as const;
export type AgentStateName = (typeof AGENT_STATES)[number];

export const AGENT_STATE_SCHEMA = 1;
export const TAIL_MAX = 400;
const LABEL_MAX = 160;

export interface AgentState {
  schema: typeof AGENT_STATE_SCHEMA;
  /** File-name safe id of the agent, unique on this machine (a session or run). */
  id: string;
  state: AgentStateName;
  /** What a `blocked` agent waits for (an approval, a question), in a line. */
  waitingFor?: string | undefined;
  /** The last of what the agent said or did, capped at TAIL_MAX characters. */
  tail?: string | undefined;
  /** The checkout the agent works in. */
  worktree?: string | undefined;
  /** Money spent so far, when known. */
  costUsd?: number | undefined;
  /** Who wrote it: "session" for an interactive or headless Luna, "autonomy" for a supervised run. */
  source: "session" | "autonomy";
  pid: number;
  /** When `state` last changed, and when the file was last written (ISO 8601). */
  since: string;
  updatedAt: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const CONTROL = /\p{Cc}/gu;

/** One line of at most `max` characters, control characters removed. Keeps the end when `tail` is set. */
export function oneLine(text: unknown, max: number, tail = false): string {
  const t = (typeof text === "string" ? text : "").replace(CONTROL, " ").replace(/\s+/g, " ").trim();
  return t.length <= max ? t : tail ? t.slice(t.length - max) : t.slice(0, max);
}

export function isAgentStateName(value: unknown): value is AgentStateName {
  return typeof value === "string" && (AGENT_STATES as readonly string[]).includes(value);
}

/** An id that is safe as a file name. */
export function safeAgentId(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "").slice(0, 80);
  return cleaned || "agent";
}

/** The directory the files live in. Under the state home, never under pi's agent directory. */
export function agentStateDir(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  const override = env.LUNA_AGENT_STATE_DIR?.trim();
  if (override) return path.resolve(override);
  return path.join(env.XDG_STATE_HOME?.trim() || path.join(home, ".local", "state"), "luna", "agents");
}

export interface AgentStateInput {
  id: string;
  state: AgentStateName;
  source: AgentState["source"];
  waitingFor?: string | undefined;
  tail?: string | undefined;
  worktree?: string | undefined;
  costUsd?: number | undefined;
  /** The previous record of the same agent: `since` is kept while the state does not change. */
  previous?: Pick<AgentState, "state" | "since"> | undefined;
  now?: Date;
  pid?: number;
}

/** Build a record from loose input: ids, labels and tails bounded, `waitingFor` only while blocked. */
export function buildAgentState(input: AgentStateInput): AgentState {
  const at = (input.now ?? new Date()).toISOString();
  const waitingFor = input.state === "blocked" ? oneLine(input.waitingFor, LABEL_MAX) : "";
  const tail = oneLine(input.tail, TAIL_MAX, true);
  const worktree = oneLine(input.worktree, 400);
  return {
    schema: AGENT_STATE_SCHEMA, id: safeAgentId(input.id), state: input.state, source: input.source, pid: input.pid ?? process.pid,
    since: input.previous?.state === input.state ? input.previous.since : at, updatedAt: at,
    ...(waitingFor ? { waitingFor } : {}),
    ...(tail ? { tail } : {}),
    ...(worktree ? { worktree } : {}),
    ...(typeof input.costUsd === "number" && Number.isFinite(input.costUsd) && input.costUsd >= 0 ? { costUsd: input.costUsd } : {}),
  };
}

/** A parsed file as a record, or null when it is not one (wrong schema, unknown state, wrong types). */
export function parseAgentState(raw: unknown): AgentState | null {
  if (!isRecord(raw) || raw.schema !== AGENT_STATE_SCHEMA) return null;
  const { id, state, source, pid, since, updatedAt } = raw;
  if (typeof id !== "string" || !isAgentStateName(state) || (source !== "session" && source !== "autonomy")) return null;
  if (typeof pid !== "number" || typeof since !== "string" || typeof updatedAt !== "string") return null;
  const waitingFor = typeof raw.waitingFor === "string" ? oneLine(raw.waitingFor, LABEL_MAX) : "";
  const tail = typeof raw.tail === "string" ? oneLine(raw.tail, TAIL_MAX, true) : "";
  const worktree = typeof raw.worktree === "string" ? oneLine(raw.worktree, 400) : "";
  return {
    schema: AGENT_STATE_SCHEMA, id: safeAgentId(id), state, source, pid, since, updatedAt,
    ...(waitingFor ? { waitingFor } : {}),
    ...(tail ? { tail } : {}),
    ...(worktree ? { worktree } : {}),
    ...(typeof raw.costUsd === "number" && Number.isFinite(raw.costUsd) && raw.costUsd >= 0 ? { costUsd: raw.costUsd } : {}),
  };
}

/** Write one agent's file. Never throws: a status report must not be able to stop the agent it reports on. */
export function writeAgentState(dir: string, state: AgentState): boolean {
  try {
    writeFileSafe(path.join(dir, `${state.id}.json`), `${JSON.stringify(state)}\n`, { root: dir, mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/** Every valid agent file in `dir`, most recently updated first. A missing directory is an empty list. */
export function readAgentStates(dir: string): AgentState[] {
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out: AgentState[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const parsed = parseAgentState(JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")));
      if (parsed) out.push(parsed);
    } catch { /* a half-written or foreign file is not an agent */ }
  }
  return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}
