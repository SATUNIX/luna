/**
 * The Luna launch screen: a short wordmark, the running pi version and the five first actions.
 *
 * The reveal is a progressive reveal of the same final content, at most twelve frames. Reduced
 * motion renders that final content at once and starts no timer. Every line is clipped with
 * `truncateToWidth`, so a narrow terminal gets one compact line instead of broken art. ASCII mode
 * avoids every non-ASCII glyph (and every styling escape) so it stays printable US-ASCII.
 *
 * Self-containment rule: import only node:* builtins, pi peers and sibling modules.
 */
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";

/** Frames in the reveal, and the interval between them. */
export const REVEAL_FRAMES = 12;
export const REVEAL_FRAME_MS = 90;

/** Below this many columns the art is dropped for one compact line. */
export const COMPACT_WIDTH = 60;

export interface LaunchTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

export interface LaunchLineOptions {
  width: number;
  frame: number;
  reducedMotion: boolean;
  ascii: boolean;
  version: string;
  hubKey: string;
  menuCmd: string;
  theme: LaunchTheme;
}

export interface LaunchHeaderOptions {
  version: string;
  hubKey: string;
  menuCmd: string;
  ascii: boolean;
  reducedMotion: boolean;
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

/** Reduced motion from the environment or the parsed `pi-kit/ui.json` record. */
export function isReducedMotion(ui?: Record<string, unknown>): boolean {
  if (process.env.PI_KIT_REDUCED_MOTION === "1") return true;
  if (ui?.reducedMotion === true) return true;
  if (process.env.TERM === "dumb") return true;
  if (process.env.CI !== undefined) return true;
  return false;
}

/** The final content, before the progressive reveal and width clipping. */
function contentLines(opts: LaunchLineOptions): string[] {
  const style: LaunchTheme = opts.ascii ? { fg: (_color, text) => text, bold: (text) => text } : opts.theme;
  const separator = opts.ascii ? " | " : " · ";
  if (opts.width < COMPACT_WIDTH) {
    return [
      `${style.bold("Luna")} ${opts.menuCmd}${separator}${opts.hubKey}${separator}/profile${separator}/model${separator}/resume${separator}pi ${opts.version}`,
    ];
  }
  const art = opts.ascii ? ASCII_ART : BLOCK_ART;
  const actions = [
    `${opts.menuCmd}   command menu`,
    `${opts.hubKey}   control centre`,
    "/profile   switch profile",
    "/model   choose model",
    "/resume   resume a session",
  ];
  return [
    `${style.bold("Luna")}  ${style.fg("dim", `${opts.menuCmd}${separator}pi ${opts.version}`)}`,
    "",
    ...art.map((line) => style.fg("accent", line)),
    "",
    ...actions.map((line) => style.fg("text", line)),
  ];
}

/** Clip one line to the terminal width. ASCII mode keeps its ellipsis printable too. */
function clip(line: string, width: number, ascii: boolean): string {
  const clipped = truncateToWidth(line, Math.max(0, Math.floor(width)), ascii ? "..." : "…");
  // truncateToWidth closes with reset/hyperlink escapes even for plain text; strip them in ASCII mode.
  return ascii ? stripTerminalSequences(clipped) : clipped;
}

/** The launch lines at a frame: a progressive reveal, or the final frame when reduced. */
export function launchLines(opts: LaunchLineOptions): string[] {
  const content = contentLines(opts);
  const final = opts.reducedMotion || opts.frame >= REVEAL_FRAMES - 1;
  const revealed = final ? content.length : Math.max(1, Math.ceil(((Math.max(0, opts.frame) + 1) / REVEAL_FRAMES) * content.length));
  const shown = content.slice(0, Math.min(content.length, revealed));
  return shown.map((line) => clip(line, opts.width, opts.ascii));
}

/**
 * The `ctx.ui.setHeader` factory. The component owns the reveal timer, clears it when the final
 * frame is reached and clears it again on `dispose()`.
 */
export function launchHeader(opts: LaunchHeaderOptions): (tui: TUI, theme: Theme) => Component & { dispose?(): void } {
  return (tui, theme) => {
    const launchTheme: LaunchTheme = {
      fg: (color: string, text: string) => theme.fg(color as ThemeColor, text),
      bold: (text: string) => theme.bold(text),
    };
    let frame = opts.reducedMotion ? REVEAL_FRAMES - 1 : 0;
    let timer: ReturnType<typeof setInterval> | undefined;
    const stop = (): void => {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    };
    const component: Component & { dispose?(): void } = {
      render: (width: number): string[] =>
        launchLines({
          width,
          frame,
          reducedMotion: opts.reducedMotion,
          ascii: opts.ascii,
          version: opts.version,
          hubKey: opts.hubKey,
          menuCmd: opts.menuCmd,
          theme: launchTheme,
        }),
      invalidate: (): void => {},
      dispose: stop,
    };
    if (!opts.reducedMotion) {
      timer = setInterval(() => {
        if (frame < REVEAL_FRAMES - 1) frame++;
        if (frame >= REVEAL_FRAMES - 1) stop();
        tui.requestRender();
      }, REVEAL_FRAME_MS);
      timer.unref?.();
    }
    return component;
  };
}
