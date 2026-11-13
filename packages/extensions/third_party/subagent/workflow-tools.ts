/**
 * Workflows — tool and command registration (`workflow_run`, `workflow_status`, `workflow_control`,
 * `/workflows`). Pause, resume, stop and skip of a live run all go
 * through control.ts; the status list and the stop path read run-query.ts, so a background
 * subagent, a finished script run, a finished YAML run and an autonomous container run appear
 * together. A plan as data (`workflow_run {steps}`) compiles through plan.ts and runs like a saved
 * workflow.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { discoverAgents, type AgentConfig } from "./agents.ts";
import { agentDir, capConcurrency } from "./config.ts";
import { capText } from "./cap.ts";
import { CONTROL_ACTIONS, controlRun, runControls, type ControlOrigin, type ControlResult } from "./control.ts";
import { subagentStateDir } from "./logging.ts";
import { describeRun, formatRunList, MAX_RUN_LIST, queryRuns } from "./run-query.ts";
import { hasSubagentRun, isValidRunId, stopTargets } from "./status.ts";
import { isReadOnlyRole, READ_ONLY_TOOLS } from "./launch.ts";
import { compileExpansion, compilePlan, generationOf, parseExpandAnswer, planRefusal, PLAN_DESCRIPTION, resampleNote, spliceExpansion, type PlanError } from "./plan.ts";
import { redact } from "./shared/redact.ts";
import { producedResult } from "./run-contract.ts";
import { duplicateRefusal, liveRuns, runIdentity, runRegistry } from "./run-model.ts";
import { resolveSkillFile } from "./skills.ts";
import { effortRegistry } from "./wf-engine.ts";
import {
  discoverWorkflows,
  ensurePrivateDir,
  executeWorkflow,
  loadState,
  newRunState,
  readScript,
  readRunFile,
  resolveInputs,
  runScopeId,
  runsRoot,
  summarizeRun,
  workflowDigest,
  worstCaseAgents,
  writePrivate,
  MAX_EXECUTIONS,
  MAX_SCRIPT_BYTES,
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

/** Where a run's full records live, named in a truncation marker. */
function runsDirHint(cwd: string): string {
  return `${runsRoot(cwd)} and ${subagentStateDir(cwd)}`;
}

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
export type Gated = Pick<WorkflowDef, "name" | "description" | "source" | "file"> & {
  /** An inline plan: gated like a project workflow, but its card and refusals say "plan". */
  inlinePlan?: true;
};

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
  // An inline plan is gated as strictly as a project workflow; only the subject's name tells the
  // operator which of the two they are approving.
  const what = w.inlinePlan ? "plan" : "project workflow";
  if (!ctx.hasUI || !ctx.ui?.select) return `Blocked: ${what} "${w.name}" needs interactive approval or a digest grant (sha256 ${digest} in PI_KIT_TRUSTED_WORKFLOWS, or trusted earlier with "Trust this digest").`;
  // A tool raises this card, and a script can raise it mid-run: under an open overlay it waits.
  const select = ctx.ui.select.bind(ctx.ui);
  const asked = await askFree(ctx, {
    what: `workflow ${w.name}: waiting for approval`,
    show: (card) => select(`Run ${what} "${w.name}"${calledFrom ? ` (called by workflow "${calledFrom}")` : ""}? ${w.description}\nSource: ${w.file}\nsha256: ${digest}\nOnly run workflows from repositories you trust.`, [...TRUST_CHOICES], card),
  });
  if (asked.kind !== "shown") return `Blocked: no operator approved ${what} "${w.name}".`;
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
  return `Cancelled: ${what} not approved.`;
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

/**
 * Steps at the run's cursor that were cut off mid-run (aborted, or left running by a crash) and can
 * write. An `expand` step that passed with its answer lost counts: only asking it again can go on.
 */
export function interruptedWriterSteps(w: WorkflowDef, state: RunState, agents: readonly AgentConfig[]): StepDef[] {
  const step = w.steps[state.cursor];
  if (!step) return [];
  const cutOff = (s: StepDef) => {
    const st = state.steps[s.id];
    return st?.status === "aborted" || st?.status === "running" || (s.expand === true && st?.status === "passed" && !st.expanded && st.expandAnswer === undefined);
  };
  const candidates = step.parallel ? step.parallel.filter(cutOff) : cutOff(step) ? [step] : [];
  return candidates.filter((s) => isWriterStep(s, agents));
}

