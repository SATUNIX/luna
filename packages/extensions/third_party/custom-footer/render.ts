/**
 * Status bar rendering: pure functions from a state snapshot to lines, no I/O.
 *
 * Every line is built from prioritised segments. When the terminal is too narrow the least
 * important segment goes first (path and provider, then tokens, then branch and thinking), long
 * segments switch to a shorter form before anything is dropped, and segments that carry a
 * boundary or failure warning are never dropped for secondary telemetry. Widths are terminal
 * columns (wide characters, emoji and ANSI sequences handled by ./width.ts).
 *
 * Priorities (lower survives longer):
 *   0 critical warnings   unattended / not-enforced, compaction off, failed work, blocked
 *   1 identity            project, model, effort
 *   2 active work         live children, todo progress, running checks
 *   3 context             window headroom
 *   4 orientation         branch, thinking level, profile
 *   5 telemetry           tokens, cost
 *   6 detail              path, provider, session name
 *   7 other chips         extension statuses that are neither active nor failing
 */
import os from "node:os";
import path from "node:path";
import type { AgentsView, CompactionView, Cost, EffortView, FirewallView, UnattendedView, UsageTotals } from "./data.ts";
import { displayWidth, padDisplay, truncateDisplay } from "./width.ts";

export type Theme = { fg: (color: string, text: string) => string; bold: (text: string) => string; name?: string };
export type FooterMode = "default" | "light" | "heavy";
export type TodoItem = { id: number; text: string; state: "open" | "active" | "done" };
export type StatusEntry = { key: string; text: string; ageMs?: number };

export type FooterState = {
  cwd: string;
  branch?: string;
  sessionName?: string;
  provider?: string;
  model?: string;
  thinking?: string;
  profile?: string;
  context?: { tokens?: number | null; contextWindow?: number; percent?: number | null };
  totals: UsageTotals;
  partial: boolean;
  cost: Cost;
  pricingSource?: string;
  effort?: EffortView;
  unattended?: UnattendedView;
  compaction?: CompactionView;
  agents?: AgentsView;
  firewall?: FirewallView;
  /** True while a request is running (stale transient chips stay visible then). */
  running?: boolean;
  /** The cat for the idle footer: a coloured, fixed-width face and, after an event, its status text. */
  cat?: { text: string; label?: string };
  statuses: StatusEntry[];
  todos: TodoItem[];
  now: number;
  /** Force ASCII glyphs (also chosen automatically for ISO/ANSI/TTY themes). */
  ascii?: boolean;
};

// --- formatting -------------------------------------------------------------------------------

