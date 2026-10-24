import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Effective auto-compaction state, computed from the REAL settings files with pi's own
// semantics (node_modules/@earendil-works/pi-coding-agent/dist/core/settings-manager.js and
// core/compaction/compaction.js), not from the kit's assumptions about them:
//
//   * settings precedence is global (<agent dir>/settings.json) then project (<cwd>/.pi/settings.json),
//     deep-merged field by field, the project winning. An UNTRUSTED project's file is not read at all.
//   * `compaction.enabled` is `settings.compaction?.enabled ?? true` and is then tested for
//     truthiness; reserveTokens defaults to 16384 and keepRecentTokens to 20000.
//   * the threshold is `contextTokens > contextWindow - reserveTokens` (shouldCompact) and
//     `enabled: false` short-circuits BOTH the threshold check and the overflow recovery
//     (AgentSession._checkCompaction returns first thing when !settings.enabled). The kit's older
//     docs said overflow compaction "cannot be disabled"; in pi 0.85.1 it can, which is exactly why
//     a disabled state has to be loud.
//
// Nothing here imports the toolchain lib (extensions are self-contained).

/** Shape other extensions read from `globalThis[Symbol.for("pi-kit.compaction")]`. */
export interface PublishedCompaction {
  /** true/false once known; null before the first session_start or when it cannot be determined. */
  enabled: boolean | null;
  /** Token count at which the FIRST automatic compaction happens (min of pi's and the kit trigger); null when unknown or disabled. */
  thresholdTokens: number | null;
  /** Why compaction is off or cannot work; null when it is healthy (or not yet known). */
  reason: string | null;
}

export const COMPACTION_GLOBAL_KEY = Symbol.for("pi-kit.compaction");
const WARNED_KEY = Symbol.for("pi-kit.compaction.warned");

export const PI_DEFAULT_RESERVE_TOKENS = 16384;
export const PI_DEFAULT_KEEP_RECENT_TOKENS = 20000;
/** pi-ai's clampMaxTokensToContext keeps this many tokens free of output (api/simple-options.js). */
export const PI_CONTEXT_SAFETY_TOKENS = 4096;
export const KIT_DEFAULT_THRESHOLD_TOKENS = 100_000;

export type CompactionCode = "disabled" | "window-unknown" | "reserve-exceeds-window" | null;

export interface CompactionState {
  enabled: boolean;
  source: "project" | "global" | "default";
  reserveTokens: number;
  keepRecentTokens: number;
  /** The model's context window, or null when it is unknown. Never 0. */
  contextWindow: number | null;
  /** contextWindow - reserveTokens (pi's own trigger), or null when the window is unknown. */
  nativeThresholdTokens: number | null;
  kitTrigger: { loaded: boolean; enabled: boolean; thresholdTokens: number | null; effective: boolean };
  /** Earliest automatic trigger (see PublishedCompaction). */
  thresholdTokens: number | null;
  code: CompactionCode;
  reason: string | null;
  /** Non-fatal observations (unparseable settings file, untrusted project file, ...). */
  notes: string[];
}

export interface CompactionInputs {
  cwd: string;
  /** undefined = assume trusted (older pi without ctx.isProjectTrusted). */
  projectTrusted?: boolean | undefined;
  /**
   * Active model's contextWindow. undefined/null = no model yet (nothing to complain about);
   * a number <= 0 or NaN = a model whose window is unknown (reported as such, never as 0%).
   */
  contextWindow?: number | null | undefined;
  /** Whether trigger-compact is loaded in this session (its /compact-threshold command is registered). */
  kitTriggerLoaded?: boolean;
}

export function agentDir(): string {
  const env = process.env.PI_CODING_AGENT_DIR;
  if (env) return env === "~" ? os.homedir() : env.startsWith("~/") ? path.join(os.homedir(), env.slice(2)) : env;
  return path.join(os.homedir(), ".pi", "agent");
}

