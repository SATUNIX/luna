import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { todoFilePath, resolveSessionId, readTodos } from "./todo-read.ts";
import { agentDir, agentFailureCount, createTotalsCache, costOf, DEFAULT_PRICING, isRecord, loadPricing, readAgents, readBranch, readCompaction, readEffort, readFirewall, readProfile, readSecurity, readUnattended } from "./data.ts";
import { fmtDuration, fmtTokens, footerGlyphs, renderDetail, renderFooter } from "./render.ts";
import type { FooterMode, FooterState, StatusEntry, Theme, TodoItem } from "./render.ts";
import { PHRASES, TIPS, pick, renderTodoWidget, toolPhrase } from "./widgets.ts";
import type { Tip } from "./widgets.ts";
import { ANIMATIONS, TRANSIENT, classifyToolError, finished, indicatorFor, renderCat, resolveCatState, transientHoldMs } from "./cat.ts";
import type { CatState } from "./cat.ts";

// Status bar (custom-footer). This is the ONE owner of the footer: no other extension installs one.
//
//  1. Footer: replaces pi's built-in footer through ctx.ui.setFooter(factory). Three densities,
//     each built from prioritised segments so a narrow terminal drops the least important first and
//     never a boundary or failure warning (./render.ts). It shows the effort tier, unattended
//     state, compaction state and live children published by their owners (globalThis registries),
//     and marks costs as measured, estimated or unknown. Rendering reads a cache: no subprocess and
//     no disk read per render or tick.
//  2. Working line: while the agent runs, a 1 s ticker sets the working message to
//     "<activity>… 1m 04s · ↑12.3k ↓~850". The ticker exists only while a request runs, and is
//     cleared on agent end, on session start (reload) and on shutdown.
//  3. Tips and todos widgets (/tips, /footer todos).
//  4. The cat (./cat.ts): a fixed-width ASCII face for the agent's semantic state. While a request
//     runs it replaces pi's spinner (setWorkingIndicator), re-set only when the resolved state
//     changes; between requests the footer shows it, and a result (done, warning, denied, error,
//     cancelled) plays through once on a short timer that clears itself. /footer cat on|off.
//
// Settings persist in <agent dir>/pi-kit/ui.json. Invalid arguments never change them.

export type { FooterMode, FooterState, TodoItem, StatusEntry } from "./render.ts";
export { estimateCost, sessionTotals, costOf, createTotalsCache } from "./data.ts";
export type { UsageTotals } from "./data.ts";
export { fmtTokens, fmtCost, fmtCostView, fmtDuration, footerGlyphs, renderFooter, renderDetail, statusChip, visibleWidth, truncate } from "./render.ts";
export { PHRASES, TIPS, toolPhrase, renderTodoWidget } from "./widgets.ts";
export type { Tip } from "./widgets.ts";

type FooterCtx = ExtensionContext;
type UiSettings = { footer: boolean; mode: FooterMode; tips: boolean; todos: boolean; cat: boolean; ascii?: boolean };

const TIP_WIDGET = "pi-kit-tips";
const TODO_WIDGET = "pi-kit-todos";
const TICK_MS = 1000;
const PHRASE_ROTATE_MS = 8000;
const TIP_ROTATE_MS = 30000;
const MODES: FooterMode[] = ["default", "light", "heavy"];

function isFooterMode(value: unknown): value is FooterMode {
  return MODES.some((mode) => mode === value);
}

/** `String(value)` for a value of any type (event payloads are not checked by pi). */
const toText = (value: unknown): string => String(value);

export function readTodoItems(cwd: string, sessionId?: string): TodoItem[] {
  try {
    return readTodos(todoFilePath(cwd, sessionId)).todos.map((t) => ({ id: t.id, text: t.text.trim(), state: t.state }));
  } catch {
    return [];
  }
}

function settingsFile(): string {
  return path.join(agentDir(), "pi-kit", "ui.json");
}

