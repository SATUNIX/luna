/**
 * Workflows — declarative chains of subagent (and skill) steps, run by a deterministic executor.
 *
 * A workflow is a Markdown file with YAML frontmatter (the body is documentation). Code, not a
 * model, decides the step order: sequential steps, parallel groups, review gates that loop back
 * to an earlier step, and simple conditions. Every run gets a *blackboard* directory
 * (.pi/workflows/runs/<run-id>/): each step's final answer is saved as steps/<id>.md, steps are
 * told the directory and may write artefacts there, and later steps pull them in with
 * {{file:...}} or {{steps.<id>.output}}. state.json records progress, so an interrupted run
 * (Esc, crash, closed terminal) resumes where it stopped.
 *
 * See docs/workflows.md for the authoring guide.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { agentDir, toText } from "./config.ts";
import type { AgentConfig } from "./agents.ts";
import { mapWithConcurrencyLimit, runAgent, type RunAgentOptions, type RunOverrides } from "./runner.ts";
import { getResultOutput, isFailedResult } from "./result.ts";
import { deriveOutcome, RUN_STATUSES, type Execution, type RunStatus, type StepResult } from "./run-contract.ts";
import { runRegistry, type PhaseStatus, type RunModel, type RunRegistry } from "./run-model.ts";
import { redact, REDACTION_POLICY } from "./redact.ts";
import { redact as redactExecutionText } from "./shared/redact.ts";
import { RunControl } from "./control.ts";
import { parseScriptMeta, type ScriptPhase } from "./wf-meta.ts";
import type { SingleResult, SpawnChild } from "./types.ts";
import { ensureDirSafe, piWorkspaceOptions, writeFileSafe } from "./shared/safe-fs.ts";
import { compileCheckedRegex } from "./shared/safe-regex.ts";

const SUBAGENT_DIR = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------------------------
// Definition

export interface StepDef {
  id: string;
  agent?: string | undefined;
  skill?: string | undefined;
  task?: string | undefined;
  outputs?: string[] | undefined;
  model?: string | undefined;
  thinking?: string | undefined;
  tools?: string[] | undefined;
  skills?: string[] | undefined;
  extensions?: string[] | undefined;
  maxRuntimeMs?: number | undefined;
  when?: { step: string; status: StepStatus | StepStatus[] };
  gate?: { pass: string; retry: string; maxLoops: number };
  continueOnError?: boolean;
  parallel?: StepDef[];
  // The step's answer is more steps, or its result (inline plans only; plan.ts).
  expand?: boolean;
}

export interface WorkflowDef {
  name: string;
  description: string;
  inputs: Record<string, { description?: string | undefined; required?: boolean; default?: string | undefined }>;
  steps: StepDef[];
  vault: boolean;
  source: "kit" | "user" | "project";
  file: string;
}

export const STEP_STATUSES = ["pending", "running", "passed", "failed", "skipped", "aborted"] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

export const MAX_ID_LENGTH = 41;
const ID = /^[a-z][a-z0-9_-]{0,40}$/;
export const MAX_GATE_LOOPS = 10;
const DEFAULT_GATE_LOOPS = 2;

/** A step's fields, in the words the tool text and an expanding child both read. */
export const STEP_SHAPE = "{id?, agent?, task, tools?, skills?, outputs?, when?, gate?, continue_on_error?, expand?} or {parallel: [steps], gate?}";

function parseDuration(value: unknown): number | undefined {
  if (typeof value === "number") return value > 0 ? value : undefined;
  const m = toText(value ?? "").trim().match(/^(\d+)\s*(ms|s|m|h)?$/i);
  if (!m) return undefined;
  const unit = (m[2] ?? "ms").toLowerCase();
  return Number(m[1]) * (unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : unit === "s" ? 1000 : 1);
}

const strList = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.map(String).filter(Boolean) : typeof v === "string" && v.trim() ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined;

// Any non-null object, lists included (their named fields read as undefined), as the parser has
// always accepted. The frontmatter is outside data, so every field is checked before use.
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

function parseStep(raw: unknown, where: string, errors: string[], inline: boolean): StepDef {
  if (!isObject(raw)) {
    errors.push(`${where}: a step must be a mapping`);
    return { id: "invalid" };
  }
  const id = toText(raw.id ?? "");
  if (!ID.test(id)) errors.push(`${where}: id "${id}" must match ${ID}`);
  const step: StepDef = { id };
  if (raw.expand !== undefined && !inline) errors.push(`${where}: expand works only in an inline plan`);
  if (raw.expand === true) step.expand = true;
  if (Array.isArray(raw.parallel)) {
    const members: StepDef[] = raw.parallel.map((s: unknown, i: number) => parseStep(s, `${where}.parallel[${i}]`, errors, inline));
    step.parallel = members;
    for (const inner of members) if (inner.parallel) errors.push(`${where}: parallel groups cannot nest`);
    for (const inner of members) if (inner.gate) errors.push(`${where}: parallel member ${inner.id}: a gate belongs on the group, not on a member`);
    if (!members.length) errors.push(`${where}: parallel group is empty`);
  } else {
    step.agent = raw.agent ? toText(raw.agent) : raw.skill ? "implementer" : undefined;
    step.skill = raw.skill ? toText(raw.skill) : undefined;
    step.task = typeof raw.task === "string" ? raw.task : undefined;
    if (!step.agent) errors.push(`${where}: needs agent: or skill:`);
    if (!step.task?.trim()) errors.push(`${where}: needs a task`);
  }
  step.outputs = strList(raw.outputs);
  for (const o of step.outputs ?? []) if (path.isAbsolute(o) || o.split(/[\\/]/).includes("..")) errors.push(`${where}: output "${o}" must be a relative path inside the run dir`);
  step.model = raw.model ? toText(raw.model) : undefined;
  step.thinking = raw.thinking ? toText(raw.thinking) : undefined;
  step.tools = strList(raw.tools);
  step.extensions = strList(raw.extensions);
  step.skills = [...(strList(raw.skills) ?? []), ...(step.skill ? [step.skill] : [])];
  if (!step.skills.length) step.skills = undefined;
  step.maxRuntimeMs = parseDuration(raw.max_runtime ?? raw.maxRuntime);
  step.continueOnError = raw.continue_on_error === true || raw.continueOnError === true;
  if (raw.when) {
    const w = isObject(raw.when) ? raw.when : {};
    const status = Array.isArray(w.status) ? w.status.map(toText) : [toText(w.status ?? "passed")];
    step.when = { step: toText(w.step ?? ""), status: status as StepStatus[] };
    if (step.parallel) errors.push(`${where}: ${id}: a parallel group cannot take when; put it on each member`);
  }
  if (raw.gate) {
    const g = isObject(raw.gate) ? raw.gate : {};
    const rawLoops = g.max_loops ?? g.maxLoops ?? DEFAULT_GATE_LOOPS;
    const maxLoops = typeof rawLoops === "number" || typeof rawLoops === "string" ? Number(rawLoops) : Number.NaN;
    const loopsOk = Number.isInteger(maxLoops) && maxLoops >= 0 && maxLoops <= MAX_GATE_LOOPS;
    if (!loopsOk) errors.push(`${where}: gate max_loops must be a whole number from 0 to ${String(MAX_GATE_LOOPS)}`);
    step.gate = { pass: toText(g.pass ?? g.expect ?? ""), retry: toText(g.retry ?? g.on_fail ?? ""), maxLoops: loopsOk ? maxLoops : DEFAULT_GATE_LOOPS };
    if (!step.gate.pass) errors.push(`${where}: gate needs pass: (text or /regex/ the verdict line, the last non-empty line, must contain)`);
  }
  return step;
}

/**
 * The step list of a saved workflow or an inline plan (plan.ts): each step parsed, ids unique across
 * the whole workflow, references resolved. Problems go to `errors`; the steps are usable without any.
 * `inline` is a plan's: only a plan may use `expand`, whose result nobody reviewed.
 */