interface ReadResult {
  value: Record<string, unknown> | null;
  present: boolean;
  error: string | null;
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function readSettingsObject(file: string): ReadResult {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { value: null, present: false, error: null };
  }
  try {
    const parsed: unknown = JSON.parse(raw.replace(/^\uFEFF/, ""));
    // pi treats a non-object as no settings at all
    return { value: isPlainRecord(parsed) ? parsed : {}, present: true, error: null };
  } catch (error) {
    return { value: {}, present: true, error: `${file} is not valid JSON (${error instanceof Error ? error.message : String(error)}); pi ignores it and uses defaults` };
  }
}

function compactionBlock(settings: Record<string, unknown> | null): Record<string, unknown> {
  const block = settings?.compaction;
  return isPlainRecord(block) ? block : {};
}

const has = (o: Record<string, unknown>, key: string): boolean => Object.prototype.hasOwnProperty.call(o, key) && o[key] !== undefined;

function finiteOr(value: unknown, fallback: number, label: string, notes: string[]): number {
  if (value === undefined || value === null) return fallback;
  const n = typeof value === "number" ? value : Number(value);
  if (Number.isFinite(n)) return n;
  notes.push(`compaction.${label} is not a number (${JSON.stringify(value)}); pi would misbehave, the default ${fallback} is assumed here`);
  return fallback;
}

/** The kit trigger's own switches (trigger-compact reads the same file and env var). */
export function readKitTrigger(): { enabled: boolean; thresholdTokens: number } {
  const saved = readSettingsObject(path.join(agentDir(), "pi-kit", "trigger-compact.json")).value ?? {};
  const env = Number(process.env.PI_KIT_COMPACT_THRESHOLD_TOKENS);
  const savedThreshold = typeof saved.thresholdTokens === "number" && Number.isFinite(saved.thresholdTokens) && saved.thresholdTokens >= 1000 ? Math.floor(saved.thresholdTokens) : undefined;
  return {
    enabled: saved.enabled !== false,
    thresholdTokens: Number.isFinite(env) && env >= 1000 ? Math.floor(env) : (savedThreshold ?? KIT_DEFAULT_THRESHOLD_TOKENS),
  };
}

export function formatK(n: number | null): string {
  if (n === null) return "unknown";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  return n >= 1000 ? `${n % 1000 === 0 ? n / 1000 : (n / 1000).toFixed(1)}k` : String(n);
}

