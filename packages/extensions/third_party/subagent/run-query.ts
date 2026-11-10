/**
 * One query over every run this workspace knows about, whoever wrote it.
 *
 * Four stores hold runs, and each format once had its own surface:
 *   - `run.json` in `.pi/workflows/runs/<id>/`: a script run (the sandboxed workflow engine);
 *   - `state.json` in the same run directory: a YAML run (the step executor);
 *   - `runs.jsonl` in `.pi/subagent/`: one background subagent's start/end rows, for a run that
 *     has no run directory of its own. A row belongs to a workflow run when that run recorded its
 *     id as a child, and is then not a run of its own;
 *   - this process's live registry (`run-model.ts`): runs that are live now, or finished in this
 *     session, including one whose state.json has not been written yet.
 *
 * This module is a read-only view over those unchanged stores, so a run started by another
 * process is just as visible as one started here. Nothing here writes; nothing holds a prompt or
 * an output beyond a run's own redacted error text.
 *
 * `workflow_status` and `/workflows` both read `queryRuns`, so the tool, the command and the
 * stop paths always describe the same set of runs.
 */
import fs from "node:fs";
import path from "node:path";
import { isRecord } from "./config.ts";
import { subagentStateDir } from "./logging.ts";
import { runControls } from "./control.ts";
import { runRegistry, type RunKind, type RunRegistry, type RunSnapshot } from "./run-model.ts";
import { collectRuns, isValidRunId, type RunRow } from "./status.ts";
import { readJournal } from "./wf-engine.ts";
import { loadState, MAX_SCRIPT_BYTES, readRunFile, runsRoot, summarizeRun } from "./workflow.ts";

/** A run's storage format, as the list labels it. */
export type RunFormat = RunKind | "subagent";

/** One run of any format. A script or YAML run that is live in this process has `live: true`. */
export interface QueriedRun {
  id: string;
  format: RunFormat;
  name: string;
  status: string;
  startedAt: string;
  endedAt: string;
  live: boolean;
  paused: boolean;
  agents: number;
  outputTokens: number;
  error?: string | undefined;
  /** Workflow runs: the run directory. */
  dir?: string | undefined;
  /** Background subagent runs: its log file and recorded pid. */
  log?: string | undefined;
  pid?: number | undefined;
}

export interface QueryOptions {
  /** The live registry to merge; this process's own unless a caller (a test) says otherwise. */
  registry?: RunRegistry | undefined;
}

const NO_RUNS = "No runs yet.";

const countOf = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const stringOf = (value: unknown): string => (typeof value === "string" ? value : "");

function elapsed(start: string, end: string): string {
  const from = Date.parse(start);
  const to = end ? Date.parse(end) : Date.now();
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return "";
  const ms = to - from;
  return ms < 1000 ? `${ms}ms` : `${Math.round(ms / 1000)}s`;
}

/** The run directory names under the runs root; anything that is not a plain id is skipped. */
function runDirectoryIds(root: string): string[] {
  try {
    return fs.readdirSync(root).filter((name) => isValidRunId(name));
  } catch {
    return [];
  }
}

interface ScriptMeta {
  name: string;
  status: string;
  startedAt: string;
  updatedAt: string;
  launched: number;
  cached: number;
  outputTokens: number;
  error?: string | undefined;
  omissions: number;
}

// A script run's run.json, checked the way all untrusted JSON is: every field is `unknown` until
// its type is checked. A malformed or missing file means no row, never a throw at the caller.
function readScriptFile(runDir: string): unknown {
  try {
    return JSON.parse(readRunFile(runDir, "run.json", MAX_SCRIPT_BYTES));
  } catch {
    return null;
  }
}

function scriptMetaOf(raw: unknown): ScriptMeta | null {
  if (!isRecord(raw) || raw.kind !== "script" || typeof raw.name !== "string" || typeof raw.status !== "string") return null;
  const omissions = Array.isArray(raw.omissions) ? raw.omissions.length : countOf(raw.omissionCount);
  const error = typeof raw.error === "string" ? raw.error : undefined;
  return {
    name: raw.name,
    status: raw.status,
    startedAt: stringOf(raw.startedAt),
    updatedAt: stringOf(raw.updatedAt),
    launched: countOf(raw.launched),
    cached: countOf(raw.cached),
    outputTokens: countOf(raw.outputTokens),
    ...(error !== undefined ? { error } : {}),
    omissions,
  };
}

const readScriptMeta = (root: string, id: string): ScriptMeta | null => scriptMetaOf(readScriptFile(path.join(root, id)));

function scriptRow(root: string, id: string, meta: ScriptMeta): QueriedRun {
  return {
    id,
    format: "script",
    name: meta.name,
    status: meta.status,
    startedAt: meta.startedAt,
    endedAt: meta.updatedAt,
    live: false,
    paused: false,
    agents: meta.launched,
    outputTokens: meta.outputTokens,
    ...(meta.error !== undefined ? { error: meta.error } : {}),
    dir: path.join(root, id),
  };
}