/** Read <agent dir>/pi-kit/ui.json; anything malformed falls back to the defaults, key by key. */
export function loadSettings(): UiSettings {
  const defaults: UiSettings = { footer: true, mode: "default", tips: process.env.PI_KIT_TIPS !== "0", todos: process.env.PI_KIT_TODO_WIDGET !== "0", cat: process.env.PI_KIT_CAT !== "0" };
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
    // A file that is not an object has no usable keys: each one falls back to its default.
    const raw: Record<string, unknown> = isRecord(parsed) ? parsed : {};
    const out: UiSettings = {
      footer: typeof raw.footer === "boolean" ? raw.footer : defaults.footer,
      mode: isFooterMode(raw.mode) ? raw.mode : defaults.mode,
      tips: process.env.PI_KIT_TIPS === "0" ? false : typeof raw.tips === "boolean" ? raw.tips : defaults.tips,
      todos: process.env.PI_KIT_TODO_WIDGET === "0" ? false : typeof raw.todos === "boolean" ? raw.todos : defaults.todos,
      cat: process.env.PI_KIT_CAT === "0" ? false : typeof raw.cat === "boolean" ? raw.cat : defaults.cat,
    };
    if (raw.ascii === true) out.ascii = true;
    return out;
  } catch {
    return defaults;
  }
}

