/**
 * Subagent — tool and command registration.
 *
 * Tools:
 *   - `subagent`         dispatch in single / parallel / chain mode
 *   - `subagent_status`  inspect recent runs and tail a run log
 *   - `subagent_stop`    stop running / orphaned children (safety kill switch)
 * Commands:
 *   - `/subagents`       check in on running + recent runs
 *   - `/subagent-stop`   stop one, or all, running children
 *
 * Mode handlers are extracted so `execute` stays a thin router.
 */
import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { discoverAgents, staleProjectRoleCopies, type AgentConfig, type AgentScope } from "./agents.ts";
import { projectRoleDigest, runAgent, mapWithConcurrencyLimit } from "./runner.ts";
import { getFinalOutput, getResultOutput, isFailedResult, substitutePrevious, truncate } from "./result.ts";
import { subagentStateDir } from "./logging.ts";
import { collectRuns, formatRunTable } from "./status.ts";
import { stopAllLive, stopLive, stopRecordedRun, recordStop } from "./live.ts";
import { DEFAULT_CONCURRENCY, DEFAULT_MAX_DEPTH, MAX_DEPTH_CEILING, MAX_PARALLEL_TASKS, envInt, loadInheritParentModel } from "./config.ts";
import type { SingleResult, ToolContext } from "./types.ts";
import { bindWorkflowStatus, workflowStatus } from "./wf-panel.ts";

const TaskItem = Type.Object({
  agent: Type.String({ description: "Name of the agent to invoke" }),
  task: Type.String({ description: "Task to delegate to the agent" }),
  cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
  effort: Type.Optional(Type.String({ description: "Effort tier for this child (minimal|focused|standard|thorough|exhaustive); never above yours" })),
});

const SubagentParams = Type.Object({
  agent: Type.Optional(Type.String({ description: "Agent name (single mode)" })),
  task: Type.Optional(Type.String({ description: "Task (single mode)" })),
  tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
  chain: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} run sequentially; use {previous} in task to inject prior output" })),
  agentScope: Type.Optional(Type.String({ description: 'Role sources beyond the built-in kit roles: "user" (default: ~/.pi/agent/agents), "project" (.pi/agents, needs operator approval), or "both".' })),
  background: Type.Optional(Type.Boolean({ description: "Single/parallel only: return immediately and let the child run in the background; you are notified when it finishes. Use only for long work you do not need in this turn." })),
  confirmProjectAgents: Type.Optional(Type.Boolean({ description: "Deprecated and ignored. Project-local agents always need interactive operator approval or an exact PI_KIT_TRUSTED_PROJECT_ROLES digest grant." })),
  cwd: Type.Optional(Type.String({ description: "Working directory (single mode)" })),
  effort: Type.Optional(Type.String({ description: "Effort tier for the child (single mode); never above yours" })),
});

const SubagentStatusParams = Type.Object({
  limit: Type.Optional(Type.Number({ description: "How many recent runs to list (default 10, max 100)" })),
  id: Type.Optional(Type.String({ description: "Show the tail of one run's log by id" })),
  tail: Type.Optional(Type.Number({ description: "Lines of log to show for id (default 40)" })),
});

const SubagentStopParams = Type.Object({
  id: Type.Optional(Type.String({ description: "Run id to stop" })),
  all: Type.Optional(Type.Boolean({ description: "Stop every running subagent" })),
});

function isValidRunId(id: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(id) && !id.includes("..");
}

// Stop live children (in-process) and recorded orphans (registry pid), or list what is
// running. Shared by the `subagent_stop` tool and the `/subagent-stop` command.
function stopTargets(dir: string, target: string | undefined): { text: string; ok: boolean } {
  const rows = collectRuns(dir);
  const running = rows.filter((r) => r.status === "running");
  if (!target) {
    return {
      text: running.length
        ? `Running subagents (${running.length}):\n\n${formatRunTable(running)}\n\nStop one with /subagent-stop <id>, or all with /subagent-stop all.`
        : "No running subagents.",
      ok: true,
    };
  }
  if (target === "all") {
    const liveCount = stopAllLive();
    let orphanCount = 0;
    for (const r of running) {
      if (!r.live && r.pid && stopRecordedRun(r.pid)) {
        recordStop(dir, r.id);
        orphanCount++;
      }
    }
    return { text: `Stopped ${liveCount} live and ${orphanCount} orphaned subagent(s).`, ok: true };
  }
  if (!isValidRunId(target)) return { text: "Invalid run id.", ok: false };
  const row = rows.find((r) => r.id === target);
  if (!row) return { text: `No run "${target}".`, ok: false };
  if (row.end) return { text: `Run "${target}" already finished (${row.status}).`, ok: true };
  if (stopLive(target)) return { text: `Stop sent to running subagent ${target}.`, ok: true };
  if (row.pid && stopRecordedRun(row.pid)) {
    recordStop(dir, target);
    return { text: `Stop sent to orphaned subagent ${target} (pid ${row.pid}).`, ok: true };
  }
  return { text: `Could not stop ${target}: no live handle and no killable pid.`, ok: false };
}

