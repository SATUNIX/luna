/**
 * The /workflows panel (E5 slice G5): live workflow runs of this session, modelled on Claude Code's
 * workflow panel. It reads the run registry (run-model.ts) and acts through control.ts, so it does
 * exactly what workflow_control and /workflow do.
 *
 * Views:
 *   - run list: one row per run (status dot, name, status, done/total agents, elapsed, id);
 *     ↑↓ select, enter open, esc close.
 *   - run view: header (name, description, status, done/total agents, elapsed), a Phases pane with
 *     done/total, an Agents pane (label, model, tokens, elapsed, status dot) with the selected agent's
 *     last activity or error, narrator lines, and the footer keys
 *     ↑↓ select · k skip · x stop · p pause/resume · s save · esc back.
 *     `x` (stop) and `s` (save) open a No-first choice inside the panel: the first, highlighted choice
 *     is "No", and esc means No. `k` skips the selected running agent.
 *
 * Script runs (wf-engine.ts) add: `▸ <workflow>` groups for nested workflow() calls in both panes,
 * a ◆ dot for an agent() call answered from a resumed run's journal, and header badges for
 * `sandbox: reduced`, `approvals: k` and the budget used. A status line (`setStatus`) summarises the
 * active runs.
 *
 * In the TUI it opens as an overlay (`ctx.ui.custom`, overlay on pi 1.3.0 or newer, the
 * control-center hub pattern). Outside the TUI, `/workflows [run-id]` prints the same content as text.
 *
 * `s` copies a YAML run's definition file into the project's `.pi/workflows/`, so the workflow can be
 * kept and changed with the project. A copy is a project workflow: running it goes through the
 * project-workflow trust gate like any other. A script run is saved as `.pi/workflows/<name>.js`
 * only while its script still has the digest the run executed, and that digest is then trusted (the
 * operator just chose to keep the script the session ran). A run whose workflow is already a project
 * workflow has nothing to save.
 *
 * Narration: a Narrator subscribes to the registry when the extension loads and keeps the last lines
 * per run (run, phase and agent status changes, pause and resume), so a panel opened late still shows
 * what happened. Like the run model it holds no prompts or outputs.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { VERSION, type ExtensionAPI, type ExtensionContext, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { controlRun, runControls, skipRunAgent, type ControlResult } from "./control.ts";
import { runRegistry, type AgentRecord, type AgentStatus, type PhaseRecord, type PhaseStatus, type RunRegistry, type RunSnapshot, type RunStatus, type WorkflowEvent } from "./run-model.ts";
import type { ToolContext } from "./types.ts";
import { META_NAME } from "./wf-meta.ts";
import { rememberDigest } from "./workflow-tools.ts";

// --- formatting -------------------------------------------------------------------------------

export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

export function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Tokens shown for an agent: input plus output (cache reads and writes are not counted). */
export const agentTokens = (a: Pick<AgentRecord, "usage">): number => a.usage.input + a.usage.output;

const FINISHED_PHASE: ReadonlySet<PhaseStatus> = new Set(["passed", "failed", "skipped", "aborted"]);

export function counts(run: RunSnapshot): { agentsDone: number; agents: number; cached: number; phasesDone: number; phases: number } {
  return {
    agentsDone: run.agents.filter((a) => a.status !== "running").length,
    agents: run.agents.length,
    cached: run.agents.filter((a) => a.cached).length,
    phasesDone: run.phases.filter((p) => FINISHED_PHASE.has(p.status)).length,
    phases: run.phases.length,
  };
}

/** The colour a status dot takes. */
export type Tone = "running" | "good" | "bad" | "warn" | "quiet";

export function tone(status: AgentStatus | PhaseStatus | RunStatus): Tone {
  switch (status) {
    case "running":
      return "running";
    case "passed":
      return "good";
    case "failed":
      return "bad";
    case "aborted":
    case "interrupted":
      return "warn";
    case "skipped":
    case "pending":
      return "quiet";
  }
}

const TONE_COLOR: Record<Tone, ThemeColor> = { running: "accent", good: "success", bad: "error", warn: "warning", quiet: "muted" };

export const DOT = "●";
/** The dot of an agent() call answered from a resumed run's journal (nothing was launched). */
export const CACHED_DOT = "◆";

const dotOf = (a: Pick<AgentRecord, "cached">): string => (a.cached ? CACHED_DOT : DOT);

/** Budget used, in whole percent of budget.total (output tokens), or undefined without a budget. */
export function budgetPercent(run: Pick<RunSnapshot, "budgetTotal" | "usage">): number | undefined {
  const total = run.budgetTotal;
  if (typeof total !== "number" || !(total > 0)) return undefined;
  return Math.floor((run.usage.output * 100) / total);
}
/** How lines are coloured: the TUI uses the pi theme, the text fallback leaves text plain. */
export interface Paint {
  tone(t: Tone, text: string): string;
  dim(text: string): string;
  accent(text: string): string;
  bold(text: string): string;
}

