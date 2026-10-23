/**
 * Workflows — tool and command registration (`workflow_run`, `workflow_status`, `workflow_control`,
 * `/workflow`). Pause, resume, stop and skip of a live run all go through control.ts.
 */
import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { discoverAgents, type AgentConfig } from "./agents.ts";
import { agentDir } from "./config.ts";
import { CONTROL_ACTIONS, controlRun, runControls } from "./control.ts";
import { isReadOnlyRole, READ_ONLY_TOOLS } from "./launch.ts";
import {
  discoverWorkflows,
  executeWorkflow,
  listRuns,
  loadState,
  newRunState,
  readScript,
  resolveInputs,
  runsRoot,
  summarizeRun,
  workflowDigest,
  SKIPPED_ON_RESUME,
  type RunState,
  type StepDef,
  type ScriptWorkflowDef,
  type WorkflowDef,
} from "./workflow.ts";
import type { ToolContext } from "./types.ts";

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

/** The project-workflow trust gate: null to go on, or why the workflow may not run. */
export async function trustError(w: Gated, digest: string, ctx: ToolContext, calledFrom?: string): Promise<string | null> {
  if (w.source !== "project") return null;
  const envGrants = (process.env.PI_KIT_TRUSTED_WORKFLOWS ?? "").split(";").map((d) => d.trim());
  if (envGrants.includes(digest) || trustedDigests().includes(digest)) return null;
  if (!ctx.hasUI || !ctx.ui?.select) return `Blocked: project workflow "${w.name}" needs interactive approval or a digest grant (sha256 ${digest} in PI_KIT_TRUSTED_WORKFLOWS, or trusted earlier with "Trust this digest").`;
  const choice = await ctx.ui.select(
    `Run project workflow "${w.name}"${calledFrom ? ` (called by workflow "${calledFrom}")` : ""}? ${w.description}\nSource: ${w.file}\nsha256: ${digest}\nOnly run workflows from repositories you trust.`,
    [...TRUST_CHOICES],
  );
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
  const choice = await ctx.ui.select(
    `Run ${state.id} was interrupted while step(s) ${names} could write files. They may have left partial changes in the workspace or run directory.\nRe-run or skip them?`,
    [...RESUME_WRITER_CHOICES],
  );
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

async function start(
  pi: ExtensionAPI,
  ctx: ToolContext,
  name: string,
  inputsGiven: Record<string, string>,
  opts: { resume?: RunState | undefined; signal?: AbortSignal | undefined; onProgress?: (t: string) => void; launchKind?: "discretionary" | "user" },
): Promise<{ error: string; state?: undefined; workflow?: undefined } | { error?: undefined; state: RunState; workflow: WorkflowDef }> {
  const cwd = ctx.cwd ?? process.cwd();
  const { workflows, scripts } = discoverWorkflows(cwd);
  const w = workflows.find((x) => x.name === name);
  if (!w) {
    if (scripts.some((x) => x.name === name)) return { error: `Workflow "${name}" is a script workflow; run it with the workflow tool ({name: "${name}"}).` };
    return { error: `Unknown workflow "${name}".\n${listText(cwd)}` };
  }
  const trust = await trustError(w, workflowDigest(w), ctx);
  if (trust) return { error: trust };
  const agents = discoverAgents(cwd, "user").agents;
  if (opts.resume) {
    if (runControls.has(opts.resume.id)) return { error: `Run ${opts.resume.id} is still live in this session; use workflow_control {runId: "${opts.resume.id}", action: "resume"} to unpause it.` };
    const gate = await resumeWriterGate(w, opts.resume, agents, ctx);
    if (gate) return { error: gate };
  }
  let state = opts.resume;
  if (!state) {
    const { inputs, missing } = resolveInputs(w, inputsGiven);
    if (missing.length) return { error: `Missing required input(s) for ${name}: ${missing.join(", ")}. Inputs: ${Object.entries(w.inputs).map(([k, v]) => `${k}${v.required ? "*" : ""} (${v.description ?? ""})`).join("; ")}` };
    state = newRunState(w, inputs);
  }
  // The run's control (pause/resume/stop/skip); the tool call's signal (Esc) stops it.
  const { control, close } = runControls.open(state.id, opts.signal);
  try {
    const final = await executeWorkflow(w, state, { cwd, agents, control, parentModel: parentModelOf(ctx), onProgress: opts.onProgress, launchKind: opts.launchKind });
    return { state: final, workflow: w };
  } finally {
    close();
  }
}

const liveTag = (id: string): string => {
  const c = runControls.get(id);
  return c ? (c.paused ? " (active, paused)" : " (active)") : "";
};

export function registerWorkflowTools(pi: ExtensionAPI): void {
  // Workflows orchestrate subagents; a subagent child never starts one itself.
  if (process.env.PI_KIT_INTERNAL_CHILD === "1") return;

  pi.registerTool({
    name: "workflow_run",
    label: "Workflow",
    description:
      "Run a saved workflow: a deterministic chain of subagent/skill steps with a shared run directory, review gates and resume. " +
      'Use name "list" to see available workflows and their inputs. Prefer a matching workflow over hand-building subagent chains.',
    promptSnippet: "Run a saved multi-step subagent workflow (list, or run by name with inputs)",
    parameters: Type.Object({
      name: Type.String({ description: 'Workflow name, or "list"' }),
      inputs: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Workflow inputs, e.g. {goal: \"...\"}" })),
      resume: Type.Optional(Type.String({ description: "Run id to resume instead of starting a new run" })),
    }),
    async execute(_id, params, signal, onUpdate, rawCtx) {
      const ctx: ToolContext = rawCtx;
      const cwd = ctx.cwd ?? process.cwd();
      if (params.name === "list") return textResult(listText(cwd));
      let resume: RunState | undefined;
      if (params.resume) {
        const s = loadState(cwd, params.resume);
        if (!s) return textResult(`No run "${params.resume}".`, true);
        if (s.status === "passed") return textResult(`Run ${s.id} already passed.`);
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
        const r = await start(pi, ctx, resume?.workflow ?? params.name, params.inputs ?? {}, { resume, signal, onProgress: report });
        if (r.error !== undefined) return textResult(r.error, true);
        const dir = path.join(runsRoot(cwd), r.state.id);
        // A parsed workflow always has at least one step.
        const last = r.workflow.steps[r.workflow.steps.length - 1];
        const tail = r.state.status === "passed" ? `\n\nFinal step (${last?.id}) output: ${dir}/steps/${last?.id}.md` : r.state.status === "interrupted" ? `\n\nResume with workflow_run {resume: "${r.state.id}"} or /workflow resume ${r.state.id}` : "";
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
      "stop (stop its agents; the run ends interrupted and can be resumed with workflow_run {resume}), or skip (stop the agents running now, record their steps as skipped, and go on).",
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
        void start(pi, ctx, name, inputs, { resume, launchKind: "user", onProgress: (t) => {
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