export function parseSteps(raw: unknown, errors: string[], options: { inline?: boolean } = {}): StepDef[] {
  const steps: StepDef[] = Array.isArray(raw) ? raw.map((s: unknown, i: number) => parseStep(s, `steps[${i}]`, errors, options.inline === true)) : [];
  if (!steps.length) errors.push("steps: at least one step is required");
  // Ids are unique across the whole workflow (parallel members included); references resolve.
  const order: string[] = [];
  for (const s of steps) {
    order.push(s.id);
    for (const p of s.parallel ?? []) order.push(p.id);
  }
  const dup = order.filter((id, i) => order.indexOf(id) !== i);
  if (dup.length) errors.push(`duplicate step ids: ${[...new Set(dup)].join(", ")}`);
  steps.forEach((s: StepDef, i: number) => {
    const earlier = new Set(steps.slice(0, i).flatMap((x: StepDef) => [x.id, ...(x.parallel ?? []).map((p) => p.id)]));
    if (s.when && !earlier.has(s.when.step)) errors.push(`step ${s.id}: when.step "${s.when.step}" must name an earlier step`);
    const retry = s.gate?.retry;
    if (retry && !earlier.has(retry) && retry !== s.id) errors.push(`step ${s.id}: gate.retry "${retry}" must name this or an earlier top-level step`);
    if (retry && !steps.slice(0, i + 1).some((x: StepDef) => x.id === retry)) errors.push(`step ${s.id}: gate.retry must be a top-level step`);
  });
  return steps;
}

export function parseWorkflow(content: string, file: string, source: WorkflowDef["source"]): { workflow?: WorkflowDef; errors: string[] } {
  const errors: string[] = [];
  let fm: Record<string, unknown>;
  try {
    fm = parseFrontmatter(content).frontmatter;
  } catch (error) {
    return { errors: [`${file}: invalid YAML frontmatter: ${String(error)}`] };
  }
  const name = toText(fm.name ?? path.basename(file, ".md"));
  if (!ID.test(name)) errors.push(`name "${name}" must match ${ID}`);
  const inputs: WorkflowDef["inputs"] = {};
  if (isObject(fm.inputs)) {
    for (const [k, v] of Object.entries(fm.inputs)) {
      inputs[k] = isObject(v) ? { description: v.description === undefined ? undefined : toText(v.description), required: v.required === true, default: v.default !== undefined ? toText(v.default) : undefined } : { description: toText(v ?? "") };
    }
  }
  const steps = parseSteps(fm.steps, errors);
  if (errors.length) return { errors: errors.map((e) => `${path.basename(file)}: ${e}`) };
  return { workflow: { name, description: toText(fm.description ?? ""), inputs, steps, vault: fm.vault === true, source, file }, errors };
}

// ---------------------------------------------------------------------------------------------
// Discovery: kit < user < project (project workflows are untrusted, like project roles)

export function workflowDirs(cwd: string): Array<{ dir: string; source: WorkflowDef["source"] }> {
  return [
    { dir: process.env.PI_KIT_WORKFLOWS_DIR?.trim() || path.resolve(SUBAGENT_DIR, "..", "..", "..", "kit", "workflows"), source: "kit" },
    { dir: path.join(agentDir(), "workflows"), source: "user" },
    { dir: path.join(cwd, ".pi", "workflows"), source: "project" },
  ];
}

/** A JavaScript workflow script (`<name>.js`), known by its literal `meta` (wf-meta.ts). No engine runs it yet. */
export interface ScriptWorkflowDef {
  kind: "script";
  name: string;
  description: string;
  whenToUse?: string | undefined;
  phases: ScriptPhase[];
  source: WorkflowDef["source"];
  file: string;
}

export const MAX_SCRIPT_BYTES = 1024 * 1024;

function listDir(dir: string, ext: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(ext) && f.toLowerCase() !== "readme.md")
      .sort();
  } catch {
    return [];
  }
}

/** O_NONBLOCK keeps the open from waiting for a writer when the entry is a FIFO (not defined on Windows). */
const SCRIPT_OPEN_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0);

/**
 * Reads one script's meta. The script itself is never run here. The file is opened once and
 * its type, size and text all come from that descriptor, so they describe the same file.
 */
function loadScriptDef(file: string, source: WorkflowDef["source"]): { def?: ScriptWorkflowDef; error?: string } {
  let text: string;
  let fd: number;
  try {
    fd = fs.openSync(file, SCRIPT_OPEN_FLAGS);
  } catch (error) {
    // Windows refuses to open a directory; elsewhere a directory opens and fstat says so below.
    if (error instanceof Error && "code" in error && error.code === "EISDIR") return {};
    return { error: `${path.basename(file)}: unreadable (${String(error)})` };
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return {};
    if (st.size > MAX_SCRIPT_BYTES) return { error: `${path.basename(file)}: larger than ${MAX_SCRIPT_BYTES} bytes` };
    text = fs.readFileSync(fd, "utf8");
  } catch (error) {
    return { error: `${path.basename(file)}: unreadable (${String(error)})` };
  } finally {
    fs.closeSync(fd);
  }
  const parsed = parseScriptMeta(text);
  if (parsed.error !== undefined) return { error: `${path.basename(file)}: ${parsed.error}` };
  const { meta } = parsed;
  return { def: { kind: "script", name: meta.name, description: meta.description, whenToUse: meta.whenToUse, phases: meta.phases, source, file } };
}

/**
 * Every workflow in the kit, user and project directories: YAML (`*.md`) and scripts (`*.js`).
 * Names share one namespace; a later directory overrides an earlier one, and within one
 * directory a script whose name a YAML workflow already uses is reported and skipped.
 */
export function discoverWorkflows(cwd: string): { workflows: WorkflowDef[]; scripts: ScriptWorkflowDef[]; errors: string[] } {
  const byName = new Map<string, WorkflowDef>();
  const scriptsByName = new Map<string, ScriptWorkflowDef>();
  const errors: string[] = [];
  for (const { dir, source } of workflowDirs(cwd)) {
    const here = new Set<string>();
    for (const f of listDir(dir, ".md")) {
      const file = path.join(dir, f);
      const { workflow, errors: e } = parseWorkflow(fs.readFileSync(file, "utf8"), file, source);
      errors.push(...e);
      if (workflow) {
        byName.set(workflow.name, workflow);
        scriptsByName.delete(workflow.name);
        here.add(workflow.name);
      }
    }
    for (const f of listDir(dir, ".js")) {
      const { def, error } = loadScriptDef(path.join(dir, f), source);
      if (error) errors.push(error);
      if (!def) continue;
      if (here.has(def.name)) {
        errors.push(`${f}: name "${def.name}" is already used in ${dir}`);
        continue;
      }
      here.add(def.name);
      scriptsByName.set(def.name, def);
      byName.delete(def.name);
    }
  }
  const byNameSort = <T extends { name: string }>(list: T[]): T[] => list.sort((a, b) => a.name.localeCompare(b.name));
  return { workflows: byNameSort([...byName.values()]), scripts: byNameSort([...scriptsByName.values()]), errors };
}

/** A script's text and the SHA-256 of exactly those bytes, from one read (trust is granted per digest). */
export function readScript(def: ScriptWorkflowDef): { source: string; digest: string } {
  const bytes = fs.readFileSync(def.file);
  if (bytes.length > MAX_SCRIPT_BYTES) throw new Error(`workflow ${def.name}: script is larger than ${MAX_SCRIPT_BYTES} bytes`);
  return { source: bytes.toString("utf8"), digest: crypto.createHash("sha256").update(bytes).digest("hex") };
}

export function workflowDigest(w: WorkflowDef): string {
  return crypto.createHash("sha256").update(fs.readFileSync(w.file)).digest("hex");
}

// ---------------------------------------------------------------------------------------------
// Run state (the blackboard)

