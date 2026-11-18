import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Component, sliceByColumn, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nodeRuntime } from "./shared/node-runtime.ts";
import { oneVisibleLine } from "./shared/visible-text.ts";

// Self-containment rule: only node:* builtins, the pi peers and the generated ./shared/ copy. The extension does not import the
// autonomy package: it runs its operator CLI (packages/autonomy/cli.ts) as a child process and
// speaks its `--json` protocol, exactly as an operator at a shell would.
//
// /autonomy is the operator's way to start and manage autonomous runs from inside pi. It is a
// COMMAND, not a tool: the model has no tool that starts, steers, authorises or promotes a run,
// because an autonomous run spends money and acts without prompts inside its boundary, and only a
// person may decide that. Every decision that matters is confirmed on screen with the boundary in
// front of the person, and without a screen the CLI's own rule applies: a run starts only from a
// contract that already carries an authorisation for exactly this boundary.
//
// What this does not prevent: a model with a shell tool can run the same CLI itself, and the CLI's
// `--yes` is consent by whoever holds the terminal. The tool firewall therefore classifies the CLI's
// control commands (start, plan --authorise, promote, resume, reconfigure, ...) as high and never
// learned (each one asks the operator, and an unattended worker is refused). That is a guard rail:
// the authorisation record is a consent and integrity record, not a signature (docs/autonomy.md).

const HERE = path.dirname(fileURLToPath(import.meta.url));

// The CLI's JSON is outside data: `unknown` until these guards narrow it.
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/** A field of a JSON value that may not be an object (a primitive or null reads as undefined). */
function field(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

export function cliPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.PI_AUTONOMY_CLI?.trim();
  return override || path.resolve(HERE, "..", "..", "..", "autonomy", "cli.ts");
}

export interface CliResult {
  code: number | null;
  /** The parsed `--json` object, or null when the CLI printed none. */
  json: Record<string, unknown> | null;
  stdout: string;
  stderr: string;
}

/** Run the CLI once. Always resolves (a missing CLI or a crash is a result, not an exception). */
export function runCli(args: string[], { json = true, cwd, timeoutMs = 120_000, env = process.env }: { json?: boolean; cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): Promise<CliResult> {
  const cli = cliPath(env);
  return new Promise((resolve) => {
    if (!fs.existsSync(cli)) {
      resolve({ code: null, json: null, stdout: "", stderr: `the autonomy CLI is not installed at ${cli} (a git install of the kit includes packages/autonomy; the npm package does not ship the runner)` });
      return;
    }
    // The CLI is a Node script. Under a compiled pi, process.execPath is pi itself, and
    // `pi cli.ts list` would run an agent turn with the path as its prompt (./shared/node-runtime.ts).
    const runtime = nodeRuntime({ env });
    if (!runtime.ok) {
      resolve({ code: null, json: null, stdout: "", stderr: `the autonomy CLI needs Node.js to run: ${runtime.reason}` });
      return;
    }
    const child = spawn(runtime.command, [cli, ...args, ...(json ? ["--json"] : [])], { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      let parsed: Record<string, unknown> | null = null;
      if (json) {
        try {
          const value: unknown = JSON.parse(stdout);
          if (isRecord(value) && !Array.isArray(value)) parsed = value;
        } catch { /* the CLI printed no JSON object */ }
      }
      resolve({ code, json: parsed, stdout, stderr });
    };
    const timer = setTimeout(() => { child.kill("SIGKILL"); stderr += `\ntimed out after ${timeoutMs / 1000}s`; finish(null); }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); if (stdout.length > 8_000_000) child.kill("SIGKILL"); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); if (stderr.length > 1_000_000) stderr = stderr.slice(-500_000); });
    child.on("error", (error) => { stderr += `\n${error.message}`; finish(null); });
    child.on("close", (code) => finish(code));
  });
}

/** Split a command line into words, honouring single and double quotes. No shell is involved anywhere. */
export function splitArgs(input: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: string | null = null;
  let started = false;
  for (const ch of input) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started || current) { words.push(current); current = ""; started = false; }
    } else current += ch;
  }
  if (started || current) words.push(current);
  return words;
}

const RUN_ID = /^[a-z0-9][a-z0-9-]{2,40}$/;

