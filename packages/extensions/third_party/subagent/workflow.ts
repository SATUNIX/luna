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
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { agentDir, toText } from "./config.ts";
import type { AgentConfig } from "./agents.ts";
import { mapWithConcurrencyLimit, runAgent, type RunOverrides } from "./runner.ts";
import { getResultOutput, isFailedResult } from "./result.ts";
import { runRegistry, type PhaseStatus, type RunModel, type RunRegistry } from "./run-model.ts";
import { redact, REDACTION_POLICY } from "./redact.ts";
import { RunControl } from "./control.ts";
import { parseScriptMeta, type ScriptPhase } from "./wf-meta.ts";
import type { SingleResult, SpawnChild } from "./types.ts";

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

export type StepStatus = "pending" | "running" | "passed" | "failed" | "skipped" | "aborted";

const ID = /^[a-z][a-z0-9_-]{0,40}$/;

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

function parseStep(raw: unknown, where: string, errors: string[]): StepDef {
  if (!isObject(raw)) {
    errors.push(`${where}: a step must be a mapping`);
    return { id: "invalid" };
  }
  const id = toText(raw.id ?? "");
  if (!ID.test(id)) errors.push(`${where}: id "${id}" must match ${ID}`);
  const step: StepDef = { id };
  if (Array.isArray(raw.parallel)) {
    const members: StepDef[] = raw.parallel.map((s: unknown, i: number) => parseStep(s, `${where}.parallel[${i}]`, errors));
    step.parallel = members;
    for (const inner of members) if (inner.parallel) errors.push(`${where}: parallel groups cannot nest`);
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
  }
  if (raw.gate) {
    const g = isObject(raw.gate) ? raw.gate : {};
    step.gate = { pass: toText(g.pass ?? g.expect ?? ""), retry: toText(g.retry ?? g.on_fail ?? ""), maxLoops: Math.max(0, Math.min(Number(g.max_loops ?? g.maxLoops ?? 2), 10)) };
    if (!step.gate.pass) errors.push(`${where}: gate needs pass: (text or /regex/ the output must contain)`);
  }
  return step;
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
  const steps: StepDef[] = Array.isArray(fm.steps) ? fm.steps.map((s: unknown, i: number) => parseStep(s, `steps[${i}]`, errors)) : [];
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

/** Reads one script's meta. The script itself is never run here. */
function loadScriptDef(file: string, source: WorkflowDef["source"]): { def?: ScriptWorkflowDef; error?: string } {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch (error) {
    return { error: `${path.basename(file)}: unreadable (${String(error)})` };
  }
  if (!st.isFile()) return {};
  if (st.size > MAX_SCRIPT_BYTES) return { error: `${path.basename(file)}: larger than ${MAX_SCRIPT_BYTES} bytes` };
  const parsed = parseScriptMeta(fs.readFileSync(file, "utf8"));
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
  startedAt?: string;
  endedAt?: string;
}

export interface RunState {
  version: 1;
  id: string;
  workflow: string;
  workflowFile: string;
  inputs: Record<string, string>;
  status: "running" | "passed" | "failed" | "interrupted";
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
}

export const runsRoot = (cwd: string) => path.join(cwd, ".pi", "workflows", "runs");
const MAX_OUTPUT_IN_STATE = 4000;
const MAX_FILE_INCLUDE = 64 * 1024;
const MAX_EXECUTIONS = 60; // hard ceiling on step executions per run (loops included)

// Run files hold prompts and agent output, so the run directory is 0700 and its files 0600. The
// modes are set explicitly as well, because mkdir/write modes are masked by the umask and are not
// applied to a directory or file that already exists.
function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

function writePrivate(file: string, text: string): void {
  fs.writeFileSync(file, text, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

/** A step answer as it is written to steps/<id>.md: secrets redacted (redact.ts). */
function writeStepOutput(runDir: string, id: string, output: string): string {
  const text = redact(output);
  ensurePrivateDir(path.join(runDir, "steps"));
  writePrivate(path.join(runDir, "steps", `${id}.md`), text);
  return text;
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
    steps[id] = copy;
  }
  const inputs = Object.fromEntries(Object.entries(state.inputs).map(([k, v]) => [k, redact(v)]));
  return { ...state, inputs, steps, error: red(state.error), redacted: true, redactionPolicy: REDACTION_POLICY };
}

function saveState(dir: string, state: RunState): void {
  state.updatedAt = new Date().toISOString();
  ensurePrivateDir(dir);
  const file = path.join(dir, "state.json");
  const tmp = `${file}.${process.pid}.tmp`;
  writePrivate(tmp, JSON.stringify(redactedState(state), null, 2));
  fs.renameSync(tmp, file);
}

const RUN_STATES: ReadonlySet<string> = new Set(["running", "passed", "failed", "interrupted"]);
const STEP_STATUSES: ReadonlySet<string> = new Set(["pending", "running", "passed", "failed", "skipped", "aborted"]);

function isStepState(value: unknown): value is StepState {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const s = value as Record<string, unknown>;
  return (
    typeof s.status === "string" &&
    STEP_STATUSES.has(s.status) &&
    typeof s.attempts === "number" &&
    Number.isFinite(s.attempts) &&
    typeof s.cost === "number" &&
    Number.isFinite(s.cost) &&
    Array.isArray(s.runIds) &&
    s.runIds.every((r) => typeof r === "string")
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
    Object.values(s.steps).every(isStepState)
  );
}

export function loadState(cwd: string, id: string): RunState | null {
  if (!/^[A-Za-z0-9._-]+$/.test(id)) return null;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(runsRoot(cwd), id, "state.json"), "utf8"));
    return isRunState(parsed) ? parsed : null;
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
export function renderTemplate(template: string, ctx: { inputs: Record<string, string>; state: RunState; runDir: string; loop: number }): string {
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_m, exprRaw: string) => {
    const optional = exprRaw.endsWith("?");
    const expr = optional ? exprRaw.slice(0, -1).trim() : exprRaw;
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
    const stepRef = expr.match(/^steps\.([a-z][a-z0-9_-]*)\.(output|status)$/);
    if (stepRef) {
      const [, stepId = "", field] = stepRef;
      const st = ctx.state.steps[stepId];
      if (field === "status") return st?.status ?? missing("unknown step");
      const file = path.join(ctx.runDir, "steps", `${stepId}.md`);
      return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : missing(`step "${stepId}" has no output yet`);
    }
    if (expr.startsWith("file:")) {
      const rel = expr.slice(5).trim();
      const abs = path.resolve(ctx.runDir, rel);
      if (!abs.startsWith(ctx.runDir + path.sep)) throw new TemplateError(`template {{${expr}}}: path escapes the run directory`);
      if (!fs.existsSync(abs)) return missing(`file ${rel} does not exist in the run directory`);
      const buf = fs.readFileSync(abs);
      return buf.length > MAX_FILE_INCLUDE ? `${buf.subarray(0, MAX_FILE_INCLUDE).toString("utf8")}\n[... truncated at ${MAX_FILE_INCLUDE} bytes; read ${abs} for the rest]` : buf.toString("utf8");
    }
    throw new TemplateError(`template {{${expr}}}: unknown expression`);
  });
}

