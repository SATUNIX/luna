/**
 * Workflows — tool and command registration (`workflow_run`, `workflow_status`, `workflow_control`,
 * `/workflow`). Pause, resume, stop and skip of a live run all go through control.ts. A plan as data
 * (`workflow_run {steps}`) compiles through plan.ts and runs like a saved workflow.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { discoverAgents, type AgentConfig } from "./agents.ts";
import { agentDir } from "./config.ts";
import { CONTROL_ACTIONS, controlRun, runControls } from "./control.ts";
import { isReadOnlyRole, READ_ONLY_TOOLS } from "./launch.ts";
import { compileExpansion, compilePlan, generationOf, parseExpandAnswer, planRefusal, PLAN_DESCRIPTION, resampleNote, spliceExpansion, type PlanError } from "./plan.ts";
import { redact } from "./redact.ts";
import { producedResult } from "./run-contract.ts";
import { duplicateRefusal, liveRuns, runIdentity } from "./run-model.ts";
import { resolveSkillFile } from "./skills.ts";
import { effortRegistry } from "./wf-engine.ts";
import {
  discoverWorkflows,
  ensurePrivateDir,
  executeWorkflow,
  listRuns,
  loadState,
  newRunState,
  readScript,
  resolveInputs,
  runScopeId,
  runsRoot,
  summarizeRun,
  workflowDigest,
  worstCaseAgents,
  writePrivate,
  MAX_EXECUTIONS,
  SKIPPED_ON_RESUME,
  type ExecuteOptions,
  type ExpansionHost,
  type RunState,
  type StepDef,
  type ScriptWorkflowDef,
  type WorkflowDef,
} from "./workflow.ts";
import type { SpawnChild, ToolContext } from "./types.ts";
import { showWhenFree, type CardOptions } from "./shared/input-owner.ts";

function textResult(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], details: undefined, ...(isError ? { isError: true } : {}) };
}

function parentModelOf(ctx: ToolContext): string | undefined {
  const m = ctx.model;
  if (typeof m?.id !== "string" || !m.id) return undefined;
  return m.provider ? `${m.provider}/${m.id}` : m.id;
}

// Project workflows can run arbitrary delegated work, so like project roles they need the
// operator's approval or an exact digest grant: PI_KIT_TRUSTED_WORKFLOWS, or a digest the
// operator trusted earlier, kept in <agent dir>/pi-kit/trusted-workflows.json (protected-paths
// blocks agent writes there, so a grant cannot be planted). The prompt is a No-first select,
// because pi's confirm defaults to Yes.
export const TRUST_CHOICES = ["No, don't run it", "Run once", "Trust this digest"] as const;

export function trustStorePath(): string {
  return path.join(agentDir(), "pi-kit", "trusted-workflows.json");
}

/** Digests the operator chose "Trust this digest" for. A missing or malformed store grants nothing. */
export function trustedDigests(): string[] {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(trustStorePath(), "utf8"));
  } catch {
    return [];
  }
  if (typeof raw !== "object" || raw === null || !("digests" in raw) || !Array.isArray(raw.digests)) return [];
  const entries: unknown[] = raw.digests;
  const out: string[] = [];
  for (const entry of entries) {
    if (typeof entry === "object" && entry !== null && "digest" in entry && typeof entry.digest === "string" && /^[0-9a-f]{64}$/.test(entry.digest)) out.push(entry.digest);
  }
  return out;
}

/** What the trust gate needs to know about a workflow, YAML or script. */
export type Gated = Pick<WorkflowDef, "name" | "description" | "source" | "file">;

/** Record a "Trust this digest" grant (also used by the /workflows panel for a script it saved). */
export function rememberDigest(digest: string, w: Gated): void {
  if (trustedDigests().includes(digest)) return;
  const file = trustStorePath();
  let entries: unknown[] = [];
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (typeof raw === "object" && raw !== null && "digests" in raw && Array.isArray(raw.digests)) {
      const list: unknown[] = raw.digests;
      entries = list;
    }
  } catch {
    /* a missing or malformed store starts empty */
  }
  entries.push({ digest, name: w.name, file: w.file, trustedAt: new Date().toISOString() });
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, digests: entries }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Show a card a tool raises once no overlay holds input. `what` opens the notice that it is waiting. */
export function askFree<T>(ctx: ToolContext, ask: { what: string; show: (card: CardOptions) => Promise<T>; signal?: AbortSignal | undefined }) {
  return showWhenFree(ask.show, { signal: ask.signal ?? ctx.signal, onHeld: (holder) => ctx.ui?.notify?.(`${ask.what}; close ${holder} to see it.`, "warning") });
}