export const plainPaint: Paint = { tone: (_t, text) => text, dim: (t) => t, accent: (t) => t, bold: (t) => t };

/** The subset of pi's Theme the panel uses. */
export interface PanelTheme {
  fg(color: ThemeColor, text: string): string;
  bold(text: string): string;
}

export function themePaint(theme: PanelTheme): Paint {
  return {
    tone: (t, text) => theme.fg(TONE_COLOR[t], text),
    dim: (text) => theme.fg("dim", text),
    accent: (text) => theme.fg("accent", text),
    bold: (text) => theme.bold(text),
  };
}

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

// --- narration --------------------------------------------------------------------------------

/** Lines kept per run; the panel shows the last NARRATION_SHOWN of them. */
export const NARRATION_KEPT = 40;
export const NARRATION_SHOWN = 6;
const NARRATED_RUNS = 64;

/** Turns registry events into short narrator lines ("+12s scout#1 passed, 1.2k tok"). */
export class Narrator {
  private readonly byRun = new Map<string, string[]>();
  private readonly starts = new Map<string, number>();
  private readonly seen = new Map<string, string>(); // "<run>\0<phase|agent id>" -> last status

  /** Subscribe to a registry; returns the unsubscribe function. */
  attach(registry: RunRegistry): () => void {
    return registry.subscribe((e) => this.on(e));
  }

  lines(runId: string): string[] {
    return [...(this.byRun.get(runId) ?? [])];
  }

  on(e: WorkflowEvent): void {
    if (e.type === "run_start") {
      this.byRun.delete(e.runId);
      for (const k of [...this.seen.keys()]) if (k.startsWith(`${e.runId}\0`)) this.seen.delete(k);
      this.starts.set(e.runId, e.ts);
      this.push(e.runId, e.ts, `started ${e.name}`);
      return;
    }
    if (e.type === "phase") {
      const key = `${e.runId}\0phase:${e.phase.id}`;
      const before = this.seen.get(key);
      this.seen.set(key, e.phase.status);
      if (e.phase.status === "pending" || before === e.phase.status || (before === undefined && e.phase.status !== "running")) return;
      this.push(e.runId, e.ts, `phase ${e.phase.parent ? `${e.phase.parent} · ` : ""}${e.phase.title} ${e.phase.status}`);
      return;
    }
    if (e.type === "agent") {
      const a = e.agent;
      const key = `${e.runId}\0agent:${a.id}`;
      const before = this.seen.get(key);
      this.seen.set(key, a.status);
      if (before === a.status) return;
      if (a.status === "running") {
        if (a.cached) return; // a journal answer launches nothing; its end says so
        this.push(e.runId, e.ts, `${a.group ? `▸ ${a.group}: ` : ""}${a.id} started${a.role && a.role !== a.label ? ` (${a.role})` : ""}`);
        return;
      }
      if (a.cached) {
        this.push(e.runId, e.ts, `${a.group ? `▸ ${a.group}: ` : ""}${a.id} reused from the journal`);
        return;
      }
      const tokens = agentTokens(a);
      this.push(e.runId, e.ts, `${a.group ? `▸ ${a.group}: ` : ""}${a.id} ${a.status}${tokens ? `, ${fmtTokens(tokens)} tok` : ""}${a.error ? `: ${oneLine(a.error).slice(0, 100)}` : ""}`);
      return;
    }
    if (e.type === "control") {
      this.push(e.runId, e.ts, e.paused ? "paused: no new agents start" : "resumed");
      return;
    }
    if (e.type === "approvals") {
      this.push(e.runId, e.ts, `approval #${e.approvals}`);
      return;
    }
    this.push(e.runId, e.ts, `run ${e.status}${e.error ? `: ${oneLine(e.error).slice(0, 100)}` : ""}`);
  }

  private push(runId: string, ts: number, text: string): void {
    let list = this.byRun.get(runId);
    if (!list) {
      list = [];
      this.byRun.set(runId, list);
      while (this.byRun.size > NARRATED_RUNS) {
        const oldest = this.byRun.keys().next().value;
        if (oldest === undefined) break;
        this.byRun.delete(oldest);
        this.starts.delete(oldest);
        for (const k of [...this.seen.keys()]) if (k.startsWith(`${oldest}\0`)) this.seen.delete(k);
      }
    }
    const start = this.starts.get(runId) ?? ts;
    list.push(`+${fmtElapsed(ts - start)} ${text}`);
    if (list.length > NARRATION_KEPT) list.splice(0, list.length - NARRATION_KEPT);
  }
}

/** The process-wide narrator; registerWorkflowPanel attaches it to the run registry. */
export const narrator = new Narrator();