// The errors recorded on a step skipped by `skip` (live) or by the resume prompt. A review gate
// treats such a step, or such a member of its group, as a failed verdict, so skipping never
// bypasses a gate. A step skipped by its own `when` is the workflow's choice and is not counted.
export const SKIPPED_BY_OPERATOR = "skipped by operator";
export const SKIPPED_ON_RESUME = "skipped on resume";
function skippedByControl(st: StepState | undefined): boolean {
  return st?.status === "skipped" && (st.error === SKIPPED_BY_OPERATOR || st.error === SKIPPED_ON_RESUME);
}

function gatePasses(pattern: string, output: string): boolean {
  const re = pattern.match(/^\/(.+)\/([a-z]*)$/);
  if (re) {
    const [, source = "", flags = ""] = re;
    try {
      return new RegExp(source, flags.includes("i") ? flags : `${flags}i`).test(output);
    } catch {
      return false;
    }
  }
  return output.toLowerCase().includes(pattern.toLowerCase());
}

// ---------------------------------------------------------------------------------------------
// Executor

export interface ExecuteOptions {
  cwd: string;
  agents: AgentConfig[];
  signal?: AbortSignal | undefined;
  parentModel?: string | undefined;
  onProgress?: ((text: string) => void) | undefined;
  spawnChild?: SpawnChild | undefined;
  concurrency?: number;
  // "user" when the person typed the command (bounded by platform ceilings only); the model-callable
  // tool uses the default, "discretionary" (bounded by the effort tier).
  launchKind?: "discretionary" | "user" | undefined;
  // The telemetry registry this run reports to (run-model.ts); defaults to the process-wide one.
  registry?: RunRegistry | undefined;
  // Pause/resume/stop/skip for this run (control.ts). Without one the run gets its own; `signal`
  // still stops it either way.
  control?: RunControl | undefined;
}

