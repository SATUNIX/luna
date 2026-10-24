/**
 * Workflow telemetry — a live, in-process registry of workflow runs (RunModel) and the per-agent
 * events that feed it.
 *
 * A run has ordered phases and the agents launched in them. Each agent records its label, phase,
 * model, token usage, elapsed time and status. The YAML executor (workflow.ts) feeds it today:
 * every top-level step is a phase and every step execution (a parallel member, a gate loop's
 * re-run) is one agent. The API is engine-neutral (`kind`, phases created on demand by id), so
 * a script engine can feed the same model later.
 *
 * Nothing here is written to disk: records hold no prompts or outputs, only labels, ids, model
 * names, counters and error text. Listeners (a panel, a status line) subscribe; a throwing
 * listener is ignored so telemetry can never break a run.
 */
import type { UsageStats } from "./types.ts";

export type RunKind = "yaml" | "script";
export type RunStatus = "running" | "passed" | "failed" | "interrupted";
export type PhaseStatus = "pending" | "running" | "passed" | "failed" | "skipped" | "aborted";
export type AgentStatus = "running" | "passed" | "failed" | "skipped" | "aborted";

export interface AgentRecord {
  id: string; // unique within the run: "<label>#<n>"
  label: string;
  phase: string; // phase id
  role?: string | undefined;
  model?: string | undefined;
  status: AgentStatus;
  usage: UsageStats;
  startedAt: number;
  endedAt?: number | undefined;
  elapsedMs: number; // live for a running agent, frozen once it ends
  subagentRunId?: string | undefined; // the subagent log id, for subagent_status / stop
  activity?: string | undefined; // the last progress line
  error?: string | undefined;
  cached?: true | undefined; // answered from a resumed run's journal; nothing was launched
  group?: string | undefined; // the nested workflow() this agent ran in (script runs)
}

export interface PhaseRecord {
  id: string;
  title: string;
  status: PhaseStatus;
  agentIds: string[];
  parent?: string | undefined; // the `▸ <workflow>` group phase this phase sits under (script runs)
}

/** What a run was started from: shown by the /workflows panel. Holds no prompts or inputs. */
export interface RunInfo {
  description?: string | undefined;
  file?: string | undefined; // the workflow definition file
  source?: "kit" | "user" | "project" | undefined;
  /** Script runs: the sandbox mode the script ran in. */
  sandbox?: "full" | "reduced" | undefined;
  /** Script runs: budget.total, an output-token ceiling (null or unset: none). */
  budgetTotal?: number | null | undefined;
  /** Script runs: sha256 of the script source the run executed. */
  digest?: string | undefined;
}

export interface RunSnapshot extends RunInfo {
  id: string;
  kind: RunKind;
  name: string;
  status: RunStatus;
  paused: boolean; // a live run paused through control.ts: it launches no new agents
  startedAt: number;
  endedAt?: number | undefined;
  elapsedMs: number;
  error?: string | undefined;
  phases: PhaseRecord[];
  agents: AgentRecord[];
  usage: UsageStats;
  /** Tool-firewall approvals counted for this run (noteApproval). */
  approvals: number;
}

export type WorkflowEvent =
  | { type: "run_start"; runId: string; kind: RunKind; name: string; ts: number }
  | { type: "phase"; runId: string; phase: PhaseRecord; ts: number }
  | { type: "agent"; runId: string; agent: AgentRecord; ts: number }
  | { type: "control"; runId: string; paused: boolean; ts: number }
  | { type: "approvals"; runId: string; approvals: number; ts: number }
  | { type: "run_end"; runId: string; status: RunStatus; error?: string | undefined; ts: number };

export type WorkflowListener = (event: WorkflowEvent) => void;

export const MAX_FINISHED_RUNS = 20;

const zeroUsage = (): UsageStats => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 });

function sumUsage(agents: Iterable<AgentRecord>): UsageStats {
  const total = zeroUsage();
  for (const a of agents) {
    total.input += a.usage.input;
    total.output += a.usage.output;
    total.cacheRead += a.usage.cacheRead;
    total.cacheWrite += a.usage.cacheWrite;
    total.cost += a.usage.cost;
    total.turns += a.usage.turns;
  }
  return total;
}