export interface StepState {
  status: StepStatus;
  attempts: number;
  runIds: string[];
  output?: string; // truncated copy; the full text is steps/<id>.md
  error?: string;
  cost: number;
  /** Output tokens across every attempt; absent on older runs. */
  outputTokens?: number;
  startedAt?: string;
  endedAt?: string;
  // An `expand` step: its answer has been acted on, so a resume never reads it again.
  expanded?: true | undefined;
  // An `expand` step: why the host refused its steps; the run reports the omission.
  omitted?: string | undefined;
  // An `expand` step: what was wrong with its first answer, told to the one resample.
  expandMiss?: string | undefined;
  // An `expand` step: its answer as the child gave it, between the child ending and the host acting
  // on it, so a kill in that window replays it. steps/<id>.md is redacted, so it cannot serve.
  expandAnswer?: string | undefined;
}

export interface RunState {
  version: 1;
  id: string;
  workflow: string;
  workflowFile: string;
  inputs: Record<string, string>;
  status: RunStatus;
  cursor: number; // index into steps of the next top-level step to run
  loops: Record<string, number>;
  steps: Record<string, StepState>;
  startedAt: string;
  updatedAt: string;
  error?: string | undefined;
  executions: number;
  // Set on every state.json written since run files were redacted (redact.ts); absent on older runs.
  redacted?: true;
  redactionPolicy?: string;
  // Set while the live run is paused (control.ts); removed when it is resumed or ends.
  paused?: true | undefined;
  // Effort run scopes this model-started run has opened (runScopeId); absent on other runs.
  scopes?: number | undefined;
  // An inline plan's run: its definition is the run directory's plan.json, not a workflow file.
  plan?: true | undefined;
}

export const runsRoot = (cwd: string) => path.join(cwd, ".pi", "workflows", "runs");
const MAX_OUTPUT_IN_STATE = 4000;
const MAX_FILE_INCLUDE = 64 * 1024;
const MAX_ANSWER_IN_STATE = MAX_FILE_INCLUDE; // state.json is read back with a limit (loadState)
export const MAX_EXECUTIONS = 60; // hard ceiling on step executions per run (loops included)

/** A run file that is not there: an optional template reads it as empty. */
class MissingRunFile extends Error {}

/** A bounded regular run file, with no links on the way down. A failure names the file by its relative path. */
export function readRunFile(runDir: string, relative: string, maxBytes: number, truncate = false): string {
  try {
    return readBoundedRunFile(runDir, relative, maxBytes, truncate);
  } catch (error) {
    if (error instanceof TemplateError) throw error;
    const code = error instanceof Error && "code" in error ? String(error.code) : "unreadable";
    // ENOTDIR is a parent that is a file: the path does not exist, as for ENOENT.
    throw code === "ENOENT" || code === "ENOTDIR" ? new MissingRunFile(`${relative} does not exist`) : new TemplateError(`run file ${relative} cannot be read (${code})`);
  }
}

function readBoundedRunFile(runDir: string, relative: string, maxBytes: number, truncate: boolean): string {
  const root = path.resolve(runDir);
  const file = path.resolve(root, relative);
  if (!file.startsWith(root + path.sep)) throw new TemplateError("path escapes the run directory");
  let current = piWorkspaceOptions(file).root ?? root;
  for (const part of ["", ...path.relative(current, file).split(path.sep)]) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) throw new TemplateError("run file path contains a symbolic link");
  }
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0) | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) throw new TemplateError("run file must be a regular file with one link");
    // On Linux this checks the opened file, including an ancestor swapped since lstat, before reading.
    const resolved = fs.realpathSync(process.platform === "linux" ? `/proc/self/fd/${fd}` : file);
    if (!resolved.startsWith(fs.realpathSync(root) + path.sep)) throw new TemplateError("run file escapes the run directory");
    if (!truncate && stat.size > maxBytes) throw new TemplateError(`run file is larger than ${maxBytes} bytes`);
    const buffer = Buffer.alloc(maxBytes + 1);
    let size = 0;
    while (size < buffer.length) {
      const n = fs.readSync(fd, buffer, size, buffer.length - size, null);
      if (n === 0) break;
      size += n;
    }
    if (size > maxBytes && !truncate) throw new TemplateError(`run file is larger than ${maxBytes} bytes`);
    const text = buffer.subarray(0, Math.min(size, maxBytes)).toString("utf8");
    return size > maxBytes ? `${text}\n[... truncated at ${maxBytes} bytes; read ${file} for the rest]` : text;
  } finally {
    fs.closeSync(fd);
  }
}