// --- rendering --------------------------------------------------------------------------------

export const AGENT_ROWS = 10;
export const LIST_ROWS = 12;

export interface RunViewOptions {
  paint: Paint;
  narration: string[];
  /** Index of the highlighted agent; undefined in the text fallback. */
  selected?: number | undefined;
}

function visibleWindow<T>(items: T[], selected: number | undefined, rows: number): { start: number; items: T[] } {
  if (items.length <= rows || selected === undefined) return { start: 0, items: items.slice(0, selected === undefined ? items.length : rows) };
  const start = Math.min(Math.max(0, selected - Math.floor(rows / 2)), items.length - rows);
  return { start, items: items.slice(start, start + rows) };
}

const statusText = (run: RunSnapshot): string => `${run.status}${run.paused ? " (paused)" : ""}`;

/** The header badges: `sandbox: reduced`, `approvals: k` and the budget used, each only when it applies. */
export function badges(run: RunSnapshot, paint: Paint): string[] {
  const out: string[] = [];
  if (run.sandbox === "reduced") out.push(paint.tone("warn", "sandbox: reduced"));
  if (run.approvals > 0) out.push(paint.tone("warn", `approvals: ${run.approvals}`));
  const pct = budgetPercent(run);
  if (pct !== undefined) {
    const text = `budget: ${pct}% (${fmtTokens(run.usage.output)}/${fmtTokens(run.budgetTotal ?? 0)} output tok)`;
    out.push(pct >= 100 ? paint.tone("bad", text) : pct >= 80 ? paint.tone("warn", text) : paint.dim(text));
  }
  return out;
}

export function headerLines(run: RunSnapshot, paint: Paint): string[] {
  const c = counts(run);
  const out = [
    `${paint.bold(run.name)}${run.description ? paint.dim(` — ${oneLine(run.description)}`) : ""}`,
    `${paint.tone(tone(run.status), DOT)} ${statusText(run)} · ${c.agentsDone}/${c.agents} agents done${c.cached ? ` · ${c.cached} cached` : ""} · ${fmtElapsed(run.elapsedMs)} · ${paint.dim(run.id)}`,
  ];
  const b = badges(run, paint);
  if (b.length) out.push(b.join(paint.dim(" · ")));
  return out;
}

/** Phases in display order: each top-level phase, then the phases of its `▸` group under it. */
export function phaseTree(phases: PhaseRecord[]): Array<{ phase: PhaseRecord; depth: 0 | 1; agentIds: string[] }> {
  const ids = new Set(phases.map((p) => p.id));
  const children = new Map<string, PhaseRecord[]>();
  for (const p of phases) {
    if (p.parent === undefined || !ids.has(p.parent) || p.parent === p.id) continue;
    const list = children.get(p.parent) ?? [];
    list.push(p);
    children.set(p.parent, list);
  }
  const out: Array<{ phase: PhaseRecord; depth: 0 | 1; agentIds: string[] }> = [];
  for (const p of phases) {
    if (p.parent !== undefined && ids.has(p.parent) && p.parent !== p.id) continue;
    const kids = children.get(p.id) ?? [];
    // A group counts its own agents and those of the phases under it.
    out.push({ phase: p, depth: 0, agentIds: [...p.agentIds, ...kids.flatMap((k) => k.agentIds)] });
    for (const k of kids) out.push({ phase: k, depth: 1, agentIds: k.agentIds });
  }
  return out;
}