function yamlRow(root: string, id: string, state: NonNullable<ReturnType<typeof loadState>>): QueriedRun {
  const steps = Object.values(state.steps);
  return {
    id,
    format: "yaml",
    name: state.workflow,
    status: state.status,
    startedAt: state.startedAt,
    endedAt: state.status === "running" ? "" : state.updatedAt,
    live: false,
    paused: state.paused === true,
    agents: steps.reduce((total, step) => total + step.attempts, 0),
    outputTokens: steps.reduce((total, step) => total + (step.outputTokens ?? 0), 0),
    ...(state.error !== undefined ? { error: state.error } : {}),
    dir: path.join(root, id),
  };
}

function subagentRow(row: RunRow): QueriedRun {
  return {
    id: row.id,
    format: "subagent",
    name: row.agent,
    status: row.status,
    startedAt: row.start,
    endedAt: row.end,
    live: row.live,
    paused: false,
    agents: 1,
    outputTokens: 0,
    log: row.log,
    ...(row.pid !== undefined ? { pid: row.pid } : {}),
  };
}

const isoOf = (ms: number | undefined): string => (ms === undefined ? "" : new Date(ms).toISOString());

function snapshotRow(root: string, snap: RunSnapshot): QueriedRun {
  return {
    id: snap.id,
    format: snap.kind,
    name: snap.name,
    status: snap.status,
    startedAt: isoOf(snap.startedAt),
    endedAt: isoOf(snap.endedAt),
    live: snap.status === "running",
    paused: snap.paused,
    agents: snap.agents.length,
    outputTokens: snap.usage.output,
    ...(snap.error !== undefined ? { error: snap.error } : {}),
    dir: path.join(root, snap.id),
  };
}

// The live registry is the authority on a run this process started: its agents and status are
// newer than the file a run writes as it goes.
function mergeSnapshot(row: QueriedRun, snap: RunSnapshot): void {
  row.format = snap.kind;
  row.name = snap.name || row.name;
  row.status = snap.status;
  row.live = snap.status === "running";
  row.paused = snap.paused;
  row.agents = Math.max(row.agents, snap.agents.length);
  row.outputTokens = Math.max(row.outputTokens, snap.usage.output);
  if (snap.error !== undefined) row.error = snap.error;
  row.startedAt ||= isoOf(snap.startedAt);
  row.endedAt = isoOf(snap.endedAt) || row.endedAt;
}

/**
 * Every run of this workspace, newest first: script and YAML run directories, background
 * subagent rows that belong to no run, and this process's live registry. A `runs.jsonl` row
 * belongs to a run when that run recorded its id as a child — a YAML step's `runIds`, a script
 * journal's `subagentRunId`, or the live registry's agent — so it is not listed as a second run.
 * A child still in flight has no recorded id yet, so it stays a row of its own until it ends; so
 * does one killed between its end row and the run saving the id.
 */
export function queryRuns(cwd: string, opts: QueryOptions = {}): QueriedRun[] {
  const registry = opts.registry ?? runRegistry;
  const root = runsRoot(cwd);
  const byId = new Map<string, QueriedRun>();
  const runIds = new Set<string>();
  // Every id a run recorded as one of its children. Its rows are in runs.jsonl like any other
  // subagent's, but they are that run's steps, not runs of their own.
  const childIds = new Set<string>();
  for (const id of runDirectoryIds(root)) {
    runIds.add(id);
    const script = readScriptMeta(root, id);
    const state = script ? null : loadState(cwd, id);
    const row = script ? scriptRow(root, id, script) : state ? yamlRow(root, id, state) : null;
    if (state) {
      for (const step of Object.values(state.steps)) for (const child of step.runIds) childIds.add(child);
    }
    if (script) {
      for (const entry of readJournal(path.join(root, id, "journal.jsonl"))) {
        if (entry.subagentRunId) childIds.add(entry.subagentRunId);
      }
    }
    if (row) byId.set(id, row);
  }
  for (const snap of registry.list()) {
    runIds.add(snap.id);
    for (const agent of snap.agents) if (agent.subagentRunId) childIds.add(agent.subagentRunId);
    const row = byId.get(snap.id);
    if (row) mergeSnapshot(row, snap);
    else byId.set(snap.id, snapshotRow(root, snap));
  }
  for (const row of collectRuns(subagentStateDir(cwd))) {
    if (runIds.has(row.id) || childIds.has(row.id)) continue;
    byId.set(row.id, subagentRow(row));
  }
  // A workflow run this session controls is live even when it feeds its own registry (a caller
  // may hand `executeWorkflow` a private one): its pause state comes from the control, as before.
  for (const row of byId.values()) {
    const control = runControls.get(row.id);
    if (!control || row.format === "subagent") continue;
    row.live = true;
    row.paused = control.paused;
  }
  return [...byId.values()].sort((a, b) => (a.startedAt === b.startedAt ? a.id.localeCompare(b.id) : a.startedAt < b.startedAt ? 1 : -1));
}

