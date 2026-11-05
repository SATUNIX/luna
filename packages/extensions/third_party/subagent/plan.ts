/**
 * Workflows — plans as data. `workflow_run {steps:[...]}` takes the YAML step shape as JSON, so a
 * model describes work instead of writing orchestration code. A plan compiles through the workflow
 * parser (parseSteps) and runs in the same executor; this module adds what a saved workflow does not
 * need, because a saved workflow is reviewed and a plan is written on the spot: fields that would
 * widen a step are refused, tools can only narrow, references resolve before anything starts, and
 * every problem names its path and how to fix it. Pure: nothing here touches the disk or starts a run.
 *
 * See docs/workflows.md; tests/workflow-plan-smoke.ts.
 */
import type { AgentConfig } from "./agents.ts";
import { compileCheckedRegex } from "./shared/safe-regex.ts";
import { MAX_EXECUTIONS, parseSteps, STEP_STATUSES, TEMPLATE_EXPR, worstCaseAgents, type WorkflowDef } from "./workflow.ts";

export interface PlanStep {
  id?: string;
  agent?: string;
  task?: string;
  parallel?: PlanStep[];
  skills?: string[];
  tools?: string[];
  outputs?: string[];
  when?: { step: string; status: string | string[] };
  gate?: { pass: string; retry: string; max_loops?: number };
  continue_on_error?: boolean;
}

export interface PlanError {
  path: string;
  problem: string;
  fix: string;
}

export type Compiled = { ok: true; workflow: WorkflowDef; worstCaseAgents: number } | { ok: false; errors: PlanError[] };

/** The tool's own account of a plan; kept here so the rules and their text change together. */
export const PLAN_DESCRIPTION =
  "A step is {id?, agent?, task, tools?, skills?, outputs?, when?, gate?, continue_on_error?} or {id?, parallel: [steps], gate?}. agent defaults to implementer. tools only narrow the role. " +
  "{previous} in a task is the prior step's output; {{steps.<id>.output}} any earlier step's. when: {step, status} runs on an earlier result. " +
  "gate: {pass, retry, max_loops?} loops back to retry until the output contains pass, and the retry step's task gets the reviewer's text.";

const EXAMPLE = 'Example: {"steps":[{"task":"..."}]}';
const REFUSAL_CAP = 300;

const WIDENING: ReadonlySet<string> = new Set(["model", "thinking", "extensions", "max_runtime", "maxRuntime", "skill"]);
const LEAF_FIELDS: ReadonlySet<string> = new Set(["id", "agent", "task", "skills", "tools", "outputs", "when", "gate", "continue_on_error"]);
const GROUP_FIELDS: ReadonlySet<string> = new Set(["id", "parallel", "gate"]);
const GATE_FIELDS: ReadonlySet<string> = new Set(["pass", "retry", "max_loops"]);
const WHEN_FIELDS: ReadonlySet<string> = new Set(["step", "status"]);
const SPAWN_TOOLS: ReadonlySet<string> = new Set(["subagent", "workflow", "workflow_run", "dual_review", "dispatch_specialist"]);
const STATUSES: ReadonlySet<string> = new Set(STEP_STATUSES);
const TOOL_NAME = /^[A-Za-z][\w-]*$/;
const SKILL_NAME = /^[a-z0-9][a-z0-9._-]*$/i; // as skills.ts resolves them
const GATE_REGEX = /^\/(.+)\/([a-z]*)$/; // as workflow.ts reads a gate's pass
const MAX_LOOPS = 10;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");
const clip = (text: string, cap: number): string => (text.length <= cap ? text : `${text.slice(0, cap - 1)}…`);
/** Plan text inside a message, short enough to keep the message to its cap. */
const shown = (value: unknown): string => clip(JSON.stringify(value) ?? "undefined", 30);
const planError = (at: string, problem: string, fix: string): PlanError => ({ path: clip(at, 40), problem: clip(problem, 110), fix: clip(fix, 90) });