export function computeCompactionState(input: CompactionInputs): CompactionState {
  const notes: string[] = [];
  const globalFile = path.join(agentDir(), "settings.json");
  const projectFile = path.join(input.cwd, ".pi", "settings.json");
  const global = readSettingsObject(globalFile);
  const trusted = input.projectTrusted !== false;
  const project = trusted ? readSettingsObject(projectFile) : { value: null, present: false, error: null };
  if (global.error) notes.push(global.error);
  if (project.error) notes.push(project.error);
  if (!trusted && readSettingsObject(projectFile).present) notes.push(`${projectFile} is present but the project is not trusted, so pi ignores it`);

  const g = compactionBlock(global.value);
  const p = compactionBlock(project.value);
  const pick = (key: string): { value: unknown; from: "project" | "global" | "default" } =>
    has(p, key) ? { value: p[key], from: "project" } : has(g, key) ? { value: g[key], from: "global" } : { value: undefined, from: "default" };

  const enabledPick = pick("enabled");
  // settings.compaction?.enabled ?? true, then `if (!settings.enabled) return false`
  const enabled = Boolean(enabledPick.value ?? true);
  const source: CompactionState["source"] = enabledPick.value === undefined || enabledPick.value === null ? "default" : enabledPick.from;
  if (enabledPick.value !== undefined && enabledPick.value !== null && typeof enabledPick.value !== "boolean") {
    notes.push(`compaction.enabled is ${JSON.stringify(enabledPick.value)} (not a boolean); pi treats any truthy value as on`);
  }
  const reserveTokens = finiteOr(pick("reserveTokens").value, PI_DEFAULT_RESERVE_TOKENS, "reserveTokens", notes);
  const keepRecentTokens = finiteOr(pick("keepRecentTokens").value, PI_DEFAULT_KEEP_RECENT_TOKENS, "keepRecentTokens", notes);

  // "Unknown" is a first-class answer: pi's getContextUsage() returns undefined for a window <= 0.
  const window = typeof input.contextWindow === "number" && Number.isFinite(input.contextWindow) && input.contextWindow > 0 ? Math.floor(input.contextWindow) : null;
  const native = window === null ? null : window - reserveTokens;

  const kit = readKitTrigger();
  const kitEffective = Boolean(input.kitTriggerLoaded) && enabled && kit.enabled && native !== null && kit.thresholdTokens < native;
  const kitState = { loaded: Boolean(input.kitTriggerLoaded), enabled: kit.enabled, thresholdTokens: input.kitTriggerLoaded ? kit.thresholdTokens : null, effective: kitEffective };

  let code: CompactionCode = null;
  let reason: string | null = null;
  const where = source === "project" ? projectFile : source === "global" ? globalFile : "the defaults";
  if (!enabled) {
    code = "disabled";
    reason =
      `pi auto-compaction is OFF (compaction.enabled=false in ${where}): nothing compacts automatically and pi will not recover from a context overflow, ` +
      "so a long run stops when the window fills. Subagents and other child sessions inherit this. Turn it back on with /compaction on.";
  } else if (typeof input.contextWindow === "number" && window === null) {
    code = "window-unknown";
    reason =
      "the active model reports no context window, so compaction cannot be sized: pi cannot show real usage and its post-run check (tokens > window - reserveTokens) " +
      "would compact after every run. Set contextWindow for this model in models.json.";
  } else if (native !== null && native < keepRecentTokens + PI_CONTEXT_SAFETY_TOKENS) {
    code = "reserve-exceeds-window";
    reason =
      `compaction.reserveTokens (${formatK(reserveTokens)}) leaves a ${formatK(Math.max(native, 0))} trigger on a ${formatK(window)} window while ${formatK(keepRecentTokens)} recent tokens are kept, ` +
      "so pi would compact almost every turn without getting below the threshold. Lower compaction.reserveTokens and keepRecentTokens in settings.json for this model.";
  }

  const candidates = [native !== null && native > 0 ? native : null, kitEffective ? kit.thresholdTokens : null].filter((n): n is number => n !== null);
  return {
    enabled,
    source,
    reserveTokens,
    keepRecentTokens,
    contextWindow: window,
    nativeThresholdTokens: native,
    kitTrigger: kitState,
    thresholdTokens: enabled && candidates.length > 0 ? Math.min(...candidates) : null,
    code,
    reason,
    notes,
  };
}

export function toPublished(state: CompactionState | null): PublishedCompaction {
  return state ? { enabled: state.enabled, thresholdTokens: state.thresholdTokens, reason: state.reason } : { enabled: null, thresholdTokens: null, reason: null };
}

/** Publish the state for other extensions (the footer reads it). Returns what was published. */
export function publishCompaction(state: CompactionState | null): PublishedCompaction {
  const published = toPublished(state);
  try {
    (globalThis as Record<symbol, unknown>)[COMPACTION_GLOBAL_KEY] = published;
  } catch {
    /* a frozen global must never break a session */
  }
  return published;
}