export function renderRunLines(run: RunSnapshot, o: RunViewOptions): string[] {
  const { paint } = o;
  const c = counts(run);
  const out = [...headerLines(run, paint)];
  if (run.error) out.push(paint.tone("bad", `error: ${oneLine(run.error)}`));
  out.push("", paint.accent(`Phases (${c.phasesDone}/${c.phases})`));
  const tree = phaseTree(run.phases);
  const phaseWidth = Math.min(24, Math.max(4, ...tree.map((t) => t.phase.title.length + 2 * t.depth)));
  for (const t of tree) {
    const p = t.phase;
    const done = t.agentIds.filter((id) => run.agents.find((a) => a.id === id)?.status !== "running").length;
    const indent = "  ".repeat(t.depth);
    out.push(`  ${indent}${paint.tone(tone(p.status), DOT)} ${p.title.padEnd(phaseWidth - indent.length)}  ${p.status.padEnd(7)}  ${done}/${t.agentIds.length}`);
  }
  out.push("", paint.accent(`Agents (${c.agentsDone}/${c.agents})`));
  if (!run.agents.length) out.push(paint.dim("  no agents yet"));
  // Agents of a nested workflow() are indented under a `▸ <workflow>` line.
  const idCell = (a: AgentRecord): string => `${a.group !== undefined ? "  " : ""}${a.id}`;
  const labelWidth = Math.min(24, Math.max(5, ...run.agents.map((a) => idCell(a).length)));
  const modelWidth = Math.min(28, Math.max(5, ...run.agents.map((a) => (a.model ?? "-").length)));
  const shown = visibleWindow(run.agents, o.selected, AGENT_ROWS);
  if (shown.start > 0) out.push(paint.dim(`  … ${shown.start} above`));
  let group: string | undefined;
  shown.items.forEach((a, i) => {
    if (a.group !== undefined && a.group !== group) out.push(paint.dim(`    ▸ ${a.group}`));
    group = a.group;
    const mark = o.selected === undefined ? " " : shown.start + i === o.selected ? paint.accent("›") : " ";
    const row = `${mark} ${paint.tone(tone(a.status), dotOf(a))} ${idCell(a).padEnd(labelWidth)}  ${(a.model ?? "-").padEnd(modelWidth)}  ${`${fmtTokens(agentTokens(a))} tok`.padStart(10)}  ${fmtElapsed(a.elapsedMs).padStart(7)}  ${a.status}`;
    out.push(row);
    // The text fallback lists every failure; the TUI shows the selected agent's detail below.
    if (o.selected === undefined && a.error) out.push(paint.tone("bad", `      ${oneLine(a.error)}`));
  });
  const below = run.agents.length - shown.start - shown.items.length;
  if (below > 0) out.push(paint.dim(`  … ${below} more`));
  if (o.selected !== undefined) {
    const sel = run.agents[o.selected];
    const detail = sel ? (sel.error ?? sel.activity) : undefined;
    if (detail) out.push(paint.dim(`  ${sel?.id ?? ""}: ${oneLine(detail)}`));
  }
  const narration = o.narration.slice(-NARRATION_SHOWN);
  if (narration.length) {
    out.push("", paint.accent("Narrator"));
    for (const line of narration) out.push(paint.dim(`  ${line}`));
  }
  return out;
}

export function renderListLines(runs: RunSnapshot[], paint: Paint, selected?: number): string[] {
  const active = runs.filter((r) => r.status === "running").length;
  const out = [paint.bold(`Workflows (${runs.length} run${runs.length === 1 ? "" : "s"}, ${active} active)`)];
  if (!runs.length) {
    out.push(paint.dim("No workflow runs in this session. Start one with /workflow run <name>."));
    return out;
  }
  const nameWidth = Math.min(28, Math.max(4, ...runs.map((r) => r.name.length)));
  const shown = visibleWindow(runs, selected, LIST_ROWS);
  if (shown.start > 0) out.push(paint.dim(`  … ${shown.start} above`));
  shown.items.forEach((r, i) => {
    const c = counts(r);
    const mark = selected === undefined ? " " : shown.start + i === selected ? paint.accent("›") : " ";
    out.push(`${mark} ${paint.tone(tone(r.status), DOT)} ${r.name.padEnd(nameWidth)}  ${statusText(r).padEnd(11)}  ${`${c.agentsDone}/${c.agents} agents`.padEnd(12)}  ${fmtElapsed(r.elapsedMs).padStart(7)}  ${paint.dim(r.id)}`);
  });
  const below = runs.length - shown.start - shown.items.length;
  if (below > 0) out.push(paint.dim(`  … ${below} more`));
  return out;
}

/** The text fallback: `/workflows` (every run) or `/workflows <run-id>` outside the TUI. */
export function renderText(registry: RunRegistry, narration: Narrator, runId?: string): string {
  if (runId) {
    const run = registry.get(runId);
    if (!run) return `No workflow run "${runId}" in this session.\n${renderListLines(registry.list(), plainPaint).join("\n")}`;
    return renderRunLines(run, { paint: plainPaint, narration: narration.lines(runId) }).join("\n");
  }
  const runs = registry.list();
  const parts = [renderListLines(runs, plainPaint).join("\n")];
  for (const run of runs) parts.push(renderRunLines(run, { paint: plainPaint, narration: narration.lines(run.id) }).join("\n"));
  return parts.join("\n\n");
}

// --- save -------------------------------------------------------------------------------------

/**
 * What `s` would do. `digest` is set for a script run: the bytes saved must hash to it (the script
 * the run executed), and the saved file's digest is then trusted.
 */
export type SavePlan = { target: string; from: string; overwrite: boolean; digest?: string | undefined; message?: undefined } | { message: string; target?: undefined };

const sha256 = (bytes: Buffer): string => crypto.createHash("sha256").update(bytes).digest("hex");