/** The project-workflow trust gate: null to go on, or why the workflow may not run. */
export async function trustError(w: Gated, digest: string, ctx: ToolContext, calledFrom?: string): Promise<string | null> {
  if (w.source !== "project") return null;
  const envGrants = (process.env.PI_KIT_TRUSTED_WORKFLOWS ?? "").split(";").map((d) => d.trim());
  if (envGrants.includes(digest) || trustedDigests().includes(digest)) return null;
  if (!ctx.hasUI || !ctx.ui?.select) return `Blocked: project workflow "${w.name}" needs interactive approval or a digest grant (sha256 ${digest} in PI_KIT_TRUSTED_WORKFLOWS, or trusted earlier with "Trust this digest").`;
  // A tool raises this card, and a script can raise it mid-run: under an open overlay it waits.
  const select = ctx.ui.select.bind(ctx.ui);
  const asked = await askFree(ctx, {
    what: `workflow ${w.name}: waiting for approval`,
    show: (card) => select(`Run project workflow "${w.name}"${calledFrom ? ` (called by workflow "${calledFrom}")` : ""}? ${w.description}\nSource: ${w.file}\nsha256: ${digest}\nOnly run workflows from repositories you trust.`, [...TRUST_CHOICES], card),
  });
  if (asked.kind !== "shown") return `Blocked: no operator approved project workflow "${w.name}".`;
  const choice = asked.value;
  if (choice === TRUST_CHOICES[1]) return null;
  if (choice === TRUST_CHOICES[2]) {
    try {
      rememberDigest(digest, w);
    } catch (error) {
      ctx.ui.notify?.(`workflow ${w.name}: running once; the digest grant could not be saved (${String(error)}).`, "warning");
    }
    return null;
  }
  return "Cancelled: project workflow not approved.";
}

// Resuming a run that was stopped while a writing step ran re-runs that step on top of whatever it
// had already changed. So a resume with such steps asks first, with a No-first select (pi's
// confirm defaults to Yes), and a headless resume is refused.
export const RESUME_WRITER_CHOICES = ["No, leave the run interrupted", "Re-run the interrupted step(s)", "Skip the interrupted step(s)"] as const;

// A step is a writer unless every tool it can use (its `tools:`, else its role's) is a read tool
// (launch.ts READ_ONLY_TOOLS: read, grep, find, ls). A step with no tool list can use them all.
export function isWriterStep(step: StepDef, agents: readonly AgentConfig[]): boolean {
  const role = agents.find((a) => a.name === step.agent);
  if (role) return !isReadOnlyRole(role, step.tools);
  const tools = step.tools;
  return !(tools && tools.length > 0 && tools.every((t) => READ_ONLY_TOOLS.has(t)));
}

/** Steps at the run's cursor that were cut off mid-run (aborted, or left running by a crash) and can write. */
export function interruptedWriterSteps(w: WorkflowDef, state: RunState, agents: readonly AgentConfig[]): StepDef[] {
  const step = w.steps[state.cursor];
  if (!step) return [];
  const cutOff = (s: StepDef) => {
    const status = state.steps[s.id]?.status;
    return status === "aborted" || status === "running";
  };
  const candidates = step.parallel ? step.parallel.filter(cutOff) : cutOff(step) ? [step] : [];
  return candidates.filter((s) => isWriterStep(s, agents));
}

/** Ask before a resume re-runs interrupted writer steps. Returns an error text, or null to go on. "Skip" marks them skipped in `state`. */
export async function resumeWriterGate(w: WorkflowDef, state: RunState, agents: readonly AgentConfig[], ctx: ToolContext): Promise<string | null> {
  const writers = interruptedWriterSteps(w, state, agents);
  if (!writers.length) return null;
  const names = writers.map((s) => s.id).join(", ");
  if (!ctx.hasUI || !ctx.ui?.select) return `Blocked: run ${state.id} was interrupted while writer step(s) ${names} ran; they may have left partial changes. Resume it interactively (/workflow resume ${state.id}) to choose whether to re-run or skip them.`;
  const select = ctx.ui.select.bind(ctx.ui);
  const asked = await askFree(ctx, {
    what: `workflow run ${state.id}: waiting for your answer`,
    show: (card) => select(`Run ${state.id} was interrupted while step(s) ${names} could write files. They may have left partial changes in the workspace or run directory.\nRe-run or skip them?`, [...RESUME_WRITER_CHOICES], card),
  });
  if (asked.kind !== "shown") return `Blocked: no operator chose whether to re-run or skip step(s) ${names} of run ${state.id}.`;
  const choice = asked.value;
  if (choice === RESUME_WRITER_CHOICES[1]) return null;
  if (choice === RESUME_WRITER_CHOICES[2]) {
    const now = new Date().toISOString();
    for (const s of writers) {
      const st = state.steps[s.id];
      if (!st) continue;
      st.status = "skipped";
      st.error = SKIPPED_ON_RESUME;
      st.endedAt = now;
    }
    // A skipped single step is done; a parallel group re-runs only its other unfinished members.
    // A skipped gate step stays at the cursor: the executor fails its gate instead of passing it.
    const top = w.steps[state.cursor];
    if (top && !top.parallel && !top.gate) state.cursor++;
    return null;
  }
  return `Cancelled: run ${state.id} stays interrupted.`;
}