export function describeCompaction(state: CompactionState): string {
  const lines: string[] = [];
  const src = state.source === "default" ? "default" : `${state.source} settings`;
  lines.push(`Auto-compaction (pi): ${state.enabled ? "ON" : "OFF"}  [${src}]`);
  if (state.enabled) {
    lines.push(
      state.contextWindow === null
        ? "  context window: unknown (usage cannot be shown as a percentage)"
        : `  compacts when context exceeds ${formatK(state.nativeThresholdTokens)} tokens (window ${formatK(state.contextWindow)} - ${formatK(state.reserveTokens)} reserve); keeps ~${formatK(state.keepRecentTokens)} recent tokens`,
    );
    lines.push(`  overflow recovery: on (pi compacts once and retries; a second overflow stops the run)`);
  } else {
    lines.push("  overflow recovery: OFF as well - a full context window ends the run with an error");
  }
  if (!state.kitTrigger.loaded) lines.push("Kit fixed-budget trigger: not loaded in this profile");
  else if (!state.enabled) lines.push("Kit fixed-budget trigger: OFF (follows pi's switch)");
  else if (!state.kitTrigger.enabled) lines.push("Kit fixed-budget trigger: OFF (/compact-threshold off)");
  else if (state.kitTrigger.effective) lines.push(`Kit fixed-budget trigger: ON at ${formatK(state.kitTrigger.thresholdTokens)} tokens (fires before pi's ${formatK(state.nativeThresholdTokens)}; pi stays as the overflow backstop)`);
  else lines.push(`Kit fixed-budget trigger: ON at ${formatK(state.kitTrigger.thresholdTokens)} tokens but idle - ${state.nativeThresholdTokens === null ? "the context window is unknown" : `pi's own ${formatK(state.nativeThresholdTokens)} trigger fires first`}`);
  lines.push(`Earliest automatic trigger: ${state.thresholdTokens === null ? (state.enabled ? "unknown" : "none") : `${formatK(state.thresholdTokens)} tokens`}`);
  if (state.reason) lines.push("", `WARNING: ${state.reason}`);
  for (const note of state.notes) lines.push(`  note: ${note}`);
  lines.push("", "Manual /compact and /compress always work. Change: /compaction on|off (pi), /compaction trigger on|off (kit).");
  return lines.join("\n");
}

/**
 * Emit the degraded-state warning at most once per session (not per turn, not per reload).
 * Uses the UI when there is one and stderr otherwise, so print/JSON runs are not silent.
 */
export function warnOnce(ctx: { hasUI?: boolean; ui?: { notify?: (m: string, l?: "info" | "warning" | "error") => void }; sessionManager?: { getSessionId?: () => unknown } } | undefined, state: CompactionState, sessionKey?: string): boolean {
  if (!state.reason) return false;
  let id = sessionKey;
  if (!id) {
    try {
      const raw = ctx?.sessionManager?.getSessionId?.();
      id = typeof raw === "string" && raw ? raw : undefined;
    } catch {
      id = undefined;
    }
  }
  const key = `${id ?? `pid-${process.pid}`}:compaction`;
  const g = globalThis as Record<symbol, unknown>;
  const seen = warnedSet(g);
  if (seen.has(key)) return false;
  seen.add(key);
  emitWarning(ctx, `compaction: ${state.reason}`);
  return true;
}

// The per-process set of sessions already warned. Only membership of strings is asked, so a Set
// some other code left under the key is used as one of unknown values.
function warnedSet(g: Record<symbol, unknown>): Set<unknown> {
  const slot = g[WARNED_KEY];
  if (slot instanceof Set) return slot;
  const fresh = new Set<unknown>();
  g[WARNED_KEY] = fresh;
  return fresh;
}

/** Mark the warning as already delivered for this session (the /compaction command reports it itself). */
export function markWarned(ctx: { sessionManager?: { getSessionId?: () => unknown } } | undefined): void {
  try {
    const raw = ctx?.sessionManager?.getSessionId?.();
    const key = `${typeof raw === "string" && raw ? raw : `pid-${process.pid}`}:compaction`;
    const g = globalThis as Record<symbol, unknown>;
    const seen = warnedSet(g);
    seen.add(key);
  } catch {
    /* best effort */
  }
}

export function emitWarning(ctx: { hasUI?: boolean; ui?: { notify?: (m: string, l?: "info" | "warning" | "error") => void } } | undefined, message: string): void {
  try {
    if (ctx?.hasUI && ctx.ui?.notify) {
      ctx.ui.notify(message, "warning");
      return;
    }
  } catch {
    /* stale ctx: fall through to stderr */
  }
  try {
    process.stderr.write(`[pi-kit] ${message}\n`);
  } catch {
    /* no stderr */
  }
}