const USAGE = [
  "Autonomous runs: /autonomy <command>",
  "  templates                              what kinds of run exist",
  "  init <template> [flags]                write a run contract (flags as `pi-autonomy init`), e.g. --out run.json --spec \"...\" --check unit=\"npm test\"",
  "  plan <run.json>                        validate it and show the boundary and its digest",
  "  start <run.json> [--foreground]        show the boundary, ask you to confirm it, then start (in the background unless --foreground)",
  "  status [run]                           one run, or all of them; for one run with generations, also the footer status line",
  "  pause <run> | cancel <run>             stop a run's worker (the work is kept)",
  "  resume <run> [answer text | --approve | --deny]",
  "  steer <run> <message>                  send the worker one message",
  "  promote <run>                          carry out an approval-gated promotion",
  "  export <run> [dir]                     results, evidence, usage, decisions and the work",
  "  inbox [run] [--file <path>] [--answer <card> --value <text>]   owner cards, or runs waiting to be published",
  "  boundary <run.json> | boundary --run <run>",
  "  reconfigure <run> [--effort E4 --budget-usd n ...]   the only way effort or budgets change for a run",
  "  watch [on|off]                         the live run widget: show it now, or turn it off for this session",
  "Nothing starts without you confirming the boundary. Runs need a container engine; see docs/autonomy.md.",
].join("\n");

function say(ctx: ExtensionCommandContext, text: string, level: "info" | "warning" | "error" = "info"): void {
  if (ctx.hasUI) ctx.ui.notify(text, level);
  else process.stderr.write(`[autonomy] ${text}\n`);
}

const problemLine = (p: unknown): string => {
  const level: unknown = field(p, "level") ?? "error";
  const where: unknown = field(p, "path") ?? "";
  const message: unknown = field(p, "message") ?? p;
  return `  ${String(level)} ${String(where)}: ${String(message)}`;
};

const errorText = (r: CliResult): string => {
  const j = r.json;
  if (j?.ok === false) {
    const problems = isArray(j.problems) ? `\n${j.problems.map(problemLine).join("\n")}` : "";
    const error: unknown = j.error ?? "the command failed";
    return `${String(error)}${problems}`;
  }
  return (r.stderr || r.stdout || "the command failed").trim().slice(0, 4000);
};

const templateLine = (t: unknown): string => {
  const requires = field(t, "requires") ?? [];
  return `${String(field(t, "id"))} (${field(t, "finite") ? "finite" : "cycling"}): ${String(field(t, "title"))}\n  ${String(field(t, "summary"))}\n  needs: ${(isArray(requires) ? requires : []).join("; ")}`;
};

/** The footer key the generations status line is shown under. */
export const STATUS_KEY = "autonomy";

const ROTATION_BOX: Record<string, string> = { minutes: "time box", usd: "dollar box" };

/** The order a fleet summary lists statuses in; any other status follows alphabetically. */
const FLEET_STATUS_ORDER = ["running", "blocked", "paused", "queued", "setup"] as const;

/**
 * The footer status line for one run's `status --json` report: its generation n/N, the run's status
 * and why the last generation rotated. Undefined (the line is cleared) when the report is not a run
 * with generations (Memento mode) enabled. The report is the CLI's JSON, so every field is narrowed.
 */
export function generationStatusLine(report: unknown): string | undefined {
  const g = field(report, "generations");
  if (!isRecord(g)) return undefined;
  const run = field(report, "run");
  const status = field(report, "status");
  const current = field(g, "current");
  const max = field(g, "max");
  if (typeof run !== "string" || !RUN_ID.test(run) || typeof max !== "number") return undefined;
  const gen = typeof current === "number" && current > 0 ? `gen ${current}/${max}` : `gen -/${max}`;
  const last = field(g, "lastRotation");
  const box = field(last, "box");
  const why = isRecord(last) ? `; last rotation: ${typeof box === "string" && Object.hasOwn(ROTATION_BOX, box) ? ROTATION_BOX[box] : "box"}${field(last, "notebook") === true ? "" : ", no notebook"}` : "";
  return `memento ${run}: ${gen}${typeof status === "string" && /^[a-z_]{1,32}$/.test(status) ? `, ${status}` : ""}${why}`;
}

/** A worker string reaches the footer: collapse it to one visible line (no control or format characters). */
const oneLine = oneVisibleLine;

/**
 * The footer status line for the no-run `status --json` report: how many runs there are, how many
 * are in each status, and the first blocked run with the question it waits on. Undefined (the line
 * is cleared) when the fleet is empty or a run's status is unusable. Every field is narrowed.
 */
