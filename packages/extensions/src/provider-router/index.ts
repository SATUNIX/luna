import type { ExtensionAPI, ModelRegistry } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";

// provider-router: routes the PARENT session's own model by task difficulty at a real
// pre-inference decision point.
//
// H-03/AG-01 fix: this previously returned `{ model }` from the `model_select` hook,
// which is a post-selection NOTIFICATION only — Pi has already set/persisted the model
// before emitting it and never reads a handler's return value (confirmed against
// node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js's
// _emitModelSelect/setModel: state.model is assigned, then the event is emitted, with
// nothing consuming what handlers return). It also had no real task-difficulty input in
// production: it read `task_type` from goal-core.json, but goal-core never wrote one.
//
// Now: orchestrator (which already scores every input's complexity to decide whether to
// delegate) writes that same signal to its session's task-classification file on every `input`
// event; this extension reads it and calls the documented, supported `pi.setModel()`
// imperative API from `before_agent_start` — which fires after `input` and strictly
// before any provider request for the turn (see the Lifecycle Overview in
// node_modules/@earendil-works/pi-coding-agent/docs/extensions.md) — a genuine
// pre-inference decision point, not a notification.

interface RoutingPolicy {
  hot_path_model: string;
  strong_model: string;
  trigger_task_types: string[];
}

const DEFAULT_TRIGGER_TASK_TYPES = ["goal_decomposition", "cross_file_review", "done_triage", "complex"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// No default hot_path_model/strong_model: this extension must never override whatever
// model the operator already has configured (session default, per-agent config, etc.)
// with a hardcoded model name that may not exist in their registry. Routing is opt-in -
// without an explicit PI_KIT_ROUTING_POLICY file naming real models, before_agent_start
// is a no-op and the configured model is left untouched. Previously this defaulted to
// "gemma4:latest"/"qwen2.5-coder:32b", which silently fought the operator's own model
// choice on every turn whenever those names happened to resolve in their registry.
function readPolicy(): RoutingPolicy | null {
  const policyPath = process.env.PI_KIT_ROUTING_POLICY;
  if (!policyPath) return null;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(policyPath, "utf8"));
    if (!isRecord(parsed)) return null;
    const { hot_path_model: hot, strong_model: strong, trigger_task_types: triggers } = parsed;
    // EFF-8: both model specs must be non-empty strings; anything else leaves routing off.
    if (typeof hot !== "string" || typeof strong !== "string" || !hot || !strong) return null;
    return {
      hot_path_model: hot,
      strong_model: strong,
      trigger_task_types: Array.isArray(triggers)
        ? triggers.filter((value): value is string => typeof value === "string")
        : DEFAULT_TRIGGER_TASK_TYPES,
    };
  } catch {
    return null;
  }
}

// ORC-9: orchestrator scopes the file per session, at
// .pi/task-classification/sessions/<id>.json, so this reads only its own session's score and
// never another session's or its parent's. A session without a usable id reads the legacy
// flat .pi/task-classification.json. The resolver is duplicated, not imported, because each
// extension must stay independently extractable (packages/core/verify.ts).
const SESSION_ID_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

function resolveSessionId(ctx: { sessionManager?: { getSessionId?: () => unknown } | undefined }): string | undefined {
  try {
    const id = ctx.sessionManager?.getSessionId?.();
    return typeof id === "string" && SESSION_ID_RE.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

// Real producer: extensions/orchestrator's `input` handler (readTaskType previously
// pointed at goal-core.json, which never had a task_type field).
function readTaskType(cwd: string, sessionId: string | undefined): string {
  const file = sessionId
    ? path.join(cwd, ".pi", "task-classification", "sessions", `${sessionId}.json`)
    : path.join(cwd, ".pi", "task-classification.json");
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return isRecord(parsed) && typeof parsed.taskType === "string" ? parsed.taskType : "";
  } catch {
    return "";
  }
}

function parseModelString(value: string): { provider: string | null; id: string } {
  const idx = value.indexOf("/");
  if (idx === -1) return { provider: null, id: value };
  return { provider: value.slice(0, idx), id: value.slice(idx + 1) };
}

// Resolution uses only the documented public surface (ctx.modelRegistry.find/getAll +
// pi.setModel) — deliberately not the CLI's internal pattern resolver
// (core/model-resolver.ts), which isn't part of this package's public API surface and
// is not safe to depend on across the supported pi range.
type RegistryModel = NonNullable<ReturnType<ModelRegistry["find"]>>;

function resolveModel(modelRegistry: Pick<ModelRegistry, "find" | "getAll">, value: string): RegistryModel | null {
  const { provider, id } = parseModelString(value);
  if (provider) {
    const found = modelRegistry.find(provider, id);
    if (found) return found;
    // Provider-qualified miss: never fall back to a same-id model on another
    // provider. The id-only fallback below applies to unqualified names only.
    return null;
  }
  const all = modelRegistry.getAll?.() ?? [];
  return all.find((m) => m.id === id) ?? null;
}

export default function (pi: ExtensionAPI) {
  let policy: RoutingPolicy | null = null;
  let cwd = process.cwd();

  pi.on("session_start", async (_event, ctx) => {
    cwd = ctx.cwd ?? process.cwd();
    policy = readPolicy();
    if (policy) {
      ctx.ui?.notify?.(`provider-router: hot=${policy.hot_path_model}, strong=${policy.strong_model}`, "info");
    }
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    if (!policy) return undefined; // unconfigured - never touch the operator's own model choice
    const dir = ctx.cwd ?? cwd;
    const taskType = readTaskType(dir, resolveSessionId(ctx));
    const targetSpec = taskType && policy.trigger_task_types.includes(taskType) ? policy.strong_model : policy.hot_path_model;

    // Typed as always present, but an offline harness may omit it: keep the guard.
    const registry: ModelRegistry | undefined = ctx.modelRegistry;
    if (!registry) return undefined; // no registry available (e.g. offline harness) - nothing to route
    const model = resolveModel(registry, targetSpec);
    if (!model) {
      ctx.ui?.notify?.(`provider-router: target model '${targetSpec}' not found in the model registry — keeping current model`, "warning");
      return undefined;
    }

    try {
      const success = await pi.setModel(model);
      if (!success) {
        ctx.ui?.notify?.(`provider-router: no auth configured for '${targetSpec}' — keeping current model`, "warning");
      } else {
        ctx.ui?.notify?.(`provider-router: routed to ${targetSpec}${taskType ? ` (${taskType})` : ""}`, "info");
      }
    } catch (error) {
      ctx.ui?.notify?.(`provider-router: setModel failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
    }
    return undefined;
  });
}