const copyAgent = (a: AgentRecord, now: number): AgentRecord => ({ ...a, usage: { ...a.usage }, elapsedMs: a.endedAt === undefined ? Math.max(0, now - a.startedAt) : a.elapsedMs });
const copyPhase = (p: PhaseRecord): PhaseRecord => ({ ...p, agentIds: [...p.agentIds] });

export interface AgentStart {
  label: string;
  phase: string;
  role?: string | undefined;
  model?: string | undefined;
  cached?: true | undefined;
  group?: string | undefined;
}

export interface AgentEnd {
  status: Exclude<AgentStatus, "running">;
  usage?: UsageStats | undefined;
  model?: string | undefined;
  subagentRunId?: string | undefined;
  error?: string | undefined;
}

/** One run's live model. Obtain it from `RunRegistry.start`. */
export class RunModel {
  readonly id: string;
  readonly kind: RunKind;
  readonly name: string;
  readonly info: RunInfo;
  status: RunStatus = "running";
  paused = false;
  approvals = 0;
  readonly startedAt: number;
  endedAt: number | undefined;
  error: string | undefined;
  private readonly phases = new Map<string, PhaseRecord>();
  private readonly agents = new Map<string, AgentRecord>();
  private readonly counters = new Map<string, number>();
  private readonly emit: (event: WorkflowEvent) => void;
  private readonly now: () => number;

  constructor(id: string, kind: RunKind, name: string, emit: (event: WorkflowEvent) => void, now: () => number, info: RunInfo = {}) {
    this.emit = emit;
    this.info = { ...info };
    this.now = now;
    this.id = id;
    this.kind = kind;
    this.name = name;
    this.startedAt = now();
  }

  /** Create (or retitle) a phase. Phases keep their first-seen order; `parent` names a group phase. */
  phase(id: string, title = id, status?: PhaseStatus, parent?: string): PhaseRecord {
    let p = this.phases.get(id);
    if (!p) {
      p = { id, title, status: status ?? "pending", agentIds: [], ...(parent !== undefined ? { parent } : {}) };
      this.phases.set(id, p);
    } else {
      p.title = title;
      if (status) p.status = status;
      if (parent !== undefined) p.parent = parent;
    }
    this.emit({ type: "phase", runId: this.id, phase: copyPhase(p), ts: this.now() });
    return p;
  }

  setPhaseStatus(id: string, status: PhaseStatus): void {
    this.phase(id, this.phases.get(id)?.title ?? id, status);
  }

  hasPhase(id: string): boolean {
    return this.phases.has(id);
  }

  /** Record an agent launch; returns its id within the run. Unknown phases are created. */
  agentStart(start: AgentStart): string {
    if (!this.phases.has(start.phase)) this.phase(start.phase);
    const n = (this.counters.get(start.label) ?? 0) + 1;
    this.counters.set(start.label, n);
    const id = `${start.label}#${n}`;
    const a: AgentRecord = { id, label: start.label, phase: start.phase, role: start.role, model: start.model, status: "running", usage: zeroUsage(), startedAt: this.now(), elapsedMs: 0, ...(start.cached ? { cached: true } : {}), ...(start.group !== undefined ? { group: start.group } : {}) };
    this.agents.set(id, a);
    this.phases.get(start.phase)?.agentIds.push(id);
    this.emitAgent(a);
    return id;
  }

  /** Live progress for a running agent: usage so far, model once known, last activity line. */
  agentUpdate(id: string, update: { usage?: UsageStats | undefined; model?: string | undefined; activity?: string | undefined }): void {
    const a = this.agents.get(id);
    if (a?.status !== "running") return;
    if (update.usage) a.usage = { ...update.usage };
    if (update.model) a.model = update.model;
    if (update.activity !== undefined) a.activity = update.activity;
    this.emitAgent(a);
  }

  agentEnd(id: string, end: AgentEnd): void {
    const a = this.agents.get(id);
    if (a?.status !== "running") return;
    a.status = end.status;
    if (end.usage) a.usage = { ...end.usage };
    if (end.model) a.model = end.model;
    if (end.subagentRunId) a.subagentRunId = end.subagentRunId;
    a.error = end.error;
    a.endedAt = this.now();
    a.elapsedMs = Math.max(0, a.endedAt - a.startedAt);
    this.emitAgent(a);
  }