export function fleetStatusLine(report: unknown): string | undefined {
  const runs = field(report, "runs");
  if (!isArray(runs) || runs.length === 0) return undefined;
  const counts = new Map<string, number>();
  for (const r of runs) {
    const status = field(r, "status");
    if (typeof status !== "string" || !/^[a-z_]{1,32}$/.test(status)) return undefined;
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  const ordered = [
    ...FLEET_STATUS_ORDER.filter((s) => counts.has(s)),
    ...[...counts.keys()].filter((s) => !(FLEET_STATUS_ORDER as readonly string[]).includes(s)).sort(),
  ];
  let blocked: string | undefined;
  for (const r of runs) {
    if (field(r, "status") !== "blocked") continue;
    const question = field(field(r, "blocker"), "question");
    if (typeof question !== "string") continue;
    const line = oneLine(question);
    blocked = `${oneLine(String(field(r, "run")))} (${line.length > 80 ? `${line.slice(0, 80)}\u2026` : line})`;
    break;
  }
  return `autonomy: ${runs.length} run${runs.length === 1 ? "" : "s"} \u2014 ${ordered.map((s) => `${counts.get(s) ?? 0} ${s}`).join(", ")}${blocked ? `; blocked: ${blocked}` : ""}`;
}

// --- the live run widget ----------------------------------------------------------------------

/** The key the live run widget is shown under. */
export const WIDGET_KEY = "autonomy";
/** How often the widget refreshes while a run is active. */
export const WIDGET_POLL_MS = 2_000;
/** The width the widget's lines are rendered at outside the terminal UI, which has no width to ask. */
const WIDGET_FALLBACK_WIDTH = 80;
/** The most runs the widget lists; the rest are counted on one line. */
const WIDGET_MAX_RUNS = 6;
/** How many of the host event log's newest events one refresh reads. */
const WIDGET_EVENT_LIMIT = 200;
/** One refresh's CLI calls give up after this long; the next tick tries again. */
const WIDGET_CLI_TIMEOUT_MS = 15_000;
/** How long the widget keeps refreshing after `/autonomy start` or `resume`, even before the run list shows the change. */
const WIDGET_GRACE_MS = 60_000;
/** Statuses a run does not leave without the operator (lib/lifecycle.ts): the widget does not list them. */
const ENDED: ReadonlySet<string> = new Set(["succeeded", "failed", "cancelled", "budget_exhausted"]);
const STATUS_WORD = /^[a-z_]{1,32}$/;

/** One run as the widget shows it, narrowed from `status --json`. */
export interface WidgetRun {
  run: string;
  template: string;
  status: string;
  step: number | null;
  spentUsd: number | null;
  budgetUsd: number | null;
  /** When the run's state last changed, in ms since the epoch; null when unknown. */
  updatedMs: number | null;
}

/** One host event as the widget uses it, narrowed from `events --json`. */
export interface WidgetEvent {
  run: string;
  atMs: number;
  /** The event's cycle number, when it has one. */
  n: number | null;
  /** What the run is doing, as of this event. */
  phase: string;
}

/** Worker or run text as one visible line of at most `max` characters. */
const clipText = (value: unknown, max: number): string => {
  const line = typeof value === "string" ? oneLine(value) : "";
  return line.length > max ? `${line.slice(0, max - 1)}\u2026` : line;
};

const nonNegative = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null);

/** The runs of a no-run `status --json` report the widget can show; a malformed row is left out. */
export function widgetRuns(report: unknown): WidgetRun[] {
  const runs = field(report, "runs");
  if (!isArray(runs)) return [];
  return runs.slice(0, 1000).flatMap((r): WidgetRun[] => {
    const run = field(r, "run");
    const status = field(r, "status");
    if (typeof run !== "string" || !RUN_ID.test(run) || typeof status !== "string" || !STATUS_WORD.test(status)) return [];
    const updated = field(r, "updatedAt");
    const updatedMs = typeof updated === "string" ? Date.parse(updated) : Number.NaN;
    return [{
      run,
      template: clipText(field(r, "template"), 24) || "-",
      status,
      step: nonNegative(field(r, "step")),
      spentUsd: nonNegative(field(r, "spentUsd")),
      budgetUsd: nonNegative(field(r, "budgetUsd")),
      updatedMs: Number.isFinite(updatedMs) ? updatedMs : null,
    }];
  });
}

/** What a run is doing as of one host event (the event types of packages/autonomy/lib/events.ts). */
function eventPhase(e: unknown): string | null {
  const item = clipText(field(e, "item"), 30);
  switch (field(e, "type")) {
    case "run.started": return "starting";
    case "run.status": return clipText(field(e, "to"), 20) || null;
    case "cycle.started": return item ? `working on ${item}` : "working";
    case "gate.result": return field(e, "green") === true ? "gate green" : "gate red";
    case "cycle.ended": return `cycle ${clipText(field(e, "outcome"), 20) || "ended"}`;
    case "push": return field(e, "ok") === true ? "pushed" : "push failed";
    case "failure": return `failure ${clipText(field(e, "code"), 30)}`.trim();
    case "dispatch.claim": return `claimed ${item}`.trim();
    case "dispatch.submit": return `submitted ${item}`.trim();
    default: return null;
  }
}

