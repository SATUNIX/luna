/**
 * The `workflow` tool: runs a JavaScript workflow script (wf-engine.ts) in the background.
 *
 * Exactly one of `script` (inline source), `scriptPath` (a script in a run directory or a workflow
 * directory) or `name` (a registered script workflow), plus `args` and `resumeFromRunId`. The call
 * returns `{runId, scriptPath, transcriptDir}` at once; when the run ends, its result is posted as a
 * `luna-workflow-result` follow-up message that triggers a turn, with the value inside an
 * untrusted-data fence. The firewall asks before every call (policy "ask") and denies it in child
 * sessions; the tool is not registered in children at all.
 *
 * See docs/script-workflows.md; tests/workflow-notify-smoke.ts and tests/workflow-hooks-smoke.ts.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { discoverAgents } from "./agents.ts";
import { isSecretReadPath, untrusted } from "./fence.ts";
import { redact } from "./redact.ts";
import type { ToolContext } from "./types.ts";
import { startScriptRun, scriptRunsRoot, type EngineOptions, type RunOutcome, type ScriptSpec } from "./wf-engine.ts";
import { parseScriptMeta } from "./wf-meta.ts";
import { SandboxSession } from "./wf-sandbox.ts";
import { MAX_SCRIPT_BYTES, discoverWorkflows, workflowDirs } from "./workflow.ts";
import { openScriptWorkflow, trustError } from "./workflow-tools.ts";

export const RESULT_MESSAGE_TYPE = "luna-workflow-result";
/** Longest result text inside the completion message's fence. */
export const RESULT_TEXT_CAP = 20_000;
export const ERROR_TEXT_CAP = 4_000;

function textResult(text: string, isError = false, details?: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], details, ...(isError ? { isError: true } : {}) };
}

function canonical(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

const inside = (child: string, parent: string): boolean => {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
};

/** A script's spec from its source; the meta must be a literal (wf-meta.ts). */
export function specFromSource(source: string, file?: string): { spec: ScriptSpec; error?: undefined } | { spec?: undefined; error: string } {
  if (Buffer.byteLength(source, "utf8") > MAX_SCRIPT_BYTES) return { error: `the script is larger than ${String(MAX_SCRIPT_BYTES)} bytes` };
  const parsed = parseScriptMeta(source);
  if (parsed.error !== undefined) return { error: `the script's meta is invalid: ${parsed.error}` };
  return { spec: { name: parsed.meta.name, description: parsed.meta.description, phases: parsed.meta.phases, source, ...(file ? { file } : {}) } };
}

/**
 * Resolves `scriptPath`. It must be a `.js` file that secret-guard would let the agent read, inside
 * either a script run's directory (<cwd>/.pi/workflows/runs/<runId>/) or a workflow directory. A
 * registered workflow goes through openScriptWorkflow (the project trust gate). A script in a run
 * directory runs as the session's own only when this session created that run and the file's bytes
 * still hash to the script the run was started with (`sessionRuns` maps run id to that SHA-256);
 * any other run script, a rewritten one included, is gated like a project workflow.
 */
export async function resolveScriptPath(ctx: ToolContext, given: string, sessionRuns: ReadonlyMap<string, string>, calledFrom?: string): Promise<{ spec: ScriptSpec; error?: undefined } | { spec?: undefined; error: string }> {
  const cwd = ctx.cwd ?? process.cwd();
  const abs = path.resolve(cwd, given);
  if (isSecretReadPath(abs)) return { error: `Refused: ${given} is a path secret-guard treats as secret.` };
  if (!abs.endsWith(".js")) return { error: `scriptPath must name a .js workflow script (got ${given}).` };
  const real = canonical(abs);
  if (!real) return { error: `scriptPath ${given} does not exist.` };
  if (isSecretReadPath(real)) return { error: `Refused: ${given} resolves to a path secret-guard treats as secret.` };
  const runs = canonical(scriptRunsRoot(cwd));
  if (runs && inside(real, runs)) {
    const runId = path.relative(runs, real).split(path.sep)[0] ?? "";
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(real);
    } catch (error) {
      return { error: `Cannot read ${given}: ${String(error)}` };
    }
    const r = specFromSource(bytes.toString("utf8"), real);
    if (r.error !== undefined) return { error: `${given}: ${r.error}` };
    const digest = crypto.createHash("sha256").update(bytes).digest("hex");
    if (sessionRuns.get(runId) !== digest) {
      const trust = await trustError({ name: r.spec.name, description: r.spec.description, source: "project", file: real }, digest, ctx, calledFrom);
      if (trust) return { error: trust };
    }
    return r;
  }
  for (const { dir } of workflowDirs(cwd)) {
    const realDir = canonical(dir);
    if (!realDir || path.dirname(real) !== realDir) continue;
    const def = discoverWorkflows(cwd).scripts.find((s) => canonical(s.file) === real);
    if (!def) return { error: `${given} is not a registered script workflow (its meta may be invalid, or a later directory overrides its name); see workflow_run {name: "list"}.` };
    const opened = await openScriptWorkflow(ctx, def.name, calledFrom);
    if (opened.error !== undefined) return { error: opened.error };
    return { spec: { name: opened.def.name, description: opened.def.description, phases: opened.def.phases, source: opened.source, file: opened.def.file } };
  }
  return { error: `Refused: scriptPath must be a script in a workflow run directory (${scriptRunsRoot(cwd)}/<runId>/) or in a workflow directory.` };
}