function textResult(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], details: undefined, ...(isError ? { isError: true } : {}) };
}

// Wrap onUpdate so a run also drives a persistent footer status. The footer is the only
// TUI surface that shows a child is alive during a long tool call, when onUpdate text alone
// scrolls past; it is cleared when the delegation finishes.
// Once the tool call returns, `close()` stops the reporter: a background/detached child keeps
// streaming, and without the guard it re-set the footer after clearStatus, leaving a stale
// "subagent …" line that never cleared.
function makeReporter(ctx: ToolContext, onUpdate: ((update: { content: Array<{ type: "text"; text: string }>; details: undefined }) => void) | undefined) {
  let last = "";
  let closed = false;
  const report = (text: string) => {
    if (closed) return;
    try {
      onUpdate?.({ content: [{ type: "text" as const, text }], details: undefined });
    } catch {
      /* best effort */
    }
    if (text === last) return;
    last = text;
    try {
      ctx.ui?.setStatus?.("subagent", text);
    } catch {
      /* best effort */
    }
  };
  report.close = () => {
    closed = true;
  };
  return report;
}

function clearStatus(ctx: ToolContext): void {
  try {
    ctx.ui?.setStatus?.("subagent", undefined);
  } catch {
    /* best effort */
  }
}

function logSuffix(result: SingleResult): string {
  const attempts = result.attempts && result.attempts > 1 ? ` (after ${result.attempts} attempts)` : "";
  return result.logPath ? `\n\n_log: \`${result.logPath}\`_${attempts}` : "";
}

// When a detached/background child finishes, tell both the operator (notify) and the agent
// (a session message carrying the result), so background work is never silently forgotten and
// the agent can use the answer on its next turn.
function settledNotifier(pi: ExtensionAPI, ctx: ToolContext) {
  return (result: SingleResult, detached: boolean) => {
    if (!detached) return;
    const failed = isFailedResult(result);
    const summary = `[subagent] ${result.agent} ${failed ? `failed (${result.stopReason ?? "error"})` : "finished"} in the background (run ${result.runId ?? "?"})`;
    try {
      ctx.ui?.notify?.(`${summary} — log: ${result.logPath ?? "?"}`, failed ? "warning" : "info");
    } catch {
      /* the session may have ended */
    }
    try {
      pi.sendMessage(
        { customType: "subagent-result", content: `${summary}\n\n${truncate(getResultOutput({ ...result, detached: false }))}${logSuffix(result)}`, display: true },
        { deliverAs: "followUp", triggerTurn: false },
      );
    } catch {
      /* best effort */
    }
  };
}

// "provider/id" of the active parent model, used unless per-role model frontmatter is opted into.
function resolveParentModel(ctx: ToolContext): string | undefined {
  const parent = ctx.model;
  if (typeof parent?.id !== "string" || !parent.id.trim()) return undefined;
  return typeof parent.provider === "string" && parent.provider.trim() ? `${parent.provider}/${parent.id}` : parent.id;
}

// Nesting guard for a child that itself calls `subagent`.
function nestingError(): string | null {
  const depth = envInt("PI_KIT_SUBAGENT_DEPTH", 0, 0, MAX_DEPTH_CEILING);
  const maxDepth = envInt("PI_KIT_SUBAGENT_MAX_DEPTH", DEFAULT_MAX_DEPTH, 0, MAX_DEPTH_CEILING);
  if (depth < maxDepth) return null;
  return `Subagent nesting limit reached (depth ${depth}/${maxDepth}). Raise PI_KIT_SUBAGENT_MAX_DEPTH to allow deeper delegation, or do this step directly.`;
}