// Run files hold prompts and agent output, so the run directory is 0700 and its files 0600. The
// modes are set explicitly as well, because mkdir/write modes are masked by the umask and are not
// applied to a directory or file that already exists.
// Run directories live under <workspace>/.pi/, so nothing on the way is followed through a
// committed symlink (./shared/safe-fs.ts; tests/workspace-symlink-smoke.ts).
export function ensurePrivateDir(dir: string): void {
  ensureDirSafe(dir, { ...piWorkspaceOptions(dir), dirMode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

export function writePrivate(file: string, text: string): void {
  writeFileSafe(file, text, piWorkspaceOptions(file, 0o600));
}

/** A step answer as it is written to steps/<id>.md: secrets redacted (redact.ts). */
function writeStepOutput(runDir: string, id: string, output: string): string {
  const text = redact(output);
  ensurePrivateDir(path.join(runDir, "steps"));
  writePrivate(path.join(runDir, "steps", `${id}.md`), text);
  return text;
}

/** A step's answer on disk whole, and capped in state.json, which every save rewrites. */
function keepOutput(st: StepState, runDir: string, id: string, output: string): void {
  const text = writeStepOutput(runDir, id, output);
  st.output = text.length > MAX_OUTPUT_IN_STATE ? `${text.slice(0, MAX_OUTPUT_IN_STATE)}…` : text;
}

// The persisted copy: inputs, step outputs and errors go through redact() first. The in-memory
// state is left as it is, so a run that is not resumed keeps its own inputs.
function redactedState(state: RunState): RunState {
  const red = (v: string | undefined): string | undefined => (v === undefined ? undefined : redact(v));
  const steps: Record<string, StepState> = {};
  for (const [id, st] of Object.entries(state.steps)) {
    const copy: StepState = { ...st };
    if (st.output !== undefined) copy.output = redact(st.output);
    if (st.error !== undefined) copy.error = redact(st.error);
    if (st.omitted !== undefined) copy.omitted = redact(st.omitted);
    if (st.expandMiss !== undefined) copy.expandMiss = redact(st.expandMiss);
    steps[id] = copy;
  }
  const inputs = Object.fromEntries(Object.entries(state.inputs).map(([k, v]) => [k, redact(v)]));
  return { ...state, inputs, steps, error: red(state.error), redacted: true, redactionPolicy: REDACTION_POLICY };
}

function saveState(dir: string, state: RunState): void {
  state.updatedAt = new Date().toISOString();
  ensurePrivateDir(dir);
  // writeFileSafe replaces the file through its own exclusive temporary file and a rename.
  writePrivate(path.join(dir, "state.json"), JSON.stringify(redactedState(state), null, 2));
}

const RUN_STATES: ReadonlySet<string> = new Set(RUN_STATUSES);
const STEP_STATES: ReadonlySet<string> = new Set(STEP_STATUSES);

function isStepState(value: unknown): value is StepState {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const s = value as Record<string, unknown>;
  return (
    typeof s.status === "string" &&
    STEP_STATES.has(s.status) &&
    typeof s.attempts === "number" &&
    Number.isFinite(s.attempts) &&
    typeof s.cost === "number" &&
    Number.isFinite(s.cost) &&
    (s.outputTokens === undefined || (typeof s.outputTokens === "number" && Number.isFinite(s.outputTokens))) &&
    Array.isArray(s.runIds) &&
    s.runIds.every((r) => typeof r === "string") &&
    (s.expanded === undefined || s.expanded === true) &&
    (s.omitted === undefined || typeof s.omitted === "string") &&
    (s.expandMiss === undefined || typeof s.expandMiss === "string") &&
    (s.expandAnswer === undefined || typeof s.expandAnswer === "string")
  );
}

function isRunState(value: unknown): value is RunState {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const s = value as Record<string, unknown>;
  const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
  return (
    typeof s.id === "string" &&
    typeof s.workflow === "string" &&
    typeof s.startedAt === "string" &&
    typeof s.status === "string" &&
    RUN_STATES.has(s.status) &&
    typeof s.cursor === "number" &&
    Number.isInteger(s.cursor) &&
    s.cursor >= 0 &&
    typeof s.executions === "number" &&
    Number.isFinite(s.executions) &&
    s.executions >= 0 &&
    isRecord(s.loops) &&
    Object.values(s.loops).every((n) => typeof n === "number") &&
    isRecord(s.steps) &&
    Object.values(s.steps).every(isStepState) &&
    (s.scopes === undefined || (typeof s.scopes === "number" && Number.isInteger(s.scopes) && s.scopes >= 0)) &&
    (s.plan === undefined || s.plan === true)
  );
}

export function loadState(cwd: string, id: string): RunState | null {
  if (!/^[A-Za-z0-9._-]+$/.test(id)) return null;
  try {
    // A child can write in the run directory: a link, a FIFO or a huge file reads as no run.
    const parsed: unknown = JSON.parse(readRunFile(path.join(runsRoot(cwd), id), "state.json", MAX_SCRIPT_BYTES));
    return isRunState(parsed) ? ownState(parsed) : null;
  } catch {
    return null;
  }
}

export function listRuns(cwd: string, limit = 20): RunState[] {
  let ids: string[];
  try {
    ids = fs.readdirSync(runsRoot(cwd));
  } catch {
    return [];
  }
  return ids
    .map((id) => loadState(cwd, id))
    .filter((s): s is RunState => s !== null)
    .sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""))
    .slice(0, limit);
}

// ---------------------------------------------------------------------------------------------
// Templating

export class TemplateError extends Error {}

// {{inputs.x}}  {{steps.<id>.output}}  {{steps.<id>.status}}  {{file:rel/path}}  {{run.dir}}
// {{run.id}}  {{loop}}.  A trailing "?" makes a missing value empty instead of an error.
export const GATE_REGEX = /^\/(.+)\/([a-z]*)$/;
export const TEMPLATE_EXPR = /\{\{([^{}]+)\}\}/g;
// An expanded step's id carries its parent's (`split.a`).
export const STEP_REFERENCE = /^steps\.([a-z][a-z0-9_.-]*)\.(output|status)$/;

export function templateExpression(raw: string): { expr: string; optional: boolean } {
  const text = raw.trim();
  const optional = text.endsWith("?");
  return { expr: optional ? text.slice(0, -1).trim() : text, optional };
}

/**
 * A step's status as a later step reads it. A step whose expansion was refused did its own work, so
 * it stays passed, but what it asked for never happened, and nothing may read that as done.
 */
const resultStatus = (st: StepState | undefined): StepStatus | undefined => (st?.omitted !== undefined ? "skipped" : st?.status);

export function renderTemplate(template: string, ctx: { inputs: Record<string, string>; state: RunState; runDir: string; loop: number }): string {
  return template.replace(TEMPLATE_EXPR, (_m, exprRaw: string) => {
    const { expr, optional } = templateExpression(exprRaw);
    const missing = (what: string) => {
      if (optional) return "";
      throw new TemplateError(`template {{${expr}}}: ${what}`);
    };
    if (expr === "run.dir") return ctx.runDir;
    if (expr === "run.id") return ctx.state.id;
    if (expr === "loop") return String(ctx.loop);
    if (expr.startsWith("inputs.")) {
      const v = ctx.inputs[expr.slice(7)];
      return v !== undefined && v !== "" ? v : missing("input not provided");
    }
    const stepRef = STEP_REFERENCE.exec(expr);
    if (stepRef) {
      const [, stepId = "", field] = stepRef;
      const st = ctx.state.steps[stepId];
      if (field === "status") return resultStatus(st) ?? missing("unknown step");
      try {
        return readRunFile(ctx.runDir, `steps/${stepId}.md`, MAX_SCRIPT_BYTES, true);
      } catch (error) {
        if (error instanceof MissingRunFile) return missing(`step "${stepId}" has no output yet`);
        throw error;
      }
    }
    if (expr.startsWith("file:")) {
      const rel = expr.slice(5).trim();
      try {
        return readRunFile(ctx.runDir, rel, MAX_FILE_INCLUDE, true);
      } catch (error) {
        if (error instanceof MissingRunFile) return missing(`file ${rel} does not exist in the run directory`);
        throw error;
      }
    }
    throw new TemplateError(`template {{${expr}}}: unknown expression`);
  });
}

// The errors recorded on a step skipped by `skip` (live) or by the resume prompt. A review gate
// treats such a step, or such a member of its group, as a failed verdict, so skipping never
// bypasses a gate. A step skipped by its own `when` is the workflow's choice and is not counted.
export const SKIPPED_BY_OPERATOR = "skipped by operator";
export const SKIPPED_BY_AGENT = "skipped by the agent";
export const SKIPPED_ON_RESUME = "skipped on resume";
function skippedByControl(st: StepState | undefined): boolean {
  return st?.status === "skipped" && (st.error === SKIPPED_BY_OPERATOR || st.error === SKIPPED_BY_AGENT || st.error === SKIPPED_ON_RESUME);
}

/** How a /regex/ gate's pass is read; plan.ts checks it the same way before a run starts. */
export function compileGate(pattern: string): ReturnType<typeof compileCheckedRegex> | null {
  const re = GATE_REGEX.exec(pattern);
  if (!re) return null;
  const [, source = "", flags = ""] = re;
  // A project workflow is repository content, so its gate pattern goes through the shared
  // safe-regex check (./shared/safe-regex.ts); a refused pattern fails the gate.
  try {
    return compileCheckedRegex(source, flags.includes("i") ? flags : `${flags}i`);
  } catch (error) {
    return { ok: false, problem: error instanceof Error ? error.message : String(error) };
  }
}

// A checked pattern can still backtrack polynomially, and the host's loop runs every session, so it
// is tested in a worker that a timer can end. The start-up allowance is apart from the test's.
const GATE_START_MS = 5000;
const GATE_TEST_MS = 1000;

/** The worker could not test the gate, which says nothing about the step's work. */
export class GateError extends Error {}

/** Test a checked pattern in ./gate-worker.mjs. A test that runs out of time misses; a worker that dies is a GateError. */
function testInWorker(re: RegExp, output: string): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const worker = new Worker(new URL("./gate-worker.mjs", import.meta.url), { workerData: { re, output } });
    const end = (settle: () => void): void => {
      clearTimeout(timer);
      worker.removeAllListeners();
      worker.on("error", () => undefined); // a terminating worker may still report
      void worker.terminate();
      settle();
    };
    const died = (why: string): void => end(() => reject(new GateError(why)));
    let timer = setTimeout(() => died(`the gate worker did not start in ${String(GATE_START_MS)} ms`), GATE_START_MS);
    worker.on("message", (value: unknown) => {
      if (value === "ready") {
        clearTimeout(timer);
        timer = setTimeout(() => end(() => resolve(false)), GATE_TEST_MS);
        worker.postMessage("test");
      } else if (typeof value === "boolean") end(() => resolve(value));
      else died("the gate worker sent no verdict");
    });
    worker.on("error", (error: unknown) => died(`the gate worker failed: ${error instanceof Error ? error.message : String(error)}`));
    worker.on("exit", (code) => died(`the gate worker exited (${String(code)})`));
  });
}

/** Whether a step's answer passes its gate. Verdicts come last, so a long answer is tested on its tail. */
export async function gatePasses(pattern: string, output: string): Promise<boolean> {
  const checked = compileGate(pattern);
  if (!checked) {
    // Plain text must appear on the verdict line: the last non-empty line of the output. A verdict
    // comes last, and matching the pass token anywhere else in the prose lets a reviewer's FAIL pass.
    const lastLine = output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .at(-1);
    if (lastLine === undefined) return false;
    return lastLine.toLowerCase().includes(pattern.toLowerCase());
  }
  return checked.ok ? testInWorker(checked.re, output.slice(-MAX_FILE_INCLUDE)) : false;
}