/** The models the session can use, read from the tool context's model registry. */
function availableModelsOf(ctx: unknown): () => Array<{ provider: string; id: string }> {
  return () => {
    const registry: unknown = typeof ctx === "object" && ctx !== null ? Reflect.get(ctx, "modelRegistry") : undefined;
    const get: unknown = typeof registry === "object" && registry !== null ? Reflect.get(registry, "getAvailable") : undefined;
    if (typeof get !== "function") return [];
    let list: unknown;
    try {
      list = Reflect.apply(get, registry, []);
    } catch {
      return [];
    }
    if (!Array.isArray(list)) return [];
    const items: unknown[] = list;
    const out: Array<{ provider: string; id: string }> = [];
    for (const m of items) {
      const provider: unknown = typeof m === "object" && m !== null ? Reflect.get(m, "provider") : undefined;
      const id: unknown = typeof m === "object" && m !== null ? Reflect.get(m, "id") : undefined;
      if (typeof provider === "string" && typeof id === "string") out.push({ provider, id });
    }
    return out;
  };
}

/**
 * The output-token budget ultracode standing mode gives each run (`/effort ultracode --budget N`),
 * read from the effort registry with type guards only; null when standing mode is off or sets none.
 */
export function standingBudget(): number | null {
  try {
    const registry: unknown = Reflect.get(globalThis, Symbol.for("pi-kit.effort"));
    if (typeof registry !== "object" || registry === null) return null;
    const read: unknown = Reflect.get(registry, "standing");
    if (typeof read !== "function") return null;
    const state: unknown = Reflect.apply(read, registry, []);
    if (typeof state !== "object" || state === null || Reflect.get(state, "on") !== true) return null;
    const budget: unknown = Reflect.get(state, "budget");
    return typeof budget === "number" && Number.isSafeInteger(budget) && budget > 0 ? budget : null;
  } catch {
    return null;
  }
}

/** The completion message: status, counts, kept worktrees, paths, and the error and value inside the fence. */
export function formatCompletion(o: RunOutcome): string {
  let valueText: string;
  try {
    valueText = typeof o.value === "string" ? o.value : JSON.stringify(o.value ?? null, null, 2);
  } catch {
    valueText = "(the result could not be shown)";
  }
  const lines = [
    `Workflow ${o.name} (run ${o.runId}) ${o.status}${o.error ? ` (${o.errorKind ?? "error"}); the error text is below.` : "."}`,
    `Agents: ${String(o.launched)} launched, ${String(o.cached)} reused from the journal; ${String(o.outputTokens)} output tokens.`,
    ...o.keptWorktrees.map((w) => `Kept worktree ${w.path} on branch ${w.branch} (${w.reason ?? "changed"}); it is not merged: review it yourself.`),
    `Journal: ${o.journalPath}`,
    `Script: ${o.scriptPath}`,
    ...(o.status === "passed" ? [] : [`Resume with workflow {scriptPath: "${o.scriptPath}", resumeFromRunId: "${o.runId}"}.`]),
  ];
  // The error can carry script or agent text, so it is fenced like the value.
  if (o.error) lines.push("", untrusted("workflow-error", redact(o.error), ERROR_TEXT_CAP));
  if (o.status === "passed") lines.push("", untrusted("workflow-result", redact(valueText), RESULT_TEXT_CAP));
  return lines.join("\n");
}

export interface ScriptToolDeps {
  sandbox?: SandboxSession;
  /** Test seams: engine options laid over the ones the tool builds. */
  engine?: Partial<EngineOptions>;
}