/** One step of the plan with what the checks need around it. */
interface Entry {
  raw: Record<string, unknown>;
  at: string;
  id: string;
  index: number; // its top-level position
  member: boolean;
}

/** What every step is checked against. */
interface Scope {
  agents: readonly AgentConfig[];
  inputs: readonly string[];
  known: ReadonlySet<string>;
  /** Top-level ids, in order. */
  tops: readonly string[];
  /** Per top-level position: every id that finished before it, parallel members included. */
  before: ReadonlyArray<ReadonlySet<string>>;
  errors: PlanError[];
}

function checkFields(entry: Entry, group: boolean, scope: Scope): void {
  const allowed = group ? GROUP_FIELDS : LEAF_FIELDS;
  for (const key of Object.keys(entry.raw)) {
    const at = `${entry.at}.${key}`;
    if (allowed.has(key) && !entry.member) continue;
    if (WIDENING.has(key)) scope.errors.push(planError(at, `${key} is refused in a plan: it would widen the step.`, `Remove ${key}; the role sets it.`));
    else if (key === "parallel" && entry.member) scope.errors.push(planError(at, "parallel groups cannot nest.", "Move this group to the top level."));
    else if (key === "gate" && entry.member) scope.errors.push(planError(at, "a gate on a parallel member never runs.", "Put the gate on the group."));
    else if (group && LEAF_FIELDS.has(key)) scope.errors.push(planError(at, "a parallel group takes only id, parallel and gate.", "Move it onto the member steps."));
    else if (!allowed.has(key)) scope.errors.push(planError(at, "this field is not part of a plan.", `Use only: ${[...allowed].join(", ")}.`));
  }
}

function checkTools(entry: Entry, role: AgentConfig | undefined, scope: Scope): void {
  const { tools } = entry.raw;
  if (tools === undefined) return;
  const at = `${entry.at}.tools`;
  if (!isStrings(tools)) scope.errors.push(planError(at, "tools must be a list of tool names.", 'Use ["read", "grep"], or leave tools out.'));
  else if (tools.length === 0) scope.errors.push(planError(at, "an empty list gives a child every tool.", "Name the tools, or leave tools out."));
  else {
    const allowed = role?.tools?.length ? role.tools : undefined;
    for (const tool of tools) {
      if (SPAWN_TOOLS.has(tool.toLowerCase())) scope.errors.push(planError(at, `${shown(tool)} can start agents; a step cannot.`, "Add a step to the plan instead."));
      else if (!TOOL_NAME.test(tool)) scope.errors.push(planError(at, `${shown(tool)} is not a tool name.`, "Name each tool exactly."));
      else if (allowed && !allowed.includes(tool)) scope.errors.push(planError(at, `${shown(tool)} is not in ${clip(role?.name ?? "", 20)}'s tools; tools only narrow.`, `Use some of: ${allowed.join(", ")}.`));
    }
  }
}

function checkLists(entry: Entry, scope: Scope): void {
  const { skills, outputs, continue_on_error: keepGoing, id } = entry.raw;
  if (id !== undefined && typeof id !== "string") scope.errors.push(planError(`${entry.at}.id`, "id must be text.", 'Use an id like "review".'));
  if (skills !== undefined && !(isStrings(skills) && skills.every((s) => SKILL_NAME.test(s)))) scope.errors.push(planError(`${entry.at}.skills`, "skills must be a list of skill names.", 'Use ["workflow-authoring"], or leave skills out.'));
  if (outputs !== undefined && !isStrings(outputs)) scope.errors.push(planError(`${entry.at}.outputs`, "outputs must be a list of file names.", 'Use ["report.md"], or leave outputs out.'));
  if (keepGoing !== undefined && typeof keepGoing !== "boolean") scope.errors.push(planError(`${entry.at}.continue_on_error`, "continue_on_error must be true or false.", "Use true, or leave it out."));
}