function saveSettings(settings: UiSettings): string | null {
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Lower-cased words of a command argument (a string, or an array pi may pass). */
export function commandArgs(args: unknown): string[] {
  if (Array.isArray(args)) return args.map((a) => String(a).trim().toLowerCase()).filter(Boolean);
  if (typeof args === "string") return args.trim().split(/\s+/).filter(Boolean).map((a) => a.toLowerCase());
  return [];
}

/** on/off words; `undefined` (no word) means toggle; anything else is invalid (null). */
export function parseOnOff(value: string | undefined, current: boolean): boolean | null {
  if (value === undefined) return !current;
  if (["on", "true", "1", "yes"].includes(value)) return true;
  if (["off", "false", "0", "no"].includes(value)) return false;
  return null;
}

const USAGE = "Usage: /footer default|light|heavy | on | off | status | reload | todos [on|off] | ascii [on|off] | cat [on|off] | config";

export default function (pi: ExtensionAPI) {
  let settings = loadSettings();
  let pricing = { ...DEFAULT_PRICING };
  let ctxRef: FooterCtx | undefined;
  let requestRender: (() => void) | undefined;
  let footerInstalled = false;
  let disposed = false;
  const totalsCache = createTotalsCache();
  let cache: Omit<FooterState, "now" | "statuses" | "running" | "agents" | "effort" | "security" | "unattended" | "compaction" | "cat"> & { statusProvider?: (() => Array<[string, string]>) | undefined } = {
    cwd: process.cwd(),
    totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 },
    partial: false,
    cost: { kind: "unknown" },
    todos: [],
  };
  let profile: string | undefined;
  let firewall: FooterState["firewall"];
  let branchFromPi: string | undefined;
  let failedBase = 0;
  let todoStat = "";
  const seen = new Map<string, { text: string; at: number }>();

  // Current agent run (user prompt -> agent_end).
  let run: { startedAt: number; endedAt?: number; input: number; output: number; estOutput: number } | undefined;
  let activity: { label: string; until: number } | undefined;
  let phrase = PHRASES[0];
  let phraseAt = 0;
  let tip: Tip | undefined;
  let tipAt = 0;
  let ticker: ReturnType<typeof setInterval> | undefined;
  let unsubscribeEffort: (() => void) | undefined;

  // The cat. `live` holds what the current request is doing; `result` is a finished event still on
  // show; `applied` is the state last given to pi's working indicator.
  let live: { kind?: "thinking" | "streaming" | "working"; until: number } = { until: 0 };
  let toolsRunning = 0;
  let promptOpen = false;
  let compacting = false;
  let result: { state: CatState; at: number } | undefined;
  let applied: { state: CatState; at: number } | undefined;
  let catTimer: ReturnType<typeof setTimeout> | undefined;

  const hasTui = (ctx?: FooterCtx) => {
    // Test harnesses and older hosts may omit `hasUI` (or `ui`): only an explicit false means none.
    const host: { hasUI?: boolean; ui?: unknown } | undefined = ctx;
    return !!host && host.hasUI !== false && !!host.ui;
  };
  const isRunning = () => Boolean(run && run.endedAt === undefined);
  const say = (ctx: FooterCtx | undefined, text: string, level: "info" | "warning" | "error" = "info") => {
    if (ctx && hasTui(ctx) && typeof ctx.ui.notify === "function") ctx.ui.notify(text, level);
    else process.stderr.write(`[footer] ${text}\n`);
  };

  function readTodosCached(cwd: string, sessionId: string | undefined): TodoItem[] {
    // A stat is far cheaper than parsing the file on every event; re-read only when it changed.
    let stat: string;
    try {
      const s = fs.statSync(todoFilePath(cwd, sessionId));
      stat = `${s.mtimeMs}:${s.size}`;
    } catch {
      stat = "none";
    }
    if (stat === todoStat && stat !== "") return cache.todos;
    todoStat = stat;
    return stat === "none" ? [] : readTodoItems(cwd, sessionId);
  }

  function refresh(ctx: FooterCtx | undefined): void {
    if (!ctx || disposed) return;
    ctxRef = ctx;
    const cwd = ctx.cwd ?? process.cwd();
    let entries: unknown = [];
    try { entries = ctx.sessionManager?.getEntries?.() ?? []; } catch { /* stale ctx */ }
    const { totals, partial } = totalsCache.update(entries);
    let context: FooterState["context"];
    try { context = ctx.getContextUsage?.() ?? undefined; } catch { context = undefined; }
    let thinking: string | undefined;
    try { thinking = pi.getThinkingLevel?.(); } catch { thinking = undefined; }
    let sessionName: string | undefined;
    try { sessionName = ctx.sessionManager?.getSessionName?.(); } catch { sessionName = undefined; }
    const sessionId = resolveSessionId(ctx.sessionManager);
    cache = {
      ...cache,
      cwd,
      branch: branchFromPi ?? cache.branch,
      sessionName,
      provider: ctx.model?.provider,
      model: ctx.model?.id,
      thinking,
      profile,
      firewall,
      pricingSource: pricing.source,
      context: context ? { ...context, contextWindow: context.contextWindow ?? ctx.model?.contextWindow } : { contextWindow: ctx.model?.contextWindow },
      totals,
      partial,
      cost: costOf(totals, pricing),
      todos: readTodosCached(cwd, sessionId),
      ascii: settings.ascii,
    };
    updateTodoWidget(ctx);
    requestRender?.();
  }

  /** The bar's input: the cache plus what other extensions publish, read from memory only. */
  function state(): FooterState {
    const now = Date.now();
    let raw: Array<[string, string]>;
    try { raw = cache.statusProvider?.() ?? []; } catch { raw = []; }
    const present = new Set(raw.map(([k]) => k));
    for (const key of [...seen.keys()]) if (!present.has(key)) seen.delete(key);
    const statuses: StatusEntry[] = raw.map(([key, text]) => {
      const prior = seen.get(key);
      if (prior?.text !== text) seen.set(key, { text, at: now });
      return { key, text, ageMs: now - (seen.get(key)?.at ?? now) };
    });
    return { ...cache, cat: catView(now), running: isRunning(), agents: readAgents(failedBase), effort: readEffort(), security: readSecurity(), unattended: readUnattended(), compaction: readCompaction(), statuses, now };
  }

  function installFooter(ctx: FooterCtx): void {
    if (!hasTui(ctx) || typeof ctx.ui.setFooter !== "function") return;
    ctx.ui.setFooter((tui, theme, footerData) => {
      requestRender = () => { try { tui?.requestRender?.(); } catch { /* ignore */ } };
      cache.statusProvider = () => [...(footerData?.getExtensionStatuses?.() ?? new Map<string, string>()).entries()].sort(([a], [b]) => a.localeCompare(b));
      const unsubscribe = footerData?.onBranchChange?.(() => { branchFromPi = footerData.getGitBranch?.() ?? undefined; cache.branch = branchFromPi; requestRender?.(); });
      branchFromPi = footerData?.getGitBranch?.() ?? branchFromPi;
      if (branchFromPi) cache.branch = branchFromPi;
      return {
        render(width: number): string[] {
          try {
            return renderFooter(state(), theme, width, settings.mode);
          } catch (error) {
            const t = cache.totals;
            return [`status bar error (${String((error as { message?: unknown } | null | undefined)?.message ?? error)}) | in ${fmtTokens(t.input)} out ${fmtTokens(t.output)} | ${cache.model ?? "no model"}`.slice(0, Math.max(10, width))];
          }
        },
        invalidate() {},
        dispose() {
          try { unsubscribe?.(); } catch { /* ignore */ }
          requestRender = undefined;
          cache.statusProvider = undefined;
        },
      };
    });
    footerInstalled = true;
  }

  function removeFooter(ctx: FooterCtx): void {
    if (!hasTui(ctx)) return;
    try { ctx.ui.setFooter?.(undefined); } catch { /* ignore */ }
    footerInstalled = false;
  }

  function updateTodoWidget(ctx: FooterCtx): void {
    if (!hasTui(ctx) || typeof ctx.ui.setWidget !== "function") return;
    const theme: Theme | undefined = ctx.ui.theme;
    if (!settings.todos || !theme || !cache.todos.length) {
      ctx.ui.setWidget(TODO_WIDGET, undefined);
      return;
    }
    ctx.ui.setWidget(TODO_WIDGET, renderTodoWidget(cache.todos, theme));
  }

  function availableTips(): Tip[] {
    let names = new Set<string>();
    try { names = new Set((pi.getCommands?.() ?? []).map((c: { name?: unknown }) => String(c.name).replace(/^\//, ""))); } catch { /* ignore */ }
    return TIPS.filter((t) => !t.requires || names.has(t.requires));
  }

  function workingText(now: number): string {
    const theme: Theme | undefined = ctxRef?.ui?.theme;
    const fg = (c: string, s: string) => (theme ? theme.fg(c, s) : s);
    const glyphs = footerGlyphs(theme ?? { fg: (_c: string, t: string) => t, bold: (t: string) => t }, settings.ascii);
    if (now - phraseAt > PHRASE_ROTATE_MS) { phrase = pick(PHRASES, phrase); phraseAt = now; }
    const label = activity && activity.until > now ? activity.label : phrase;
    if (!run) return `${label}${glyphs.ellipsis}`;
    const out = run.output + run.estOutput;
    return `${label}${glyphs.ellipsis} ${fg("dim", "(")}${fg("text", fmtDuration(now - run.startedAt))}${fg("dim", glyphs.ascii ? " | " : " · ")}${fg("success", `${glyphs.input}${fmtTokens(run.input)}`)} ${fg("accent", `${glyphs.output}${run.estOutput > 0 ? "~" : ""}${fmtTokens(out)}`)}${fg("dim", ")")}`;
  }

  function tick(): void {
    const ctx = ctxRef;
    if (disposed || !ctx || !hasTui(ctx) || !isRunning()) return;
    const now = Date.now();
    try { ctx.ui.setWorkingMessage?.(workingText(now)); } catch { /* ignore */ }
    syncCat();
    if (settings.tips) {
      if (!tip || now - tipAt > TIP_ROTATE_MS) {
        const tips = availableTips();
        tip = tips.length ? pick(tips, tip) : undefined;
        tipAt = now;
        const theme: Theme | undefined = ctx.ui.theme;
        if (tip && theme) ctx.ui.setWidget?.(TIP_WIDGET, [`${theme.fg("dim", "  ⎿ Tip: ")}${theme.fg("muted", tip.text)}`]);
      }
    }
    requestRender?.();
  }

  function stopTicker(ctx?: FooterCtx): void {
    if (ticker) clearInterval(ticker);
    ticker = undefined;
    tip = undefined;
    const c = ctx ?? ctxRef;
    if (c && hasTui(c)) {
      try { c.ui.setWidget?.(TIP_WIDGET, undefined); } catch { /* ignore */ }
      try { c.ui.setWorkingMessage?.(); } catch { /* ignore */ }
    }
  }

  const paint = (colour: string, text: string): string => {
    const theme: Theme | undefined = ctxRef?.ui?.theme;
    return theme ? theme.fg(colour, text) : text;
  };

  /** The cat's state right now, by the explicit priority in cat.ts. */
  function catState(now: number): CatState {
    const active: CatState[] = [];
    if (promptOpen) active.push("waiting_for_user");
    if (compacting) active.push("crunching");
    if (isRunning()) {
      if (toolsRunning > 0) active.push("tool");
      // Until the first token arrives the model is thinking; a delta then says what it is producing.
      active.push(live.kind && live.until > now ? live.kind : "thinking");
    }
    if (result && now - result.at < transientHoldMs(result.state)) active.push(result.state);
    return resolveCatState(active);
  }

  function setResult(state: CatState): void {
    if (!settings.cat) return;
    result = { state, at: Date.now() };
    syncCat();
  }

  /** Follow the resolved state: re-set pi's indicator on a change, and arm the footer timer. */
  function syncCat(): void {
    if (disposed || !settings.cat) return;
    const ctx = ctxRef;
    const now = Date.now();
    const next = catState(now);
    if (applied?.state !== next) {
      applied = { state: next, at: now };
      if (isRunning() && ctx && hasTui(ctx) && typeof ctx.ui.setWorkingIndicator === "function") {
        try { ctx.ui.setWorkingIndicator(indicatorFor(next, paint)); } catch { /* ignore */ }
      }
    }
    armCatTimer(next, now);
    requestRender?.();
  }

  /** While idle, only a result still playing (or on show) needs a redraw; nothing else ticks. */
  function armCatTimer(state: CatState, now: number): void {
    if (catTimer) clearTimeout(catTimer);
    catTimer = undefined;
    if (isRunning() || !result) return;
    const age = now - result.at;
    if (age >= transientHoldMs(result.state)) { result = undefined; return; }
    const interval = finished(state, age) ? Math.max(50, transientHoldMs(result.state) - age) : ANIMATIONS[state].intervalMs;
    catTimer = setTimeout(() => { catTimer = undefined; syncCat(); }, interval);
    catTimer.unref?.();
  }

  function stopCat(ctx?: FooterCtx): void {
    if (catTimer) clearTimeout(catTimer);
    catTimer = undefined;
    const c = ctx ?? ctxRef;
    if (applied && c && hasTui(c)) {
      try { c.ui.setWorkingIndicator?.(); } catch { /* ignore */ }
    }
    applied = undefined;
  }

  function catView(now: number): FooterState["cat"] {
    if (!settings.cat || isRunning()) return undefined;
    const state = catState(now);
    const since = result && TRANSIENT.has(state) ? result.at : now;
    return { text: renderCat(state, now - since, paint), label: state === "idle" ? undefined : ANIMATIONS[state].label };
  }

  function reloadPricing(ctx: FooterCtx): void {
    const result = loadPricing(ctx.cwd ?? process.cwd(), pricing);
    pricing = result.pricing;
    if (result.warning) say(ctx, result.warning, "warning");
  }

  pi.on("session_start", async (_event, ctx) => {
    disposed = false;
    settings = loadSettings();
    run = undefined;
    stopTicker(ctx);
    stopCat(ctx);
    live = { until: 0 }; toolsRunning = 0; promptOpen = false; compacting = false; result = undefined;
    unsubscribeEffort?.();
    unsubscribeEffort = undefined;
    seen.clear();
    totalsCache.reset();
    todoStat = "";
    failedBase = agentFailureCount();
    const cwd = ctx.cwd ?? process.cwd();
    // Read once per session (or reload): the installer's profile marker, the firewall config and a
    // fallback branch, so refresh() never touches the disk or a subprocess for them.
    profile = readProfile(cwd);
    firewall = readFirewall();
    cache.branch = readBranch(cwd);
    reloadPricing(ctx);
    if (settings.footer) installFooter(ctx);
    try {
      const effort = (globalThis as Record<symbol, unknown>)[Symbol.for("pi-kit.effort")] as { onChange?(l: () => void): () => void } | undefined;
      unsubscribeEffort = effort?.onChange?.(() => requestRender?.());
    } catch { /* the tier chip just updates on the next refresh */ }
    refresh(ctx);
  });

  // A finished session must leave nothing running: the ticker, its widgets and the render hook.
  pi.on("session_shutdown", async (_event, ctx) => {
    disposed = true;
    stopTicker(ctx);
    stopCat(ctx);
    result = undefined;
    unsubscribeEffort?.();
    unsubscribeEffort = undefined;
    requestRender = undefined;
    cache.statusProvider = undefined;
    run = undefined;
    activity = undefined;
    seen.clear();
    const c = ctx;
    if (hasTui(c)) {
      try { c.ui.setWidget?.(TODO_WIDGET, undefined); } catch { /* ignore */ }
    }
  });

  pi.on("agent_start", async (_event, ctx) => {
    ctxRef = ctx;
    run = { startedAt: Date.now(), input: 0, output: 0, estOutput: 0 };
    failedBase = agentFailureCount();
    phrase = pick(PHRASES);
    phraseAt = Date.now();
    tip = undefined;
    result = undefined;
    live = { until: 0 };
    toolsRunning = 0;
    applied = undefined;
    if (ticker) clearInterval(ticker);
    if (hasTui(ctx)) {
      ticker = setInterval(tick, TICK_MS);
      ticker.unref?.();
      tick();
    }
    syncCat();
  });

  pi.on("message_update", async (event) => {
    if (!run) return;
    const e: { type?: unknown; delta?: unknown } | undefined = event?.assistantMessageEvent;
    const now = Date.now();
    if (e?.type === "text_delta" || e?.type === "thinking_delta" || e?.type === "toolcall_delta") {
      run.estOutput += Math.max(0, toText(e.delta ?? "").length / 4);
      if (!activity || activity.until < now || !activity.label.startsWith("Running")) {
        activity = { label: e.type === "thinking_delta" ? "Thinking" : e.type === "text_delta" ? "Writing the response" : "Preparing a tool call", until: now + 1500 };
      }
      live = { kind: e.type === "thinking_delta" ? "thinking" : e.type === "text_delta" ? "streaming" : "working", until: now + 1500 };
    }
  });

  pi.on("message_end", async (event, ctx) => {
    const msg: { role?: unknown; usage?: { input?: unknown; output?: unknown } | null } | undefined = event?.message;
    if (run && msg?.role === "assistant") {
      run.input += Number(msg.usage?.input) || 0;
      run.output += Number(msg.usage?.output) || 0;
      run.estOutput = 0;
    }
    refresh(ctx);
  });

  pi.on("tool_execution_start", async (event) => {
    toolsRunning++;
    syncCat();
    activity = { label: toolPhrase(event?.toolName ?? "tool", event?.args), until: Number.MAX_SAFE_INTEGER };
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    activity = undefined;
    toolsRunning = Math.max(0, toolsRunning - 1);
    if (event?.isError) setResult(classifyToolError(event.result));
    else syncCat();
    if (["todo", "write", "edit"].includes(event?.toolName)) refresh(ctx);
  });

  pi.on("turn_end", async (_event, ctx) => {
    refresh(ctx);
  });

  pi.on("agent_end", async (event, ctx) => {
    if (run) run.endedAt = Date.now();
    activity = undefined;
    toolsRunning = 0;
    stopTicker(ctx);
    stopCat(ctx);
    if (settings.cat && run) {
      const last: { role?: unknown; stopReason?: unknown } | undefined = [...(Array.isArray(event?.messages) ? event.messages : [])].reverse().find((m) => m?.role === "assistant");
      setResult(last?.stopReason === "error" ? "error" : last?.stopReason === "aborted" ? "cancelled" : "success");
    }
    refresh(ctx);
  });

  // A blocking prompt (an approval, a question) means the agent cannot go on without the user.
  pi.on("ui_prompt_start", async () => { promptOpen = true; syncCat(); });
  pi.on("ui_prompt_end", async () => { promptOpen = false; syncCat(); });
  pi.on("session_before_compact", async () => { compacting = true; syncCat(); });
  pi.on("session_compact", async () => { compacting = false; syncCat(); });
  pi.on("session_compact_failed", async () => { compacting = false; setResult("warning"); });

  pi.on("model_select", async (_event, ctx) => refresh(ctx));
  pi.on("thinking_level_select", async (_event, ctx) => refresh(ctx));

  const modeLabel = () => (settings.footer ? settings.mode : "off");

  pi.registerCommand("footer", {
    description: "Status bar: /footer default|light|heavy, /footer on|off, /footer status (every detail the bar drops when narrow), /footer reload, /footer todos on|off, /footer ascii on|off, /footer cat on|off, /footer config",
    getArgumentCompletions: (prefix: string) => ["default", "light", "heavy", "on", "off", "status", "reload", "todos on", "todos off", "ascii on", "ascii off", "cat on", "cat off", "config"].filter((v) => v.startsWith(prefix.trim().toLowerCase())).map((v) => ({ value: v, label: v })),
    handler: async (args, ctx) => {
      const footerCtx: FooterCtx = ctx;
      const [arg, value, ...extra] = commandArgs(args);
      const persist = (message: string) => {
        const failure = saveSettings(settings);
        say(footerCtx, failure ? `${message} (could not save it: ${failure})` : message, failure ? "warning" : "info");
      };
      const apply = () => {
        if (settings.footer) installFooter(footerCtx);
        else removeFooter(footerCtx);
        refresh(footerCtx);
      };
      const invalid = (what: string) => say(footerCtx, `footer: ${what}. Nothing was changed.\n${USAGE}`, "error");

      if (arg === "status") {
        refresh(footerCtx);
        say(footerCtx, renderDetail(state(), modeLabel()).concat([`  settings    tips ${settings.tips ? "on" : "off"}, todos ${settings.todos ? "on" : "off"}, cat ${settings.cat ? "on" : "off"}, ascii ${settings.ascii ? "on" : "auto"} (${settingsFile()})` ]).join("\n"));
        return;
      }
      if (arg === "reload") {
        reloadPricing(footerCtx);
        refresh(footerCtx);
        say(footerCtx, `Status bar pricing reloaded from ${pricing.source}`);
        return;
      }
      if (arg === "todos") {
        const next = parseOnOff(value, settings.todos);
        if (next === null || extra.length) { invalid(`"${value}" is not on or off`); return; }
        settings.todos = next;
        refresh(footerCtx);
        persist(`todo checklist ${settings.todos ? "on" : "off"}`);
        return;
      }
      if (arg === "ascii") {
        const next = parseOnOff(value, Boolean(settings.ascii));
        if (next === null || extra.length) { invalid(`"${value}" is not on or off`); return; }
        if (next) settings.ascii = true;
        else delete settings.ascii;
        refresh(footerCtx);
        persist(`ASCII status bar ${settings.ascii ? "on" : "off (chosen from the theme)"}`);
        return;
      }
      if (arg === "cat") {
        const next = parseOnOff(value, settings.cat);
        if (next === null || extra.length) { invalid(`"${value}" is not on or off`); return; }
        settings.cat = next;
        if (!next) { stopCat(footerCtx); result = undefined; }
        else if (isRunning()) { applied = undefined; syncCat(); }
        refresh(footerCtx);
        persist(`cat ${settings.cat ? "on" : "off (pi's own spinner is used)"}`);
        return;
      }
      if (arg === "config" || arg === "settings") {
        if (!hasTui(footerCtx) || typeof footerCtx.ui.select !== "function") { say(footerCtx, `footer: /footer config needs an interactive session. ${USAGE}`, "warning"); return; }
        const choice = await footerCtx.ui.select("Status bar", ["default", "light", "heavy", "off"]);
        if (!choice) return;
        if (choice === "off") settings.footer = false;
        else {
          settings.footer = true;
          settings.mode = choice as FooterMode;
        }
        apply();
        persist(settings.footer ? `Status bar set to ${settings.mode}` : "Status bar disabled (pi's built-in footer restored)");
        return;
      }
      if (arg && isFooterMode(arg)) {
        if (value !== undefined) { invalid(`unexpected "${value}" after ${arg}`); return; }
        settings.footer = true;
        settings.mode = arg;
        apply();
        persist(`Status bar set to ${settings.mode}`);
        return;
      }
      if (arg === undefined || arg === "on" || arg === "off") {
        if (value !== undefined) { invalid(`unexpected "${value}" after ${arg}`); return; }
        settings.footer = arg === "on" ? true : arg === "off" ? false : !settings.footer;
        apply();
        persist(settings.footer ? "Status bar enabled" : "Status bar disabled (pi's built-in footer restored)");
        return;
      }
      invalid(`unknown option "${arg}"`);
    },
  });

  pi.registerCommand("tips", {
    description: "Show or hide usage tips while the agent works: /tips on|off",
    handler: async (args, ctx) => {
      const footerCtx: FooterCtx = ctx;
      const [value, ...extra] = commandArgs(args);
      const next = parseOnOff(value, settings.tips);
      if (next === null || extra.length) { say(footerCtx, `tips: "${value}" is not on or off. Nothing was changed. Usage: /tips on|off`, "error"); return; }
      settings.tips = next;
      const failure = saveSettings(settings);
      if (!settings.tips && hasTui(footerCtx)) {
        try { footerCtx.ui.setWidget?.(TIP_WIDGET, undefined); } catch { /* ignore */ }
      }
      say(footerCtx, `tips ${settings.tips ? "on" : "off"}${failure ? ` (could not save it: ${failure})` : ""}`, failure ? "warning" : "info");
    },
  });

  // exposed for tests
  Object.assign(pi, { __footerDebug: { state, workingText, isInstalled: () => footerInstalled, tickerActive: () => ticker !== undefined, catTimerActive: () => catTimer !== undefined, catState: () => catState(Date.now()), seen } });
}