function realOrNull(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/** True when `file` sits directly in the project's `.pi/workflows/` (it is a project workflow). */
function inProjectWorkflows(file: string, cwd: string): boolean {
  const dir = realOrNull(path.join(cwd, ".pi", "workflows"));
  const real = realOrNull(file);
  return dir !== null && real !== null && path.dirname(real) === dir;
}

/** Where `s` would copy a run's definition, or why there is nothing to save. */
export function planSave(run: RunSnapshot, cwd: string): SavePlan {
  if (!run.file) return { message: `Run ${run.id} has no recorded definition file.` };
  if (run.source === "project" || inProjectWorkflows(run.file, cwd)) return { message: `Already a project workflow: ${run.file}` };
  if (!fs.existsSync(run.file)) return { message: `The definition file is gone: ${run.file}` };
  let target: string;
  let digest: string | undefined;
  if (run.kind === "script") {
    if (!run.digest) return { message: `Run ${run.id} has no recorded script digest; it cannot be saved.` };
    if (!META_NAME.test(run.name)) return { message: `Run ${run.id}'s workflow name "${run.name}" is not a valid file name.` };
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(run.file);
    } catch (error) {
      return { message: `Cannot read ${run.file}: ${String(error)}` };
    }
    if (sha256(bytes) !== run.digest) return { message: `Not saving: ${run.file} changed since the run (its digest no longer matches the script the run executed).` };
    target = path.join(cwd, ".pi", "workflows", `${run.name}.js`);
    digest = run.digest;
  } else target = path.join(cwd, ".pi", "workflows", path.basename(run.file));
  const unsafe = unsafeSaveTarget(cwd, target);
  if (unsafe) return { message: unsafe };
  return { target, from: run.file, overwrite: fs.existsSync(target), ...(digest !== undefined ? { digest } : {}) };
}

/**
 * Why `target` (under `<cwd>/.pi/workflows/`) is not a safe place to write, or undefined. Project
 * content is untrusted: `.pi`, `.pi/workflows` or the file itself may be a planted symlink that
 * points outside the project, so each must be absent, a real directory or a regular file.
 */
export function unsafeSaveTarget(cwd: string, target: string): string | undefined {
  const checks: [string, "dir" | "file"][] = [
    [path.join(cwd, ".pi"), "dir"],
    [path.dirname(target), "dir"],
    [target, "file"],
  ];
  for (const [p, want] of checks) {
    let st: fs.Stats;
    try {
      st = fs.lstatSync(p);
    } catch {
      continue;
    }
    const rel = path.relative(cwd, p) || p;
    if (st.isSymbolicLink()) return `Refusing to save: ${rel} is a symlink.`;
    if (want === "dir" ? !st.isDirectory() : !st.isFile()) return `Refusing to save: ${rel} is not a ${want === "dir" ? "directory" : "regular file"}.`;
  }
  return undefined;
}

/** Re-check the target, create its directory, re-check, and remove a verified regular file there. */
function prepareTarget(target: string, cwd: string): void {
  const before = unsafeSaveTarget(cwd, target);
  if (before) throw new Error(before);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const after = unsafeSaveTarget(cwd, target);
  if (after) throw new Error(after);
  if (fs.existsSync(target)) fs.unlinkSync(target);
}

/** Copy without following a symlink at any step: re-check, remove a verified regular file, then create exclusively. */
export function saveCopy(from: string, target: string, cwd: string): void {
  prepareTarget(target, cwd);
  fs.copyFileSync(from, target, fs.constants.COPYFILE_EXCL);
}

/**
 * Save a script run's script: the bytes read must hash to `digest` (the script the run executed);
 * they are written exclusively, as saveCopy does, and that digest is trusted for the saved file.
 */
export function saveScript(from: string, target: string, cwd: string, digest: string, w: { name: string; description: string }): void {
  const bytes = fs.readFileSync(from);
  if (sha256(bytes) !== digest) throw new Error(`${from} changed since the run; not saved`);
  prepareTarget(target, cwd);
  fs.writeFileSync(target, bytes, { flag: "wx" });
  rememberDigest(digest, { name: w.name, description: w.description, source: "project", file: target });
}

// --- the panel --------------------------------------------------------------------------------

export type PanelKey = "up" | "down" | "enter" | "esc" | "stop" | "pause" | "save" | "skip";

/** pi's keybindings manager, as far as the panel needs it. */
export interface KeyMatcher {
  matches(data: string, binding: "tui.select.up" | "tui.select.down" | "tui.select.confirm" | "tui.select.cancel"): boolean;
}

export function keyOf(data: string, keys: KeyMatcher): PanelKey | undefined {
  if (keys.matches(data, "tui.select.up")) return "up";
  if (keys.matches(data, "tui.select.down")) return "down";
  if (keys.matches(data, "tui.select.confirm")) return "enter";
  if (keys.matches(data, "tui.select.cancel")) return "esc";
  if (data === "x" || data === "X") return "stop";
  if (data === "p" || data === "P") return "pause";
  if (data === "s" || data === "S") return "save";
  if (data === "k" || data === "K") return "skip";
  return undefined;
}