// Project-local roles are untrusted until the operator approves them (interactively) or an
// exact content digest is pre-granted via PI_KIT_TRUSTED_PROJECT_ROLES.
async function projectTrustError(
  agents: AgentConfig[],
  projectAgentsDir: string | null,
  params: Record<string, unknown>,
  ctx: ToolContext,
): Promise<string | null> {
  const requested = new Set<string>();
  if (Array.isArray(params.chain)) for (const s of params.chain as Array<{ agent: string }>) requested.add(s.agent);
  if (Array.isArray(params.tasks)) for (const t of params.tasks as Array<{ agent: string }>) requested.add(t.agent);
  if (typeof params.agent === "string") requested.add(params.agent);
  const trusted = (process.env.PI_KIT_TRUSTED_PROJECT_ROLES ?? "").split(";");
  const projectRequested = Array.from(requested)
    .map((name) => agents.find((a) => a.name === name))
    .filter((a): a is AgentConfig => a?.source === "project")
    .filter((a) => !trusted.includes(projectRoleDigest(a)));
  if (projectRequested.length === 0) return null;
  if (!ctx.hasUI || !ctx.ui?.confirm) return "Blocked: project-local agents require interactive operator approval.";
  const ok = await ctx.ui.confirm(
    "Run project-local agents?",
    `Agents: ${projectRequested.map((a) => a.name).join(", ")}\nSource: ${projectAgentsDir ?? "(unknown)"}\n\nOnly continue for trusted repositories.`,
  );
  return ok ? null : "Canceled: project-local agents not approved.";
}

async function runChainMode(
  pi: ExtensionAPI,
  chain: Array<{ agent: string; task: string; cwd?: string; effort?: string }>,
  ctx: ToolContext,
  agents: AgentConfig[],
  signal: AbortSignal | undefined,
  reportUpdate: (text: string) => void,
  parentModel: string | undefined,
  inheritParentModel: boolean,
) {
  let previous = "";
  for (const [i, step] of chain.entries()) {
    const task = substitutePrevious(step.task, previous);
    const r = await runAgent({ defaultCwd: ctx.cwd ?? process.cwd(), agents, agentName: step.agent, task, cwd: step.cwd, step: i + 1, signal, overrides: step.effort ? { effort: step.effort } : undefined, onUpdate: reportUpdate, onSettled: settledNotifier(pi, ctx), parentModel, inheritParentModel });
    if (r.detached) {
      return textResult(`Chain detached at step ${i + 1} (${step.agent}): running in the background (run ${r.runId ?? "?"}). Follow it with subagent_status id=${r.runId ?? "<run>"}.`);
    }
    if (isFailedResult(r)) {
      return textResult(`Chain stopped at step ${i + 1} (${step.agent}): ${getResultOutput(r)}${logSuffix(r)}`, true);
    }
    previous = r.finalOutput || getFinalOutput(r.messages);
  }
  // `previous` holds the last step's output (finalOutput, else its final message text).
  return textResult(previous || "(no output)");
}

async function runParallelMode(
  pi: ExtensionAPI,
  tasks: Array<{ agent: string; task: string; cwd?: string; effort?: string }>,
  ctx: ToolContext,
  agents: AgentConfig[],
  signal: AbortSignal | undefined,
  reportUpdate: (text: string) => void,
  parentModel: string | undefined,
  inheritParentModel: boolean,
  background: boolean,
) {
  if (tasks.length > MAX_PARALLEL_TASKS) {
    return textResult(`Too many parallel tasks (${tasks.length}). Max ${MAX_PARALLEL_TASKS}.`, true);
  }
  const concurrency = envInt("PI_KIT_SUBAGENT_CONCURRENCY", DEFAULT_CONCURRENCY, 1, MAX_PARALLEL_TASKS);
  // Background tasks all launch at once (each returns immediately); the concurrency limit only
  // bounds tasks the parent actually waits on.
  const results = await mapWithConcurrencyLimit(tasks, background ? tasks.length : concurrency, (t) =>
    runAgent({ defaultCwd: ctx.cwd ?? process.cwd(), agents, agentName: t.agent, task: t.task, cwd: t.cwd, signal, overrides: t.effort ? { effort: t.effort } : undefined, onUpdate: reportUpdate, onSettled: settledNotifier(pi, ctx), parentModel, inheritParentModel, background }),
  );
  const detachedCount = results.filter((r) => r.detached).length;
  const successCount = results.filter((r) => !r.detached && !isFailedResult(r)).length;
  const summaries = results.map((r) => {
    const status = r.detached ? `detached (running, run ${r.runId ?? "?"})` : isFailedResult(r) ? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}` : "completed";
    return `### [${r.agent}] ${status}\n\n${truncate(getResultOutput(r))}${logSuffix(r)}`;
  });
  const header = `Parallel: ${successCount}/${results.length} succeeded${detachedCount ? `, ${detachedCount} running in the background` : ""}`;
  return textResult(`${header}\n\n${summaries.join("\n\n---\n\n")}`, successCount === 0 && detachedCount === 0);
}