export function fmtTokens(value: number): string {
  if (value < 1000) return `${Math.round(value)}`;
  if (value < 10_000) return `${(value / 1000).toFixed(1)}k`;
  if (value < 1_000_000) return `${Math.round(value / 1000)}k`;
  if (value < 10_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  return `${Math.round(value / 1_000_000)}M`;
}

export function fmtCost(value: number | undefined): string {
  if (value === undefined) return "unknown";
  if (value === 0) return "$0.00";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

/** `$1.23` measured, `~$1.23` estimated from configured prices, `?` when unknown. */
export function fmtCostView(cost: Cost): string {
  if (cost.kind === "unknown" || cost.value === undefined) return "?";
  return `${cost.kind === "estimated" ? "~" : ""}${fmtCost(cost.value)}`;
}

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

export function shortCwd(cwd: string, home = os.homedir()): string {
  const rel = path.relative(home, cwd);
  const inside = rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  const shown = inside ? (rel ? `~${path.sep}${rel}` : "~") : cwd;
  const parts = shown.split(/[\\/]/);
  return parts.length > 4 ? [parts[0], "…", ...parts.slice(-2)].join(path.sep) : shown;
}

export type Glyphs = {
  ascii: boolean;
  marker: string;
  separator: string;
  filled: string;
  empty: string;
  input: string;
  output: string;
  cache: string;
  done: string;
  active: string;
  open: string;
  more: string;
  ellipsis: string;
  warn: string;
  dot: string;
};

export function footerGlyphs(theme: Theme, forceAscii = false): Glyphs {
  // Themes named iso/ansi/tty/ascii, or PI_KIT_ASCII=1, use only characters on a standard keyboard.
  const ascii = forceAscii || /(?:^|[-_])(iso|ansi|tty|ascii)(?:[-_]|$)/i.test(theme.name ?? "") || process.env.PI_KIT_ASCII === "1";
  return ascii
    ? { ascii, marker: ">", separator: " | ", filled: "=", empty: "-", input: "in:", output: "out:", cache: "cache:", done: "[x]", active: "[>]", open: "[ ]", more: "...", ellipsis: "...", warn: "!", dot: "-" }
    : { ascii, marker: "●", separator: " │ ", filled: "█", empty: "░", input: "↑", output: "↓", cache: "⟲", done: "✔", active: "▸", open: "☐", more: "…", ellipsis: "…", warn: "!", dot: "·" };
}

function bar(pct: number, cells: number, theme: Theme, glyphs: Glyphs): string {
  const filled = Math.max(0, Math.min(cells, Math.round((pct / 100) * cells)));
  const color = pct > 90 ? "error" : pct > 70 ? "warning" : "success";
  return theme.fg(color, glyphs.filled.repeat(filled)) + theme.fg("dim", glyphs.empty.repeat(cells - filled));
}

function thinkingColor(level?: string): string {
  switch (level) {
    case "minimal": return "thinkingMinimal";
    case "low": return "thinkingLow";
    case "medium": return "thinkingMedium";
    case "high": return "thinkingHigh";
    case "xhigh": return "thinkingXhigh";
    default: return "thinkingOff";
  }
}

// --- status chips -----------------------------------------------------------------------------

export type ChipSeverity = "error" | "warn" | "ok" | "active" | "info";

export function chipSeverity(text: string): ChipSeverity {
  if (/\b(fail|failed|error|blocked|denied|lost=[1-9])/i.test(text)) return "error";
  if (/\b(warn|stale|partial|no script|pending)/i.test(text)) return "warn";
  if (/\b(pass|passed|ok|ready|on|done|lost=0)\b/i.test(text)) return "ok";
  if (/running|…|\.\.\./i.test(text)) return "active";
  return "info";
}

const SEVERITY_COLOR: Record<ChipSeverity, string> = { error: "error", warn: "warning", ok: "success", active: "accent", info: "text" };

/** Chips that describe work in flight; they are hidden once stale and nothing is running. */
export const TRANSIENT_KEYS = new Set(["subagent", "workflow", "orchestrator", "profile", "console", "kit-update", "verify-gate", "verify", "recovery-orchestrator"]);
export const STALE_CHIP_MS = 120_000;

export function statusChip(key: string, raw: string, theme: Theme, maxWidth = 40): string {
  const text = raw.replace(/[\r\n\t]+/g, " ").replace(/ +/g, " ").trim();
  const label = key.replace(/^pi-kit-/, "");
  // Many extensions already prefix their own name ("trace-ledger: lost=0").
  const prefixed = text.match(/^([\w.-]+):\s*(.*)$/);
  const name = prefixed && prefixed[1].toLowerCase() === label.toLowerCase() ? prefixed[1] : label;
  const value = prefixed && prefixed[1].toLowerCase() === label.toLowerCase() ? prefixed[2] : text;
  const chip = `${theme.fg("dim", name)} ${theme.fg(SEVERITY_COLOR[chipSeverity(value)], value)}`;
  return truncateDisplay(chip, maxWidth);
}

// --- fitting ----------------------------------------------------------------------------------

type Seg = { id: string; prio: number; text: string; alts?: string[] };

const join = (segs: Seg[], sep: string) => segs.map((s) => s.text).join(sep);

/**
 * Lay `left` and `right` on one line of `width` columns. Too wide: shorten segments to their
 * alternative forms (least important first), then drop the least important segment, and only
 * truncate when nothing but critical segments and the anchor (the first left segment) remain.
 */
export function fitLine(left: Seg[], right: Seg[], width: number, sep: string): string {
  let l = left.filter((s) => s.text);
  let r = right.filter((s) => s.text);
  const size = () => {
    const lw = displayWidth(join(l, sep));
    const rw = r.length ? displayWidth(join(r, sep)) : 0;
    return { lw, rw, total: lw + (rw ? rw + 2 : 0) };
  };
  const byLeastImportant = () => [...l, ...r].sort((a, b) => b.prio - a.prio);
  // 1. shorter forms
  for (let guard = 0; guard < 64 && size().total > width; guard++) {
    const target = byLeastImportant().find((s) => s.alts && s.alts.length);
    if (!target) break;
    target.text = target.alts!.shift()!;
  }
  // 2. drop secondary segments (priority 2 and below, least important first) before any warning or
  //    identity segment is touched
  const anchor = l[0];
  const dropWhere = (min: number) => {
    while (size().total > width) {
      const drop = byLeastImportant().find((s) => s.prio >= min && s !== anchor);
      if (!drop) return;
      l = l.filter((s) => s !== drop);
      r = r.filter((s) => s !== drop);
    }
  };
  dropWhere(2);
  // 3. still too wide with several critical warnings: name the first and count the rest; the full
  //    list stays one keystroke away in /footer status. Identity (priority 1) goes last of all.
  if (size().total > width) {
    const critical = [...l, ...r].filter((s) => s.prio === 0);
    if (critical.length >= 2) {
      const first = critical[0];
      const merged: Seg = { id: "critical", prio: 0, text: `${first.text} +${critical.length - 1}` };
      const replace = (segs: Seg[]) => {
        let placed = false;
        return segs.flatMap((s) => (s.prio !== 0 ? [s] : placed ? [] : ((placed = true), [merged])));
      };
      l = replace(l);
      r = replace(r);
    }
  }
  dropWhere(1);
  // 4. truncate what is left
  const { lw, rw, total } = size();
  if (total > width) {
    const leftRoom = width - (rw ? rw + 2 : 0);
    if (rw && leftRoom >= 12) return `${truncateDisplay(join(l, sep), leftRoom)}  ${join(r, sep)}`;
    return truncateDisplay(join(l, sep), width);
  }
  if (!rw) return join(l, sep);
  return join(l, sep) + " ".repeat(width - lw - rw) + join(r, sep);
}

// --- segments ---------------------------------------------------------------------------------

type Ctx = { state: FooterState; theme: Theme; glyphs: Glyphs; mode: FooterMode; width: number };

function effortSegment({ state, theme, glyphs }: Ctx, full: boolean): Seg | null {
  const e = state.effort;
  if (!e) return null;
  const pin = e.pinned ? "*" : "";
  const next = e.pendingCode ? `${glyphs.ascii ? "->" : "→"}${e.pendingCode}` : "";
  const used = e.usage && e.usage.total > 0 ? ` ${e.usage.total}/${e.usage.maxTotal}` : "";
  const long = `${theme.fg("dim", "effort ")}${theme.fg("accent", `${e.code} ${e.label}${pin}`)}${next ? theme.fg("warning", next) : ""}${used ? theme.fg("muted", used) : ""}`;
  const short = `${theme.fg("accent", `${e.code}${pin}`)}${next ? theme.fg("warning", next) : ""}${used ? theme.fg("muted", used) : ""}`;
  return full ? { id: "effort", prio: 1, text: long, alts: [short] } : { id: "effort", prio: 1, text: short };
}

function contextSegment({ state, theme, glyphs, mode }: Ctx): Seg {
  const c = state.context ?? {};
  const pct = typeof c.percent === "number" && Number.isFinite(c.percent) ? c.percent : undefined;
  const window = c.contextWindow;
  if (pct === undefined) {
    // Unknown is unknown (right after a compaction, or a model without a window): never 0%.
    const unknown = `${theme.fg("dim", "ctx ")}${theme.fg("muted", window ? `?/${fmtTokens(window)}` : "?")}`;
    return { id: "ctx", prio: 3, text: unknown, alts: [theme.fg("dim", "ctx ?")] };
  }
  const color = pct > 90 ? "error" : pct > 70 ? "warning" : "text";
  const free = window && typeof c.tokens === "number" ? Math.max(0, window - c.tokens) : undefined;
  const headroom = free !== undefined ? theme.fg("dim", ` ${fmtTokens(free)} free`) : theme.fg("dim", ` ${Math.max(0, 100 - Math.round(pct))}% free`);
  const full = `${theme.fg("dim", "ctx ")}${bar(pct, 12, theme, glyphs)} ${theme.fg(color, `${pct.toFixed(0)}%`)}${headroom}`;
  const mid = `${theme.fg("dim", "ctx ")}${bar(pct, 8, theme, glyphs)} ${theme.fg(color, `${pct.toFixed(0)}%`)}`;
  const tiny = `${theme.fg("dim", "ctx ")}${theme.fg(color, `${pct.toFixed(0)}%`)}`;
  return { id: "ctx", prio: 3, text: mode === "light" ? tiny : full, alts: mode === "light" ? [] : [mid, tiny] };
}

function warningSegments({ state, theme, glyphs }: Ctx): Seg[] {
  const out: Seg[] = [];
  const w = (text: string, color: string, bold = false) => (bold ? theme.bold(theme.fg(color, text)) : theme.fg(color, text));
  const u = state.unattended;
  if (u?.active) out.push({ id: "unattended", prio: 0, text: w(`${glyphs.warn} UNATTENDED${u.boundary ? ` ${glyphs.dot} ${u.boundary}` : ""}`, "warning", true), alts: [w(`${glyphs.warn} UNATTENDED`, "warning", true)] });
  else if (u?.misconfigured) out.push({ id: "unattended", prio: 0, text: w(`${glyphs.warn} unattended NOT enforced`, "error", true), alts: [w(`${glyphs.warn} unattended?`, "error", true)] });
  if (state.compaction?.enabled === false) out.push({ id: "compaction", prio: 0, text: w(`${glyphs.warn} compaction off`, "warning"), alts: [w(`${glyphs.warn} no compact`, "warning")] });
  if (state.agents && state.agents.failed > 0) out.push({ id: "agents-failed", prio: 0, text: w(`${glyphs.warn} ${state.agents.failed} agent${state.agents.failed === 1 ? "" : "s"} failed`, "error"), alts: [w(`${glyphs.warn} ${state.agents.failed} failed`, "error")] });
  return out;
}

function workSegments({ state, theme, glyphs, mode }: Ctx): Seg[] {
  const out: Seg[] = [];
  if (state.agents && state.agents.live > 0) out.push({ id: "agents", prio: 2, text: `${theme.fg("accent", glyphs.active)} ${theme.fg("dim", "agents ")}${theme.fg("accent", String(state.agents.live))}`, alts: [`${theme.fg("accent", glyphs.active)}${theme.fg("accent", String(state.agents.live))}`] });
  if (state.todos.length) {
    const done = state.todos.filter((i) => i.state === "done").length;
    if (done < state.todos.length || mode === "heavy") out.push({ id: "todos", prio: 2, text: `${theme.fg("dim", "todos ")}${theme.fg(done === state.todos.length ? "success" : "accent", `${done}/${state.todos.length}`)}` });
  }
  return out;
}

/** Chips worth showing at this width: failing ones are warnings, running ones are work, the rest are extras. */
function chipSegments({ state, theme, mode }: Ctx): Seg[] {
  const out: Seg[] = [];
  const hideSubagent = mode !== "heavy" && Boolean(state.agents);
  for (const entry of state.statuses) {
    if (entry.key === "custom-footer" || !entry.text?.trim()) continue;
    if (hideSubagent && entry.key === "subagent") continue;
    const severity = chipSeverity(entry.text);
    const stale = TRANSIENT_KEYS.has(entry.key) && (entry.ageMs ?? 0) > STALE_CHIP_MS && !state.running && severity !== "error";
    if (stale) continue;
    const prio = severity === "error" ? 0 : severity === "warn" || severity === "active" ? 2 : 7;
    if (mode === "light" && prio > 0) continue;
    out.push({ id: `chip:${entry.key}`, prio, text: statusChip(entry.key, entry.text, theme, mode === "heavy" ? 56 : 34) });
  }
  return out;
}

function branchSegment({ state, theme }: Ctx): Seg | null {
  return state.branch ? { id: "branch", prio: 4, text: theme.fg("muted", "on ") + theme.fg("mdLink", state.branch) } : null;
}

function tokenSegments({ state, theme, glyphs }: Ctx): Seg[] {
  const t = state.totals;
  const tokens = [
    theme.fg("success", `${glyphs.input}${fmtTokens(t.input)}`),
    theme.fg("accent", `${glyphs.output}${fmtTokens(t.output)}`),
    t.cacheRead ? theme.fg("muted", `${glyphs.cache}${fmtTokens(t.cacheRead)}`) : "",
  ].filter(Boolean).join(" ");
  const costColor = state.cost.kind === "unknown" ? "muted" : "warning";
  const cost = `${theme.fg("dim", "cost ")}${theme.fg(costColor, fmtCostView(state.cost))}${state.cost.kind === "estimated" ? theme.fg("dim", " est") : ""}${state.partial ? theme.fg("warning", " partial") : ""}`;
  return [
    { id: "tokens", prio: 5, text: `${theme.fg("dim", "session ")}${tokens}`, alts: [tokens] },
    { id: "cost", prio: 5, text: cost, alts: [`${theme.fg(costColor, fmtCostView(state.cost))}`] },
  ];
}

// --- the bar ----------------------------------------------------------------------------------

export function renderFooter(state: FooterState, theme: Theme, width: number, mode: FooterMode = "default"): string[] {
  const glyphs = footerGlyphs(theme, state.ascii);
  const ctx: Ctx = { state, theme, glyphs, mode, width };
  const sep = theme.fg("borderMuted", glyphs.separator);
  const project = path.basename(state.cwd) || state.cwd;
  const projectSeg: Seg = { id: "project", prio: 1, text: `${theme.fg("accent", glyphs.marker)} ${theme.bold(theme.fg("text", project))}` };
  const warnings = warningSegments(ctx);
  const effortShort = effortSegment(ctx, false);
  const effortFull = effortSegment(ctx, true);
  const work = workSegments(ctx);
  const chips = chipSegments(ctx);
  const catSeg: Seg[] = state.cat ? [{ id: "cat", prio: 5, text: state.cat.label ? `${state.cat.text} ${theme.fg("dim", state.cat.label)}` : state.cat.text, alts: [state.cat.text] }] : [];
  const modelSeg: Seg | null = state.model ? { id: "model", prio: 1, text: theme.fg("accent", state.model), alts: [truncateDisplay(theme.fg("accent", state.model), 18)] } : null;

  if (mode === "light") {
    const left: Seg[] = [projectSeg, ...warnings, ...(effortShort ? [effortShort] : []), contextSegment(ctx), ...work, ...(branchSegment(ctx) ? [branchSegment(ctx)!] : []), ...chips];
    const right: Seg[] = [...catSeg, ...(modelSeg ? [{ ...modelSeg, prio: 5 }] : [])];
    return [truncateDisplay(fitLine(left, right, width, sep), width)];
  }

  // Line 1: where and with what
  const think = state.thinking && state.thinking !== "off" ? { id: "think", prio: 4, text: theme.fg(thinkingColor(state.thinking), `think ${state.thinking}`) } : null;
  const profile = state.profile ? { id: "profile", prio: 4, text: `${theme.fg("dim", "profile ")}${theme.fg("text", state.profile)}` } : null;
  const line1Left: Seg[] = [projectSeg, ...(branchSegment(ctx) ? [branchSegment(ctx)!] : []), { id: "path", prio: 6, text: theme.fg("dim", shortCwd(state.cwd)) }, ...(state.sessionName ? [{ id: "session", prio: 6, text: theme.fg("muted", `${glyphs.ascii ? "session " : "• "}${state.sessionName}`) }] : [])];
  // keep the path after the branch in reading order, but as the first thing to go
  const line1Right: Seg[] = [...(state.provider ? [{ id: "provider", prio: 6, text: theme.fg("dim", state.provider) }] : []), ...(modelSeg ? [modelSeg] : [{ id: "model", prio: 1, text: theme.fg("dim", "no model") }]), ...(think ? [think] : []), ...(profile ? [profile] : []), ...(effortFull ? [effortFull] : [])];
  const lines = [fitLine(line1Left, line1Right, width, sep)];

  // Line 2: state of the work
  const line2Left: Seg[] = [...warnings, contextSegment(ctx), ...work];
  const line2Right: Seg[] = [...catSeg, ...(mode === "heavy" ? [] : chips)];
  lines.push(fitLine(line2Left, line2Right, width, sep));

  if (mode === "heavy") {
    // Line 3: telemetry and delegation budget
    const e = state.effort;
    const budget: Seg[] = e?.usage ? [{ id: "children", prio: 2, text: `${theme.fg("dim", "children ")}${theme.fg("text", `${e.usage.total}/${e.usage.maxTotal}`)}${theme.fg("dim", ` ${glyphs.dot} scouts `)}${theme.fg("text", `${e.usage.scouts}/${e.usage.maxScouts}`)}${e.usage.live ? theme.fg("accent", ` ${e.usage.live} running`) : ""}`, alts: [`${theme.fg("dim", "children ")}${theme.fg("text", `${e.usage.total}/${e.usage.maxTotal}`)}`] }] : [];
    lines.push(fitLine([...tokenSegments(ctx), ...budget], state.pricingSource ? [{ id: "pricing", prio: 6, text: theme.fg("dim", /^unconfigured/.test(state.pricingSource) ? "no prices set" : `pricing ${path.basename(state.pricingSource)}`) }] : [], width, sep));
    // Line 4: diagnostics and every extension chip
    const diag: Seg[] = [];
    if (state.firewall?.mode || state.firewall?.policy) diag.push({ id: "firewall", prio: 4, text: `${theme.fg("dim", "firewall ")}${theme.fg("text", [state.firewall.mode, state.firewall.policy].filter(Boolean).join("/"))}` });
    if (state.compaction) diag.push({ id: "compact-state", prio: 4, text: `${theme.fg("dim", "compaction ")}${theme.fg(state.compaction.enabled ? "success" : "warning", state.compaction.enabled ? `on${state.compaction.thresholdTokens ? ` @${fmtTokens(state.compaction.thresholdTokens)}` : ""}` : `off${state.compaction.reason ? ` (${state.compaction.reason})` : ""}`)}` });
    if (state.effort?.pinned) diag.push({ id: "pinned", prio: 4, text: theme.fg("dim", "effort pinned by the run or parent") });
    const all = [...diag, ...chips];
    lines.push(all.length ? fitLine(all, [], width, sep) : theme.fg("dim", truncateDisplay("status no extension status", width)));
  }
  return lines.map((line) => (displayWidth(line) > width ? truncateDisplay(line, width) : line));
}

/** Plain-text detail for /footer status: everything the bar can show, with nothing dropped for width. */
export function renderDetail(state: FooterState, mode: string): string[] {
  const rows: string[] = [];
  rows.push(`Status bar: ${mode}`);
  rows.push(`  location    ${state.cwd}${state.branch ? ` (git ${state.branch})` : ""}`);
  rows.push(`  model       ${state.provider ? `${state.provider} ` : ""}${state.model ?? "none"}${state.thinking && state.thinking !== "off" ? `, thinking ${state.thinking}` : ""}`);
  if (state.profile) rows.push(`  profile     ${state.profile}`);
  if (state.effort) rows.push(`  effort      ${state.effort.code} ${state.effort.label}${state.effort.pinned ? " (pinned by the run or parent)" : ""}${state.effort.pendingCode ? `; ${state.effort.pendingCode} from the next message` : ""}${state.effort.usage ? `; this request: ${state.effort.usage.total}/${state.effort.usage.maxTotal} children, ${state.effort.usage.scouts}/${state.effort.usage.maxScouts} scouts, ${state.effort.usage.live} running` : ""}`);
  const c = state.context ?? {};
  rows.push(`  context     ${typeof c.percent === "number" ? `${c.percent.toFixed(0)}% used` : "unknown"}${c.tokens != null && c.contextWindow ? ` (${c.tokens}/${c.contextWindow} tokens)` : c.contextWindow ? ` (window ${c.contextWindow} tokens)` : ""}`);
  rows.push(`  compaction  ${state.compaction ? (state.compaction.enabled ? `on${state.compaction.thresholdTokens ? `, threshold ${state.compaction.thresholdTokens} tokens` : ""}` : `OFF${state.compaction.reason ? `: ${state.compaction.reason}` : ""}`) : "not reported"}`);
  rows.push(`  unattended  ${state.unattended ? (state.unattended.active ? `ACTIVE (${state.unattended.boundary ?? "boundary"}${state.unattended.autoApprove ? ", approvals automatic" : ""})` : state.unattended.label) : "no"}`);
  if (state.firewall) rows.push(`  firewall    ${[state.firewall.mode, state.firewall.policy].filter(Boolean).join("/") || "unknown"}`);
  if (state.agents) rows.push(`  agents      ${state.agents.live} running, ${state.agents.failed} failed this request`);
  const t = state.totals;
  rows.push(`  tokens      in ${t.input}, out ${t.output}, cache read ${t.cacheRead}, cache write ${t.cacheWrite}, total ${t.total}${state.partial ? " (partial: some messages carried no usage)" : ""}`);
  rows.push(`  cost        ${fmtCostView(state.cost)}${state.cost.kind === "estimated" ? " (estimated from configured prices)" : state.cost.kind === "reported" ? " (reported by the model catalogue)" : " (unknown: no prices configured and none reported)"}; pricing ${state.pricingSource ?? "unconfigured"}`);
  if (state.todos.length) rows.push(`  todos       ${state.todos.filter((i) => i.state === "done").length}/${state.todos.length} done`);
  rows.push(`  statuses    ${state.statuses.length ? "" : "none"}`);
  for (const s of state.statuses) rows.push(`    ${s.key}: ${s.text.replace(/\s+/g, " ").trim()}${s.ageMs !== undefined && s.ageMs > STALE_CHIP_MS ? ` (unchanged for ${fmtDuration(s.ageMs)}${TRANSIENT_KEYS.has(s.key) && !state.running ? "; hidden from the bar" : ""})` : ""}`);
  return rows;
}

export { displayWidth as visibleWidth, truncateDisplay as truncate, padDisplay };