export const STOP_CHOICES = ["No, keep it running", "Stop the run"] as const;
export const SAVE_NO = "No, don't save";

interface Confirm {
  action: "stop" | "save";
  question: string;
  choices: string[]; // choices[0] is always the No
  index: number;
  runId: string;
  target?: string | undefined;
  from?: string | undefined;
  digest?: string | undefined;
  name?: string | undefined;
  description?: string | undefined;
}

export interface PanelDeps {
  registry: RunRegistry;
  narrator: Narrator;
  cwd: string;
  paint: Paint;
  /** Close the panel. */
  close: () => void;
  requestRender?: () => void;
  control?: (runId: string, action: string) => ControlResult;
  /** Skip one running agent (`k`); defaults to skipRunAgent. */
  skip?: (runId: string, agentId: string) => ControlResult;
  isLive?: (runId: string) => boolean;
}

export class WorkflowPanel {
  view: "list" | "run" = "list";
  runId: string | undefined;
  listIndex = 0;
  agentIndex = 0;
  confirm: Confirm | undefined;
  note: string | undefined;
  private readonly deps: PanelDeps;

  constructor(deps: PanelDeps, runId?: string) {
    this.deps = deps;
    if (runId) {
      if (deps.registry.get(runId)) {
        this.view = "run";
        this.runId = runId;
      } else this.note = `No workflow run "${runId}" in this session.`;
    }
  }

  private control(runId: string, action: string): ControlResult {
    return (this.deps.control ?? controlRun)(runId, action);
  }

  private live(runId: string): boolean {
    return (this.deps.isLive ?? ((id: string) => runControls.has(id)))(runId);
  }

  private current(): RunSnapshot | undefined {
    return this.runId ? this.deps.registry.get(this.runId) : undefined;
  }

  press(key: PanelKey): void {
    if (this.confirm) {
      this.pressConfirm(key);
      this.deps.requestRender?.();
      return;
    }
    if (this.view === "list") this.pressList(key);
    else this.pressRun(key);
    this.deps.requestRender?.();
  }

  private pressConfirm(key: PanelKey): void {
    const c = this.confirm;
    if (!c) return;
    if (key === "up") c.index = Math.max(0, c.index - 1);
    else if (key === "down") c.index = Math.min(c.choices.length - 1, c.index + 1);
    else if (key === "esc") {
      this.confirm = undefined;
      this.note = c.action === "stop" ? "Not stopped." : "Not saved.";
    } else if (key === "enter") {
      this.confirm = undefined;
      if (c.index === 0) {
        this.note = c.action === "stop" ? "Not stopped." : "Not saved.";
        return;
      }
      if (c.action === "stop") this.note = this.control(c.runId, "stop").message;
      else if (c.target && c.from && c.digest) {
        try {
          saveScript(c.from, c.target, this.deps.cwd, c.digest, { name: c.name ?? "", description: c.description ?? "" });
          this.note = `Saved ${c.target}. Its digest is trusted, so this project workflow runs without the trust prompt until the file changes.`;
        } catch (error) {
          this.note = `Could not save ${c.target}: ${String(error)}`;
        }
      } else if (c.target && c.from) {
        try {
          saveCopy(c.from, c.target, this.deps.cwd);
          this.note = `Saved ${c.target}. It is a project workflow now: running it asks for trust first.`;
        } catch (error) {
          this.note = `Could not save ${c.target}: ${String(error)}`;
        }
      }
    }
  }

  private pressList(key: PanelKey): void {
    const runs = this.deps.registry.list();
    this.listIndex = Math.min(this.listIndex, Math.max(0, runs.length - 1));
    if (key === "up") this.listIndex = Math.max(0, this.listIndex - 1);
    else if (key === "down") this.listIndex = Math.min(Math.max(0, runs.length - 1), this.listIndex + 1);
    else if (key === "esc") this.deps.close();
    else if (key === "enter") {
      const run = runs[this.listIndex];
      if (!run) return;
      this.view = "run";
      this.runId = run.id;
      this.agentIndex = 0;
      this.note = undefined;
    }
  }