// ---------------------------------------------------------------------------------------------
// Worst case and run scope

// An `expand` step counts its one resample. A plan's gate never rewinds over one (plan.ts), so this
// adds nothing to a gated segment.
const leafCount = (step: StepDef): number => step.parallel?.length ?? (step.expand ? 2 : 1);

/**
 * The most agents a run can still launch, retries of a failed launch aside: each step once, plus
 * every gated segment (retry target to gate) for each loop its gate has left. Loop counts persist
 * across a rewind, so each gate adds its own loops once and overlapping gates simply add up.
 *
 * With `state`, only what is left: the steps from the cursor, the unpassed members of an interrupted
 * group there, and the gates a run from here can still reach, which includes one behind the cursor
 * when a later gate can rewind past it. An `expand` step's steps are not known yet: each expansion
 * is charged when it arrives, and from then on is counted here.
 */
export function worstCaseAgents(w: WorkflowDef, state?: RunState): number {
  const cursor = state?.cursor ?? 0;
  const left = (step: StepDef): number => (step.gate ? Math.max(0, step.gate.maxLoops - (state?.loops[step.id] ?? 0)) : 0);
  const retryIndex = (step: StepDef): number => (step.gate?.retry ? w.steps.findIndex((s) => s.id === step.gate?.retry) : -1);
  let reach = cursor;
  for (let changed = true; changed; ) {
    changed = false;
    for (const [i, step] of w.steps.entries()) {
      const target = retryIndex(step);
      if (i >= reach && left(step) > 0 && target >= 0 && target < reach) {
        reach = target;
        changed = true;
      }
    }
  }
  let total = 0;
  for (const [i, step] of w.steps.entries()) {
    if (i >= cursor) total += i === cursor && state ? atCursor(step, state) : leafCount(step);
    const target = retryIndex(step);
    if (i >= reach && target >= 0) total += left(step) * w.steps.slice(target, i + 1).reduce((sum, s) => sum + leafCount(s), 0);
  }
  return total;
}

/** What the step at the cursor can still launch. A pass there launches nothing, unless an expansion is unsettled. */
function atCursor(step: StepDef, state: RunState): number {
  if (step.parallel) return unfinishedMembers(step, state).length;
  const st = state.steps[step.id];
  if (st?.status !== "passed") return leafCount(step);
  return step.expand && !st.expanded && st.expandMiss === undefined ? 1 : 0;
}

/**
 * A parallel group's members to run: all of them, none of a group that passed and only awaits the
 * cursor, or on resume those that had not passed or been skipped. A gate's rewind sets its members
 * back to pending, so a pass from an earlier loop never reads as finished here.
 */
function unfinishedMembers(group: StepDef, state: RunState): StepDef[] {
  const members = group.parallel ?? [];
  const status = state.steps[group.id]?.status;
  if (status === "passed") return [];
  if (status !== "aborted" && status !== "running") return members;
  return members.filter((inner) => !["passed", "skipped"].includes(state.steps[inner.id]?.status ?? "pending"));
}

const MAX_RUN_SCOPE_ID = 64;

/**
 * The effort scope id for this run's next scope. The ledger opens an id once, so a resume takes a new
 * one: the run id, then `.r2`, `.r3`. A run id too long for the ledger is replaced by its digest.
 */
export function runScopeId(state: RunState): string {
  const n = (state.scopes ?? 0) + 1;
  const suffix = n > 1 ? `.r${String(n)}` : "";
  const room = MAX_RUN_SCOPE_ID - suffix.length;
  const base = state.id.length <= room ? state.id : crypto.createHash("sha256").update(state.id).digest("hex").slice(0, room);
  return `${base}${suffix}`;
}

// ---------------------------------------------------------------------------------------------
// Executor

/**
 * What the host did with an `expand` step's answer. `invalid` carries what the resample is told;
 * `refused` launches nothing and is reported as an omission; `spliced` steps are already in the run.
 */
export type ExpansionVerdict = { kind: "done"; text: string } | { kind: "spliced"; steps: StepDef[] } | { kind: "refused"; reason: string } | { kind: "invalid"; note: string };

/** How a plan's run turns an `expand` step's answer into steps (workflow-tools.ts). */
export interface ExpansionHost {
  settle(parent: StepDef, output: string): ExpansionVerdict;
  /** A child's answer this process saw, so a resume can tell it from one written into state.json. */
  remember(stepId: string, answer: string): void;
}

export interface ExecuteOptions {
  cwd: string;
  agents: AgentConfig[];
  signal?: AbortSignal | undefined;
  parentModel?: string | undefined;
  onProgress?: ((text: string) => void) | undefined;
  spawnChild?: SpawnChild | undefined;
  concurrency?: number;
  // "user" when the person typed the command (bounded by platform ceilings only); "workflow" when
  // the model started the run, charged to `workflowRun`, the scope effort opened for it.
  launchKind?: "user" | "workflow" | undefined;
  workflowRun?: { runId: string; runToken: string } | undefined;
  // The telemetry registry this run reports to (run-model.ts); defaults to the process-wide one.
  registry?: RunRegistry | undefined;
  // Pause/resume/stop/skip for this run (control.ts). Without one the run gets its own; `signal`
  // still stops it either way.
  control?: RunControl | undefined;
  // Set on a plan's run: what an `expand` step's answer does. Saved workflows have no `expand`.
  expansion?: ExpansionHost | undefined;
}

// Inside the executor the run's control is always present.
type RunOptions = ExecuteOptions & { control: RunControl; answers: Map<string, string> };

function projectSlug(cwd: string): string {
  let dir = path.resolve(cwd);
  for (;;) {
    if (fs.existsSync(path.join(dir, ".git"))) break;
    const parent = path.dirname(dir);
    if (parent === dir) {
      dir = path.resolve(cwd);
      break;
    }
    dir = parent;
  }
  return path.basename(dir).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "project";
}

export function newRunState(w: WorkflowDef, inputs: Record<string, string>): RunState {
  const now = new Date();
  const id = `${now.toISOString().replace(/[:.]/g, "-")}-${w.name}-${crypto.randomBytes(2).toString("hex")}`;
  return ownState({ version: 1, id, workflow: w.name, workflowFile: w.file, inputs: { ...inputs }, status: "running", cursor: 0, loops: {}, steps: {}, startedAt: now.toISOString(), updatedAt: now.toISOString(), executions: 0 });
}

function ownState(state: RunState): RunState {
  for (const record of [state.steps, state.loops, state.inputs]) Object.setPrototypeOf(record, null);
  return state;
}

export function resolveInputs(w: WorkflowDef, given: Record<string, string>): { inputs: Record<string, string>; missing: string[] } {
  const inputs: Record<string, string> = { ...given };
  const missing: string[] = [];
  for (const [k, spec] of Object.entries(w.inputs)) {
    if ((inputs[k] === undefined || inputs[k] === "") && spec.default !== undefined) inputs[k] = spec.default;
    if (spec.required && !inputs[k]) missing.push(k);
  }
  return { inputs, missing };
}

/** A step that can edit files directly, or has every tool: the rule the script engine's writer lock uses. */
function editsFiles(step: StepDef, agents: readonly AgentConfig[]): boolean {
  const tools = step.tools?.length ? step.tools : agents.find((a) => a.name === step.agent)?.tools;
  return !tools?.length || tools.some((t) => t === "write" || t === "edit");
}

const BLACKBOARD_NOTE = (runDir: string, files: string[]) =>
  [
    "## Workflow run",
    `You are one step of an automated workflow. The run's shared directory is: ${runDir}`,
    "Write any files your task asks for into that directory (relative names are relative to it). Later steps read them.",
    files.length ? `Files already in the run directory: ${files.join(", ")}` : "",
    "End with a concise final answer: it is saved and passed to later steps.",
  ]
    .filter(Boolean)
    .join("\n");

const EXPAND_NOTE =
  "\n\n## Your answer\nYour final answer is exactly one JSON object and nothing else: {\"steps\":[...]} and the host runs those steps next, or {\"done\":\"the result\"} if no more steps are needed. " +
  `A step is ${STEP_SHAPE}. tools only narrow what you have. You cannot start agents yourself; the steps are how you ask.`;