/** The events of an `events --json` report the widget can use; an unknown or malformed event is left out. */
export function widgetEvents(report: unknown): WidgetEvent[] {
  const events = field(report, "events");
  if (!isArray(events)) return [];
  return events.slice(-WIDGET_EVENT_LIMIT).flatMap((e): WidgetEvent[] => {
    const run = field(e, "run");
    const at = field(e, "at");
    const phase = eventPhase(e);
    if (typeof run !== "string" || typeof at !== "string" || phase === null) return [];
    const atMs = Date.parse(at);
    const n = field(e, "n");
    if (!Number.isFinite(atMs)) return [];
    return [{ run, atMs, n: typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : null, phase }];
  });
}

/**
 * Statuses the supervisor leaves on its own (TRANSITIONS in packages/autonomy/lib/lifecycle.ts):
 * a new run is `setup` while its container is built, then `ready`, then `running`. A paused or
 * blocked run changes only when the operator acts.
 */
const MOVING: ReadonlySet<string> = new Set(["setup", "ready", "running", "recovering"]);

/** A run whose status can change without the operator, so the widget keeps refreshing while one exists. */
export const isMovingRun = (r: WidgetRun): boolean => MOVING.has(r.status);

/**
 * A run the widget is shown for: one starting, running or recovering, or one paused part-way
 * through (a run's step counts its cycles from 0, so a run paused before its first cycle is not).
 */
export const isActiveRun = (r: WidgetRun): boolean => isMovingRun(r) || (r.status === "paused" && r.step !== null && r.step > 0);

/**
 * Whether the widget keeps refreshing: while a run can change on its own, or until `graceUntil`
 * (ms since the epoch) after a command that changed a run, whose new status the run list may not
 * show yet. A paused run alone is shown but not refreshed.
 */
export const widgetPolls = (runs: readonly WidgetRun[], now: number, graceUntil: number): boolean => runs.some(isMovingRun) || now < graceUntil;

const ageText = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
};

const dollars = (n: number | null): string => (n === null ? "$-" : `$${n.toFixed(2)}`);

/**
 * Plain `text` (no escape sequences: every value is one visible line) in at most `width` columns,
 * ending in an ellipsis when cut. pi-tui's truncateToWidth would add SGR resets, which a line
 * widget outside the terminal UI would show as text.
 */
const fit = (text: string, width: number): string =>
  visibleWidth(text) <= width ? text : `${sliceByColumn(text, 0, Math.max(0, width - 1), true)}\u2026`;

/** `text` cut to `width` columns (with an ellipsis) or padded to it. */
const column = (text: string, width: number): string => {
  const cut = fit(text, width);
  return cut + " ".repeat(Math.max(0, width - visibleWidth(cut)));
};

/**
 * The widget's lines: a heading and one line per run that has not ended (active runs first, at most
 * WIDGET_MAX_RUNS), each giving the run, its template, cycle, phase, spend against budget and the
 * age of its last event. No line is wider than `width` columns. Empty (the widget is hidden) when no
 * run is active.
 */
export function renderAutonomyWidget(runs: readonly WidgetRun[], events: readonly WidgetEvent[], now: number, width: number): string[] {
  const cols = Math.floor(width);
  if (!Number.isFinite(cols) || cols < 1) return [];
  const open = runs.filter((r) => !ENDED.has(r.status));
  const active = open.filter(isActiveRun);
  if (active.length === 0) return [];
  const last = new Map<string, WidgetEvent>();
  const cycle = new Map<string, number>();
  for (const e of events) {
    const prev = last.get(e.run);
    if (!prev || e.atMs >= prev.atMs) last.set(e.run, e);
    if (e.n !== null) cycle.set(e.run, Math.max(cycle.get(e.run) ?? 0, e.n));
  }
  const ordered = [...active, ...open.filter((r) => !isActiveRun(r))];
  const listed = ordered.slice(0, WIDGET_MAX_RUNS);
  const idWidth = Math.min(24, Math.max(...listed.map((r) => r.run.length)));
  const templateWidth = Math.min(14, Math.max(...listed.map((r) => r.template.length)));
  const waiting = open.length - active.length;
  const lines = [`autonomy: ${active.length} active${waiting ? `, ${waiting} waiting` : ""} (/autonomy status for detail, /autonomy watch off hides this)`];
  for (const r of listed) {
    const e = last.get(r.run);
    const n = cycle.get(r.run) ?? r.step;
    const phase = r.status === "running" ? (e?.phase ?? "running") : r.status;
    const spend = r.budgetUsd === null ? dollars(r.spentUsd) : `${dollars(r.spentUsd)}/${dollars(r.budgetUsd)}`;
    const since = e?.atMs ?? r.updatedMs;
    const age = since === null ? "-" : `${ageText(now - since)} ago`;
    lines.push(`  ${column(r.run, idWidth)}  ${column(r.template, templateWidth)}  cycle ${n === null ? "-" : String(n)}  ${phase}  ${spend}  ${age}`);
  }
  if (ordered.length > listed.length) lines.push(`  +${ordered.length - listed.length} more (/autonomy status)`);
  return lines.map((line) => fit(line, cols));
}