  private pressRun(key: PanelKey): void {
    const run = this.current();
    if (!run || key === "esc") {
      this.view = "list";
      this.note = undefined;
      const idx = this.deps.registry.list().findIndex((r) => r.id === this.runId);
      if (idx >= 0) this.listIndex = idx;
      return;
    }
    const last = Math.max(0, run.agents.length - 1);
    if (key === "up") this.agentIndex = Math.max(0, Math.min(this.agentIndex, last) - 1);
    else if (key === "down") this.agentIndex = Math.min(last, this.agentIndex + 1);
    else if (key === "stop") {
      if (!this.live(run.id)) this.note = `Run ${run.id} is not live; there is nothing to stop.`;
      else this.confirm = { action: "stop", question: `Stop run ${run.id} (${run.name})? Its running agents are stopped and the run ends interrupted.`, choices: [...STOP_CHOICES], index: 0, runId: run.id };
    } else if (key === "skip") {
      const a = run.agents[Math.min(this.agentIndex, last)];
      if (!this.live(run.id)) this.note = `Run ${run.id} is not live; there is nothing to skip.`;
      else if (!a) this.note = "No agent is selected.";
      else if (a.status !== "running") this.note = `${a.id} is not running; there is nothing to skip.`;
      else this.note = (this.deps.skip ?? skipRunAgent)(run.id, a.id).message;
    } else if (key === "pause") {
      if (!this.live(run.id)) this.note = `Run ${run.id} is not live; it cannot be paused or resumed here.`;
      else this.note = this.control(run.id, run.paused ? "resume" : "pause").message;
    } else if (key === "save") {
      const plan = planSave(run, this.deps.cwd);
      if (plan.target === undefined) this.note = plan.message;
      else {
        const rel = path.relative(this.deps.cwd, plan.target) || plan.target;
        this.confirm = {
          action: "save",
          question: plan.digest
            ? `${plan.overwrite ? `${rel} already exists. Overwrite it with ${plan.from}` : `Save ${plan.from} as the project workflow ${rel}`} and trust its digest (sha256 ${plan.digest}) in every project, so it runs without the trust prompt?`
            : plan.overwrite ? `${rel} already exists. Overwrite it with ${plan.from}?` : `Save a copy of ${plan.from} as the project workflow ${rel}?`,
          choices: [SAVE_NO, plan.digest ? (plan.overwrite ? `Overwrite ${rel} and trust it` : `Save and trust ${rel}`) : plan.overwrite ? `Overwrite ${rel}` : `Save as ${rel}`],
          index: 0,
          runId: run.id,
          target: plan.target,
          from: plan.from,
          digest: plan.digest,
          name: run.name,
          description: run.description,
        };
      }
    }
  }

  footer(): string {
    if (this.view === "list") return "↑↓ select · enter open · esc close";
    const run = this.current();
    return `↑↓ select · k skip · x stop · p ${run?.paused ? "resume" : "pause"} · s save · esc back`;
  }

  /** The panel's lines, each cut to `width` columns. */
  render(width: number): string[] {
    const { paint } = this.deps;
    const w = Math.max(20, width);
    const rule = paint.dim("─".repeat(Math.min(w, 120)));
    const out: string[] = [rule];
    const run = this.view === "run" ? this.current() : undefined;
    if (run) {
      this.agentIndex = Math.min(this.agentIndex, Math.max(0, run.agents.length - 1));
      out.push(...renderRunLines(run, { paint, narration: this.deps.narrator.lines(run.id), selected: run.agents.length ? this.agentIndex : undefined }).map((l) => ` ${l}`));
    } else {
      const runs = this.deps.registry.list();
      this.listIndex = Math.min(this.listIndex, Math.max(0, runs.length - 1));
      out.push(...renderListLines(runs, paint, runs.length ? this.listIndex : undefined).map((l) => ` ${l}`));
    }
    out.push("");
    if (this.note) out.push(` ${paint.tone("warn", oneLine(this.note))}`);
    if (this.confirm) {
      out.push(` ${paint.bold(this.confirm.question)}`);
      this.confirm.choices.forEach((choice, i) => out.push(i === this.confirm?.index ? ` ${paint.accent(`› ${choice}`)}` : `   ${choice}`));
      out.push(` ${paint.dim("↑↓ choose · enter confirm · esc cancel")}`);
    } else out.push(` ${paint.dim(this.footer())}`);
    out.push(rule);
    return out.map((l) => truncateToWidth(l, w, "…"));
  }
}

// --- registration -----------------------------------------------------------------------------

// Copied from control-center/hub.ts (extensions stay self-contained); workflow-panel-smoke checks
// the two agree.
/** True when the running pi has the overlay `done()` fix (1.3.0 or newer). */
export function supportsOverlay(version: string = VERSION): boolean {
  const parts = version.replace(/^[^0-9]*/, "").split(/[.\-+]/).map((p) => Number(p));
  const [major = 0, minor = 0] = parts;
  return major > 1 || (major === 1 && minor >= 3);
}