function listRunFiles(runDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "state.json" || e.name === "plan.json" || e.name.endsWith(".tmp")) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else out.push(r);
    }
  };
  try {
    walk(runDir, "");
  } catch {
    /* empty */
  }
  return out.slice(0, 50);
}

// Telemetry for one step execution: the run's model and the phase (top-level step id) it belongs to.
interface StepTelemetry {
  run: RunModel;
  phase: string;
}

const DENIAL_POLL_MS = 250;

/** Wait `ms`, or less when the signal aborts first. */
export function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** What the script engine does around each attempt: admit it, charge it, give its place back on a denial. */
export interface SlotHooks {
  before: () => Promise<void>;
  ran: (result: SingleResult) => void;
  denied: () => void;
}

/**
 * runAgent for a workflow step: a "concurrency" denial means the run's slots are full, so it waits
 * for one instead of failing the step. Both workflow engines launch through this.
 */
export async function runAgentWithSlot(options: RunAgentOptions & { signal: AbortSignal }, hooks?: SlotHooks): Promise<SingleResult> {
  for (;;) {
    await hooks?.before();
    const r = await runAgent(options);
    hooks?.ran(r);
    if (r.deniedCode !== "concurrency" || options.signal.aborted) return r;
    hooks?.denied();
    await delay(DENIAL_POLL_MS, options.signal);
  }
}

async function runStep(step: StepDef, state: RunState, runDir: string, loop: number, opts: RunOptions, tele: StepTelemetry): Promise<StepState> {
  const st: StepState = state.steps[step.id] ?? { status: "pending", attempts: 0, runIds: [], cost: 0 };
  state.steps[step.id] = st;
  const start = { label: step.id, phase: tele.phase, role: step.agent, model: step.model };
  if (step.when) {
    const dep = resultStatus(state.steps[step.when.step]);
    const wanted = Array.isArray(step.when.status) ? step.when.status : [step.when.status];
    if (!dep || !wanted.includes(dep)) {
      st.status = "skipped";
      delete st.error;
      st.endedAt = new Date().toISOString();
      tele.run.agentSkipped(start);
      saveState(runDir, state);
      return st;
    }
  }
  let task: string;
  try {
    task = renderTemplate(step.task ?? "", { inputs: state.inputs, state, runDir, loop });
    if (st.expandMiss !== undefined) task = `${task}\n\n${st.expandMiss}`;
    if (step.outputs?.length) {
      const required = step.outputs.map((o) => path.join(runDir, o));
      task = `${task}\n\n## Required output\n${required.map((p) => `Write your report to ${p}. The step fails if that exact file is absent.`).join("\n")}`;
    }
  } catch (error) {
    st.status = "failed";
    st.error = error instanceof Error ? error.message : String(error);
    tele.run.agentEnd(tele.run.agentStart(start), { status: "failed", error: st.error });
    saveState(runDir, state);
    return st;
  }
  // The scheduler gate: a paused run launches no new agent. A stop while waiting launches nothing
  // and leaves the step as it was, so a resume does not mistake it for an interrupted one.
  await opts.control.gate();
  if (opts.control.stopped) return st;
  st.status = "running";
  delete st.error;
  st.attempts++;
  st.startedAt = new Date().toISOString();
  state.executions++;
  // On disk before the launch: a crash during this step must leave it "running", so a resume knows
  // a writer may have changed files (interruptedWriterSteps), not as if it had never started.
  saveState(runDir, state);
  opts.onProgress?.(`${state.workflow} · ${step.id}${loop ? ` (loop ${loop})` : ""} · running ${step.agent}`);
  const overrides: RunOverrides = {
    model: step.model,
    thinking: step.thinking,
    tools: step.tools,
    skills: step.skills,
    extensions: step.extensions,
    maxRuntimeMs: step.maxRuntimeMs,
    appendSystemPrompt: BLACKBOARD_NOTE(runDir, listRunFiles(runDir)) + (step.expand ? EXPAND_NOTE : ""),
  };
  const agentId = tele.run.agentStart(start);
  const handle = opts.control.agent(step.id, agentId);
  let result: SingleResult;
  try {
    const launch: RunAgentOptions & { signal: AbortSignal } = {
      defaultCwd: opts.cwd,
      agents: opts.agents,
      agentName: step.agent ?? "", // parseStep requires an agent on every non-parallel step
      task,
      signal: handle.signal,
      parentModel: opts.parentModel,
      spawnChild: opts.spawnChild,
      overrides,
      launchKind: opts.launchKind,
      workflowRun: opts.workflowRun,
      onUpdate: (t) => {
        tele.run.agentUpdate(agentId, { activity: t });
        opts.onProgress?.(`${state.workflow} · ${step.id} · ${t}`);
      },
      onUsage: (usage, model) => tele.run.agentUpdate(agentId, { usage, model }),
    };
    // A step waiting for a slot takes a pause like any other launch.
    result = await runAgentWithSlot(launch, { before: () => opts.control.gate(), ran: () => undefined, denied: () => undefined });
  } finally {
    handle.done();
  }
  const settle = (status: "passed" | "failed" | "aborted" | "skipped"): void =>
    tele.run.agentEnd(agentId, { status, usage: result.usage, model: result.model, subagentRunId: result.runId, error: st.error });
  if (result.runId) st.runIds.push(result.runId);
  st.cost += result.usage.cost;
  st.outputTokens = (st.outputTokens ?? 0) + result.usage.output;
  const answer = result.finalOutput || getResultOutput(result);
  if (step.expand || step.gate) opts.answers.set(step.id, answer);
  keepOutput(st, runDir, step.id, answer);
  st.endedAt = new Date().toISOString();
  // A member of a parallel group settles while its siblings still run, and the group saves only once
  // they all have: write now, so a host kill loses nothing that finished. saveState writes the whole
  // state synchronously, so two settles cannot interleave or lose a member.
  const settled = (): StepState => {
    saveState(runDir, state);
    return st;
  };
  if (handle.skipped()) {
    st.status = "skipped";
    st.error = handle.skipOrigin() === "agent" ? SKIPPED_BY_AGENT : SKIPPED_BY_OPERATOR;
    settle("skipped");
    return settled();
  }
  if (result.stopReason === "aborted" || opts.control.stopped) {
    st.status = "aborted";
    st.error = "cancelled";
    settle("aborted");
    return settled();
  }
  if (isFailedResult(result)) {
    st.status = "failed";
    st.error = result.errorMessage || result.stderr.slice(0, 500) || `exit ${result.exitCode}`;
    settle("failed");
    return settled();
  }
  const missingOutputs = (step.outputs ?? []).filter((o) => !fs.existsSync(path.join(runDir, o)));
  if (missingOutputs.length) {
    st.status = "failed";
    st.error = `declared output(s) not written in ${runDir}: ${missingOutputs.map((o) => path.join(runDir, o)).join(", ")}`;
    settle("failed");
    return settled();
  }
  st.status = "passed";
  settle("passed");
  if (step.expand) {
    opts.expansion?.remember(step.id, answer);
    if (answer.length <= MAX_ANSWER_IN_STATE && redactExecutionText(answer) === answer) st.expandAnswer = answer;
  }
  return settled();
}

// A stale "running" in a resumed state.json is a step that never finished: it shows as pending.
const phaseStatus = (s: StepStatus | undefined): PhaseStatus => (s === undefined || s === "running" ? "pending" : s);

// What a step that reached the executor did; `pending` and `skipped` are not reported.
const STEP_EXECUTION: Readonly<Record<Exclude<StepStatus, "pending" | "skipped">, Execution>> = { running: "unknown", passed: "completed", failed: "failed", aborted: "cancelled" };