// Inside the executor the run's control is always present.
type RunOptions = ExecuteOptions & { control: RunControl };

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
  return { version: 1, id, workflow: w.name, workflowFile: w.file, inputs, status: "running", cursor: 0, loops: {}, steps: {}, startedAt: now.toISOString(), updatedAt: now.toISOString(), executions: 0 };
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

function listRunFiles(runDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "state.json" || e.name.endsWith(".tmp")) continue;
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

async function runStep(step: StepDef, state: RunState, runDir: string, loop: number, opts: RunOptions, tele: StepTelemetry): Promise<StepState> {
  const st: StepState = state.steps[step.id] ?? { status: "pending", attempts: 0, runIds: [], cost: 0 };
  state.steps[step.id] = st;
  const start = { label: step.id, phase: tele.phase, role: step.agent, model: step.model };
  if (step.when) {
    const dep = state.steps[step.when.step]?.status;
    const wanted = Array.isArray(step.when.status) ? step.when.status : [step.when.status];
    if (!dep || !wanted.includes(dep)) {
      st.status = "skipped";
      st.endedAt = new Date().toISOString();
      tele.run.agentSkipped(start);
      return st;
    }
  }
  let task: string;
  try {
    task = renderTemplate(step.task ?? "", { inputs: state.inputs, state, runDir, loop });
  } catch (error) {
    st.status = "failed";
    st.error = error instanceof Error ? error.message : String(error);
    tele.run.agentEnd(tele.run.agentStart(start), { status: "failed", error: st.error });
    return st;
  }
  // The scheduler gate: a paused run launches no new agent. A stop while waiting launches nothing
  // and leaves the step as it was, so a resume does not mistake it for an interrupted one.
  await opts.control.gate();
  if (opts.control.stopped) return st;
  st.status = "running";
  st.attempts++;
  st.startedAt = new Date().toISOString();
  state.executions++;
  opts.onProgress?.(`${state.workflow} · ${step.id}${loop ? ` (loop ${loop})` : ""} · running ${step.agent}`);
  const overrides: RunOverrides = {
    model: step.model,
    thinking: step.thinking,
    tools: step.tools,
    skills: step.skills,
    extensions: step.extensions,
    maxRuntimeMs: step.maxRuntimeMs,
    appendSystemPrompt: BLACKBOARD_NOTE(runDir, listRunFiles(runDir)),
  };
  const agentId = tele.run.agentStart(start);
  const handle = opts.control.agent(step.id, agentId);
  let result: SingleResult;
  try {
    result = await runAgent({
      defaultCwd: opts.cwd,
      agents: opts.agents,
      agentName: step.agent ?? "", // parseStep requires an agent on every non-parallel step
      task,
      signal: handle.signal,
      parentModel: opts.parentModel,
      spawnChild: opts.spawnChild,
      overrides,
      launchKind: opts.launchKind,
      onUpdate: (t) => {
        tele.run.agentUpdate(agentId, { activity: t });
        opts.onProgress?.(`${state.workflow} · ${step.id} · ${t}`);
      },
      onUsage: (usage, model) => tele.run.agentUpdate(agentId, { usage, model }),
    });
  } finally {
    handle.done();
  }
  const settle = (status: "passed" | "failed" | "aborted" | "skipped"): void =>
    tele.run.agentEnd(agentId, { status, usage: result.usage, model: result.model, subagentRunId: result.runId, error: st.error });
  if (result.runId) st.runIds.push(result.runId);
  st.cost += result.usage.cost;
  const output = writeStepOutput(runDir, step.id, result.finalOutput || getResultOutput(result));
  st.output = output.length > MAX_OUTPUT_IN_STATE ? `${output.slice(0, MAX_OUTPUT_IN_STATE)}…` : output;
  st.endedAt = new Date().toISOString();
  if (handle.skipped()) {
    st.status = "skipped";
    st.error = SKIPPED_BY_OPERATOR;
    settle("skipped");
    return st;
  }
  if (result.stopReason === "aborted" || opts.control.stopped) {
    st.status = "aborted";
    st.error = "cancelled";
    settle("aborted");
    return st;
  }
  if (isFailedResult(result)) {
    st.status = "failed";
    st.error = result.errorMessage || result.stderr.slice(0, 500) || `exit ${result.exitCode}`;
    settle("failed");
    return st;
  }
  const missingOutputs = (step.outputs ?? []).filter((o) => !fs.existsSync(path.join(runDir, o)));
  if (missingOutputs.length) {
    st.status = "failed";
    st.error = `declared output(s) not written: ${missingOutputs.join(", ")}`;
    settle("failed");
    return st;
  }
  st.status = "passed";
  settle("passed");
  return st;
}