function checkWhen(entry: Entry, scope: Scope): void {
  const { when } = entry.raw;
  if (when === undefined) return;
  const at = `${entry.at}.when`;
  if (!isRecord(when)) {
    scope.errors.push(planError(at, "when must be a mapping.", 'Use {"step": "a", "status": "failed"}.'));
    return;
  }
  for (const key of Object.keys(when)) if (!WHEN_FIELDS.has(key)) scope.errors.push(planError(`${at}.${key}`, "this field is not part of when.", "Use only step and status."));
  if (typeof when.step !== "string" || !scope.before[entry.index]?.has(when.step)) scope.errors.push(planError(`${at}.step`, `${shown(when.step)} is not an earlier step.`, "Name an earlier step's id."));
  const statuses: unknown[] = Array.isArray(when.status) ? when.status : [when.status];
  if (statuses.length === 0 || !statuses.every((s) => typeof s === "string" && STATUSES.has(s))) scope.errors.push(planError(`${at}.status`, `${shown(when.status)} is not a step status.`, "Use passed, failed or skipped."));
}

function checkGate(entry: Entry, scope: Scope): void {
  const { gate } = entry.raw;
  if (gate === undefined || entry.member) return;
  const at = `${entry.at}.gate`;
  if (!isRecord(gate)) {
    scope.errors.push(planError(at, "gate must be a mapping.", 'Use {"pass": "PASS", "retry": "build"}.'));
    return;
  }
  for (const key of Object.keys(gate)) if (!GATE_FIELDS.has(key)) scope.errors.push(planError(`${at}.${key}`, "this field is not part of a gate.", "Use only pass, retry and max_loops."));
  const { pass, retry, max_loops: loops } = gate;
  if (typeof pass !== "string" || !pass) scope.errors.push(planError(`${at}.pass`, "a gate needs pass: text its output must contain.", 'Use "VERDICT: PASS".'));
  else {
    const re = GATE_REGEX.exec(pass);
    if (re) {
      const [, source = "", flags = ""] = re;
      let safe = false;
      try {
        safe = compileCheckedRegex(source, flags.includes("i") ? flags : `${flags}i`).ok;
      } catch {
        /* an invalid pattern is refused below */
      }
      if (!safe) scope.errors.push(planError(`${at}.pass`, `${shown(pass)} is not a safe pattern, so the gate could never pass.`, "Use plain text or a simpler pattern."));
    }
  }
  if (typeof retry !== "string" || !scope.tops.slice(0, entry.index + 1).includes(retry)) scope.errors.push(planError(`${at}.retry`, `${shown(retry)} is not this or an earlier top-level step.`, "Name the step to redo; give it an id."));
  if (loops !== undefined && !(typeof loops === "number" && Number.isInteger(loops) && loops >= 0 && loops <= MAX_LOOPS)) scope.errors.push(planError(`${at}.max_loops`, `max_loops must be a whole number from 0 to ${String(MAX_LOOPS)}.`, "Use 1 or 2."));
}

function checkTask(entry: Entry, task: string, scope: Scope): void {
  const at = `${entry.at}.task`;
  for (const match of task.matchAll(TEMPLATE_EXPR)) {
    const raw = match[1] ?? "";
    const optional = raw.endsWith("?");
    const expr = optional ? raw.slice(0, -1).trim() : raw;
    if (expr === "run.dir" || expr === "run.id" || expr === "loop" || expr.startsWith("file:")) continue;
    if (expr.startsWith("inputs.")) {
      if (!optional && !scope.inputs.includes(expr.slice(7))) scope.errors.push(planError(at, `{{${clip(expr, 30)}}} names an input nobody gave.`, "Pass it in inputs, or write the text into the task."));
      continue;
    }
    const step = /^steps\.([a-z][a-z0-9_-]*)\.(?:output|status)$/.exec(expr)?.[1];
    if (step === undefined) scope.errors.push(planError(at, `{{${clip(expr, 30)}}} is not a template expression.`, "Use {previous}, {{steps.<id>.output}} or {{run.dir}}."));
    else if (!scope.known.has(step)) scope.errors.push(planError(at, `{{${clip(expr, 40)}}} names no step in this plan.`, "Use the id of a step in the plan."));
    else if (!optional && !scope.before[entry.index]?.has(step)) scope.errors.push(planError(at, `${clip(step, 30)} has not run yet at this step.`, `Add ? to allow nothing yet: {{${clip(expr, 40)}?}}.`));
  }
  if (entry.index === 0 && /\{previous\}/.test(task)) scope.errors.push(planError(at, "{previous} has no prior step on the first step.", "Remove it, or add a step before this one."));
}