/**
 * Opens a script workflow by name for running, top-level or from a script's `workflow(name)`
 * call (`calledFrom` names the calling workflow). A project script goes through the same trust
 * gate as a project YAML workflow, every time it is opened, nested calls included. The returned
 * source is the exact bytes whose digest the gate checked.
 */
export async function openScriptWorkflow(
  ctx: ToolContext,
  name: string,
  calledFrom?: string,
): Promise<{ error: string; def?: undefined } | { error?: undefined; def: ScriptWorkflowDef; source: string; digest: string }> {
  const cwd = ctx.cwd ?? process.cwd();
  const { workflows, scripts } = discoverWorkflows(cwd);
  const def = scripts.find((x) => x.name === name);
  if (!def) {
    if (workflows.some((x) => x.name === name)) return { error: `Workflow "${name}" is a YAML workflow, not a script; run it with workflow_run.` };
    return { error: `Unknown script workflow "${name}".` };
  }
  let read: { source: string; digest: string };
  try {
    read = readScript(def);
  } catch (error) {
    return { error: `workflow ${name}: cannot read ${def.file} (${String(error)})` };
  }
  const trust = await trustError(def, read.digest, ctx, calledFrom);
  if (trust) return { error: trust };
  return { def, ...read };
}

function listText(cwd: string): string {
  const { workflows, scripts, errors } = discoverWorkflows(cwd);
  const lines = workflows.map((w) => {
    const inputs = Object.entries(w.inputs).map(([k, v]) => `${k}${v.required ? "*" : ""}`).join(", ");
    return `- ${w.name} (${w.source}): ${w.description}${inputs ? ` — inputs: ${inputs}` : ""}`;
  });
  for (const s of scripts) lines.push(`- ${s.name} (${s.source}, script): ${s.description}${s.whenToUse ? ` — use when: ${s.whenToUse}` : ""}`);
  lines.sort();
  return [lines.length ? `Workflows:\n${lines.join("\n")}` : "No workflows found.", errors.length ? `\nInvalid workflow files:\n${errors.map((e) => `  ${e}`).join("\n")}` : ""].join("");
}