/** Ask before a resume re-runs interrupted writer steps. Returns an error text, or null to go on. "Skip" marks them skipped in `state`. */
export async function resumeWriterGate(w: WorkflowDef, state: RunState, agents: readonly AgentConfig[], ctx: ToolContext): Promise<string | null> {
  const writers = interruptedWriterSteps(w, state, agents);
  if (!writers.length) return null;
  const names = writers.map((s) => s.id).join(", ");
  if (!ctx.hasUI || !ctx.ui?.select) return `Blocked: run ${state.id} was interrupted while writer step(s) ${names} ran; they may have left partial changes. Resume it interactively (/workflows resume ${state.id}) to choose whether to re-run or skip them.`;
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
 * "workflow" in that scope. A plan's run saves plan.json when `fresh`, ahead of the charge, because
 * the ledger cannot refund one: a save that fails costs nothing, and a refused run removes what it
 * saved. It gets its expansion host. A typed resume has no scope to charge, so it refuses a new
 * expansion: no one saw those steps. What the run already charged replays.
 */
async function launchRun(ctx: ToolContext, w: WorkflowDef, state: RunState, agents: AgentConfig[], identity: string, opts: StartOptions, plan?: { run: PlanRun; fresh?: true }): Promise<Started> {
  const cwd = ctx.cwd ?? process.cwd();
  // Nothing awaits from this check to the hold below, so two calls cannot both pass it.
  const live = liveRuns.find(identity);
  if (live) return { error: duplicateRefusal(live) };
  if (plan?.fresh) {
    const secret = secretTextError(plan.run.steps);
    if (secret) return { error: planRefusal([secret]) };
    try {
      savePlan(cwd, state.id, plan.run);
    } catch (error) {
      return { error: `Plan could not be saved: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  const refused = (error: string): Started => {
    if (plan?.fresh) discardPlan(cwd, state.id);
    return { error };
  };
  let launch: Pick<ExecuteOptions, "launchKind" | "workflowRun" | "concurrency"> = { launchKind: "user" };
  let charge: ChargeExpansion = () => "a typed resume has no run scope to charge it to";
  if (opts.launchKind !== "user") {
    const effort = effortRegistry();
    if (!effort) return refused("Refused: workflow runs need the effort extension (it budgets their agents); it is in every shipped profile.");
    const runId = runScopeId(state);
    const scope = effort.openRunScope(runId, { planned: worstCaseAgents(w, state) });
    if (!scope.ok) return refused(`Refused: the workflow run could not be budgeted (${scope.code}): ${scope.reason}`);
    state.scopes = (state.scopes ?? 0) + 1;
    const { runToken } = scope;
    launch = { launchKind: "workflow", workflowRun: { runId, runToken }, ...(scope.maxConcurrent === undefined ? {} : { concurrency: scope.maxConcurrent }) };
    charge = (planned) => {
      const charged = effort.chargeRunScope?.(runId, runToken, planned) ?? { ok: false, code: "run-scope", reason: "the effort extension cannot charge an expansion" };
      return charged.ok ? null : charged.reason;
    };
  }
  // A serial local model gets one agent at a time however many the plan allows (config.ts modelConcurrencyCap).
  const wanted = launch.concurrency ?? 4;
  const capped = capConcurrency(wanted, ctx.model);
  if (capped < wanted) launch = { ...launch, concurrency: capped };
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

// The SHA-256 of each `expand` answer a child of this process gave. A run directory is in the
// workspace, so an answer in state.json that is not listed here was written by something else.
const sessionAnswers = new Map<string, string>();
const answerKey = (runId: string, stepId: string): string => `${runId}\0${stepId}`;

/** The first field of a definition with text the canonical secret table matches, by path. */
function secretField(value: unknown, at: string): string | undefined {
  if (typeof value === "string") return redact(value) === value ? undefined : at;
  if (Array.isArray(value)) {
    const list: unknown[] = value;
    for (const [i, item] of list.entries()) {
      const found = secretField(item, `${at}[${String(i)}]`);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  for (const [key, item] of Object.entries(value)) {
    if (redact(key) !== key) return at;
    const found = secretField(item, `${at}.${key}`);
    if (found) return found;
  }
  return undefined;
}

/**
 * A definition must survive on disk unchanged, because a resume runs what plan.json says: masking it
 * would run different work, so a plan with secret-shaped text is refused, not saved. The table, not
 * the display heuristic: a task may say "token". The error names the field, never its text.
 */
function secretTextError(steps: unknown): PlanError | undefined {
  const at = secretField(steps, "steps");
  return at === undefined ? undefined : { path: at, problem: "this field holds secret-shaped text.", fix: "Remove it and refer to the credential by name." };
}

/** The steps as given, for a resume to compile again. */
function savePlan(cwd: string, runId: string, plan: PlanRun): void {
  const text = JSON.stringify({ version: 1, steps: plan.steps, expansions: plan.expansions }, null, 2);
  ensurePrivateDir(path.dirname(planFile(cwd, runId)));
  writePrivate(planFile(cwd, runId), text);
  sessionPlans.set(runId, sha256(text));
}

/** Undo savePlan for a run that was refused: nothing started, so nothing of it stays. */
function discardPlan(cwd: string, runId: string): void {
  sessionPlans.delete(runId);
  fs.rmSync(path.dirname(planFile(cwd, runId)), { recursive: true, force: true });
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
    remember(stepId, answer) {
      sessionAnswers.set(answerKey(state.id, stepId), sha256(answer));
    },
    settle(parent, output) {
      const answer = parseExpandAnswer(output);
      if (answer.kind === "invalid") return { kind: "invalid", note: resampleNote(answer.error) };
      if (answer.kind === "done") return answer;
      if (generationOf(parent.id) >= limit) return { kind: "refused", reason: `expansion refused: step ${parent.id} is at the expansion depth limit of ${String(limit)}` };
      const built = compileExpansion(answer.steps, parent, agents, Object.keys(state.inputs));
      if (!built.ok && built.overLimit) return { kind: "refused", reason: `expansion refused: ${planRefusal(built.errors)}` };
      if (!built.ok) return { kind: "invalid", note: resampleNote(built.errors[0] ?? { path: "steps", problem: "the plan is invalid.", fix: "Check it." }) };
      const error = missingSkill(built.workflow, cwd) ?? secretTextError(answer.steps);
      if (error) return { kind: "invalid", note: resampleNote(error) };
      // The count holds a resample for a step whose answer is unsettled, as a resume must. This answer is valid, so none follows.
      const resample = state.steps[parent.id]?.expandMiss === undefined ? 1 : 0;
      const worst = state.executions + worstCaseAgents(w, state) - resample + built.worstCaseAgents;
      if (worst > MAX_EXECUTIONS) return { kind: "refused", reason: `expansion refused: this run could reach ${String(worst)} agents, over its limit of ${String(MAX_EXECUTIONS)}` };
      const refused = charge(built.worstCaseAgents);
      if (refused) return { kind: "refused", reason: `expansion refused: ${refused}` };
      plan.expansions.push({ parent: parent.id, steps: answer.steps });
      try {
        savePlan(cwd, state.id, plan);
      } catch (saveError) {
        plan.expansions.pop();
        return { kind: "refused", reason: `expansion refused: it could not be saved (${saveError instanceof Error ? saveError.message : String(saveError)})` };
      }
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
async function startPlan(ctx: ToolContext, steps: unknown, inputs: Record<string, string>, opts: StartOptions): Promise<Started> {
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
    bytes = Buffer.from(readRunFile(path.dirname(file), PLAN_FILE, MAX_SCRIPT_BYTES));
    saved = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    return { error: `Run ${state.id} cannot be resumed: its ${PLAN_FILE} is missing or unreadable (${error instanceof Error ? error.message : String(error)}). Start a new run.` };
  }
  // An answer waiting in state.json becomes steps, so it is as much the definition as plan.json is.
  const answers = Object.entries(state.steps).flatMap(([id, st]) => (st.expandAnswer !== undefined && !st.expanded ? [{ id, answer: st.expandAnswer }] : []));
  const planDigest = sha256(bytes);
  const digest = answers.length ? sha256(JSON.stringify([planDigest, answers])) : planDigest;
  const seen = answers.every(({ id, answer }) => sessionAnswers.get(answerKey(state.id, id)) === sha256(answer));
  if (sessionPlans.get(state.id) !== planDigest || !seen) {
    const trust = await trustError({ name: state.workflow, description: `The inline plan of run ${state.id}.`, source: "project", file, inlinePlan: true }, digest, ctx);
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
  if (!expansions) return { error: `Run ${state.id}: its ${PLAN_FILE} lists expansions it cannot read` };
  const unusable = replayExpansions(workflow, state, agents, expansions);
  if (unusable !== null) return { error: `Run ${state.id}: ${unusable}` };
  const noSkill = missingSkill(workflow, cwd);
  if (noSkill) return { error: `Run ${state.id}: ${planRefusal([noSkill])}` };
  const refused = await resumeError(workflow, state, agents, ctx);
  if (refused) return { error: refused };
  return launchRun(ctx, workflow, state, agents, identity, opts, { run: { steps, expansions } });
}

/** A panel opener, bound by wf-panel.ts: the `/workflows` command's `panel` subcommand. */
export type WorkflowPanelOpener = (ctx: ExtensionContext, runId?: string) => Promise<void>;

let panelOpener: WorkflowPanelOpener | undefined;

export function bindWorkflowPanelOpener(fn: WorkflowPanelOpener): void {
  panelOpener = fn;
}

// One stop path for the tool and the command: a live workflow run goes through control.ts, a
// background subagent (live here or an orphan recorded in runs.jsonl) through status.ts. An id
// that is neither keeps control.ts's "No live run" answer.
function stopRun(cwd: string, id: string, origin: ControlOrigin): ControlResult {
  const dir = subagentStateDir(cwd);
  if (!runControls.has(id) && hasSubagentRun(dir, id)) return stopTargets(dir, id);
  return controlRun(id, "stop", runControls, origin);
}

// `stop all`: every live workflow run of this session, then every live or orphaned subagent.
function stopEveryRun(cwd: string, origin: ControlOrigin): string {
  const lines: string[] = [];
  for (const id of runControls.ids()) {
    const r = controlRun(id, "stop", runControls, origin);
    if (r.ok) lines.push(r.message);
  }
  lines.push(stopTargets(subagentStateDir(cwd), "all").message);
  return lines.join("\n");
}

const COMMAND_USAGE = "/workflows | list | status [id] | panel [id] | run <name> key=value… | resume <id> | pause <id> | skip <id> | stop <id|all>";

export interface WorkflowToolDeps {
  /** Test seam: the child spawner the tool's runs use. */
  spawnChild?: SpawnChild;
}

/**
 * The tools that only mean something once a run exists. They are registered inactive (pi 1.x
 * honours `defaultActive: false`; an older pi ignores the field and simply leaves them active), so
 * their 1,636 characters of text are not in every request of a session that never starts a run.
 */
const RUN_TOOLS = ["workflow_status", "workflow_control"];

/** Make the run tools callable: a run has started, or is about to. A pi without tool control skips it. */
export function activateRunTools(pi: ExtensionAPI): void {
  try {
    if (typeof pi.getActiveTools !== "function" || typeof pi.setActiveTools !== "function") return;
    const current = pi.getActiveTools();
    const missing = RUN_TOOLS.filter((name) => !current.includes(name));
    if (missing.length > 0) pi.setActiveTools([...current, ...missing]);
  } catch {
    /* activation is an optimisation; the tools stay inactive and /workflows still lists runs */
  }
}

export function registerWorkflowTools(pi: ExtensionAPI, deps: WorkflowToolDeps = {}): void {
  // Workflows orchestrate subagents; a subagent child never starts one itself.
  if (process.env.PI_KIT_INTERNAL_CHILD === "1") return;

  // A run begins in one of three ways: the model starts one (workflow_run, workflow, or a background
  // subagent), the operator starts one with a command, or a run is resumed. Each one wakes the tools.
  pi.on("tool_call", async (event) => {
    const background = event.toolName === "subagent" && Reflect.get(event.input, "background") === true;
    if (background || event.toolName === "workflow_run" || event.toolName === "workflow") activateRunTools(pi);
    return undefined;
  });
  runRegistry.subscribe((event) => {
    if (event.type === "run_start") activateRunTools(pi);
  });
  // An autonomous container run never goes through the registry: the operator starts it with
  // /autonomy or a CLI, and it can outlive the session. Look for one before each prompt, so a session that only watches it still gets the tools.
  const wakeForAutonomy = (cwd: string): void => {
    try {
      if (queryRuns(cwd).some((run) => run.format === "autonomy" && (run.live || run.status === "blocked"))) activateRunTools(pi);
    } catch {
      /* the lookup is an optimisation; /workflows still lists the run */
    }
  };
  pi.on("before_agent_start", async (_event, ctx) => {
    wakeForAutonomy(ctx.cwd ?? process.cwd());
    return undefined;
  });

  pi.registerTool({
    name: "workflow_run",
    label: "Workflow",
    description:
      "Run subagent steps with a shared directory, gates and resume. Pass exactly one of: name (a saved workflow; \"list\" shows them), steps (a plan as data) or resume (a run id). " +
      PLAN_DESCRIPTION,
    promptSnippet: "Run a saved workflow or an inline plan",
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: 'Saved workflow name, or "list"' })),
      steps: Type.Optional(Type.Array(Type.Unknown(), { description: "The plan's steps" })),
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
        const tail = producedResult(r.state.status) ? `\n\nFinal step (${last?.id}) output: ${dir}/steps/${last?.id}.md` : r.state.status === "interrupted" || r.state.status === "failed" ? `\n\nResume with workflow_run {resume: "${r.state.id}"} or /workflows resume ${r.state.id}` : "";
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
    description:
      "List runs of every format — workflow YAML, workflow script, subagent and autonomous container — live or finished. " +
      "With id: YAML steps, script counters, a subagent's log tail, or an autonomous run's template, spend, blocker and liveness.",
    promptSnippet: "Inspect workflow, subagent and autonomy runs",
    defaultActive: false,
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: "One run's id; without it, the newest runs of every format" })),
      limit: Type.Optional(Type.Number({ description: "How many runs to list (default 20, max 100)" })),
      tail: Type.Optional(Type.Number({ description: "Lines of a background subagent's log to show with id (default 40)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, rawCtx) {
      const cwd = rawCtx.cwd ?? process.cwd();
      if (params.id !== undefined) {
        // The id is model-supplied and is joined into a filesystem path: check it before reading.
        if (!isValidRunId(params.id)) return textResult("Invalid run id.", true);
        const text = describeRun(cwd, params.id, { tail: params.tail });
        return text ? textResult(capText(text, `under ${runsDirHint(cwd)}`)) : textResult(`No run "${params.id}".`, true);
      }
      const limit = Math.max(1, Math.min(Number(params.limit) || 20, MAX_RUN_LIST));
      return textResult(capText(formatRunList(queryRuns(cwd), limit), `under ${runsDirHint(cwd)}`));
    },
  });

  pi.registerTool({
    name: "workflow_control",
    label: "Workflow control",
    description:
      "Control a live workflow run in this session: pause (start no new agents; running ones finish), resume (unpause; a pause the console's safety stop set yields only to the operator), " +
      "stop (a live run's agents stop and it ends interrupted, resumable with workflow_run {resume}; a background subagent run id stops that child; all stops every live run and every background subagent, orphans included), " +
      "or skip (stop the agents running now and record their steps as skipped; a skipped required step can fail the run or leave it partial).",
    promptSnippet: "Pause, resume, stop or skip a live workflow run or a background subagent",
    defaultActive: false,
    parameters: Type.Object({
      runId: Type.Optional(Type.String({ description: "The live run's id, or a background subagent run id (workflow_status lists both)" })),
      action: Type.Union(CONTROL_ACTIONS.map((a) => Type.Literal(a)), { description: CONTROL_ACTIONS.join(" | ") }),
      all: Type.Optional(Type.Boolean({ description: 'With action "stop": stop every live workflow run and every background subagent, orphans included' })),
    }),
    async execute(_id, params, _signal, _onUpdate, rawCtx) {
      const cwd = rawCtx.cwd ?? process.cwd();
      if (params.all === true) {
        if (params.action !== "stop") return textResult('all is only used with action "stop".', true);
        return textResult(stopEveryRun(cwd, "agent"));
      }
      if (!params.runId) return textResult('Give a runId, or all: true with action "stop" (workflow_status lists runs).', true);
      if (params.action === "stop") {
        const r = stopRun(cwd, params.runId, "agent");
        return textResult(r.message, !r.ok);
      }
      // The governed agent asks here: it cannot lift a pause the console's safety stop holds for the operator.
      const r = controlRun(params.runId, params.action, runControls, "agent");
      return textResult(r.message, !r.ok);
    },
  });

  // One command: `/workflows` is the surface. Bare
  // `/workflows` lists runs of every format, past runs included; `list` keeps showing the saved
  // workflow definitions, and `panel` opens the live TUI panel.
  const runCommand = async (args: string, rawCtx: ExtensionContext): Promise<void> => {
    const ctx = rawCtx;
    const cwd = ctx.cwd ?? process.cwd();
    const [sub = "", ...rest] = args.trim().split(/\s+/).filter(Boolean);
    const notify = (m: string, l: "info" | "warning" | "error" = "info"): void => {
      if (ctx.ui?.notify) ctx.ui.notify(m, l);
      else process.stderr.write(`${m}\n`);
    };
    if (!sub) {
      notify(formatRunList(queryRuns(cwd)));
      return;
    }
    if (sub === "list") {
      notify(listText(cwd));
      return;
    }
    if (sub === "panel") {
      if (!panelOpener) {
        notify("The workflow panel is not available in this session.", "warning");
        return;
      }
      await panelOpener(ctx, rest[0]);
      return;
    }
    if (sub === "status") {
      const id = rest[0];
      if (!id) {
        notify(formatRunList(queryRuns(cwd)));
        return;
      }
      if (!isValidRunId(id)) {
        notify("Invalid run id.", "error");
        return;
      }
      const text = describeRun(cwd, id);
      notify(text ?? `No run "${id}".`, text ? "info" : "error");
      return;
    }
    if (sub === "stop" && rest[0] === "all") {
      notify(stopEveryRun(cwd, "operator"));
      return;
    }
    if (sub === "stop") {
      const r = stopRun(cwd, rest[0] ?? "", "operator");
      notify(r.message, r.ok ? "info" : "warning");
      return;
    }
    // A live run is controlled through control.ts; `resume` of a run that is not live
    // continues it from its state.json below.
    if (sub === "pause" || sub === "skip" || (sub === "resume" && runControls.has(rest[0] ?? ""))) {
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
      notify(`workflow ${name}: started${resume ? ` (resuming ${resume.id})` : ""}. /workflows status to follow, /workflows stop <id> to stop.`);
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
            pi.sendMessage({ customType: "workflow-result", content: capText(text, `under ${path.join(runsRoot(cwd), r.state?.id ?? "")}`), display: true }, { deliverAs: "followUp", triggerTurn: false });
          } catch {
            notify(text, r.error || r.state?.status !== "passed" ? "warning" : "info");
          }
        })
        .catch((error: unknown) => {
          notify(`workflow ${name} crashed: ${String(error)}`, "error");
        });
      return;
    }
    notify(`Unknown subcommand "${sub}". ${COMMAND_USAGE}`, "error");
  };

  const completions = (prefix: string) => {
    const words = prefix.trimStart().split(/\s+/);
    if (words.length <= 1) return ["list", "panel ", "run ", "status", "resume ", "pause ", "skip ", "stop "].filter((v) => v.startsWith(words[0] ?? "")).map((v) => ({ value: v, label: v.trim() }));
    if (words[0] === "run" && words.length === 2) {
      const { workflows } = discoverWorkflows(process.cwd());
      return workflows.filter((w) => w.name.startsWith(words[1] ?? "")).map((w) => ({ value: `run ${w.name} `, label: w.name, description: w.description }));
    }
    if (["status", "panel", "pause", "skip", "resume", "stop"].includes(words[0] ?? "") && words.length === 2) {
      const ids = queryRuns(process.cwd())
        .filter((r) => r.id.startsWith(words[1] ?? ""))
        .map((r) => ({ value: `${words[0]} ${r.id}`, label: r.id, description: `${r.format}: ${r.name} (${r.status})` }));
      const all = words[0] === "stop" && "all".startsWith(words[1] ?? "") ? [{ value: "stop all", label: "all" }] : [];
      return [...all, ...ids];
    }
    return null;
  };

  pi.registerCommand("workflows", {
    description: `Every workflow, subagent and autonomous run, live or finished: list them, show one, stop one or all. ${COMMAND_USAGE}`,
    getArgumentCompletions: completions,
    handler: runCommand,
  });
}