export function registerScriptWorkflowTool(pi: ExtensionAPI, deps: ScriptToolDeps = {}): void {
  if (process.env.PI_KIT_INTERNAL_CHILD === "1") return;
  const sandbox = deps.sandbox ?? new SandboxSession();
  // Run directories this session created, each with the SHA-256 of the script.js the run was started
  // with: that exact script is the session's own to re-run; a rewritten one is trust-gated.
  const sessionRuns = new Map<string, string>();

  pi.registerTool({
    name: "workflow",
    label: "Workflow script",
    description:
      "Run a JavaScript workflow script in the background: deterministic multi-agent orchestration with agent(), parallel(), pipeline(), phase(), log(), args, budget and workflow(). " +
      "Pass exactly one of script (inline source starting with `export const meta = {name, description, phases}`), scriptPath (a script saved by an earlier run, or in a workflow directory) or name (a registered script workflow). " +
      "Returns runId, scriptPath and transcriptDir at once; the result arrives later as a follow-up message. Resume an interrupted run with {scriptPath, resumeFromRunId}; to change the script, pass the edited source as script with resumeFromRunId (a rewritten run script needs the operator's approval). " +
      "Only use it when the user asked for a workflow or multi-agent orchestration.",
    promptSnippet: "Run a JavaScript multi-agent workflow script in the background",
    parameters: Type.Object({
      script: Type.Optional(Type.String({ description: "Inline workflow script (plain JavaScript, starting with export const meta = {...})" })),
      scriptPath: Type.Optional(Type.String({ description: "Path of a workflow script: one an earlier run saved, or one in a workflow directory" })),
      name: Type.Optional(Type.String({ description: "Name of a registered script workflow" })),
      args: Type.Optional(Type.Unknown({ description: "Value passed to the script as `args` (a JSON value, not a JSON-encoded string)" })),
      resumeFromRunId: Type.Optional(Type.String({ description: "Run id whose journal's unchanged prefix of agent() calls is reused" })),
    }),
    async execute(_id, params, _signal, _onUpdate, rawCtx) {
      const ctx: ToolContext = rawCtx;
      const cwd = ctx.cwd ?? process.cwd();
      const given = [params.script, params.scriptPath, params.name].filter((v) => v !== undefined);
      if (given.length !== 1) return textResult("Pass exactly one of script, scriptPath or name.", true);
      let spec: ScriptSpec;
      if (params.script !== undefined) {
        const r = specFromSource(params.script);
        if (r.error !== undefined) return textResult(`workflow: ${r.error}`, true);
        spec = r.spec;
      } else if (params.scriptPath !== undefined) {
        const r = await resolveScriptPath(ctx, params.scriptPath, sessionRuns);
        if (r.error !== undefined) return textResult(r.error, true);
        spec = r.spec;
      } else {
        const opened = await openScriptWorkflow(ctx, params.name ?? "");
        if (opened.error !== undefined) return textResult(opened.error, true);
        spec = { name: opened.def.name, description: opened.def.description, phases: opened.def.phases, source: opened.source, file: opened.def.file };
      }
      const mode = await sandbox.prepare({ hasUI: ctx.hasUI === true, ...(ctx.ui?.select ? { select: ctx.ui.select.bind(ctx.ui) } : {}) });
      if (!mode.ok) return textResult(mode.error, true);
      const budget = standingBudget();
      const started = startScriptRun(spec, params.args, {
        cwd,
        ...(budget !== null ? { budgetTotal: budget } : {}),
        agents: discoverAgents(cwd, "user").agents,
        parentModel: ctx.model?.id ? (ctx.model.provider ? `${ctx.model.provider}/${ctx.model.id}` : ctx.model.id) : undefined,
        availableModels: availableModelsOf(rawCtx),
        sandbox: { mode: mode.mode, support: sandbox.support },
        resolveWorkflow: async (ref, calledFrom) => {
          if (typeof ref === "string") {
            const opened = await openScriptWorkflow(ctx, ref, calledFrom);
            if (opened.error !== undefined) throw new Error(opened.error);
            return { name: opened.def.name, description: opened.def.description, phases: opened.def.phases, source: opened.source, file: opened.def.file };
          }
          const r = await resolveScriptPath(ctx, ref.scriptPath, sessionRuns, calledFrom);
          if (r.error !== undefined) throw new Error(r.error);
          return r.spec;
        },
        ...(params.resumeFromRunId !== undefined ? { resumeFrom: params.resumeFromRunId } : {}),
        ...deps.engine,
      });
      if (!started.ok) return textResult(started.error, true);
      // startScriptRun saved spec.source (UTF-8) as the run's script.js.
      sessionRuns.set(started.runId, crypto.createHash("sha256").update(spec.source, "utf8").digest("hex"));
      void started.done.then((outcome) => {
        const content = formatCompletion(outcome);
        try {
          pi.sendMessage(
            { customType: RESULT_MESSAGE_TYPE, content, display: true, details: { runId: outcome.runId, status: outcome.status, journalPath: outcome.journalPath, scriptPath: outcome.scriptPath } },
            { deliverAs: "followUp", triggerTurn: true },
          );
        } catch {
          try {
            ctx.ui?.notify?.(content, outcome.status === "passed" ? "info" : "warning");
          } catch {
            /* the session is gone */
          }
        }
      });
      const details = { runId: started.runId, scriptPath: started.scriptPath, transcriptDir: started.transcriptDir };
      return textResult(
        [
          `Workflow ${spec.name} started in the background.`,
          `runId: ${started.runId}`,
          `scriptPath: ${started.scriptPath}`,
          `transcriptDir: ${started.transcriptDir}`,
          "The result arrives as a follow-up message when the run ends. workflow_control {runId, action} pauses, resumes, stops or skips it.",
        ].join("\n"),
        false,
        details,
      );
    },
  });
}
