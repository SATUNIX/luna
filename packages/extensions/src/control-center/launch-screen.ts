/**
 * The Luna launch screen: the wordmark, a one-line summary and a systemd-style status list.
 *
 *     [ OK ] branch-lab     [ OK ] effort     [FAIL] web-console: registered nothing
 *
 * A first start adds a short card under the summary (how to get a model, one prompt to try) until the
 * first prompt is sent. Names only, no paths. Detail lives in `/menu` (Doctor page), not on screen. The list is revealed
 * over a handful of short frames and the timer stops itself; reduced motion, ASCII mode and
 * NO_COLOR draw the finished screen once with no timer; NO_COLOR also draws it uncoloured. Every line is clipped to the width.
 *
 * Edit freely: this file only draws. What is on or off comes from `boot-status.ts`.
 *
 * Self-containment rule: import only node:* builtins, pi peers and sibling modules.
 */
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import type { BootItem } from "./boot-status.ts";

export const REVEAL_FRAMES = 10;
export const REVEAL_FRAME_MS = 70;

/** Below this many columns the wordmark and the list are dropped; below this many rows only the wordmark is. */
const MIN_LIST_WIDTH = 60;
const MIN_ART_ROWS = 28;

export interface LaunchTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

const PLAIN: LaunchTheme = { fg: (_color, text) => text, bold: (text) => text };

export interface LaunchInfo {
  version: string;
  hubKey: string;
  menuCmd: string;
  /** Short facts for the summary line, already formatted: `profile balanced`, `security guarded`. */
  facts: string[];
  items: BootItem[];
  /** First-run lines (what to do next); absent after the first prompt has been sent. */
  firstRun?: string[];
}

/** What a first start needs to say: how to get a model, and one thing to try. Shorter once a model exists. */
export function firstRunCard(hasModel: boolean): string[] {
  const example = 'try: "summarise this repo and suggest one improvement"';
  return hasModel ? [`First run: ${example}`] : ["First run: no model yet. /login to sign in or add an API key, or /llama for a local model", example];
}

const BLOCK_ART = [
  "  ██╗     ██╗   ██╗███╗   ██╗ █████╗ ",
  "  ██║     ██║   ██║████╗  ██║██╔══██╗",
  "  ██║     ██║   ██║██╔██╗ ██║███████║",
  "  ██║     ██║   ██║██║╚██╗██║██╔══██║",
  "  ███████╗╚██████╔╝██║ ╚████║██║  ██║",
  "  ╚══════╝ ╚═════╝ ╚═╝  ╚═══╝╚═╝  ╚═╝",
];

const ASCII_ART = [
  "  _",
  " | |   _   _ _ __   __ _ ",
  " | |  | | | | '_ \\ / _` |",
  " | |__| |_| | | | | (_| |",
  " |____|\\__,_|_| |_|\\__,_|",
];

/** Theme names that ask for ASCII glyphs; the rule `custom-footer` uses (`footerGlyphs`). */
export function asciiThemeName(name?: string): boolean {
  return /(?:^|[-_])(iso|ansi|tty|ascii)(?:[-_]|$)/i.test(name ?? "");
}

/** No animation: the env opt-outs, a dumb terminal, CI, or `reducedMotion` in `pi-kit/ui.json`. */
export function isReducedMotion(ui?: Record<string, unknown>): boolean {
  if (process.env.PI_KIT_REDUCED_MOTION === "1" || ui?.reducedMotion === true) return true;
  return process.env.TERM === "dumb" || process.env.CI !== undefined || noColorRequested();
}

/** NO_COLOR (any non-empty value, per no-color.org) asks for uncoloured output. */
export function noColorRequested(): boolean {
  return (process.env.NO_COLOR ?? "") !== "";
}

export interface LaunchRender {
  width: number;
  rows: number;
  /** 0..REVEAL_FRAMES-1; the last frame is the finished screen. */
  frame: number;
  ascii: boolean;
  info: LaunchInfo;
  theme: LaunchTheme;
}

function cell(item: BootItem, theme: LaunchTheme, pending: boolean): string {
  if (pending) return `${theme.fg("warning", "[ .. ]")} ${theme.fg("dim", item.name)}`;
  if (item.state === "ok") return `${theme.fg("success", "[ OK ]")} ${item.name}`;
  if (item.state === "idle") return `${theme.fg("dim", "[ -- ]")} ${theme.fg("dim", `${item.name} (idle)`)}`;
  if (item.state === "fail") return `${theme.fg("error", "[FAIL]")} ${item.name}`;
  return `${theme.fg("dim", "[ -- ]")} ${theme.fg("dim", item.name)}`;
}