/** {previous} as a reference to the prior top-level step; a step `when` may skip leaves no output. */
function withPrevious(task: string, entry: Entry, scope: Scope, whenSkips: readonly boolean[]): string {
  const prior = scope.tops[entry.index - 1];
  if (prior === undefined) return task;
  return task.replace(/(?<!\{)\{previous\}(?!\})/g, `{{steps.${prior}.output${whenSkips[entry.index - 1] ? "?" : ""}}}`);
}

/** A plan's raw step list checked, and rewritten into the shape parseSteps reads. */
function normalise(scope: Scope, entries: ReadonlyArray<{ entry?: Entry | undefined; members?: Entry[] | undefined }>): unknown[] {
  const whenSkips = entries.map(({ entry }) => entry?.raw.when !== undefined);
  const leaf = (entry: Entry): Record<string, unknown> => {
    checkFields(entry, false, scope);
    const { agent = "implementer", task } = entry.raw;
    const role = scope.agents.find((a) => a.name === agent);
    if (!role) scope.errors.push(planError(`${entry.at}.agent`, `${shown(agent)} is not a role.`, `Use one of: ${scope.agents.map((a) => a.name).join(", ")}.`));
    checkTools(entry, role, scope);
    checkLists(entry, scope);
    checkWhen(entry, scope);
    checkGate(entry, scope);
    if (typeof task !== "string" || !task.trim()) scope.errors.push(planError(`${entry.at}.task`, "a step needs a task: text saying what to do.", 'Add "task": "...".'));
    else checkTask(entry, task, scope);
    const { when, gate, tools, skills, outputs, continue_on_error: keepGoing } = entry.raw;
    return { id: entry.id, agent, task: typeof task === "string" ? withPrevious(task, entry, scope, whenSkips) : task, tools, skills, outputs, when, gate, continue_on_error: keepGoing };
  };
  return entries.map(({ entry, members }) => {
    if (!entry) return undefined;
    if (!members) return leaf(entry);
    checkFields(entry, true, scope);
    checkLists(entry, scope);
    checkGate(entry, scope);
    return { id: entry.id, parallel: members.map(leaf), gate: entry.raw.gate };
  });
}

/** Each gate's reviewer text reaches the step it sends work back to, unless that task already asks for it. */
function feedGates(steps: unknown[]): void {
  const tasksOf = (s: Record<string, unknown>): Array<Record<string, unknown>> => (Array.isArray(s.parallel) ? s.parallel.filter(isRecord) : [s]);
  const tops = steps.filter(isRecord);
  for (const step of tops) {
    if (!isRecord(step.gate) || typeof step.id !== "string") continue;
    const { retry } = step.gate;
    const target = tops.find((s) => s.id === retry);
    if (!target) continue;
    const reference = `steps.${step.id}.output`;
    for (const leaf of tasksOf(target)) if (typeof leaf.task === "string" && !leaf.task.includes(reference)) leaf.task = `${leaf.task}\n\nThe last review of this work (empty on a first attempt):\n{{${reference}?}}`;
  }
}