/** Open the panel (TUI) or print its text (any other mode). */
export async function openWorkflowPanel(ctx: ExtensionContext, runId?: string, registry: RunRegistry = runRegistry, narration: Narrator = narrator): Promise<void> {
  const cwd = ctx.cwd || process.cwd();
  if (ctx.mode !== "tui") {
    const text = renderText(registry, narration, runId);
    if (ctx.hasUI) ctx.ui.notify(text, "info");
    else {
      try {
        process.stderr.write(`${text}\n`);
      } catch {
        /* no stderr */
      }
    }
    return;
  }
  await ctx.ui.custom<undefined>(
    (tui, theme, keybindings, done) => {
      let closed = false;
      const offRegistry = registry.subscribe(() => tui.requestRender());
      // Elapsed times tick while the panel is open.
      const timer = setInterval(() => tui.requestRender(), 1000);
      timer.unref?.();
      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(timer);
        offRegistry();
      };
      const panel = new WorkflowPanel(
        {
          registry,
          narrator: narration,
          cwd,
          paint: themePaint(theme),
          requestRender: () => tui.requestRender(),
          close: () => {
            cleanup();
            done(undefined);
          },
        },
        runId,
      );
      return {
        render: (width: number) => panel.render(width),
        invalidate: () => {},
        handleInput: (data: string) => {
          const key = keyOf(data, keybindings);
          if (key) panel.press(key);
        },
        dispose: cleanup,
      };
    },
    supportsOverlay() ? { overlay: true, overlayOptions: { width: "90%", maxHeight: "90%" } } : undefined,
  );
}

// --- status line ------------------------------------------------------------------------------

export const STATUS_KEY = "workflows";

/** The footer status for this session's active runs, or undefined when none is running. */
export function statusLine(runs: RunSnapshot[]): string | undefined {
  const active = runs.filter((r) => r.status === "running");
  if (!active.length) return undefined;
  const parts: string[] = [];
  const only = active.length === 1 ? active[0] : undefined;
  if (only) {
    const c = counts(only);
    parts.push(`wf ${only.name}: ${c.agentsDone}/${c.agents} agents`);
    if (only.paused) parts.push("paused");
    const pct = budgetPercent(only);
    if (pct !== undefined) parts.push(`budget ${pct}%`);
    if (only.approvals > 0) parts.push(`approvals: ${only.approvals}`);
  } else {
    const done = active.reduce((n, r) => n + counts(r).agentsDone, 0);
    const all = active.reduce((n, r) => n + r.agents.length, 0);
    parts.push(`wf: ${active.length} running · ${done}/${all} agents`);
    const paused = active.filter((r) => r.paused).length;
    if (paused) parts.push(`${paused} paused`);
  }
  return parts.join(" · ");
}

/** Keeps one status line in step with the registry; setStatus is called only when the text changes. */
export class WorkflowStatus {
  private set: ((text: string | undefined) => void) | undefined;
  private last: string | undefined;
  private readonly registry: RunRegistry;

  constructor(registry: RunRegistry) {
    this.registry = registry;
  }

  attach(): () => void {
    return this.registry.subscribe(() => this.refresh());
  }

  /** Report to this session's footer (the latest session wins). */
  bind(set: (text: string | undefined) => void): void {
    this.set = set;
    this.last = undefined;
    this.push(statusLine(this.registry.list()));
  }

  unbind(): void {
    const set = this.set;
    this.set = undefined;
    this.last = undefined;
    try {
      set?.(undefined);
    } catch {
      /* the session is gone */
    }
  }

  refresh(): void {
    if (!this.set) return;
    const text = statusLine(this.registry.list());
    if (text !== this.last) this.push(text);
  }

  private push(text: string | undefined): void {
    this.last = text;
    try {
      this.set?.(text);
    } catch {
      /* a stale context must never break a run */
    }
  }
}

/** The process-wide status line; registerWorkflowPanel attaches it to the run registry. */
export const workflowStatus = new WorkflowStatus(runRegistry);

/** Point the status line at a session's footer (called from the subagent session_start handler). */
export function bindWorkflowStatus(ctx: ToolContext): void {
  if (process.env.PI_KIT_INTERNAL_CHILD === "1" || !ctx.hasUI) return;
  const ui = ctx.ui;
  if (!ui?.setStatus) return;
  workflowStatus.bind((text) => ui.setStatus?.(STATUS_KEY, text));
}

let attached = false;

/** Register `/workflows` and start narrating the session's runs. */
export function registerWorkflowPanel(pi: ExtensionAPI): void {
  // Workflows run in the operator's session; a subagent child has no panel.
  if (process.env.PI_KIT_INTERNAL_CHILD === "1") return;
  if (!attached) {
    narrator.attach(runRegistry);
    workflowStatus.attach();
    attached = true;
  }
  pi.registerCommand("workflows", {
    description: "Workflow runs panel: /workflows [run-id] (header, phases, agents, narrator; k skip · x stop · p pause · s save)",
    getArgumentCompletions: (prefix: string) => {
      const p = prefix.trim();
      return runRegistry
        .list()
        .filter((r) => r.id.startsWith(p))
        .map((r) => ({ value: r.id, label: r.id, description: `${r.name}: ${r.status}` }));
    },
    handler: async (args, ctx) => {
      await openWorkflowPanel(ctx, args.trim() || undefined);
    },
  });
}