/**
 * One StepResult for each leaf step that ran, from its latest attempt, so a gate that missed and then
 * passed reads as completed. A skip is not an omission: a `when` skip is the plan working, and an
 * operator's skip is a decision to go on. Neither is a step that never reached the executor. The one
 * exception is the governed agent's skip of a required step, which is an omission, not `required`:
 * the agent cannot turn it into `passed`, and the run keeps what the other steps did. An expansion
 * the host refused is an omission too: the step itself ran, the work it asked for did not.
 */
export function stepResults(w: WorkflowDef, state: RunState): StepResult[] {
  const out: StepResult[] = [];
  for (const step of w.steps.flatMap((s) => s.parallel ?? [s])) {
    const st = state.steps[step.id];
    if (st?.status === "skipped" && st.error === SKIPPED_BY_AGENT && !step.continueOnError) out.push({ stepId: step.id, execution: "skipped", required: false, reason: { code: "agent-skip", text: st.error }, usage: { agents: st.attempts, outputTokens: st.outputTokens ?? 0 } });
    if (!st || st.status === "pending" || st.status === "skipped") continue;
    out.push({ stepId: step.id, execution: STEP_EXECUTION[st.status], required: !step.continueOnError, ...(st.error ? { reason: { code: "step", text: st.error } } : {}), usage: { agents: st.attempts, outputTokens: st.outputTokens ?? 0 } });
    if (st.omitted !== undefined) out.push({ stepId: step.id, execution: "skipped", required: false, reason: { code: "expand-refused", text: st.omitted }, usage: { agents: 0, outputTokens: 0 } });
  }
  return out;
}

/**
 * Run (or resume) a workflow. Returns the final state; never throws for step failures.
 * Resuming re-runs the step that was interrupted and continues from there.
 */
export async function executeWorkflow(w: WorkflowDef, state: RunState, options: ExecuteOptions): Promise<RunState> {
  ownState(state);
  const control = options.control ?? new RunControl(state.id);
  // The caller's signal (Esc on the tool call) stops the run like a `stop` action.
  const onAbort = () => control.act("stop");
  if (options.signal?.aborted) onAbort();
  else options.signal?.addEventListener("abort", onAbort, { once: true });
  const opts: RunOptions = { ...options, control, signal: control.signal, answers: new Map() };
  // Telemetry: every top-level step is a phase, listed up front with its saved status.
  const run = (opts.registry ?? runRegistry).start(state.id, "yaml", w.name, { description: w.description, file: w.file, source: w.source });
  for (const step of w.steps) run.phase(step.id, step.id, phaseStatus(state.steps[step.id]?.status));
  try {
    const final = await executeSteps(w, state, opts, run);
    if (final.status !== "running") run.finish(final.status, final.error);
    return final;
  } catch (error) {
    // A thrown invariant or a failed write: the run is over, so state.json must not read as live.
    state.status = "failed";
    state.error = `executor error: ${error instanceof Error ? error.message : String(error)}`;
    state.paused = undefined;
    try {
      saveState(path.join(runsRoot(opts.cwd), state.id), state);
    } catch {
      /* the write may be what failed; the caller gets the throw */
    }
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    // An executor error (a thrown invariant) must not leave the run looking live.
    run.finish("failed", "executor error");
  }
}

async function executeSteps(w: WorkflowDef, state: RunState, opts: RunOptions, run: RunModel): Promise<RunState> {
  const runDir = path.join(runsRoot(opts.cwd), state.id);
  ensurePrivateDir(runDir);
  state.status = "running";
  state.error = undefined;
  state.paused = opts.control.paused ? true : undefined;
  run.setPaused(opts.control.paused);
  saveState(runDir, state);
  // Pause and resume show in state.json and the run model while the run is live.
  const offControl = opts.control.onChange((paused) => {
    state.paused = paused ? true : undefined;
    run.setPaused(paused);
    if (state.status === "running") saveState(runDir, state);
  });
  const finish = (end: RunFinish) => {
    offControl();
    const { status } = deriveOutcome(stepResults(w, state), { errored: end.error !== undefined, stopped: end.stopped === true, hasResult: true });
    state.status = status;
    state.error = end.stopped ? "cancelled" : end.error;
    state.paused = undefined;
    run.setPaused(false);
    saveState(runDir, state);
    return state;
  };
  try {
    return await runSteps(w, state, opts, run, runDir, finish);
  } finally {
    offControl();
  }
}

/**
 * Act on an `expand` step's answer, once. An invalid answer gets one resample, told what was wrong; a
 * second miss fails the step, as does a miss with no execution left to resample with. Everything but that failure leaves the step passed, because the step
 * did its work: `done` becomes its output, `refused` an omission, and spliced steps are ordinary
 * steps of this run from here on, so stop, failure and the journal need nothing new.
 */
async function settleExpansion(step: StepDef, st: StepState, state: RunState, opts: RunOptions, run: RunModel, runDir: string, loop: number): Promise<void> {
  while (st.status === "passed" && !st.expanded) {
    const answer = opts.answers.get(step.id) ?? st.expandAnswer;
    const verdict: ExpansionVerdict = answer === undefined ? { kind: "invalid", note: "The original expansion answer is unavailable; answer again without credentials." } : opts.expansion?.settle(step, answer) ?? { kind: "refused", reason: "this run cannot expand a step" };
    // Acted on, so it goes at the next save. Until that save a kill replays it, and plan.json decides.
    delete st.expandAnswer;
    opts.answers.delete(step.id);
    if (verdict.kind === "invalid") {
      if (st.expandMiss !== undefined) {
        st.status = "failed";
        st.error = `no usable answer after a resample. ${verdict.note}`;
        break;
      }
      if (state.executions >= MAX_EXECUTIONS) {
        st.status = "failed";
        st.error = `no resample: the run is at ${MAX_EXECUTIONS} step executions (loop safety limit). ${verdict.note}`;
        break;
      }
      // Pending until the resample starts: a stop before then must not read the old answer again.
      st.expandMiss = verdict.note;
      st.status = "pending";
      saveState(runDir, state);
      await runStep(step, state, runDir, loop, opts, { run, phase: step.id });
      saveState(runDir, state);
      continue;
    }
    st.expanded = true;
    if (verdict.kind === "done") keepOutput(st, runDir, step.id, verdict.text);
    else if (verdict.kind === "refused") {
      st.omitted = verdict.reason;
      keepOutput(st, runDir, step.id, verdict.reason); // the steps it asked for must not read as its result
    } else {
      for (const leaf of verdict.steps.flatMap((s) => [s, ...(s.parallel ?? [])])) state.steps[leaf.id] = { status: "pending", attempts: 0, runIds: [], cost: 0 };
      let after = step.id;
      for (const added of verdict.steps) {
        run.phase(added.id, added.id, "pending", undefined, after);
        after = added.id;
      }
      opts.onProgress?.(`${state.workflow} · ${step.id} · expanded into ${String(verdict.steps.length)} step(s)`);
    }
    delete st.expandMiss;
    saveState(runDir, state);
  }
}

/** A member's answer for its group's output. A child can replace the file, so it is read like any run file. */
function memberOutput(runDir: string, id: string): string {
  try {
    return readRunFile(runDir, `steps/${id}.md`, MAX_SCRIPT_BYTES, true);
  } catch (error) {
    if (error instanceof MissingRunFile) return "(no output)";
    throw error;
  }
}

/** How the executor's loop ended: stopped, stopped on an error, or (neither) off the last step. */
interface RunFinish {
  stopped?: boolean;
  error?: string;
}