  /** A step that never launched (an unmet `when`): recorded so a panel can show it. */
  agentSkipped(start: AgentStart): string {
    const id = this.agentStart(start);
    this.agentEnd(id, { status: "skipped" });
    return id;
  }

  /** Pause state from the run's control (control.ts); a change emits a `control` event. */
  setPaused(paused: boolean): void {
    if (this.status !== "running" || this.paused === paused) return;
    this.paused = paused;
    this.emit({ type: "control", runId: this.id, paused, ts: this.now() });
  }

  /** Count one tool-firewall approval raised by this run's agents. */
  noteApproval(): void {
    if (this.status !== "running") return;
    this.approvals++;
    this.emit({ type: "approvals", runId: this.id, approvals: this.approvals, ts: this.now() });
  }

  finish(status: Exclude<RunStatus, "running">, error?: string): void {
    if (this.status !== "running") return;
    const ts = this.now();
    // Anything still running when the run ends was cut off with it.
    for (const a of this.agents.values()) if (a.status === "running") this.agentEnd(a.id, { status: "aborted", error: error ?? "run ended" });
    this.status = status;
    this.paused = false;
    this.error = error;
    this.endedAt = ts;
    this.emit({ type: "run_end", runId: this.id, status, error, ts });
  }

  snapshot(): RunSnapshot {
    const now = this.now();
    const agents = [...this.agents.values()].map((a) => copyAgent(a, now));
    return {
      id: this.id,
      kind: this.kind,
      name: this.name,
      description: this.info.description,
      file: this.info.file,
      source: this.info.source,
      sandbox: this.info.sandbox,
      budgetTotal: this.info.budgetTotal,
      digest: this.info.digest,
      status: this.status,
      paused: this.paused,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      elapsedMs: Math.max(0, (this.endedAt ?? now) - this.startedAt),
      error: this.error,
      phases: [...this.phases.values()].map(copyPhase),
      agents,
      usage: sumUsage(agents),
      approvals: this.approvals,
    };
  }

  private emitAgent(a: AgentRecord): void {
    this.emit({ type: "agent", runId: this.id, agent: copyAgent(a, this.now()), ts: this.now() });
  }
}

/** All runs of this process: active ones, plus the most recent finished ones. */
export class RunRegistry {
  private readonly runs = new Map<string, RunModel>();
  private readonly listeners = new Set<WorkflowListener>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** Start a run. A resumed run reuses its id: the old model is replaced by a fresh one. */
  start(id: string, kind: RunKind, name: string, info: RunInfo = {}): RunModel {
    this.runs.delete(id);
    const run = new RunModel(id, kind, name, (e) => this.dispatch(e), this.now, info);
    this.runs.set(id, run);
    this.dispatch({ type: "run_start", runId: id, kind, name, ts: run.startedAt });
    this.prune();
    return run;
  }

  get(id: string): RunSnapshot | undefined {
    return this.runs.get(id)?.snapshot();
  }

  /** Newest first. */
  list(): RunSnapshot[] {
    return [...this.runs.values()].map((r) => r.snapshot()).sort((a, b) => b.startedAt - a.startedAt);
  }

  activeCount(): number {
    let n = 0;
    for (const r of this.runs.values()) if (r.status === "running") n++;
    return n;
  }

  subscribe(listener: WorkflowListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private dispatch(event: WorkflowEvent): void {
    for (const l of [...this.listeners]) {
      try {
        l(event);
      } catch {
        /* a listener must never break a run */
      }
    }
    if (event.type === "run_end") this.prune();
  }

  // Keep every active run and the MAX_FINISHED_RUNS most recent finished ones.
  private prune(): void {
    const finished = [...this.runs.values()].filter((r) => r.status !== "running").sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
    for (const r of finished.slice(MAX_FINISHED_RUNS)) this.runs.delete(r.id);
  }
}

/** The process-wide registry the executors feed. */
export const runRegistry = new RunRegistry();