/**
 * The live run widget's poller for one session. A refresh reads the run list (`status --json`) and,
 * when a run is active, the newest host events (`events --json`), and shows the widget; with no
 * active run it hides the widget. It refreshes every WIDGET_POLL_MS on an unref'd timer while
 * widgetPolls says so, skipping a tick while the previous refresh is still running.
 */
function runWidget() {
  let ctx: ExtensionContext | undefined;
  let timer: NodeJS.Timeout | undefined;
  let inFlight = false;
  let off = false;
  let shown = false;
  let graceUntil = 0;
  let tui: TUI | undefined;
  let runs: WidgetRun[] = [];
  let events: WidgetEvent[] = [];

  const stop = (): void => {
    if (timer) clearInterval(timer);
    timer = undefined;
  };

  /** Keep refreshing on the timer, or stop. */
  const poll = (value: boolean): void => {
    if (!value) { stop(); return; }
    if (timer) return;
    timer = setInterval(() => { void refresh(); }, WIDGET_POLL_MS);
    timer.unref();
  };

  const hide = (on: ExtensionContext): void => {
    if (shown) {
      try { on.ui.setWidget(WIDGET_KEY, undefined); } catch { /* the session's UI is gone */ }
    }
    shown = false;
    tui = undefined;
  };

  const show = (on: ExtensionContext): void => {
    if (on.mode === "tui") {
      // The terminal renders the component at its current width on every frame, so a resize never overflows.
      if (!shown) {
        on.ui.setWidget(WIDGET_KEY, (t: TUI): Component => {
          tui = t;
          return { render: (width: number) => renderAutonomyWidget(runs, events, Date.now(), width), invalidate: () => undefined };
        });
      } else tui?.requestRender();
    } else {
      on.ui.setWidget(WIDGET_KEY, renderAutonomyWidget(runs, events, Date.now(), WIDGET_FALLBACK_WIDTH));
    }
    shown = true;
  };

  /**
   * Refresh now. `statusReport` is a `status --json` report the caller already has, so it is not
   * read twice; `changed` says a command just changed a run, so refreshing goes on for
   * WIDGET_GRACE_MS even while the run list does not show the change yet.
   */
  async function refresh(on: ExtensionContext | undefined = ctx, statusReport?: Record<string, unknown> | null, changed = false): Promise<void> {
    if (!on?.hasUI || off) return;
    if (changed) graceUntil = Date.now() + WIDGET_GRACE_MS;
    if (inFlight) return;
    ctx = on;
    inFlight = true;
    try {
      const report = statusReport === undefined ? (await runCli(["status"], { cwd: on.cwd, timeoutMs: WIDGET_CLI_TIMEOUT_MS })).json : statusReport;
      const next = report?.ok === true ? widgetRuns(report) : [];
      if (ctx !== on || off) return;
      poll(widgetPolls(next, Date.now(), graceUntil));
      if (!next.some(isActiveRun)) { hide(on); return; }
      const read = await runCli(["events", "--limit", String(WIDGET_EVENT_LIMIT)], { cwd: on.cwd, timeoutMs: WIDGET_CLI_TIMEOUT_MS });
      // A session that ended or a widget turned off while the CLI ran is not drawn on.
      if (ctx !== on || off) return;
      runs = next;
      events = read.json?.ok === true ? widgetEvents(read.json) : [];
      show(on);
    } catch {
      stop();
      hide(on);
    } finally {
      inFlight = false;
    }
  }

  return {
    refresh,
    /** `/autonomy watch on|off`. */
    setOff(on: ExtensionContext, value: boolean): void {
      off = value;
      if (value) { stop(); hide(on); }
    },
    /** The session ended: stop polling and forget its UI. */
    shutdown(): void {
      stop();
      ctx = undefined;
      shown = false;
      tui = undefined;
    },
  };
}

