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
  /** Both set, or both empty when the policy only names a fallback list. */
  hot_path_model: string;
  strong_model: string;
  trigger_task_types: string[];
  /** Models to move to, in order, when the current one fails with a credit, rate-limit or server error. */
  fallback: string[];
}

const MAX_FALLBACK = 3;
const COOLDOWN_MS = 5 * 60_000;

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
    const fallback = Array.isArray(parsed.fallback)
      ? parsed.fallback.filter((v): v is string => typeof v === "string" && v !== "").slice(0, MAX_FALLBACK)
      : [];
    // EFF-8: both model specs must be non-empty strings; anything else leaves routing off (a policy
    // that only lists fallback models still works as a failover list).
    const routes = typeof hot === "string" && typeof strong === "string" && hot !== "" && strong !== "";
    if (!routes && fallback.length === 0) return null;
    return {
      hot_path_model: routes ? hot : "",
      strong_model: routes ? strong : "",
      fallback,
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

/** The model spec a registry model answers to: "provider/id". */
const specOf = (m: { provider?: string; id?: string } | undefined): string => (m?.id ? `${m.provider ? `${m.provider}/` : ""}${m.id}` : "");

export default function (pi: ExtensionAPI) {
  let policy: RoutingPolicy | null = null;
  let cwd = process.cwd();
  // Specs that failed, with when they may be tried again, and the model to go back to afterwards.
  const cooling = new Map<string, number>();
  let primary: string | null = null;
  let registry: ModelRegistry | undefined;

  const isCooling = (spec: string): boolean => (cooling.get(spec) ?? 0) > Date.now();

  pi.on("session_start", async (_event, ctx) => {
    cwd = ctx.cwd ?? process.cwd();
    policy = readPolicy();
    cooling.clear();
    primary = null;
    if (policy) {
      const route = policy.hot_path_model ? `hot=${policy.hot_path_model}, strong=${policy.strong_model}` : "failover only";
      ctx.ui?.notify?.(`provider-router: ${route}${policy.fallback.length ? `, fallback=${policy.fallback.join(" > ")}` : ""}`, "info");
    }
  });

  // finish-reason-retry classifies every provider failure once and offers it here. Taking it means
  // moving to the next fallback model that is not cooling down, which pi's retry then uses.
  pi.events?.on("luna:provider-failure", (data: unknown) => {
    if (!policy || policy.fallback.length === 0 || typeof data !== "object" || data === null) return;
    if (Reflect.get(data, "kind") === "other" || !registry) return;
    const failed = String(Reflect.get(data, "model") ?? "");
    const failedProvider = String(Reflect.get(data, "provider") ?? "");
    // Two providers can serve the same model id: match the provider too when the emitter gave it.
    const current = [...registry.getAll?.() ?? []].find((m) => m.id === failed && (!failedProvider || m.provider === failedProvider));
    const failedSpec = specOf(current) || (failedProvider && failed ? `${failedProvider}/${failed}` : failed);
    primary ??= failedSpec;
    cooling.set(failedSpec, Date.now() + COOLDOWN_MS);
    cooling.set(failed, Date.now() + COOLDOWN_MS);
    const candidates: Array<{ spec: string; model: NonNullable<ReturnType<typeof resolveModel>> }> = [];
    for (const spec of policy.fallback) {
      if (isCooling(spec) || spec === failedSpec) continue;
      const next = resolveModel(registry, spec);
      if (next) candidates.push({ spec, model: next });
    }
    if (candidates.length === 0) return;
    Reflect.set(data, "handled", true);
    // The emitter awaits this before it lets pi retry, so the retry runs on the new model. pi.setModel
    // returns false (it does not throw) when the target has no usable credentials: try the next
    // fallback, and resolve false when none took so the failure is not retried on the same model.
    Reflect.set(data, "switching", (async (): Promise<boolean> => {
      for (const { spec, model } of candidates) {
        const switched = await pi.setModel(model).catch(() => false);
        if (switched) return true;
        cooling.set(spec, Date.now() + COOLDOWN_MS);
      }
      return false;
    })());
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    if (!policy) return undefined; // unconfigured - never touch the operator's own model choice
    registry = ctx.modelRegistry;
    if (!registry) return undefined; // no registry available (e.g. offline harness) - nothing to route
    const dir = ctx.cwd ?? cwd;
    const taskType = readTaskType(dir, resolveSessionId(ctx));
    let targetSpec = "";
    if (policy.hot_path_model) {
      targetSpec = taskType && policy.trigger_task_types.includes(taskType) ? policy.strong_model : policy.hot_path_model;
    } else if (primary && !isCooling(primary) && specOf(ctx.model) !== primary) {
      targetSpec = primary; // failover only: go back to the model that failed once its cooldown is over
    }
    // A target that is cooling down after a failure gives way to the first fallback that is not.
    if (targetSpec && isCooling(targetSpec)) targetSpec = policy.fallback.find((spec) => !isCooling(spec)) ?? targetSpec;
    if (!targetSpec) return undefined;
    if (primary && targetSpec === primary) primary = null;
    if (specOf(ctx.model) === targetSpec) return undefined;

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