/** One run by id, or undefined. The id is checked before any path is built from it. */
export function findRun(cwd: string, id: string, opts: QueryOptions = {}): QueriedRun | undefined {
  if (!isValidRunId(id)) return undefined;
  return queryRuns(cwd, { registry: opts.registry }).find((run) => run.id === id);
}

/** The one-line form both the list and its tests read: id, status, format, name, agents, elapsed. */
export function formatRunLine(run: QueriedRun): string {
  const active = run.live ? (run.paused ? " (active, paused)" : " (active)") : "";
  const parts = [`- ${run.id}: ${run.status}${active}`, run.format, run.name, `${run.agents} agent${run.agents === 1 ? "" : "s"}`];
  const duration = elapsed(run.startedAt, run.endedAt);
  if (duration) parts.push(duration);
  const error = run.error ? ` — ${run.error.slice(0, 120)}` : "";
  return `${parts.join(" · ")}${error}`;
}

/** The most runs `workflow_status` lists in one call. */
export const MAX_RUN_LIST = 100;

/** The list `workflow_status` and `/workflows` show: every format, newest first. */
export function formatRunList(runs: readonly QueriedRun[], limit = 20): string {
  if (runs.length === 0) return NO_RUNS;
  const live = runs.filter((run) => run.live).length;
  const shown = runs.slice(0, Math.max(1, limit));
  const header = `Runs (${runs.length}${live ? `, ${live} live` : ""}):`;
  const howToSeeMore = runs.length <= MAX_RUN_LIST ? `workflow_status {limit: ${runs.length}} lists them all` : `workflow_status {limit: ${MAX_RUN_LIST}} lists the newest ${MAX_RUN_LIST}, and workflow_status {id} shows any run`;
  const more = runs.length > shown.length ? `\n… ${runs.length - shown.length} more; ${howToSeeMore}.` : "";
  return [header, ...shown.map(formatRunLine)].join("\n") + more;
}

const TAIL_LINES = 40;
const MAX_TAIL_LINES = 1000;

function describeSubagent(cwd: string, run: QueriedRun, tail: number): string {
  const logPath = path.join(subagentStateDir(cwd), `${run.id}.log`);
  const lines = Math.max(1, Math.min(Number.isFinite(tail) ? Math.trunc(tail) : TAIL_LINES, MAX_TAIL_LINES));
  const header = `Format: subagent · run ${run.id}\nsubagent ${run.name} · ${run.status} · started ${run.startedAt || "?"} · log: ${run.log || logPath}`;
  try {
    const body = fs.readFileSync(logPath, "utf8").split(/\r?\n/);
    return `${header}\n\n\`\`\`\n${body.slice(-lines).join("\n")}\n\`\`\``;
  } catch {
    return `${header}\n\nNo log for run "${run.id}" under ${path.dirname(logPath)}.`;
  }
}

function describeScript(run: QueriedRun): string {
  const meta = run.dir ? scriptMetaOf(readScriptFile(run.dir)) : null;
  const launched = meta ? `${meta.launched} agents launched${meta.cached ? ` (${meta.cached} cached)` : ""}` : `${run.agents} agents launched`;
  const tokens = meta ? meta.outputTokens : run.outputTokens;
  const omissions = meta && meta.omissions > 0 ? `\nOmitted: ${meta.omissions} step(s) did not complete.` : "";
  const duration = elapsed(run.startedAt, run.endedAt);
  return [
    `Format: script · run ${run.id}`,
    `script ${run.name} · ${run.status}${duration ? ` · ${duration}` : ""}`,
    `Agents: ${launched}; ${tokens} output tokens.${run.error ? `\nError: ${run.error}` : ""}${omissions}`,
    `Run directory: ${run.dir ?? "?"}`,
  ].join("\n");
}

/**
 * One run in full: a YAML run's steps, a script run's counters, or a background subagent's log
 * tail. A workflow step's child is not in the list, but its id still resolves here to its log,
 * the same id `workflow_control` stops. Null when the id names no run; a caller checks the id
 * first (a rejected id reads as "Invalid run id").
 */
export function describeRun(cwd: string, id: string, opts: QueryOptions & { tail?: number | undefined } = {}): string | null {
  const run = findRun(cwd, id, opts);
  if (!run) {
    if (!isValidRunId(id)) return null;
    const child = collectRuns(subagentStateDir(cwd)).find((row) => row.id === id);
    return child ? describeSubagent(cwd, subagentRow(child), opts.tail ?? TAIL_LINES) : null;
  }
  if (run.format === "subagent") return describeSubagent(cwd, run, opts.tail ?? TAIL_LINES);
  if (run.format === "script") return describeScript(run);
  const state = loadState(cwd, id);
  if (!state) return `Format: yaml · run ${id}\n${formatRunLine(run)}\nRun directory: ${run.dir ?? "?"}`;
  return `Format: yaml · run ${id}\n${summarizeRun(state)}\n\nRun directory: ${run.dir ?? "?"}`;
}