function parseKv(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  let lastKey: string | undefined;
  for (const a of args) {
    const m = a.match(/^([A-Za-z_][\w-]*)=(.*)$/);
    if (m) {
      const [, key = "", value = ""] = m;
      out[key] = value.replace(/^["']|["']$/g, "");
      lastKey = key;
    } else if (lastKey) out[lastKey] = `${out[lastKey] ?? ""} ${a}`; // unquoted multi-word values: goal=fix the login bug
  }
  for (const [k, v] of Object.entries(out)) out[k] = v.replace(/^["']|["']$/g, "").trim();
  return out;
}

/** How a run is started; every kind of start takes the same options. */
interface StartOptions {
  signal?: AbortSignal | undefined;
  onProgress?: (t: string) => void;
  launchKind?: "user";
  spawnChild?: SpawnChild | undefined;
}

type Started = { error: string; state?: undefined; workflow?: undefined } | { error?: undefined; state: RunState; workflow: WorkflowDef };

/** One expansion as a step asked for it; a resume compiles it again. */
interface Expansion {
  parent: string;
  steps: unknown;
}

/** What plan.json holds: the plan as given, and each expansion in the order it happened. */
interface PlanRun {
  steps: unknown;
  expansions: Expansion[];
}

/** Charge an expansion's worst case to the run: null, or why it cannot be afforded. */
type ChargeExpansion = (planned: number) => string | null;

/**
 * Run a definition. A live run doing the same work is refused first. A run you typed is a "user"
 * launch. Any other is the model's: it opens an effort run scope, charged the run's worst case, so a
 * run that cannot be afforded is refused here with nothing started. Its agents then launch as kind
 * "workflow" in that scope. A plan's run saves plan.json when `fresh`, once the run may go ahead and
 * ahead of any launch, and gets its expansion host. A typed resume has no scope to charge, so it
 * refuses a new expansion: no one saw those steps. What the run already charged replays.
 */
async function launchRun(ctx: ToolContext, w: WorkflowDef, state: RunState, agents: AgentConfig[], identity: string, opts: StartOptions, plan?: { run: PlanRun; fresh?: true }): Promise<Started> {
  const cwd = ctx.cwd ?? process.cwd();
  // Nothing awaits from this check to the hold below, so two calls cannot both pass it.
  const live = liveRuns.find(identity);
  if (live) return { error: duplicateRefusal(live) };
  let launch: Pick<ExecuteOptions, "launchKind" | "workflowRun" | "concurrency"> = { launchKind: "user" };
  let charge: ChargeExpansion = () => "a typed resume has no run scope to charge it to";
  if (opts.launchKind !== "user") {
    const effort = effortRegistry();
    if (!effort) return { error: "Refused: workflow runs need the effort extension (it budgets their agents); it is in every shipped profile." };
    const runId = runScopeId(state);
    const scope = effort.openRunScope(runId, { planned: worstCaseAgents(w, state) });
    if (!scope.ok) return { error: `Refused: the workflow run could not be budgeted (${scope.code}): ${scope.reason}` };
    state.scopes = (state.scopes ?? 0) + 1;
    const { runToken } = scope;
    launch = { launchKind: "workflow", workflowRun: { runId, runToken }, ...(scope.maxConcurrent === undefined ? {} : { concurrency: scope.maxConcurrent }) };
    charge = (planned) => {
      const charged = effort.chargeRunScope?.(runId, runToken, planned) ?? { ok: false, code: "run-scope", reason: "the effort extension cannot charge an expansion" };
      return charged.ok ? null : charged.reason;
    };
  }
  if (plan?.fresh) savePlan(cwd, state.id, plan.run);
  const release = liveRuns.hold(identity, { runId: state.id, name: w.name });
  // The run's control (pause/resume/stop/skip); the tool call's signal (Esc) stops it.
  const { control, close } = runControls.open(state.id, opts.signal);
  try {
    const expansion = plan ? expansionHost(cwd, w, state, agents, plan.run, charge) : undefined;
    const final = await executeWorkflow(w, state, { cwd, agents, control, parentModel: parentModelOf(ctx), onProgress: opts.onProgress, spawnChild: opts.spawnChild, expansion, ...launch });
    return { state: final, workflow: w };
  } finally {
    close();
    release();
  }
}

/** Why a resume cannot go on, or null: the run is still live, or an interrupted writer needs an answer. */
async function resumeError(w: WorkflowDef, state: RunState, agents: readonly AgentConfig[], ctx: ToolContext): Promise<string | null> {
  if (runControls.has(state.id)) return `Run ${state.id} is still live in this session; use workflow_control {runId: "${state.id}", action: "resume"} to unpause it.`;
  return resumeWriterGate(w, state, agents, ctx);
}

/** Start or resume a YAML workflow, or resume a plan's run. */
export async function startWorkflow(ctx: ToolContext, name: string, inputsGiven: Record<string, string>, opts: StartOptions & { resume?: RunState | undefined }): Promise<Started> {
  if (opts.resume?.plan) return resumePlan(ctx, opts.resume, opts);
  const cwd = ctx.cwd ?? process.cwd();
  const { workflows, scripts } = discoverWorkflows(cwd);
  const w = workflows.find((x) => x.name === name);
  if (!w) {
    if (scripts.some((x) => x.name === name)) return { error: `Workflow "${name}" is a script workflow; run it with the workflow tool ({name: "${name}"}).` };
    return { error: `Unknown workflow "${name}".\n${listText(cwd)}` };
  }
  const digest = workflowDigest(w);
  const trust = await trustError(w, digest, ctx);
  if (trust) return { error: trust };
  const agents = discoverAgents(cwd, "user").agents;
  if (opts.resume) {
    const refused = await resumeError(w, opts.resume, agents, ctx);
    if (refused) return { error: refused };
  }
  let state = opts.resume;
  if (!state) {
    const { inputs, missing } = resolveInputs(w, inputsGiven);
    if (missing.length) return { error: `Missing required input(s) for ${name}: ${missing.join(", ")}. Inputs: ${Object.entries(w.inputs).map(([k, v]) => `${k}${v.required ? "*" : ""} (${v.description ?? ""})`).join("; ")}` };
    state = newRunState(w, inputs);
  }
  return launchRun(ctx, w, state, agents, runIdentity("yaml", digest, state.inputs), opts);
}

const PLAN_FILE = "plan.json";
const planFile = (cwd: string, runId: string): string => path.join(runsRoot(cwd), runId, PLAN_FILE);
const sha256 = (data: string | Buffer): string => crypto.createHash("sha256").update(data).digest("hex");

// The SHA-256 of each plan.json this process wrote. Any other plan (from an earlier session, or
// rewritten: a run directory is in the workspace, and an agent can write there) is gated on resume
// like a project workflow, because a plan is delegated work with no firewall question of its own.
const sessionPlans = new Map<string, string>();

/** The steps as given, secrets redacted like every run file, for a resume to compile again. */
function savePlan(cwd: string, runId: string, plan: PlanRun): void {
  const text = JSON.stringify({ version: 1, steps: plan.steps, expansions: plan.expansions }, (_key, value: unknown) => (typeof value === "string" ? redact(value) : value), 2);
  ensurePrivateDir(path.dirname(planFile(cwd, runId)));
  writePrivate(planFile(cwd, runId), text);
  sessionPlans.set(runId, sha256(text));
}

/** Skills that resolve nowhere: a child would otherwise start without them and say nothing. */
function missingSkill(w: WorkflowDef, cwd: string): PlanError | undefined {
  for (const [i, step] of w.steps.entries()) {
    for (const [j, leaf] of (step.parallel ?? [step]).entries()) {
      const name = leaf.skills?.find((s) => !resolveSkillFile(s, cwd));
      if (name !== undefined) return { path: `steps[${i}]${step.parallel ? `.parallel[${j}]` : ""}.skills`, problem: `no skill is named "${name.slice(0, 40)}".`, fix: "Name an installed skill, or leave it out." };
    }
  }
  return undefined;
}

const DEFAULT_EXPAND_DEPTH = 3;

/**
 * What an `expand` step's answer does to its run. Validation, then the bounds, then the charge, then
 * plan.json, then the splice: nothing launches before the charge, and a kill after the save replays
 * the expansion rather than asking the step again. An over-bound expansion is refused, not resampled:
 * the same steps would be refused again, and the agent that started the run can replan.
 */
function expansionHost(cwd: string, w: WorkflowDef, state: RunState, agents: readonly AgentConfig[], plan: PlanRun, charge: ChargeExpansion): ExpansionHost {
  const limit = effortRegistry()?.expandDepth?.() ?? DEFAULT_EXPAND_DEPTH;
  return {
    settle(parent, output) {
      const answer = parseExpandAnswer(output);
      if (answer.kind === "invalid") return { kind: "invalid", note: resampleNote(answer.error) };
      if (answer.kind === "done") return answer;
      if (generationOf(parent.id) >= limit) return { kind: "refused", reason: `expansion refused: step ${parent.id} is at the expansion depth limit of ${String(limit)}` };
      const built = compileExpansion(answer.steps, parent, agents, Object.keys(state.inputs));
      const error = built.ok ? missingSkill(built.workflow, cwd) : built.errors[0];
      if (error || !built.ok) return { kind: "invalid", note: resampleNote(error ?? { path: "steps", problem: "the plan is invalid.", fix: "Check it." }) };
      const worst = state.executions + worstCaseAgents(w, state) + built.worstCaseAgents;
      if (worst > MAX_EXECUTIONS) return { kind: "refused", reason: `expansion refused: this run could reach ${String(worst)} agents, over its limit of ${String(MAX_EXECUTIONS)}` };
      const refused = charge(built.worstCaseAgents);
      if (refused) return { kind: "refused", reason: `expansion refused: ${refused}` };
      plan.expansions.push({ parent: parent.id, steps: answer.steps });
      savePlan(cwd, state.id, plan);
      spliceExpansion(w, parent.id, built.steps);
      return { kind: "spliced", steps: built.steps };
    },
  };
}

/** A plan.json's recorded expansions; anything malformed is reported, never skipped. */
function savedExpansions(saved: unknown): Expansion[] | null {
  const list: unknown = typeof saved === "object" && saved !== null ? Reflect.get(saved, "expansions") : undefined;
  if (list === undefined) return [];
  if (!Array.isArray(list)) return null;
  const entries: unknown[] = list;
  const out: Expansion[] = [];
  for (const entry of entries) {
    const parent: unknown = typeof entry === "object" && entry !== null ? Reflect.get(entry, "parent") : undefined;
    if (typeof parent !== "string") return null;
    out.push({ parent, steps: Reflect.get(Object(entry), "steps") });
  }
  return out;
}

/** Put a resumed run's expansions back in order, under the same rules as when they arrived. Null, or what is wrong. */
function replayExpansions(w: WorkflowDef, state: RunState, agents: readonly AgentConfig[], expansions: readonly Expansion[]): string | null {
  for (const { parent, steps } of expansions) {
    const step = w.steps.find((s) => s.id === parent);
    if (!step?.expand) return `an expansion names ${parent.slice(0, 40)}, which is not a step with expand`;
    const built = compileExpansion(steps, step, agents, Object.keys(state.inputs));
    if (!built.ok) return planRefusal(built.errors);
    spliceExpansion(w, parent, built.steps);
    const st = state.steps[parent];
    if (st) st.expanded = true;
  }
  return null;
}

/** Compile a plan and run it through the same executor as a YAML workflow. */
export async function startPlan(ctx: ToolContext, steps: unknown, inputs: Record<string, string>, opts: StartOptions): Promise<Started> {
  const cwd = ctx.cwd ?? process.cwd();
  const agents = discoverAgents(cwd, "user").agents;
  const compiled = compilePlan(steps, agents, Object.keys(inputs));
  if (!compiled.ok) return { error: planRefusal(compiled.errors) };
  const { workflow } = compiled;
  const noSkill = missingSkill(workflow, cwd);
  if (noSkill) return { error: planRefusal([noSkill]) };
  const state = newRunState(workflow, inputs);
  state.plan = true;
  return launchRun(ctx, workflow, state, agents, runIdentity("plan", JSON.stringify(workflow.steps), inputs), opts, { run: { steps, expansions: [] }, fresh: true });
}

/** Resume a plan's run from its plan.json, never from a saved workflow of the same name. */
async function resumePlan(ctx: ToolContext, state: RunState, opts: StartOptions): Promise<Started> {
  const cwd = ctx.cwd ?? process.cwd();
  const file = planFile(cwd, state.id);
  let bytes: Buffer;
  let saved: unknown;
  try {
    bytes = fs.readFileSync(file);
    saved = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    return { error: `Run ${state.id} cannot be resumed: its ${PLAN_FILE} is missing or unreadable (${error instanceof Error ? error.message : String(error)}). Start a new run.` };
  }
  const digest = sha256(bytes);
  if (sessionPlans.get(state.id) !== digest) {
    const trust = await trustError({ name: state.workflow, description: `The inline plan of run ${state.id}.`, source: "project", file }, digest, ctx);
    if (trust) return { error: trust };
  }
  const agents = discoverAgents(cwd, "user").agents;
  const steps: unknown = typeof saved === "object" && saved !== null ? Reflect.get(saved, "steps") : undefined;
  const compiled = compilePlan(steps, agents, Object.keys(state.inputs));
  if (!compiled.ok) return { error: `Run ${state.id}: ${PLAN_FILE} no longer compiles. ${planRefusal(compiled.errors)}` };
  const { workflow } = compiled;
  // The plan as first given names the run: its expansions are what the run did, not what it was asked.
  const identity = runIdentity("plan", JSON.stringify(workflow.steps), state.inputs);
  const expansions = savedExpansions(saved);
  const unusable = expansions ? replayExpansions(workflow, state, agents, expansions) : `its ${PLAN_FILE} lists expansions it cannot read`;
  if (unusable !== null || !expansions) return { error: `Run ${state.id}: ${unusable ?? PLAN_FILE}` };
  const refused = await resumeError(workflow, state, agents, ctx);
  if (refused) return { error: refused };
  return launchRun(ctx, workflow, state, agents, identity, opts, { run: { steps, expansions } });
}

const liveTag = (id: string): string => {
  const c = runControls.get(id);
  return c ? (c.paused ? " (active, paused)" : " (active)") : "";
};

export interface WorkflowToolDeps {
  /** Test seam: the child spawner the tool's runs use. */
  spawnChild?: SpawnChild;
}

export function registerWorkflowTools(pi: ExtensionAPI, deps: WorkflowToolDeps = {}): void {
  // Workflows orchestrate subagents; a subagent child never starts one itself.
  if (process.env.PI_KIT_INTERNAL_CHILD === "1") return;

  pi.registerTool({
    name: "workflow_run",
    label: "Workflow",
    description:
      "Run a workflow: subagent steps with a shared directory, gates and resume. Pass exactly one of: name (a saved workflow; \"list\" shows them), steps (a plan as data) or resume (a run id). " +
      PLAN_DESCRIPTION +
      " Prefer this to subagent chains.",
    promptSnippet: "Run a saved workflow, or an inline plan of subagent steps",
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: 'Saved workflow name, or "list"' })),
      steps: Type.Optional(Type.Array(Type.Unknown(), { description: "An inline plan: the steps to run" })),
      inputs: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Inputs, e.g. {goal: \"...\"}" })),
      resume: Type.Optional(Type.String({ description: "Run id to resume" })),
    }),
    async execute(_id, params, signal, onUpdate, rawCtx) {
      const ctx: ToolContext = rawCtx;
      const cwd = ctx.cwd ?? process.cwd();
      if ([params.name, params.steps, params.resume].filter((v) => v !== undefined).length !== 1) return textResult('Pass exactly one of name, steps or resume ({name: "list"} shows the saved workflows).', true);
      if (params.name === "list") return textResult(listText(cwd));
      let resume: RunState | undefined;
      if (params.resume) {
        const s = loadState(cwd, params.resume);
        if (!s) return textResult(`No run "${params.resume}".`, true);
        if (producedResult(s.status)) return textResult(`Run ${s.id} already ${s.status}.`);
        resume = s;
      }
      const report = (t: string) => {
        onUpdate?.({ content: [{ type: "text", text: t }], details: undefined });
        try {
          ctx.ui?.setStatus?.("workflow", t.slice(0, 120));
        } catch {
          /* best effort */
        }
      };
      try {
        const start = { signal, onProgress: report, spawnChild: deps.spawnChild };
        const r = await (params.steps === undefined ? startWorkflow(ctx, resume?.workflow ?? params.name ?? "", params.inputs ?? {}, { ...start, resume }) : startPlan(ctx, params.steps, params.inputs ?? {}, start));
        if (r.error !== undefined) return textResult(r.error, true);
        const dir = path.join(runsRoot(cwd), r.state.id);
        // A parsed workflow always has at least one step.
        const last = r.workflow.steps[r.workflow.steps.length - 1];
        const tail = producedResult(r.state.status) ? `\n\nFinal step (${last?.id}) output: ${dir}/steps/${last?.id}.md` : r.state.status === "interrupted" ? `\n\nResume with workflow_run {resume: "${r.state.id}"} or /workflow resume ${r.state.id}` : "";
        return textResult(`${summarizeRun(r.state, r.workflow)}\n\nRun directory: ${dir}${tail}`, r.state.status === "failed");
      } finally {
        try {
          ctx.ui?.setStatus?.("workflow", undefined);
        } catch {
          /* best effort */
        }
      }
    },
  });

  pi.registerTool({
    name: "workflow_status",
    label: "Workflow status",
    description: "Show recent workflow runs, or one run's step-by-step state (with id).",
    promptSnippet: "Inspect workflow runs",
    parameters: Type.Object({ id: Type.Optional(Type.String()) }),
    async execute(_id, params, _signal, _onUpdate, rawCtx) {
      const cwd = rawCtx.cwd ?? process.cwd();
      if (params.id) {
        const s = loadState(cwd, params.id);
        return s ? textResult(`${summarizeRun(s)}\n\nRun directory: ${path.join(runsRoot(cwd), s.id)}`) : textResult(`No run "${params.id}".`, true);
      }
      const runs = listRuns(cwd, 10);
      return textResult(runs.length ? runs.map((r) => `- ${r.id}: ${r.status}${liveTag(r.id)}${r.error ? ` — ${r.error.slice(0, 120)}` : ""}`).join("\n") : "No workflow runs yet.");
    },
  });

  pi.registerTool({
    name: "workflow_control",
    label: "Workflow control",
    description:
      "Control a live workflow run in this session: pause (start no new agents; running ones finish), resume (unpause; a pause the console's safety stop set yields only to the operator), " +
      "stop (stop its agents; the run ends interrupted and can be resumed with workflow_run {resume}), or skip (stop the agents running now and record their steps as skipped; a skipped required step can fail the run or leave it partial).",
    promptSnippet: "Pause, resume, stop or skip within a live workflow run",
    parameters: Type.Object({
      runId: Type.String({ description: "The live run's id (workflow_status lists active runs)" }),
      action: Type.Union(CONTROL_ACTIONS.map((a) => Type.Literal(a)), { description: CONTROL_ACTIONS.join(" | ") }),
    }),
    async execute(_id, params) {
      // The governed agent asks here: it cannot lift a pause the console's safety stop holds for the operator.
      const r = controlRun(params.runId, params.action, runControls, "agent");
      return textResult(r.message, !r.ok);
    },
  });

  pi.registerCommand("workflow", {
    description: "Workflows: /workflow list | run <name> key=value… | status [id] | resume <id> | pause <id> | skip <id> | stop <id>",
    getArgumentCompletions: (prefix: string) => {
      const words = prefix.trimStart().split(/\s+/);
      if (words.length <= 1) return ["list", "run ", "status", "resume ", "pause ", "skip ", "stop "].filter((v) => v.startsWith(words[0] ?? "")).map((v) => ({ value: v, label: v.trim() }));
      if (words[0] === "run" && words.length === 2) {
        const { workflows } = discoverWorkflows(process.cwd());
        return workflows.filter((w) => w.name.startsWith(words[1] ?? "")).map((w) => ({ value: `run ${w.name} `, label: w.name, description: w.description }));
      }
      return null;
    },
    handler: async (args, rawCtx) => {
      const ctx = rawCtx;
      const cwd = ctx.cwd ?? process.cwd();
      const [sub = "list", ...rest] = args.trim().split(/\s+/).filter(Boolean);
      const notify = (m: string, l: "info" | "warning" | "error" = "info") => {
        ctx.ui.notify(m, l);
      };
      if (sub === "list") {
        notify(listText(cwd));
        return;
      }
      if (sub === "status") {
        const id = rest[0];
        if (id) {
          const s = loadState(cwd, id);
          notify(s ? `${summarizeRun(s)}\nRun directory: ${path.join(runsRoot(cwd), s.id)}` : `No run "${id}".`);
          return;
        }
        const runs = listRuns(cwd, 10);
        notify(runs.length ? runs.map((r) => `${r.id}: ${r.status}${liveTag(r.id)}`).join("\n") : "No workflow runs yet.");
        return;
      }
      // A live run is controlled through control.ts; `resume` of a run that is not live
      // continues it from its state.json below.
      if (sub === "stop" || sub === "pause" || sub === "skip" || (sub === "resume" && runControls.has(rest[0] ?? ""))) {
        const r = controlRun(rest[0] ?? "", sub);
        notify(r.message, r.ok ? "info" : "warning");
        return;
      }
      if (sub === "run" || sub === "resume") {
        let name = rest[0];
        let inputs = parseKv(rest.slice(1));
        let resume: RunState | undefined;
        if (sub === "resume") {
          const s = loadState(cwd, rest[0] ?? "");
          if (!s) {
            notify(`No run "${rest[0] ?? ""}".`, "error");
            return;
          }
          resume = s;
          name = s.workflow;
        } else if (!name) {
          const { workflows } = discoverWorkflows(cwd);
          if (!ctx.hasUI || !ctx.ui.select || !workflows.length) {
            notify(listText(cwd));
            return;
          }
          const pick = await ctx.ui.select("Run workflow", workflows.map((w) => `${w.name} — ${w.description}`));
          if (!pick) return;
          const [picked = ""] = pick.split(" — ");
          name = picked;
          const w = workflows.find((x) => x.name === picked);
          if (!w) throw new Error(`workflow ${picked}: not found`);
          for (const [k, spec] of Object.entries(w.inputs)) {
            const v = ctx.ui.input ? await ctx.ui.input(`${name}: ${k}${spec.required ? " (required)" : ""}`, spec.description) : undefined;
            if (v === undefined && spec.required) return;
            if (v) inputs = { ...inputs, [k]: v };
          }
        }
        // Commands run outside a turn: the workflow runs in the background, drives the footer,
        // and posts its summary into the session when done so the agent can pick it up.
        notify(`workflow ${name}: started${resume ? ` (resuming ${resume.id})` : ""}. /workflow status to follow, /workflow stop <id> to stop.`);
        void startWorkflow(ctx, name, inputs, { resume, launchKind: "user", spawnChild: deps.spawnChild, onProgress: (t) => {
          ctx.ui?.setStatus?.("workflow", t.slice(0, 120));
        } })
          .then((r) => {
            try {
              ctx.ui?.setStatus?.("workflow", undefined);
            } catch {
              /* session may be gone */
            }
            const text = r.error !== undefined ? `workflow ${name}: ${r.error}` : `${summarizeRun(r.state, r.workflow)}\nRun directory: ${path.join(runsRoot(cwd), r.state.id)}`;
            try {
              pi.sendMessage({ customType: "workflow-result", content: text, display: true }, { deliverAs: "followUp", triggerTurn: false });
            } catch {
              notify(text, r.error || r.state?.status !== "passed" ? "warning" : "info");
            }
          })
          .catch((error: unknown) => {
            notify(`workflow ${name} crashed: ${String(error)}`, "error");
          });
        return;
      }
      notify(`Unknown subcommand "${sub}". /workflow list | run <name> key=value… | status [id] | resume <id> | pause <id> | skip <id> | stop <id>`, "error");
    },
  });
}