export function registerSubagentTools(pi: ExtensionAPI): void {
  // Tell the operator once when project copies of the kit roles differ from the built-ins: with
  // agentScope "project"/"both" they shadow the maintained kit roles. Identical copies are not
  // reported, so the listed names are exactly the customised/drifted files.
  pi.on("session_start", async (_event, rawCtx) => {
    const ctx: ToolContext = rawCtx;
    if (process.env.PI_KIT_INTERNAL_CHILD === "1" || !ctx.hasUI) return;
    // The /workflows status line reports to this session's footer.
    bindWorkflowStatus(ctx);
    const stale = staleProjectRoleCopies(ctx.cwd ?? process.cwd());
    if (stale.length) {
      ctx.ui?.notify?.(
        `subagent: .pi/agents has copies of built-in roles that differ from the kit versions (${stale.join(", ")}). Built-in kit roles are used by default; these copies only override them with agentScope "project"/"both" — delete them unless you customised them on purpose.`,
        "info",
      );
    }
  });
  // A session ending must not leave its children running unattended.
  pi.on("session_shutdown", async () => {
    stopAllLive();
    workflowStatus.unbind();
  });

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description:
      "Delegate tasks to specialized subagents with isolated context. Modes: single (agent+task), " +
      "parallel (tasks array), chain (sequential with {previous} placeholder). Built-in roles: scout, " +
      "planner, implementer, reviewer, delegator (plus ~/.pi/agent/agents). A subagent cannot see this " +
      "conversation: make each task self-contained. Esc cancels running subagents; background: true " +
      "detaches long work. Only a delegator role may delegate further (depth limit PI_KIT_SUBAGENT_MAX_DEPTH, default 2).",
    promptSnippet: "Delegate a task to a planner/implementer/reviewer subagent (single, parallel, or chain)",
    parameters: SubagentParams,

    async execute(_toolCallId, params, signal, onUpdate, rawCtx) {
      const ctx: ToolContext = rawCtx;
      const reportUpdate = makeReporter(ctx, onUpdate);
      const parentModel = resolveParentModel(ctx);
      const inheritParentModel = loadInheritParentModel();
      const background = params.background === true;

      const nesting = nestingError();
      if (nesting) return textResult(nesting, true);

      const scope = (params.agentScope as AgentScope) ?? "user";
      const discovery = discoverAgents(ctx.cwd ?? process.cwd(), scope);
      const agents = discovery.agents;

      const hasChain = (params.chain?.length ?? 0) > 0;
      const hasTasks = (params.tasks?.length ?? 0) > 0;
      const hasSingle = Boolean(params.agent && params.task);
      const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);
      const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
      if (modeCount !== 1) {
        return textResult(`Provide exactly one mode (agent+task, tasks, or chain).\nAvailable agents: ${available}`, true);
      }
      if (background && hasChain) {
        return textResult("background is not supported for chain mode (each step needs the previous step's output). Run the chain in the foreground, or background single/parallel tasks.", true);
      }

      if (scope === "project" || scope === "both") {
        const trustError = await projectTrustError(agents, discovery.projectAgentsDir, params, ctx);
        if (trustError) return textResult(trustError, trustError.startsWith("Blocked"));
      }

      try {
        if (params.chain && params.chain.length > 0) {
          return await runChainMode(pi, params.chain, ctx, agents, signal, reportUpdate, parentModel, inheritParentModel);
        }
        if (params.tasks && params.tasks.length > 0) {
          return await runParallelMode(pi, params.tasks, ctx, agents, signal, reportUpdate, parentModel, inheritParentModel, background);
        }
        const r = await runAgent({ defaultCwd: ctx.cwd ?? process.cwd(), agents, agentName: params.agent as string, task: params.task as string, cwd: params.cwd, signal, overrides: params.effort ? { effort: params.effort } : undefined, onUpdate: reportUpdate, onSettled: settledNotifier(pi, ctx), parentModel, inheritParentModel, background });
        if (r.detached) {
          return textResult(`Subagent ${r.agent} running in the background (detached). run: ${r.runId ?? "?"}\nFollow with subagent_status id=${r.runId ?? "<run>"}; stop with subagent_stop id=${r.runId ?? "<run>"}.`);
        }
        if (isFailedResult(r)) {
          return textResult(`Agent ${r.stopReason || "failed"}: ${getResultOutput(r)}${logSuffix(r)}`, true);
        }
        return textResult(r.finalOutput || getFinalOutput(r.messages) || "(no output)");
      } finally {
        reportUpdate.close();
        clearStatus(ctx);
      }
    },
  });

  pi.registerTool({
    name: "subagent_status",
    label: "Subagent status",
    description:
      "List recent subagent runs (status, agent, duration, log path) from .pi/subagent/runs.jsonl, or tail one run's log. " +
      "Use this to see live progress (`tail -f` the log path) and to recover results after a child was killed or a parent abort.",
    promptSnippet: "Inspect recent subagent runs and their logs",
    parameters: SubagentStatusParams,
    async execute(_toolCallId, params, _signal, _onUpdate, rawCtx) {
      const ctx: ToolContext = rawCtx;
      const dir = subagentStateDir(ctx.cwd ?? process.cwd());
      if (params.id) {
        const id = params.id;
        // The id is model-supplied and is joined into a filesystem path; reject anything
        // that could traverse out of the state dir before reading.
        if (!isValidRunId(id)) return textResult("Invalid run id.", true);
        const logPath = path.join(dir, `${id}.log`);
        if (!fs.existsSync(logPath)) return textResult(`No log for run "${id}" under ${dir}.`, true);
        const lines = fs.readFileSync(logPath, "utf8").split(/\r?\n/);
        const tail = Math.max(1, Math.min(Number(params.tail) || 40, 1000));
        return textResult(`## ${id}\n\n\`\`\`\n${lines.slice(-tail).join("\n")}\n\`\`\``);
      }
      const runs = collectRuns(dir);
      if (runs.length === 0) return textResult(`No subagent runs recorded under ${dir}.`);
      const limit = Math.max(1, Math.min(Number(params.limit) || 10, 100));
      const running = runs.filter((r) => r.status === "running").length;
      return textResult(`Recent subagent runs (${runs.length}, ${running} running):\n\n${formatRunTable(runs, limit)}\n\nUse \`subagent_status id=<run>\` to tail a log.`);
    },
  });

  pi.registerTool({
    name: "subagent_stop",
    label: "Subagent stop",
    description:
      "Safety kill switch for subagents. With no id and all unset, lists running runs; with id, stops that run; " +
      "with all=true, stops every running run. Stops in-process children and orphaned children recorded in the run registry.",
    promptSnippet: "Stop running subagents",
    parameters: SubagentStopParams,
    async execute(_toolCallId, params, _signal, _onUpdate, rawCtx) {
      const ctx: ToolContext = rawCtx;
      const dir = subagentStateDir(ctx.cwd ?? process.cwd());
      const target = params.all ? "all" : params.id ? params.id : undefined;
      const result = stopTargets(dir, target);
      return textResult(result.text, !result.ok);
    },
  });

  pi.registerCommand("subagents", {
    description: "Check in on subagents: running and recent runs with log paths. /subagents [limit]",
    handler: async (args, rawCtx) => {
      const ctx: ToolContext = rawCtx;
      const dir = subagentStateDir(ctx.cwd ?? process.cwd());
      const rows = collectRuns(dir);
      const running = rows.filter((r) => r.status === "running").length;
      const limit = Math.max(1, Math.min(Number((args ?? "").trim()) || 20, 100));
      const body = rows.length
        ? `${running} running, ${rows.length} total\n\n${formatRunTable(rows, limit)}\n\n/subagent-stop <id|all> to stop`
        : "No subagent runs recorded.";
      ctx.ui?.notify?.(`subagents\n\n${body}`, "info");
    },
  });

  pi.registerCommand("subagent-stop", {
    description: "Stop running subagents (safety). /subagent-stop [<id>|all]; no args lists running runs.",
    handler: async (args, rawCtx) => {
      const ctx: ToolContext = rawCtx;
      const dir = subagentStateDir(ctx.cwd ?? process.cwd());
      const target = (args ?? "").trim() || undefined;
      if (target === "all" && ctx.ui?.confirm) {
        const running = collectRuns(dir).filter((r) => r.status === "running").length;
        const ok = await ctx.ui.confirm("Stop all subagents?", `This terminates ${running} running subagent(s).`);
        if (!ok) {
          ctx.ui?.notify?.("Cancelled.", "info");
          return;
        }
      }
      const result = stopTargets(dir, target);
      ctx.ui?.notify?.(result.text, result.ok ? "info" : "error");
    },
  });
}