// A stale "running" in a resumed state.json is a step that never finished: it shows as pending.
const phaseStatus = (s: StepStatus | undefined): PhaseStatus => (s === undefined || s === "running" ? "pending" : s);

/**
 * Run (or resume) a workflow. Returns the final state; never throws for step failures.
 * Resuming re-runs the step that was interrupted and continues from there.
 */
export async function executeWorkflow(w: WorkflowDef, state: RunState, options: ExecuteOptions): Promise<RunState> {
  const control = options.control ?? new RunControl(state.id);
  // The caller's signal (Esc on the tool call) stops the run like a `stop` action.
  const onAbort = () => control.act("stop");
  if (options.signal?.aborted) onAbort();
  else options.signal?.addEventListener("abort", onAbort, { once: true });
  const opts: RunOptions = { ...options, control, signal: control.signal };
  // Telemetry: every top-level step is a phase, listed up front with its saved status.
  const run = (opts.registry ?? runRegistry).start(state.id, "yaml", w.name, { description: w.description, file: w.file, source: w.source });
  for (const step of w.steps) run.phase(step.id, step.id, phaseStatus(state.steps[step.id]?.status));
  try {
    const final = await executeSteps(w, state, opts, run);
    if (final.status !== "running") run.finish(final.status, final.error);
    return final;
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
  const finish = (status: RunState["status"], error?: string) => {
    offControl();
    state.status = status;
    state.error = error;
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

async function runSteps(w: WorkflowDef, state: RunState, opts: RunOptions, run: RunModel, runDir: string, finish: (status: RunState["status"], error?: string) => RunState): Promise<RunState> {
  while (state.cursor < w.steps.length) {
    await opts.control.gate();
    if (opts.control.stopped) return finish("interrupted", "cancelled");
    if (state.executions >= MAX_EXECUTIONS) return finish("failed", `stopped after ${MAX_EXECUTIONS} step executions (loop safety limit)`);
    const step = w.steps[state.cursor];
    if (!step) throw new Error(`workflow ${w.name}: no step at position ${state.cursor}`);
    const loop = step.gate ? (state.loops[step.id] ?? 0) : Object.values(state.loops).reduce((a, b) => Math.max(a, b), 0);

    let failed: string | undefined;
    if (step.parallel) {
      const group: StepState = state.steps[step.id] ?? { status: "pending", attempts: 0, runIds: [], cost: 0 };
      state.steps[step.id] = group;
      // Resuming an interrupted group re-runs only the members that had not passed (or were skipped).
      const resuming = group.status === "aborted" || group.status === "running";
      const todo = resuming ? step.parallel.filter((inner) => !["passed", "skipped"].includes(state.steps[inner.id]?.status ?? "pending")) : step.parallel;
      group.status = "running";
      group.startedAt = new Date().toISOString();
      saveState(runDir, state);
      run.setPhaseStatus(step.id, "running");
      await mapWithConcurrencyLimit(todo, opts.concurrency ?? 4, (inner) => runStep(inner, state, runDir, loop, opts, { run, phase: step.id }));
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
        return finish("interrupted", "cancelled");
      }
      const bad = step.parallel.filter((inner, i) => results[i]?.status === "failed" && !inner.continueOnError);
      group.status = bad.length ? "failed" : "passed";
      run.setPhaseStatus(step.id, group.status);
      // A group's combined output: each member's answer under its id.
      const combined = step.parallel.map((inner) => `## ${inner.id}\n\n${fs.existsSync(path.join(runDir, "steps", `${inner.id}.md`)) ? fs.readFileSync(path.join(runDir, "steps", `${inner.id}.md`), "utf8") : "(no output)"}`).join("\n\n");
      writeStepOutput(runDir, step.id, combined);
      if (bad.length) failed = `parallel step(s) failed: ${bad.map((b) => `${b.id} (${state.steps[b.id]?.error})`).join("; ")}`;
    } else {
      run.setPhaseStatus(step.id, "running");
      // A gate step skipped by the resume prompt stays at the cursor so its gate can fail below.
      const prior = state.steps[step.id];
      const st = step.gate && prior?.status === "skipped" && prior.error === SKIPPED_ON_RESUME ? prior : await runStep(step, state, runDir, loop, opts, { run, phase: step.id });
      saveState(runDir, state);
      run.setPhaseStatus(step.id, phaseStatus(st.status));
      if (st.status === "aborted" || opts.control.stopped) return finish("interrupted", "cancelled");
      if (st.status === "failed" && !step.continueOnError) failed = `step ${step.id} failed: ${st.error}`;
    }
    if (failed) return finish("failed", failed);

    // Review gate: a failing verdict loops back (bounded); exhausting the loops fails the run.
    const { gate } = step;
    const gated = state.steps[step.id];
    const skipped = gate ? (step.parallel ? step.parallel.map((inner) => state.steps[inner.id]) : [gated]).some(skippedByControl) : false;
    if (gate && gated && (gated.status === "passed" || skipped)) {
      if (skipped || !gatePasses(gate.pass, fs.readFileSync(path.join(runDir, "steps", `${step.id}.md`), "utf8"))) {
        const used = state.loops[step.id] ?? 0;
        gated.status = "failed";
        run.setPhaseStatus(step.id, "failed");
        const why = skipped ? "was skipped before its verdict" : `did not pass after ${used} loop(s) (needs "${gate.pass}")`;
        if (!gate.retry || used >= gate.maxLoops) return finish("failed", `gate ${step.id} ${why}`);
        state.loops[step.id] = used + 1;
        state.cursor = w.steps.findIndex((s) => s.id === gate.retry);
        opts.onProgress?.(`${state.workflow} · gate ${step.id} failed → back to ${gate.retry} (loop ${used + 1}/${gate.maxLoops})`);
        saveState(runDir, state);
        continue;
      }
    }
    state.cursor++;
    saveState(runDir, state);
  }
  finish("passed");
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
  const cost = Object.values(steps).reduce((a, s) => a + (s.cost || 0), 0);
  const lines = order.map((label) => {
    const id = label.trim();
    const st = steps[id];
    return `${label.startsWith("  ") ? "    " : "  "}${id}: ${st?.status ?? "pending"}${st?.attempts && st.attempts > 1 ? ` ×${st.attempts}` : ""}${st?.error ? ` — ${st.error.slice(0, 160)}` : ""}`;
  });
  return [`workflow ${state.workflow} · run ${state.id} · ${state.status}${state.error ? ` — ${state.error}` : ""}${cost ? ` · $${cost.toFixed(4)}` : ""}`, ...lines].join("\n");
}