export default function autonomyRun(pi: ExtensionAPI) {
  const resolveFile = (ctx: ExtensionCommandContext, file: string): string => path.resolve(ctx.cwd ?? process.cwd(), file);
  const widget = runWidget();

  // Lifecycle only: show the widget at session start when a run is already active, and stop polling at shutdown.
  pi.on("session_start", (_event, ctx) => { void widget.refresh(ctx); });
  pi.on("session_shutdown", () => { widget.shutdown(); });

  async function show(ctx: ExtensionCommandContext, args: string[]): Promise<CliResult> {
    const r = await runCli(args, { json: false, cwd: ctx.cwd });
    say(ctx, (r.stdout || r.stderr).trim() || "(no output)", r.code === 0 ? "info" : "error");
    return r;
  }

  /** Run a command through the CLI's JSON protocol, and report its text output or its failure. */
  async function run(ctx: ExtensionCommandContext, args: string[]): Promise<CliResult> {
    const text = await runCli(args, { json: false, cwd: ctx.cwd });
    say(ctx, (text.stdout || text.stderr).trim() || "(no output)", text.code === 0 ? "info" : "error");
    return text;
  }

  async function start(ctx: ExtensionCommandContext, words: string[]): Promise<void> {
    const foreground = words.includes("--foreground");
    const file = words.find((w) => !w.startsWith("--"));
    if (!file) { say(ctx, "usage: /autonomy start <run.json> [--foreground]", "error"); return; }
    const config = resolveFile(ctx, file);
    const planned = await runCli(["plan", "--config", config], { cwd: ctx.cwd });
    if (planned.json?.ok !== true) { say(ctx, `cannot start: ${errorText(planned)}`, "error"); return; }
    const plan = planned.json;
    const text = await runCli(["plan", "--config", config], { json: false, cwd: ctx.cwd });
    const boundary = (text.stdout || "").trim();
    const planDigest: unknown = plan.digest ?? "";
    const digest = String(planDigest);
    // The text on screen and the digest that will be authorised come from two reads of the file: they must agree.
    if (!/^[a-f0-9]{64}$/.test(digest) || new RegExp(`^digest ${digest}$`, "m").exec(boundary) === null) { say(ctx, `not started: ${file} changed while its boundary was being read. Run /autonomy plan ${file} and try again.`, "error"); return; }
    const detach = !foreground;

    if (ctx.hasUI) {
      const who = os.userInfo().username;
      const ok = await ctx.ui.confirm(
        `Authorise this boundary and start run ${String(plan.run)}?`,
        `${boundary}\n\nThis run acts without approval prompts inside the boundary above and spends money up to its budget. Only you can authorise it (digest ${digest.slice(0, 12)}).`,
      );
      if (!ok) { say(ctx, "Not authorised. Nothing was started.", "info"); return; }
      if (field(plan.authorisation, "status") !== "authorised") {
        // --digest: authorise exactly the boundary that was on screen, even if the file changed since.
        const auth = await runCli(["plan", "--config", config, "--authorise", "--yes", "--by", who, "--digest", digest], { cwd: ctx.cwd });
        if (auth.json?.ok !== true) { say(ctx, `could not record the authorisation: ${errorText(auth)}`, "error"); return; }
      }
    } else if (field(plan.authorisation, "status") !== "authorised") {
      say(ctx, `not started: there is no screen to confirm the boundary on, and ${file} does not carry an authorisation for it (digest ${digest.slice(0, 12)}). Authorise it once at a terminal with \`pi-autonomy plan --config ${file} --authorise\`.`, "error");
      return;
    }

    const started = await runCli(["start", "--config", config, "--yes", ...(detach ? ["--detach"] : [])], { cwd: ctx.cwd, timeoutMs: detach ? 120_000 : 24 * 60 * 60 * 1000 });
    if (started.json?.ok !== true) { say(ctx, `not started: ${errorText(started)}`, "error"); return; }
    const s = started.json;
    const run = String(s.run);
    say(ctx, detach
      ? `Run ${run} started (supervisor pid ${String(s.pid)}). Follow it with /autonomy status ${run}; results with /autonomy export ${run}. Logs: ${String(s.log)}`
      : `Run ${run} ended: ${String(s.status)}${s.outcome ? ` (${String(field(s.outcome, "reason"))})` : ""}. Results: /autonomy export ${run}`);
    // The new run is in `setup` while its container is built: the widget shows it and keeps refreshing.
    if (detach) await widget.refresh(ctx, undefined, true);
  }

  /** Commands that change a run and first show the CLI's own account of what would change, then ask. */
  async function confirmed(ctx: ExtensionCommandContext, args: string[], title: string): Promise<void> {
    const first = await runCli(args, { cwd: ctx.cwd });
    const json = first.json;
    if (json?.ok === true) { say(ctx, (await runCli(args, { json: false, cwd: ctx.cwd })).stdout.trim() || "done"); return; }
    // A refusal that says it needs approval carries the description of what would happen.
    const error: unknown = json?.error ?? "";
    const needs = json?.ok === false && json.code === "refused" && /needs your (approval|confirmation)|--yes/.test(String(error));
    if (!needs) { say(ctx, errorText(first), "error"); return; }
    if (!ctx.hasUI) { say(ctx, `${errorText(first)}\n(no screen to confirm on; run the command at a terminal)`, "error"); return; }
    const ok = await ctx.ui.confirm(title, String(json.error));
    if (!ok) { say(ctx, "Not confirmed. Nothing changed.", "info"); return; }
    const done = await runCli([...args, "--yes"], { json: false, cwd: ctx.cwd });
    say(ctx, (done.stdout || done.stderr).trim() || "done", done.code === 0 ? "info" : "error");
  }

  pi.registerCommand("autonomy", {
    description: "Start and manage autonomous runs in a hardened container: /autonomy templates|init|plan|start|status|pause|resume|steer|cancel|promote|export|inbox|boundary|reconfigure|watch. A run only starts after you confirm its boundary.",
    getArgumentCompletions: (prefix: string) =>
      ["templates", "init", "plan", "start", "status", "pause", "resume", "steer", "cancel", "promote", "export", "inbox", "boundary", "reconfigure", "watch", "help"]
        .filter((v) => v.startsWith(prefix.trim().toLowerCase()))
        .map((v) => ({ value: v, label: v })),
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const words = splitArgs(args);
      const cmd = (words.shift() ?? "help").toLowerCase();
      const runId = (): string | null => {
        const id = words[0];
        if (!id || !RUN_ID.test(id)) { say(ctx, `usage: /autonomy ${cmd} <run>  (a run id such as todo-api-1; \`/autonomy status\` lists them)`, "error"); return null; }
        return id;
      };
      switch (cmd) {
        case "help":
        case "?":
          say(ctx, USAGE);
          return;
        case "templates": {
          const r = await runCli(["templates"], { cwd: ctx.cwd });
          const templates = r.json?.ok === true ? r.json.templates : undefined;
          if (!isArray(templates)) { say(ctx, errorText(r), "error"); return; }
          say(ctx, templates.map(templateLine).join("\n\n"));
          return;
        }
        case "init": {
          const template = words.shift();
          if (!template || template.startsWith("-")) { say(ctx, "usage: /autonomy init <template> [--out run.json] [--spec \"...\"] [--check id=command] ...  (see /autonomy templates)", "error"); return; }
          const out = words.includes("--out") ? [] : ["--out", "run.json"];
          const r = await runCli(["init", "--template", template, ...out, ...words], { cwd: ctx.cwd });
          if (r.json?.ok !== true) { say(ctx, `init failed: ${errorText(r)}`, "error"); return; }
          const problems = isArray(r.json.problems) ? r.json.problems : [];
          say(ctx, `Wrote ${String(r.json.path)}${problems.length ? `\n${problems.map((p) => `  ${String(field(p, "level"))} ${String(field(p, "path"))}: ${String(field(p, "message"))}`).join("\n")}` : ""}\nNext: /autonomy plan ${path.basename(String(r.json.path))}`);
          return;
        }
        case "plan": {
          if (!words[0]) { say(ctx, "usage: /autonomy plan <run.json>", "error"); return; }
          await show(ctx, ["plan", "--config", resolveFile(ctx, words[0])]);
          return;
        }
        case "boundary": {
          if (words[0] === "--run" && words[1]) { await show(ctx, ["boundary", "--run", words[1]]); return; }
          if (!words[0]) { say(ctx, "usage: /autonomy boundary <run.json> | boundary --run <run>", "error"); return; }
          await show(ctx, ["boundary", "--config", resolveFile(ctx, words[0])]);
          return;
        }
        case "start":
          return start(ctx, words);
        case "status": {
          if (words[0] && !RUN_ID.test(words[0])) { say(ctx, "usage: /autonomy status [run]", "error"); return; }
          await run(ctx, ["status", ...(words[0] ? ["--run", words[0]] : [])]);
          // One run: its generations, if any, become the footer status line (cleared otherwise).
          if (words[0] && ctx.hasUI) {
            const report = await runCli(["status", "--run", words[0]], { cwd: ctx.cwd });
            ctx.ui.setStatus(STATUS_KEY, report.json?.ok === true ? generationStatusLine(report.json) : undefined);
          }
          // No run: a one-line fleet summary, or the line is cleared when there are no runs; the
          // same report shows the live widget when a run is active.
          if (!words[0] && ctx.hasUI) {
            const report = await runCli(["status"], { cwd: ctx.cwd });
            ctx.ui.setStatus(STATUS_KEY, report.json?.ok === true ? fleetStatusLine(report.json) : undefined);
            await widget.refresh(ctx, report.json);
          }
          return;
        }
        case "watch": {
          const mode = words[0] ?? "on";
          if (mode !== "on" && mode !== "off") { say(ctx, "usage: /autonomy watch [on|off]", "error"); return; }
          if (!ctx.hasUI) { say(ctx, "the live run widget needs a screen", "error"); return; }
          widget.setOff(ctx, mode === "off");
          if (mode === "on") await widget.refresh(ctx);
          say(ctx, mode === "off" ? "The live run widget is off for this session; /autonomy watch on shows it again." : "The live run widget shows while a run is active (refreshed every 2 s).");
          return;
        }
        case "pause": {
          const id = runId();
          if (id) await run(ctx, ["pause", "--run", id]);
          return;
        }
        case "cancel": {
          const id = runId();
          if (!id) return;
          if (ctx.hasUI && !(await ctx.ui.confirm(`Cancel run ${id}?`, "The worker is stopped and the run ends as cancelled. The work is kept and can still be exported."))) { say(ctx, "Not cancelled."); return; }
          await run(ctx, ["cancel", "--run", id]);
          return;
        }
        case "resume": {
          const id = runId();
          if (!id) return;
          const rest = words.slice(1);
          const approve = rest.includes("--approve");
          const deny = rest.includes("--deny");
          const answer = rest.filter((w) => w !== "--approve" && w !== "--deny").join(" ").trim();
          if (approve && ctx.hasUI && !(await ctx.ui.confirm(`Approve for run ${id}?`, "You are answering the run's pending approval with yes. Check `/autonomy status` for what it is asking."))) { say(ctx, "Not approved."); return; }
          if (approve && !ctx.hasUI) { say(ctx, "approving a run's request needs a screen to confirm on", "error"); return; }
          const resumed = await run(ctx, ["resume", "--run", id, "--detach", ...(approve ? ["--approve"] : []), ...(deny ? ["--deny"] : []), ...(answer ? ["--answer", answer] : [])]);
          // A paused or blocked run is not refreshed on its own: watch for it to start running again.
          if (resumed.code === 0) await widget.refresh(ctx, undefined, true);
          return;
        }
        case "steer": {
          const id = runId();
          if (!id) return;
          const message = words.slice(1).join(" ").trim();
          if (!message) { say(ctx, "usage: /autonomy steer <run> <message>", "error"); return; }
          await run(ctx, ["steer", "--run", id, "--message", message]);
          return;
        }
        case "promote": {
          const id = runId();
          if (id) await confirmed(ctx, ["promote", "--run", id], `Promote the result of run ${id}?`);
          return;
        }
        case "export": {
          const id = runId();
          if (!id) return;
          await run(ctx, ["export", "--run", id, ...(words[1] ? ["--out", resolveFile(ctx, words[1])] : [])]);
          return;
        }
        case "inbox": {
          if (!words[0]) { await run(ctx, ["inbox"]); return; }
          // The CLI's own hint is `pi-autonomy inbox --run <run> ...`, so that form is accepted too.
          if (words[0] === "--run") words.shift();
          const id = runId();
          if (!id) return;
          const rest: string[] = [];
          for (let i = 1; i < words.length; i++) {
            const w = words[i];
            const value = words[i + 1];
            if (w === "--file" && value !== undefined) rest.push(w, resolveFile(ctx, value));
            else if (w === "--answer" && value !== undefined) rest.push(w, value);
            // The equals form: the CLI's parser rejects a separate value that starts with "--", and an answer is free text.
            else if (w === "--value" && value !== undefined) rest.push(`--value=${value}`);
            else { say(ctx, "usage: /autonomy inbox [run] [--file <path>] [--answer <card> --value <text>]", "error"); return; }
            i += 1;
          }
          await run(ctx, ["inbox", "--run", id, ...rest]);
          return;
        }
        case "reconfigure": {
          const id = runId();
          if (id) await confirmed(ctx, ["reconfigure", "--run", id, ...words.slice(1)], `Change run ${id}'s limits?`);
          return;
        }
        default:
          say(ctx, `unknown command "${cmd}".\n${USAGE}`, "error");
          return;
      }
    },
  });
}
