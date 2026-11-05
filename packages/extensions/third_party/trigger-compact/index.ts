import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Built-in fallback used only when nothing else sets a threshold: no env var, and no
// persisted <agent dir>/pi-kit/trigger-compact.json from a prior /compact-threshold run.
const DEFAULT_THRESHOLD_TOKENS = 100_000;
const MIN_THRESHOLD_TOKENS = 1_000;
// pi's own defaults (settings-manager.js getCompactionReserveTokens): the native trigger is
// contextWindow - reserveTokens.
const PI_DEFAULT_RESERVE_TOKENS = 16_384;

function agentDir(): string {
  const env = process.env.PI_CODING_AGENT_DIR;
  if (env) return env === "~" ? os.homedir() : env.startsWith("~/") ? path.join(os.homedir(), env.slice(2)) : env;
  return path.join(os.homedir(), ".pi", "agent");
}

function settingsFile(): string {
  return path.join(agentDir(), "pi-kit", "trigger-compact.json");
}

// An explicit `undefined` in a patch removes that key from the saved file.
type Settings = { thresholdTokens?: number | undefined; enabled?: boolean | undefined };

function loadPersisted(): Settings {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
    // Shape guard: a literal `null` (or an array) parses fine but has no fields to read.
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function loadPersistedThreshold(): number | undefined {
  const raw = loadPersisted();
  return typeof raw.thresholdTokens === "number" && Number.isFinite(raw.thresholdTokens) && raw.thresholdTokens >= MIN_THRESHOLD_TOKENS
    ? Math.floor(raw.thresholdTokens)
    : undefined;
}

function savePersisted(patch: Settings): void {
  const merged: Settings = { ...loadPersisted(), ...patch };
  const next = Object.fromEntries(Object.entries(merged).filter(([, value]) => value !== undefined));
  if (Object.keys(next).length === 0) {
    fs.rmSync(settingsFile(), { force: true }); // nothing saved: back to pure defaults
    return;
  }
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  const tmp = `${settingsFile()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, settingsFile());
}

function savePersistedThreshold(thresholdTokens: number): void {
  savePersisted({ thresholdTokens });
}

// The kit-level switch (/compact-threshold off|on). Separate from pi's own setting so an
// operator can keep pi's overflow protection while disabling this fixed-budget trigger.
function kitTriggerEnabled(): boolean {
  return loadPersisted().enabled !== false;
}

// pi's own compaction settings, read the way pi reads them (settings-manager.js): global
// <agent dir>/settings.json, deep-merged field by field with the project's .pi/settings.json, the
// project winning - and an UNTRUSTED project's file is not read at all. `enabled` is
// `compaction?.enabled ?? true` tested for truthiness; reserveTokens defaults to 16384.
// (This extension used to ignore `enabled` entirely, and ctx.compact() does not check it either, so
// turning auto-compaction off in /settings still compacted at 100k tokens.)
// Cached by file mtime and size so the per-turn check costs two stat calls. mtime alone misses a
// rewrite within one timestamp tick on coarse-clock filesystems (overlayfs, older kernels).
type CompactionBlock = { enabled?: unknown; reserveTokens?: unknown };
const settingsCache = new Map<string, { mtimeMs: number; size: number; block: CompactionBlock | undefined }>();
function readCompactionBlock(file: string): CompactionBlock | undefined {
  // One open file: the mtime and size that key the cache describe the same file that is parsed.
  let mtimeMs: number;
  let size: number;
  let text: string;
  const cached = settingsCache.get(file);
  try {
    const fd = fs.openSync(file, "r");
    try {
      ({ mtimeMs, size } = fs.fstatSync(fd));
      if (cached?.mtimeMs === mtimeMs && cached.size === size) return cached.block;
      text = fs.readFileSync(fd, "utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    settingsCache.delete(file);
    return undefined;
  }
  let block: CompactionBlock | undefined;
  try {
    const parsed: unknown = JSON.parse(text.replace(/^\uFEFF/, ""));
    const c: unknown = typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "compaction") : undefined;
    block = c !== null && typeof c === "object" && !Array.isArray(c) ? c : {};
  } catch {
    block = cached?.block; // mid-write or corrupt: keep the last good value
  }
  settingsCache.set(file, { mtimeMs, size, block });
  return block;
}

export interface PiCompactionSettings {
  enabled: boolean;
  reserveTokens: number;
}

export function piCompactionSettings(cwd: string, projectTrusted?: boolean): PiCompactionSettings {
  const project = projectTrusted === false ? undefined : readCompactionBlock(path.join(cwd, ".pi", "settings.json"));
  const global = readCompactionBlock(path.join(agentDir(), "settings.json"));
  const pick = (key: keyof CompactionBlock): unknown => (project && Object.prototype.hasOwnProperty.call(project, key) && project[key] !== undefined ? project[key] : global?.[key]);
  const reserve = Number(pick("reserveTokens") ?? PI_DEFAULT_RESERVE_TOKENS);
  return { enabled: Boolean(pick("enabled") ?? true), reserveTokens: Number.isFinite(reserve) ? reserve : PI_DEFAULT_RESERVE_TOKENS };
}

export function piAutoCompactionEnabled(cwd: string, projectTrusted?: boolean): boolean {
  return piCompactionSettings(cwd, projectTrusted).enabled;
}

function envThreshold(): number | undefined {
  const raw = process.env.PI_KIT_COMPACT_THRESHOLD_TOKENS;
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= MIN_THRESHOLD_TOKENS ? Math.floor(n) : undefined;
}

// Environment configuration is intentional for managed installs and takes priority, matching
// the rest of the kit's PI_KIT_* precedence convention (see e.g. PI_KIT_SUBAGENT_INHERIT_MODEL).
function resolveInitialThreshold(): number {
  return envThreshold() ?? loadPersistedThreshold() ?? DEFAULT_THRESHOLD_TOKENS;
}

// Accepts a plain integer or shorthand like "500k" / "1.2m".
function parseTokenAmount(raw: string): number | undefined {
  const m = raw.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(k|m)?$/);
  if (!m) return undefined;
  const value = Number(m[1]);
  if (!Number.isFinite(value)) return undefined;
  const mult = m[2] === "k" ? 1_000 : m[2] === "m" ? 1_000_000 : 1;
  return Math.floor(value * mult);
}

function formatTokens(n: number): string {
  if (n >= 1_000_000 && n % 1_000_000 === 0) return `${n / 1_000_000}M`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000 && n % 1_000 === 0) return `${n / 1_000}k`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

// Compaction callbacks are deferred: they fire after compaction finishes, by which point the
// session may have been replaced or reloaded. A ctx captured before that is stale, and reading
// `ctx.hasUI` on it throws ("This extension ctx is stale after session replacement or reload").
// Because the throw happens *inside* the compaction error handler, it surfaces as an unhandled
// extension error and kills the session instead of reporting the compaction failure. A dropped
// notification is always preferable to that.
function notifySafely(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error"): void {
  try {
    if (ctx.hasUI) ctx.ui.notify(message, level);
  } catch {
    /* stale ctx after reload — drop the notification */
  }
}

// A one-shot child (subagent, reviewer, validator: `pi -p` / `--mode json`, PI_KIT_INTERNAL_CHILD=1)
// must never call ctx.compact(). pi's ctx.compact() is AgentSession.compact(): it ABORTS the running
// agent first and never resumes it. Interactively that costs a "continue"; in a print/JSON child
// there is nobody to type it, the process just ends with no final message (the reviewer that
// "ended without emitting any final message", log ending at compaction_start reason "manual",
// recorded in docs/future-work.md). pi's own threshold/overflow compaction runs INSIDE the run and
// continues it, so children rely on that.
function isOneShotChild(ctx: ExtensionContext): boolean {
  if (process.env.PI_KIT_INTERNAL_CHILD === "1") return true;
  const mode = (ctx as { mode?: string }).mode;
  return mode === "print" || mode === "json";
}

export const RESUME_MESSAGE =
  "[pi-kit] Your context was compacted automatically (fixed-budget trigger) while you were working, which interrupted the run. " +
  "Continue the task from where you left off; the summary at the top of this conversation holds the state.";

export default function (pi: ExtensionAPI) {
  let thresholdTokens = resolveInitialThreshold();
  const envOverride = envThreshold();
  // Level-triggered with re-arming: fire when usage is above the threshold and the trigger is armed;
  // re-arm only once usage is known to be at or below it again. (The old edge trigger needed a
  // previous reading at or below the threshold, so a resumed session that was already above it never
  // fired; a level trigger without re-arming would loop when compaction cannot get below a low
  // threshold.)
  let armed = true;
  let inFlight = false;
  let inFlightSince = 0;
  let pendingAtSettle = false;
  let notedInactive = false;

  const triggerCompaction = (ctx: ExtensionContext, opts: { customInstructions?: string | undefined; resume?: boolean; tokens?: number } = {}) => {
    inFlight = true;
    inFlightSince = Date.now();
    notifySafely(ctx, "Compaction started", "info");
    ctx.compact({
      ...(opts.customInstructions !== undefined ? { customInstructions: opts.customInstructions } : {}),
      onComplete: () => {
        inFlight = false;
        notifySafely(ctx, "Compaction completed", "info");
        if (!opts.resume) return;
        // The compaction aborted a live run and pi never continues an aborted run: continue it, but
        // only if nothing else has (an autonomous loop's follow-up may already have started a run).
        try {
          const idle = typeof ctx.isIdle === "function" ? ctx.isIdle() : true;
          const queued = typeof ctx.hasPendingMessages === "function" ? ctx.hasPendingMessages() : false;
          if (idle && !queued) {
            // Typed void, but a runtime that returns a promise still has its rejection caught.
            const sendResume = (): unknown => pi.sendUserMessage(RESUME_MESSAGE);
            void Promise.resolve(sendResume()).catch(() => {});
          }
        } catch {
          /* stale ctx after a reload: the reload started a fresh session, nothing to resume */
        }
      },
      onError: (error) => {
        inFlight = false;
        notifySafely(ctx, `Compaction failed: ${error.message}`, "error");
      },
    });
  };

  // Whether the kit trigger may fire now, and the numbers behind it. `native` is pi's own trigger
  // (window - reserveTokens); null when the context window is unknown.
  const evaluate = (ctx: ExtensionContext, tokens: number, window: number | undefined) => {
    const trusted = typeof ctx.isProjectTrusted === "function" ? ctx.isProjectTrusted() : undefined;
    const settings = piCompactionSettings(ctx.cwd ?? process.cwd(), trusted);
    const native = window && window > 0 ? window - settings.reserveTokens : null;
    return { settings, native, nativeWillFire: native !== null && tokens > native, redundant: native !== null && thresholdTokens >= native };
  };

  const maybeFire = (ctx: ExtensionContext, event: unknown, atSettle: boolean) => {
    // A compaction whose callback never arrived (a reload swallowed it) must not disarm the trigger for good.
    if (inFlight && Date.now() - inFlightSince > 5 * 60_000) inFlight = false;
    if (isOneShotChild(ctx) || inFlight) return;
    let usage: ReturnType<ExtensionContext["getContextUsage"]>;
    try {
      usage = ctx.getContextUsage();
    } catch {
      return;
    }
    // Unknown stays unknown: no model / an unknown window returns undefined, and right after a
    // compaction pi reports tokens: null until the next response. Neither is "0 tokens".
    if (usage?.tokens === undefined || usage.tokens === null) return;
    const tokens = usage.tokens;
    if (tokens <= thresholdTokens) {
      armed = true;
      pendingAtSettle = false;
      return;
    }
    if (!atSettle && !armed) return;
    // Automatic compaction obeys both switches; the manual /trigger-compact always works.
    const info = evaluate(ctx, tokens, usage.contextWindow);
    if (!kitTriggerEnabled() || !info.settings.enabled) return;
    if (ctx.signal?.aborted) return; // the operator pressed Esc: do not start work behind their back
    // pi compacts by itself at window - reserveTokens, inside the run, and resumes it. When that
    // trigger is at or below ours, ours can only double-trigger (both firing on the same turn) or
    // never fire; stand down and say so once.
    if (info.nativeWillFire || info.redundant) {
      if (info.redundant && info.native !== null && !notedInactive) {
        notedInactive = true;
        notifySafely(ctx, `Kit auto-compact trigger (${formatTokens(thresholdTokens)}) is at or above pi's own trigger (${formatTokens(info.native)} = window - reserveTokens), so pi compacts first and this trigger is idle. Lower it with /compact-threshold to use it.`, "warning");
      }
      return;
    }
    if (atSettle) {
      if (!pendingAtSettle) return;
      pendingAtSettle = false;
      armed = false;
      triggerCompaction(ctx, { tokens });
      return;
    }
    // A turn that ended without tool calls is the end of the run: compact once pi has settled
    // instead of aborting a run that is already finishing (and losing any queued follow-up).
    const toolResults = (event as { toolResults?: unknown[] } | undefined)?.toolResults;
    const runContinues = !Array.isArray(toolResults) || toolResults.length > 0;
    if (!runContinues) {
      pendingAtSettle = true;
      return;
    }
    const running = typeof ctx.isIdle === "function" ? !ctx.isIdle() : true;
    armed = false;
    triggerCompaction(ctx, { resume: running, tokens });
  };

  pi.on("turn_end", (event, ctx) => {
    maybeFire(ctx, event, false);
  });

  // Pending because the last turn was final: pi has now settled (no retry, compaction or follow-up
  // left), so compacting cannot interrupt anything.
  pi.on("agent_settled", (_event, ctx) => {
    if (pendingAtSettle) maybeFire(ctx, undefined, true);
  });

  pi.registerCommand("trigger-compact", {
    description: "Trigger compaction immediately, optionally with custom instructions",
    handler: async (args, ctx) => {
      const instructions = args.trim() || undefined;
      triggerCompaction(ctx, { customInstructions: instructions });
    },
  });

  pi.registerCommand("compact-threshold", {
    description: "View or change the kit auto-compact trigger: /compact-threshold [amount|off|on|reset], e.g. /compact-threshold 500k",
    handler: async (args, ctx) => {
      const arg = args.trim();
      const usage = ctx.getContextUsage();
      const window = usage?.contextWindow;
      const trusted = typeof ctx.isProjectTrusted === "function" ? ctx.isProjectTrusted() : undefined;
      const settings = piCompactionSettings(ctx.cwd ?? process.cwd(), trusted);
      const native = window && window > 0 ? window - settings.reserveTokens : null;
      // An unknown window is said to be unknown; it is never shown as 0 or omitted silently.
      const windowNote = window && window > 0 ? ` (context window: ${formatTokens(window)})` : " (context window: unknown)";

      if (!arg || arg.toLowerCase() === "status") {
        const source = envOverride !== undefined ? "env override" : loadPersistedThreshold() !== undefined ? "saved" : "default";
        const piOn = settings.enabled;
        const state = !piOn ? "OFF (pi auto-compaction is disabled in /settings)" : !kitTriggerEnabled() ? "OFF (/compact-threshold off)" : "on";
        const idle = native !== null && thresholdTokens >= native ? ` — idle: pi compacts first at ${formatTokens(native)} (window - reserve)` : native === null ? " — cannot tell whether pi compacts first (window unknown)" : ` — fires before pi's own ${formatTokens(native)}`;
        const child = isOneShotChild(ctx) ? " — not used in this one-shot child session (pi's own compaction applies)" : "";
        if (ctx.hasUI) ctx.ui.notify(`Auto-compact trigger: ${state} · threshold ${formatTokens(thresholdTokens)} tokens [${source}]${windowNote}${state === "on" ? idle : ""}${child}`, "info");
        return;
      }

      if (arg.toLowerCase() === "off" || arg.toLowerCase() === "on") {
        const enable = arg.toLowerCase() === "on";
        try {
          savePersisted({ enabled: enable ? undefined : false });
        } catch {
          if (ctx.hasUI) ctx.ui.notify("Could not save the setting; it was not changed", "error");
          return;
        }
        const piNote = enable && !settings.enabled ? " — note: pi auto-compaction is still off in /settings, which also stops this trigger" : "";
        if (ctx.hasUI) ctx.ui.notify(`Kit auto-compact trigger ${enable ? "enabled" : "disabled"}${piNote}. Manual /compact and /trigger-compact still work.`, "info");
        return;
      }

      if (envOverride !== undefined) {
        if (ctx.hasUI) ctx.ui.notify("Auto-compact threshold is locked by PI_KIT_COMPACT_THRESHOLD_TOKENS; unset it to change this from the TUI", "error");
        return;
      }

      if (arg.toLowerCase() === "reset") {
        thresholdTokens = DEFAULT_THRESHOLD_TOKENS;
        armed = true;
        try { savePersisted({ thresholdTokens: undefined }); } catch { /* best effort */ }
        if (ctx.hasUI) ctx.ui.notify(`Auto-compact threshold reset to default (${formatTokens(DEFAULT_THRESHOLD_TOKENS)} tokens)${windowNote}`, "info");
        return;
      }

      const parsed = parseTokenAmount(arg);
      if (parsed === undefined || parsed < MIN_THRESHOLD_TOKENS) {
        if (ctx.hasUI) ctx.ui.notify(`Invalid threshold "${arg}". Use a token count, e.g. 500000 or 500k`, "error");
        return;
      }
      if (window && parsed >= window) {
        if (ctx.hasUI) ctx.ui.notify(`${formatTokens(parsed)} is at or above the ${formatTokens(window)} context window — auto-compact would never fire. Not changed.`, "error");
        return;
      }
      if (native !== null && window !== undefined && parsed >= native) {
        if (ctx.hasUI) ctx.ui.notify(`${formatTokens(parsed)} is at or above pi's own compaction trigger (${formatTokens(native)} = window ${formatTokens(window)} - reserveTokens ${formatTokens(settings.reserveTokens)}): pi would compact first, so this trigger would never fire. Not changed.`, "error");
        return;
      }

      thresholdTokens = parsed;
      armed = true;
      notedInactive = false;
      try {
        savePersistedThreshold(parsed);
      } catch {
        if (ctx.hasUI) ctx.ui.notify(`Threshold set to ${formatTokens(parsed)} for this session, but saving to disk failed — it will not persist across restarts`, "error");
        return;
      }
      if (ctx.hasUI) ctx.ui.notify(`Auto-compact threshold set to ${formatTokens(parsed)} tokens${windowNote}`, "info");
    },
  });
}