async function runSteps(w: WorkflowDef, state: RunState, opts: RunOptions, run: RunModel, runDir: string, finish: (end: RunFinish) => RunState): Promise<RunState> {
  while (state.cursor < w.steps.length) {
    await opts.control.gate();
    if (opts.control.stopped) return finish({ stopped: true });
    if (state.executions >= MAX_EXECUTIONS) return finish({ error: `stopped after ${MAX_EXECUTIONS} step executions (loop safety limit)` });
    const step = w.steps[state.cursor];
    if (!step) throw new Error(`workflow ${w.name}: no step at position ${state.cursor}`);
    const loop = step.gate ? (state.loops[step.id] ?? 0) : Object.values(state.loops).reduce((a, b) => Math.max(a, b), 0);

    let failed: string | undefined;
    if (step.parallel) {
      const group: StepState = state.steps[step.id] ?? { status: "pending", attempts: 0, runIds: [], cost: 0 };
      state.steps[step.id] = group;
      const todo = unfinishedMembers(step, state);
      if (state.executions + todo.length > MAX_EXECUTIONS) return finish({ error: `stopped before group ${step.id}: its ${todo.length} step(s) would pass ${MAX_EXECUTIONS} step executions (loop safety limit)` });
      group.status = "running";
      group.startedAt = new Date().toISOString();
      saveState(runDir, state);
      run.setPhaseStatus(step.id, "running");
      // Zero means the tier allows no concurrent agents, and the limiter below would read it as one.
      if (opts.concurrency === 0) return finish({ error: `stopped before group ${step.id}: this tier allows no concurrent agents (maxConcurrent is 0)` });
      // A plan is not reviewed, so its writers share the checkout one at a time. A saved workflow's
      // author chose its groups (docs/workflows.md).
      const oneAtATime = state.plan === true && todo.some((inner) => editsFiles(inner, opts.agents));
      // A member that fails to write stops the rest: they run on no one's behalf otherwise, and would
      // rewrite the failed run's state. The group waits for them, so nothing outlives the run.
      let broke: { error: unknown } | undefined;
      await mapWithConcurrencyLimit(todo, oneAtATime ? 1 : (opts.concurrency ?? 4), async (inner) => {
        try {
          await runStep(inner, state, runDir, loop, opts, { run, phase: step.id });
        } catch (error) {
          broke ??= { error };
          opts.control.act("stop");
        }
      });
      if (broke) throw broke.error;
      const results = step.parallel.map((inner) => {
        const r = state.steps[inner.id];
        if (!r) throw new Error(`workflow ${w.name}: step ${inner.id} has no state`);
        return r;
      });
      saveState(runDir, state);
      group.endedAt = new Date().toISOString();
      group.cost = results.reduce((a, r) => a + r.cost, 0);
      if (results.some((r) => r.status === "aborted") || opts.control.stopped) {
        group.status = "aborted";
        run.setPhaseStatus(step.id, "aborted");
        return finish({ stopped: true });
      }
      const bad = step.parallel.filter((inner, i) => results[i]?.status === "failed" && !inner.continueOnError);
      group.status = bad.length ? "failed" : "passed";
      run.setPhaseStatus(step.id, group.status);
      // A group's combined output: each member's answer under its id.
      let combined: string;
      try {
        combined = step.parallel.map((inner) => `## ${inner.id}\n\n${memberOutput(runDir, inner.id)}`).join("\n\n");
      } catch (error) {
        return finish({ error: `group ${step.id}: ${error instanceof Error ? error.message : String(error)}` });
      }
      writeStepOutput(runDir, step.id, combined);
      if (step.gate) opts.answers.set(step.id, combined); // the gate reads all of it, whatever the file limit
      if (bad.length) failed = `parallel step(s) failed: ${bad.map((b) => `${b.id} (${state.steps[b.id]?.error})`).join("; ")}`;
    } else {
      run.setPhaseStatus(step.id, "running");
      // A gate step skipped by the resume prompt stays at the cursor so its gate can fail below. A pass
      // at the cursor is a kill before the cursor moved: the step finished, so it is not run again,
      // and an `expand` step that answered is not asked again. A gate's rewind sets passes back to pending.
      const prior = state.steps[step.id];
      const kept = (step.gate && prior?.status === "skipped" && prior.error === SKIPPED_ON_RESUME) || prior?.status === "passed";
      const st = kept && prior ? prior : await runStep(step, state, runDir, loop, opts, { run, phase: step.id });
      saveState(runDir, state);
      if (step.expand) await settleExpansion(step, st, state, opts, run, runDir, loop);
      run.setPhaseStatus(step.id, phaseStatus(st.status));
      if (st.status === "aborted" || opts.control.stopped) return finish({ stopped: true });
      if (st.status === "failed" && !step.continueOnError) failed = `step ${step.id} failed: ${st.error}`;
    }
    if (failed) return finish({ error: failed });

    // Review gate: a failing verdict loops back (bounded); exhausting the loops fails the run.
    const { gate } = step;
    const gated = state.steps[step.id];
    const skipped = gate ? (step.parallel ? step.parallel.map((inner) => state.steps[inner.id]) : [gated]).some(skippedByControl) : false;
    if (gate && gated && (gated.status === "passed" || skipped)) {
      let passes: boolean;
      try {
        passes = !skipped && (await gatePasses(gate.pass, opts.answers.get(step.id) ?? readRunFile(runDir, `steps/${step.id}.md`, MAX_SCRIPT_BYTES, true)));
      } catch (error) {
        // Not a verdict: the step may have passed, so neither a miss nor a pass is true.
        return finish({ error: `gate ${step.id} could not be tested: ${error instanceof Error ? error.message : String(error)}` });
      }
      if (!passes) {
        const used = state.loops[step.id] ?? 0;
        gated.status = "failed";
        run.setPhaseStatus(step.id, "failed");
        const why = skipped ? "was skipped before its verdict" : `did not pass after ${used} loop(s) (needs "${gate.pass}")`;
        if (!gate.retry || used >= gate.maxLoops) return finish({ error: `gate ${step.id} ${why}` });
        state.loops[step.id] = used + 1;
        const gateAt = state.cursor;
        state.cursor = w.steps.findIndex((s) => s.id === gate.retry);
        // Everything from the target on runs again, so none of it reads as finished to a resume.
        for (const redo of w.steps.slice(state.cursor, gateAt + 1).flatMap((s) => [s, ...(s.parallel ?? [])])) {
          const st = state.steps[redo.id];
          if (st) st.status = "pending";
        }
        opts.onProgress?.(`${state.workflow} · gate ${step.id} failed → back to ${gate.retry} (loop ${used + 1}/${gate.maxLoops})`);
        saveState(runDir, state);
        continue;
      }
    }
    state.cursor++;
    saveState(runDir, state);
  }
  finish({});
  if (w.vault) copyToVault(opts.cwd, runDir, state);
  return state;
}

// Optionally keep a finished run's artefacts in the memory vault for cross-session pick-up.
function copyToVault(cwd: string, runDir: string, state: RunState): void {
  try {
    const vault = process.env.PI_KIT_VAULT?.trim() || path.join(os.homedir(), ".pi", "vault");
    const dest = path.join(vault, "Projects", projectSlug(cwd), "Workflows", state.id);
    fs.cpSync(runDir, dest, { recursive: true });
  } catch {
    /* best effort */
  }
}

export function summarizeRun(state: RunState, w?: WorkflowDef): string {
  const steps = state.steps ?? {};
  const order = w ? w.steps.flatMap((s) => [s.id, ...(s.parallel ?? []).map((p) => `  ${p.id}`)]) : Object.keys(steps);
  // A group's own entry repeats its members' cost and has no attempts of its own.
  const cost = Object.values(steps).reduce((a, s) => a + (s.attempts > 0 ? s.cost || 0 : 0), 0);
  const lines = order.map((label) => {
    const id = label.trim();
    const st = steps[id];
    return `${label.startsWith("  ") ? "    " : "  "}${id}: ${st?.status ?? "pending"}${st?.attempts && st.attempts > 1 ? ` ×${st.attempts}` : ""}${st?.error ? ` — ${st.error.slice(0, 160)}` : ""}${st?.omitted ? ` — omitted: ${st.omitted.slice(0, 200)}` : ""}`;
  });
  const launched = Object.values(steps).reduce((a, s) => a + s.attempts, 0);
  const outputTokens = Object.values(steps).reduce((a, s) => a + (s.outputTokens ?? 0), 0);
  return [`workflow ${state.workflow} · run ${state.id} · ${state.status}${state.error ? ` — ${state.error}` : ""}${cost ? ` · $${cost.toFixed(4)}` : ""}`, `Agents: ${launched} launched; ${outputTokens} output tokens.`, ...lines].join("\n");
}