/** The launch screen at a frame. Pure: same input, same lines. */
export function launchLines(opts: LaunchRender): string[] {
  const { info, width } = opts;
  const theme = opts.ascii ? PLAIN : opts.theme;
  const sep = opts.ascii ? " | " : " · ";
  const lines: string[] = [];

  if (opts.rows >= MIN_ART_ROWS && width >= MIN_LIST_WIDTH) {
    for (const line of opts.ascii ? ASCII_ART : BLOCK_ART) lines.push(theme.fg("accent", line));
    lines.push("");
  }

  const failed = info.items.filter((item) => item.state === "fail");
  const loaded = info.items.filter((item) => item.state === "ok").length;
  lines.push(`${theme.bold("Luna")} ${theme.fg("dim", info.version)}${sep}${[...info.facts, `${loaded} loaded`, `${failed.length} failed`].join(sep)}`);
  lines.push(theme.fg("dim", `${info.menuCmd}${sep}${info.hubKey}${sep}/model${sep}/resume`));
  for (const line of info.firstRun ?? []) lines.push(theme.fg("accent", line));

  const failLine = (item: BootItem): string => `${cell(item, theme, false)}${item.note ? theme.fg("error", `: ${item.note}`) : ""}`;
  if (width < MIN_LIST_WIDTH) {
    lines.push(...failed.map(failLine));
    return lines.map((line) => clip(line, width, opts.ascii));
  }

  // Reveal the first `shown` items; the newest few are still "[ .. ]".
  const final = opts.frame >= REVEAL_FRAMES - 1;
  const shown = final ? info.items.length : Math.ceil(((opts.frame + 1) / REVEAL_FRAMES) * info.items.length);
  const pendingCount = final ? 0 : Math.max(2, Math.ceil(info.items.length / REVEAL_FRAMES));
  const settled = new Set(info.items.slice(0, Math.max(0, shown - pendingCount)));
  const visible = info.items.slice(0, shown);

  lines.push("");
  lines.push(...visible.filter((item) => item.state === "fail").map(failLine));

  const on = visible.filter((item) => item.state === "ok");
  if (on.length > 0) {
    const colWidth = Math.max(...on.map((item) => 7 + item.name.length)) + 2;
    const cols = Math.max(1, Math.floor(width / colWidth));
    for (let start = 0; start < on.length; start += cols) {
      const row = on.slice(start, start + cols).map((item) => cell(item, theme, !settled.has(item)) + " ".repeat(colWidth - 7 - item.name.length));
      lines.push(row.join("").trimEnd());
    }
  }

  const off = visible.filter((item) => item.state === "off" || item.state === "idle").map((item) => item.name);
  // One line, clipped: the full list is a /menu away.
  if (off.length > 0) lines.push(theme.fg("dim", `[ -- ] ${off.length} off: ${off.join(" ")}`));

  return lines.map((line) => clip(line, width, opts.ascii));
}

function clip(line: string, width: number, ascii: boolean): string {
  const clipped = truncateToWidth(line, Math.max(0, Math.floor(width)), ascii ? "..." : "…");
  return ascii ? stripTerminalSequences(clipped) : clipped;
}

export interface LaunchHeaderOptions {
  /** Called on each render until the reveal ends, so late registrations are not reported as failures. */
  info: () => LaunchInfo;
  ascii: boolean;
  reducedMotion: boolean;
}

/** The `ctx.ui.setHeader` factory. The timer stops itself at the last frame and on `dispose()`. */
export function launchHeader(opts: LaunchHeaderOptions): (tui: TUI, theme: Theme) => Component & { dispose?(): void } {
  return (tui, theme) => {
    const launchTheme: LaunchTheme = noColorRequested()
      ? PLAIN
      : {
          fg: (color, text) => theme.fg(color as ThemeColor, text),
          bold: (text) => theme.bold(text),
        };
    let frame = opts.reducedMotion ? REVEAL_FRAMES - 1 : 0;
    let timer: ReturnType<typeof setInterval> | undefined;
    const stop = (): void => {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    };
    if (!opts.reducedMotion) {
      timer = setInterval(() => {
        frame += 1;
        if (frame >= REVEAL_FRAMES - 1) stop();
        tui.requestRender();
      }, REVEAL_FRAME_MS);
      timer.unref?.();
    }
    // Registrations can land after this handler runs, so recompute for the first second, then freeze.
    const born = Date.now();
    let frozen: LaunchInfo | undefined;
    return {
      render: (width) => {
        const info = frozen ?? opts.info();
        if (frame >= REVEAL_FRAMES - 1 && Date.now() - born > 1000) frozen = info;
        return launchLines({ width, rows: tui.terminal.rows, frame, ascii: opts.ascii || asciiThemeName(theme.name), info, theme: launchTheme });
      },
      invalidate: () => {},
      dispose: stop,
    };
  };
}
