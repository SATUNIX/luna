/**
 * Subagent — running one isolated agent child.
 *
 * Builds the child argv/env, creates the run log, streams the child, and maps the outcome
 * onto a `SingleResult`. `runAgent` takes an options object; `runSingleAgent` is the
 * positional wrapper kept for existing callers and tests.
 *
 * A run is one logical unit with one log/registry entry, but it may make more than one
 * attempt: a *transient* failure (spawn failure, or a non-zero exit with no usable output)
 * is retried up to PI_KIT_SUBAGENT_RETRIES times. Usage is summed across attempts.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runChildProcess } from "./child-process.ts";
import { boundMessage, classifyFailure, isFailedResult, isMsg } from "./result.ts";
import { createRunLog, subagentStateDir } from "./logging.ts";
import { noteFinished, registerLive, unregisterLive } from "./live.ts";
import { isReadOnlyRole, isScoutRole, prepareChildLaunch, readOnlyTools } from "./launch.ts";
import { skillPreamble } from "./skills.ts";
import { OUTPUT_FIELD, SCHEMA_ENV, STRUCTURED_TOOL, StructuredSchemaError, checkSchema, readStructured } from "./structured-output/check.ts";
import {
  DEFAULT_CHILD_APPROVAL_TIMEOUT_MS,
  DEFAULT_CHILD_STREAM_CAP,
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_MAX_RUNTIME_MS,
  DEFAULT_RETRIES,
  LOG_SKIP_EVENT_TYPES,
  MAX_DEPTH_CEILING,
  MAX_STORED_MESSAGES,
  RETRY_BACKOFF_MS,
  envFlag,
  envInt,
  isRecord,
  toText,
} from "./config.ts";
import type { AgentConfig, SingleResult, SpawnChild, UsageStats } from "./types.ts";

// Operator-owned exact-role grants include the complete role definition, including its
// optional model frontmatter. The execution policy decides whether it is used.
export function projectRoleDigest(agent: AgentConfig): string {
  return crypto.createHash("sha256").update(JSON.stringify({ name: agent.name, systemPrompt: agent.systemPrompt, tools: agent.tools ?? [], model: agent.model ?? "" })).digest("hex");
}

export async function mapWithConcurrencyLimit<TIn, TOut>(
  items: TIn[],
  concurrency: number,
  fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results: TOut[] = new Array<TOut>(items.length);
  // One iterator shared by every worker: each pull hands out the next unclaimed index.
  const queue = items.entries();
  const workers = new Array(limit).fill(null).map(async () => {
    for (const [current, item] of queue) results[current] = await fn(item, current);
  });
  await Promise.all(workers);
  return results;
}

function writePromptTempFile(agentName: string, prompt: string): { dir: string; filePath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
  const safeName = agentName.replace(/[^\w.-]+/g, "_");
  const filePath = path.join(dir, `prompt-${safeName}.md`);
  fs.writeFileSync(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
  return { dir, filePath };
}

function emptyUsage(): UsageStats {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

function addUsage(target: UsageStats, other: UsageStats): void {
  target.input += other.input;
  target.output += other.output;
  target.cacheRead += other.cacheRead;
  target.cacheWrite += other.cacheWrite;
  target.cost += other.cost;
  target.turns += other.turns;
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  // Deliberately NOT unref'd: between attempts there is no child keeping the event loop
  // alive, so an unref'd timer would let the process exit mid-retry.
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface RunAgentOptions {
  defaultCwd: string;
  agents: AgentConfig[];
  agentName: string;
  task: string;
  cwd?: string | undefined;
  step?: number | undefined;
  signal?: AbortSignal | undefined;
  // onUpdate is invoked once per streamed child message so the parent sees a live
  // "still working" signal instead of a silent tool call until the child closes.
  onUpdate?: ((text: string) => void) | undefined;
  // onUsage receives a copy of the attempt's running usage and model after each assistant
  // message, so workflow telemetry can show tokens while the child still works.
  onUsage?: ((usage: UsageStats, model: string | undefined) => void) | undefined;
  // onSettled fires once when the run is completely done. `detached` is true when the
  // parent's signal had already aborted, i.e. the parent is no longer waiting on the
  // result — used to notify the operator that a detached child finished.
  onSettled?: ((result: SingleResult, detached: boolean) => void) | undefined;
  spawnChild?: SpawnChild | undefined;
  parentModel?: string | undefined;
  // Force every child onto the parent model, ignoring role `model:` frontmatter.
  inheritParentModel?: boolean | undefined;
  // Return immediately with a "detached" result; the child runs on and onSettled reports it.
  background?: boolean | undefined;
  // Per-call overrides (workflow steps), applied over the role definition.
  overrides?: RunOverrides | undefined;
  // "discretionary" (default): the agent's own delegation, bounded by the effort tier.
  // "user": a launch the person typed (a /workflow command), bounded only by the platform ceilings.
  // "workflow": an agent of a script-workflow run, charged to the run's pinned scope (`workflowRun`).
  launchKind?: "discretionary" | "user" | "workflow" | undefined;
  // Workflow launches only: the run id and run token from effort's openRunScope. Such a child never
  // delegates further: it gets no subagent tool or extension and its nesting limit is its own depth.
  workflowRun?: { runId: string; runToken: string } | undefined;
  // A JSON result schema. The child gets the StructuredOutput tool and the host validates what it
  // submitted (see structured-output/). An invalid schema makes runAgent reject before any launch.
  schema?: unknown;
}

// The child-only extension that registers StructuredOutput; a fixed path inside this extension.
const STRUCTURED_EXTENSION = fileURLToPath(new URL("./structured-output/index.ts", import.meta.url));

function structuredPrompt(): string {
  return `When your work is done, return the result by calling the ${STRUCTURED_TOOL} tool once with {"${OUTPUT_FIELD}": <result>}, where <result> matches the schema of its "${OUTPUT_FIELD}" parameter. Only that call counts as your result; text you write is not read. If the call is rejected, fix what it lists and call it again.`;
}

function structuredRetryNote(errors: readonly string[]): string {
  const shown = errors.slice(0, 20).map((e) => `- ${e}`).join("\n");
  return `\n\nA previous attempt at this task did not return a valid result through ${STRUCTURED_TOOL}:\n${shown || "- it never called the tool"}\nThis is the last attempt: call ${STRUCTURED_TOOL} with a result that matches the schema.`;
}

export interface RunOverrides {
  model?: string | undefined;
  thinking?: string | undefined;
  tools?: string[] | undefined;
  skills?: string[] | undefined;
  // Extra kit extensions for the isolated child (e.g. memory-vault for memory_save).
  extensions?: string[] | undefined;
  maxRuntimeMs?: number | undefined;
  // Requested effort tier for the child; clamped to the parent's tier.
  effort?: string | undefined;
  // Appended to the role's system prompt (e.g. workflow blackboard conventions).
  appendSystemPrompt?: string | undefined;
}

export async function runAgent(options: RunAgentOptions): Promise<SingleResult> {
  const {
    defaultCwd,
    agents,
    agentName,
    task,
    cwd,
    step,
    signal,
    onUpdate,
    onUsage,
    onSettled,
    spawnChild,
    parentModel,
    inheritParentModel = false,
    background = false,
    overrides = {},
    launchKind = "discretionary",
    workflowRun,
    schema,
  } = options;

  // Checked before anything else (no log, no launch): a bad schema is the caller's error.
  const structured = schema !== undefined;
  if (structured) {
    const problems = checkSchema(schema);
    if (problems.length > 0) throw new StructuredSchemaError(problems);
  }

  // Deeper children receive PI_KIT_SUBAGENT_DEPTH+1; the tool layer refuses to spawn once
  // depth reaches PI_KIT_SUBAGENT_MAX_DEPTH.
  const childDepth = envInt("PI_KIT_SUBAGENT_DEPTH", 0, 0, MAX_DEPTH_CEILING) + 1;
  // Esc / a parent cancel stops the child: an interrupted delegation must not keep spending
  // tokens invisibly, and a chain must not be silently truncated behind a "detached" result.
  // Long work that should outlive the turn is requested explicitly with `background: true`.
  // PI_KIT_SUBAGENT_DETACH_SIGNAL=1 restores the old detach-on-cancel behaviour.
  const detachOnAbort = envFlag("PI_KIT_SUBAGENT_DETACH_SIGNAL", false);
  const abortSignal = background || detachOnAbort ? undefined : signal;

  const early: SingleResult = {
    agent: agentName,
    task,
    exitCode: 0,
    messages: [],
    stderr: "",
    usage: emptyUsage(),
    step,
  };
  if (abortSignal?.aborted) {
    return { ...early, exitCode: 1, stopReason: "aborted", errorMessage: "Subagent was aborted before launch" };
  }

  const agent = agents.find((a) => a.name === agentName);
  if (!agent) {
    const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
    return { ...early, exitCode: 1, stderr: `Unknown agent: "${agentName}". Available: ${available}.` };
  }

  // Model: an explicit per-call override, else the role's `model:` frontmatter, else the active
  // parent model. PI_KIT_SUBAGENT_INHERIT_MODEL=1 forces the parent model for every role.
  const selectedModel = overrides.model ?? (inheritParentModel ? parentModel : agent.model ?? parentModel);
  const thinking = overrides.thinking ?? agent.thinking;
  const workflowLaunch = launchKind === "workflow";
  const listed = overrides.tools ?? agent.tools;
  const tools = workflowLaunch && listed ? listed.filter((t) => t !== "subagent") : listed;
  // An empty tool list means "every tool", so a role left with none is refused rather than widened.
  if (listed && listed.length > 0 && tools?.length === 0) {
    return { ...early, exitCode: 1, stopReason: "denied", errorMessage: `Subagent not started: role "${agentName}" has no tool a workflow agent may use (workflow agents cannot delegate)`, deniedCode: "no-tools" };
  }
  const childCwd = cwd ?? defaultCwd;
  const baseArgs: string[] = ["--mode", "json", "-p", "--no-session"];
  if (selectedModel) baseArgs.push("--model", selectedModel);
  if (thinking) baseArgs.push("--thinking", thinking);
  if (tools && tools.length > 0) baseArgs.push("--tools", tools.join(","));
  // The extension arguments and environment come from delegation-guard per attempt (below): every
  // attempt is a new child execution, so it reserves against the effort budget again.

  const skills = [...new Set([...(agent.skills ?? []), ...(overrides.skills ?? [])])];
  const preload = skillPreamble(skills, childCwd);
  const systemPrompt = `${agent.systemPrompt.trim()}${preload.text}${overrides.appendSystemPrompt ? `\n\n${overrides.appendSystemPrompt.trim()}` : ""}${structured ? `\n\n${structuredPrompt()}` : ""}`;

  const runLog = createRunLog(defaultCwd, agentName, task, childDepth - 1);
  runLog.write(`# model=${selectedModel ?? "(parent default)"}${thinking ? ` thinking=${thinking}` : ""}`);
  if (skills.length) runLog.write(`# skills=${skills.join(",")}${preload.missing.length ? ` missing=${preload.missing.join(",")}` : ""}`);

  const streamCap = envInt("PI_KIT_SUBAGENT_STREAM_CAP_BYTES", DEFAULT_CHILD_STREAM_CAP, 64 * 1024, Number.MAX_SAFE_INTEGER);
  const idleTimeoutMs = envInt("PI_KIT_SUBAGENT_IDLE_TIMEOUT_MS", DEFAULT_IDLE_TIMEOUT_MS, 0, Number.MAX_SAFE_INTEGER);
  const maxRuntimeMs = overrides.maxRuntimeMs ?? agent.maxRuntimeMs ?? envInt("PI_KIT_SUBAGENT_MAX_RUNTIME_MS", DEFAULT_MAX_RUNTIME_MS, 0, Number.MAX_SAFE_INTEGER);
  const heartbeatMs = envInt("PI_KIT_SUBAGENT_HEARTBEAT_MS", DEFAULT_HEARTBEAT_MS, 0, Number.MAX_SAFE_INTEGER);
  const maxAttempts = 1 + envInt("PI_KIT_SUBAGENT_RETRIES", DEFAULT_RETRIES, 0, 5);
  const retryBackoffMs = envInt("PI_KIT_SUBAGENT_RETRY_BACKOFF_MS", RETRY_BACKOFF_MS, 0, 60000);

  const runAttempt = async (note = ""): Promise<SingleResult> => {
    const result: SingleResult = {
      agent: agentName,
      task,
      exitCode: 0,
      messages: [],
      stderr: "",
      usage: emptyUsage(),
      step,
      logPath: runLog.logPath,
      runId: runLog.id,
      model: selectedModel,
    };
    // Reserve the launch: mandatory protections, effort budget and the child's environment.
    // Refused launches never spawn and are never retried.
    const prepared = prepareChildLaunch({
      cwd: childCwd,
      kind: launchKind,
      role: agentName,
      scout: isScoutRole(agent),
      readOnly: isReadOnlyRole(agent, tools),
      readOnlyTools: readOnlyTools(agent, tools),
      requestedTier: overrides.effort ?? agent.effort,
      extraExtensions: [...(agent.extensions ?? []), ...(overrides.extensions ?? [])].filter((e) => !workflowLaunch || e !== "subagent"),
      needsSubagent: !workflowLaunch && (tools?.includes("subagent") ?? false),
      baseEnv: { ...process.env },
      ...(workflowRun ? { runId: workflowRun.runId, runToken: workflowRun.runToken } : {}),
    });
    if (!prepared.ok) {
      runLog.write(`# launch refused (${prepared.code}): ${prepared.reason}`);
      return { ...result, exitCode: 1, stopReason: "denied", errorMessage: `Subagent not started: ${prepared.reason}`, deniedCode: prepared.code };
    }
    runLog.write(`# extensions=${prepared.loaded.join(",")} tier=${prepared.childTier}${prepared.slot.id ? ` slot=${prepared.slot.id}` : ""}`);
    // A recovery launch of a role that is not read-only (a scout with bash) runs with only its read tools.
    const narrowed = prepared.tools;
    if (narrowed) runLog.write(`# recovery launch: tools narrowed to ${narrowed.join(",")}`);
    const args = [...(narrowed ? baseArgs.map((arg, i) => (baseArgs[i - 1] === "--tools" ? narrowed.join(",") : arg)) : baseArgs), ...prepared.args];
    // A structured run adds the child-only extension and, when the tool list is an allowlist, its tool.
    // This happens after the launch was classified, so the extra tool never changes the charge.
    if (structured) {
      const at = args.indexOf("--tools");
      if (at >= 0 && args[at + 1] !== undefined) args[at + 1] = `${args[at + 1]},${STRUCTURED_TOOL}`;
      args.push("-e", STRUCTURED_EXTENSION);
    }
    // StructuredOutput calls seen on the child's event stream, by tool call id, and the last one
    // the child finished without an error. Only the arguments are kept; the host re-validates them.
    const structuredCalls = new Map<string, unknown>();
    let submitted: { args: unknown } | undefined;
    let outcomeLabel = "error";
    let tmpDir: string | null = null;
    let tmpPath: string | null = null;
    let schemaPath: string | null = null;
    const startedAt = Date.now();
    let lastTool: string | undefined;
    let lastTarget: string | undefined;

    const shortTarget = (value: string) => (value.length > 48 ? "…" + value.slice(-45) : value);
    const toolTarget = (input: unknown): string | undefined => {
      if (!input || typeof input !== "object") return undefined;
      const o = input as Record<string, unknown>;
      const cand = o.path ?? o.file_path ?? o.filePath ?? o.file ?? o.pattern ?? o.command ?? o.query;
      return typeof cand === "string" ? shortTarget(cand) : undefined;
    };
    const updateText = (suffix: string) => {
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      const tool = lastTool ? ` · last ${lastTool}${lastTarget ? ` ${lastTarget}` : ""}` : "";
      return `[${agentName}]${step ? ` step ${step}` : ""} ${suffix} · ${elapsed}s${tool} · ${result.usage.turns} turn(s) · run ${runLog.id}`;
    };

    const processLine = (line: string) => {
      if (!line.trim()) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        runLog.write(`[unparsed] ${line.slice(0, 300)}`);
        return;
      }
      // The child's JSON is outside data: read only checked fields from it.
      const event = isRecord(parsed) ? parsed : {};
      const toolName = typeof event.toolName === "string" ? event.toolName : undefined;
      const message = isMsg(event.message) ? event.message : undefined;
      // Skip per-token deltas; message_end carries the full content and tool_* events show
      // the actions, so the log stays readable and small.
      const type = toText(event.type ?? "");
      if (!LOG_SKIP_EVENT_TYPES.has(type)) runLog.write(line);

      // Current pi emits tool_execution_start/end (not tool_result_end). These are the most
      // useful live "what is the child doing right now" signals — without them the parent
      // tool call looked frozen during a long child tool, which is the reported stall.
      if (structured && toolName === STRUCTURED_TOOL && typeof event.toolCallId === "string") {
        if (type === "tool_execution_start") structuredCalls.set(event.toolCallId, event.args);
        else if (type === "tool_execution_end" && event.isError === false && structuredCalls.has(event.toolCallId)) submitted = { args: structuredCalls.get(event.toolCallId) };
      }
      if (type === "tool_execution_start") {
        lastTool = toolName;
        lastTarget = toolTarget(event.args);
        onUpdate?.(updateText(`running ${toolName ?? "tool"}`));
        return;
      }
      if (type === "tool_execution_end") {
        onUpdate?.(updateText(`finished ${toolName ?? "tool"}`));
        return;
      }

      if ((type === "message_end" || type === "tool_result_end") && message) {
        const msg = message;
        // Bound memory: keep only the most recent messages (final answer is kept separately).
        if (result.messages.length >= MAX_STORED_MESSAGES) result.messages.shift();
        result.messages.push(boundMessage(msg));
        if (msg.role === "assistant") {
          result.usage.turns++;
          const u = msg.usage;
          if (u) {
            result.usage.input += u.input || 0;
            result.usage.output += u.output || 0;
            result.usage.cacheRead += u.cacheRead || 0;
            result.usage.cacheWrite += u.cacheWrite || 0;
            result.usage.cost += u.cost?.total || 0;
          }
          if (!result.model && msg.model) result.model = msg.model;
          if (msg.stopReason) result.stopReason = msg.stopReason;
          if (msg.errorMessage) result.errorMessage = msg.errorMessage;
          const assistantText = (Array.isArray(msg.content) ? msg.content : []).filter((part) => part.type === "text" && part.text).map((part) => part.text as string).join("\n");
          if (assistantText) result.finalOutput = assistantText;
          onUsage?.({ ...result.usage }, result.model);
        }
        onUpdate?.(updateText(`${msg.role ?? "message"}${msg.stopReason ? ` (${msg.stopReason})` : ""}`));
      }
    };

    try {
      if (systemPrompt.trim()) {
        const tmp = writePromptTempFile(agent.name, systemPrompt);
        tmpDir = tmp.dir;
        tmpPath = tmp.filePath;
        args.push("--append-system-prompt", tmpPath);
      }
      if (structured) {
        if (!tmpDir) tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
        schemaPath = path.join(tmpDir, "result-schema.json");
        fs.writeFileSync(schemaPath, JSON.stringify(schema), { encoding: "utf-8", mode: 0o600 });
      }
      // The task goes over stdin (merged into the prompt by print mode), never argv: see
      // ChildRunOptions.stdin.
      runLog.write(`# args=${args.join(" ")}`);

      const childEnv: Record<string, string | undefined> = {
        ...prepared.env,
        PI_KIT_INTERNAL_CHILD: "1",
        PI_KIT_SUBAGENT_DEPTH: String(childDepth),
        PI_KIT_SUBAGENT_STATE_DIR: subagentStateDir(defaultCwd),
        // A workflow agent may not delegate: its nesting limit is the depth it already has.
        ...(workflowLaunch ? { PI_KIT_SUBAGENT_MAX_DEPTH: String(childDepth) } : {}),
      };
      // A workflow agent names its run, so tool-firewall tags its approval requests for the
      // console's run-scoped broker. Any other child never inherits a run id.
      if (workflowLaunch && workflowRun) childEnv.PI_KIT_WORKFLOW_RUN_ID = workflowRun.runId;
      else Reflect.deleteProperty(childEnv, "PI_KIT_WORKFLOW_RUN_ID");
      // An agent in its own worktree would otherwise file approvals under the worktree's .pi/, where
      // the session's console never looks: point it at the console of the session that started it.
      if (workflowLaunch && !childEnv.PI_KIT_HUMAN_CONSOLE_DIR) childEnv.PI_KIT_HUMAN_CONSOLE_DIR = path.resolve(defaultCwd, ".pi", "human-console");
      if (schemaPath) childEnv[SCHEMA_ENV] = schemaPath;
      else Reflect.deleteProperty(childEnv, SCHEMA_ENV); // a grandchild never inherits its parent's schema
      // A headless child cannot answer its own tool-firewall "ask"; bound the broker wait so
      // an unanswered approval fails closed in minutes, not the 15-minute root default. The
      // parent's human-console still sees the request and an attentive operator can resolve it.
      if (!childEnv.PI_KIT_HUMAN_CONSOLE_TIMEOUT_MS) {
        childEnv.PI_KIT_HUMAN_CONSOLE_TIMEOUT_MS = String(envInt("PI_KIT_SUBAGENT_APPROVAL_TIMEOUT_MS", DEFAULT_CHILD_APPROVAL_TIMEOUT_MS, 1, Number.MAX_SAFE_INTEGER));
      }
      const outcome = await runChildProcess({
        args,
        stdin: `Task: ${task}${note}`,
        cwd: childCwd,
        env: childEnv,
        signal: abortSignal,
        streamCap,
        idleTimeoutMs,
        maxRuntimeMs,
        heartbeatMs,
        spawnChild,
        onSpawn: (handle) => {
          prepared.slot.attach(handle.pid);
          runLog.attachPid(handle.pid);
          registerLive({
            id: runLog.id,
            agent: agentName,
            pid: handle.pid,
            startedAt: Date.now(),
            cwd: childCwd,
            logPath: runLog.logPath,
            terminate: handle.terminate,
          });
        },
        onLine: processLine,
        onStderr: (text) => {
          result.stderr += text;
          runLog.write(`[stderr] ${text.trimEnd()}`);
        },
        onKill: (reason) => runLog.write(`# killed=${reason}`),
        onHeartbeat: (hb) => onUpdate?.(updateText(`working (idle ${Math.round(hb.idleMs / 1000)}s, out ${Math.round(hb.stdoutBytes / 1024)}KiB)`)),
      });

      result.exitCode = outcome.exitCode;
      outcomeLabel = outcome.killReason ?? (outcome.spawnFailure ? "spawn-failed" : outcome.exitCode === 0 ? "ok" : `exit-${outcome.exitCode}`);
      if (outcome.spawnFailure) {
        result.stopReason = "error";
        result.errorMessage = `Subagent launch failed: ${outcome.spawnFailure}`;
      } else if (outcome.killReason === "signal") {
        result.stopReason = "aborted";
        result.errorMessage = "Subagent was aborted";
      } else if (outcome.killReason === "stream-cap") {
        // Distinct from "error": getResultOutput() treats this as recoverable and prefers
        // whatever partial answer the child already streamed over the bare error text.
        result.stopReason = "stream-cap";
        result.errorMessage = `Subagent terminated: output exceeded ${streamCap} bytes. Raise PI_KIT_SUBAGENT_STREAM_CAP_BYTES for exploration-heavy tasks.`;
      } else if (outcome.killReason === "timeout") {
        result.stopReason = "timeout";
        result.errorMessage = `Subagent terminated: no output for ${idleTimeoutMs} ms. Raise or unset PI_KIT_SUBAGENT_IDLE_TIMEOUT_MS on a slow server.`;
      } else if (outcome.killReason === "wall-clock") {
        result.stopReason = "wall-clock";
        result.errorMessage = `Subagent terminated: exceeded ${Math.round(maxRuntimeMs / 60000)} min wall-clock limit. Raise or unset PI_KIT_SUBAGENT_MAX_RUNTIME_MS for longer tasks.`;
      } else if (outcome.killReason === "stopped") {
        result.stopReason = "stopped";
        result.errorMessage = "Subagent stopped by operator";
      }
      if (structured) {
        // The child's own verdict is not trusted: its submitted arguments are validated here again.
        const read = submitted ? readStructured(schema, submitted.args) : { ok: false as const, errors: [`no ${STRUCTURED_TOOL} call finished without an error`] };
        result.structured = read.ok ? read.value : null;
        result.structuredErrors = read.ok ? undefined : read.errors;
        runLog.write(read.ok ? `# structured output accepted` : `# structured output rejected: ${read.errors.slice(0, 5).join("; ")}`);
      }
      return result;
    } catch (error) {
      return { ...result, exitCode: 1, errorMessage: `Subagent launch failed: ${String(error)}` };
    } finally {
      // Release the concurrency slot. The charge stays whatever happened: a failed, killed or
      // never-started child is not refunded.
      prepared.slot.settle(outcomeLabel);
      unregisterLive(runLog.id);
      if (tmpPath) try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      if (schemaPath) try { fs.unlinkSync(schemaPath); } catch { /* ignore */ }
      if (tmpDir) try { fs.rmdirSync(tmpDir); } catch { /* ignore */ }
    }
  };

  const settle = async (): Promise<SingleResult> => {
    let result: SingleResult;
    let attempts = 1;
    try {
      result = await runAttempt();
      while (attempts < maxAttempts && classifyFailure(result) === "transient") {
        runLog.write(`# transient failure (attempt ${attempts}: ${result.stopReason ?? `exit ${result.exitCode}`}); retrying in ${retryBackoffMs}ms`);
        await delay(retryBackoffMs);
        attempts++;
        const next = await runAttempt();
        addUsage(next.usage, result.usage);
        result = next;
      }
      // One more launch, charged like any other, when a child finished normally but returned no valid
      // structured result. A failed or refused child is not retried here; either way the result is
      // then final, and `structured` stays null when it is still missing.
      if (structured && result.structured === null && !isFailedResult(result)) {
        runLog.write(`# structured output missing or invalid; one retry`);
        attempts++;
        const next = await runAttempt(structuredRetryNote(result.structuredErrors ?? []));
        addUsage(next.usage, result.usage);
        result = next;
      }
    } catch (error) {
      runLog.close("launch-error", { error: String(error) });
      return { ...early, exitCode: 1, errorMessage: `Subagent launch failed: ${String(error)}` };
    }

    // A structured run always ends with a value or null, also when a launch was refused.
    if (structured && result.structured === undefined) {
      result.structured = null;
      result.structuredErrors = [result.errorMessage ?? `no ${STRUCTURED_TOOL} result`];
    }
    result.attempts = attempts;
    noteFinished(isFailedResult(result));
    const stop = result.stopReason ?? (result.exitCode === 0 ? "end" : "error");
    runLog.write(`# exit=${result.exitCode} stopReason=${stop} attempts=${attempts} turns=${result.usage.turns} model=${result.model ?? "?"} cost=${result.usage.cost}`);
    runLog.close(stop, { exitCode: result.exitCode, turns: result.usage.turns, model: result.model, cost: result.usage.cost, attempts });
    return result;
  };

  // The settle promise owns log finalization exactly once. onSettled is attached by the
  // path that resolves first, so a truly-detached run still notifies when it finishes later.
  const settlePromise = settle();
  settlePromise.catch(() => { /* handled by the awaited path or the detached watcher below */ });

  // Explicit background run: hand control straight back; the log, registry and onSettled carry
  // the outcome.
  if (background) {
    settlePromise.then((r) => onSettled?.(r, true), () => {});
    return { ...early, exitCode: 0, stopReason: "detached", detached: true, logPath: runLog.logPath, runId: runLog.id, model: selectedModel };
  }

  // Detach (default): if the parent cancels, stop *awaiting* the child and return control
  // immediately. The child keeps working; its log + registry record the outcome and
  // onSettled notifies the operator. Without this, "detach" was cosmetic — the parent still
  // blocked on the child, so a cancel or interrupt never actually returned control (the
  // reported "tool counter stops and the main agent does not continue").
  if (!abortSignal && signal) {
    const detached: SingleResult = { ...early, exitCode: 0, stopReason: "detached", detached: true, logPath: runLog.logPath, runId: runLog.id, model: selectedModel };
    if (signal.aborted) {
      settlePromise.then((r) => onSettled?.(r, true), () => {});
      return detached;
    }
    let detachResolve!: (value: "__detached__") => void;
    const onAbort = new Promise<"__detached__">((resolve) => { detachResolve = resolve; });
    const onAbortHandler = () => detachResolve("__detached__");
    signal.addEventListener("abort", onAbortHandler, { once: true });
    if (signal.aborted) detachResolve("__detached__"); // guard the check-then-subscribe race
    let winner: SingleResult | "__detached__";
    try {
      winner = await Promise.race([settlePromise, onAbort]);
    } finally {
      // Remove on both paths; after a fired {once:true} listener this is a safe no-op.
      signal.removeEventListener("abort", onAbortHandler);
    }
    if (winner === "__detached__") {
      settlePromise.then((r) => onSettled?.(r, true), () => {});
      return detached;
    }
    onSettled?.(winner, false);
    return winner;
  }

  const result = await settlePromise;
  onSettled?.(result, signal?.aborted === true);
  return result;
}

// Positional wrapper kept for existing callers/tests.
export async function runSingleAgent(
  defaultCwd: string,
  agents: AgentConfig[],
  agentName: string,
  task: string,
  cwd: string | undefined,
  step: number | undefined,
  signal: AbortSignal | undefined,
  onUpdate?: (text: string) => void,
  spawnChild?: SpawnChild,
  parentModel?: string,
  inheritParentModel = false,
): Promise<SingleResult> {
  return runAgent({
    defaultCwd,
    agents,
    agentName,
    task,
    cwd,
    step,
    signal,
    onUpdate,
    spawnChild,
    parentModel,
    inheritParentModel,
  });
}