/** A parseSteps message as a plan error. These are the checks the parser keeps for itself. */
function parserError(message: string): PlanError {
  const m = /^(steps\[\d+\](?:\.parallel\[\d+\])?): (.*)$/.exec(message);
  const [, at = "steps", problem = message] = m ?? [];
  const fix = /duplicate/.test(problem) ? "Give every step its own id." : /output/.test(problem) ? "Use a relative path inside the run directory." : "Use lower-case letters, digits, - and _.";
  return planError(at, problem, fix);
}

/**
 * Compile a plan. `inputs` names the inputs the call passes, so a task can use {{inputs.x}}. Nothing
 * is launched here; the caller charges `worstCaseAgents` (the same arithmetic as a saved workflow)
 * before any agent starts.
 */
export function compilePlan(steps: unknown, agents: readonly AgentConfig[], inputs: readonly string[] = []): Compiled {
  if (!Array.isArray(steps)) return { ok: false, errors: [planError("steps", "steps must be a list of steps.", "Pass a list.")] };
  const raw: unknown[] = steps;
  if (raw.length === 0) return { ok: false, errors: [planError("steps", "a plan needs at least one step.", "Add a step.")] };
  const errors: PlanError[] = [];
  const entries = raw.map((step, index) => {
    const at = `steps[${index}]`;
    if (!isRecord(step)) {
      errors.push(planError(at, "a step must be a mapping.", 'Use {"task": "..."}.'));
      return {};
    }
    const id = typeof step.id === "string" ? step.id : `step-${index + 1}`;
    const entry: Entry = { raw: step, at, id, index, member: false };
    if (step.parallel === undefined) return { entry };
    if (!Array.isArray(step.parallel) || step.parallel.length === 0) {
      errors.push(planError(`${at}.parallel`, "parallel must be a list of at least one step.", 'Use [{"task": "..."}].'));
      return {};
    }
    const list: unknown[] = step.parallel;
    const members: Entry[] = [];
    list.forEach((member, j) => {
      if (!isRecord(member)) errors.push(planError(`${at}.parallel[${j}]`, "a step must be a mapping.", 'Use {"task": "..."}.'));
      else members.push({ raw: member, at: `${at}.parallel[${j}]`, id: typeof member.id === "string" ? member.id : `${id}-${j + 1}`, index, member: true });
    });
    return { entry, members };
  });
  const idsOf = (e: (typeof entries)[number]): string[] => [...(e.entry ? [e.entry.id] : []), ...(e.members ?? []).map((m) => m.id)];
  const before: Array<ReadonlySet<string>> = entries.map((_, i) => new Set(entries.slice(0, i).flatMap(idsOf)));
  const scope: Scope = { agents, inputs, known: new Set(entries.flatMap(idsOf)), tops: entries.map((e) => e.entry?.id ?? ""), before, errors };
  const normal = normalise(scope, entries);
  if (errors.length) return { ok: false, errors };
  feedGates(normal);
  const parsed: string[] = [];
  const parsedSteps = parseSteps(normal, parsed);
  if (parsed.length) return { ok: false, errors: parsed.map(parserError) };
  const workflow: WorkflowDef = { name: "plan", description: "An inline plan.", inputs: {}, steps: parsedSteps, vault: false, source: "user", file: "plan.json" };
  const worst = worstCaseAgents(workflow);
  if (worst > MAX_EXECUTIONS) return { ok: false, errors: [planError("steps", `the worst case is ${String(worst)} agents, over the run limit of ${String(MAX_EXECUTIONS)}.`, "Use fewer steps or a lower max_loops.")] };
  return { ok: true, workflow, worstCaseAgents: worst };
}

/** What a refused call returns: the first problem, how many follow, and one example. */
export function planRefusal(errors: readonly PlanError[]): string {
  const first = errors[0] ?? planError("steps", "the plan is invalid.", "Check it.");
  const more = errors.length > 1 ? ` (${String(errors.length - 1)} more)` : "";
  return clip(`Plan refused at ${first.path}: ${first.problem}${more} Fix: ${first.fix} ${EXAMPLE}`, REFUSAL_CAP);
}
