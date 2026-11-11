/**
 * A theme-aware rounded border for a kit TUI overlay, plus the transcript dimming behind it.
 *
 * pi draws an overlay on top of the transcript without dimming it, and the kit's two overlays (the
 * `/` menu hub and the `/workflows` panel) accept whatever width the host gives them. `withOverlayFrame`
 * wraps such a component: it frames every rendered line in a rounded `border`-coloured box, and while
 * the overlay is open it dims the base transcript lines the host composites the overlay onto.
 *
 * `compositeOverlays` is protected on the host's `TuiBase` and absent from pi-tui's public `TUI`
 * type, so it is reached through a structural cast of the trusted host object. If the host does not
 * expose it, or an overlay frame is already installed, the wrapper only frames.
 *
 * Extensions are self-contained, so the vendor copy of this file
 * (`packages/extensions/third_party/subagent/overlay-frame.ts`) is byte-identical to this one, like
 * `supportsOverlay`; the smokes assert the equality.
 */
import { stripTerminalSequences, truncateToWidth, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";

/** The theme surface the border and dimming need; pi's `Theme` satisfies it. */
export interface OverlayTheme {
  fg(color: string, text: string): string;
}

/** Where the compositing patch is marked on a host instance, so it is never stacked. */
const COMPOSITE_MARK = Symbol.for("pi-kit.overlay-frame.composite");
/** kitty graphics protocol and iTerm2 inline image prefixes; image lines are left undimmed. */
const KITTY_IMAGE = "\x1b_G";
const ITERM_IMAGE = "\x1b]1337;File=";

/** The protected host members reached structurally, since the public `TUI` omits them. */
interface CompositeHost {
  compositeOverlays?: (lines: string[], termWidth: number, termHeight: number) => string[];
  hasOverlay?: () => boolean;
  [key: symbol]: unknown;
}

function isImageLine(line: string): boolean {
  return line.includes(KITTY_IMAGE) || line.includes(ITERM_IMAGE);
}

/** Draw one content row inside the vertical borders, exactly `width` cells wide. */
function contentLine(line: string, width: number, inner: number, theme: OverlayTheme): string {
  const border = theme.fg("border", "│");
  const truncated = truncateToWidth(line, inner, "…");
  const pad = Math.max(0, inner - visibleWidth(truncated));
  return `${border} ${truncated}${" ".repeat(pad)} ${border}`;
}

/** Draw the top border, embedding `title` after the first dash when present. */
function topLine(width: number, inner: number, theme: OverlayTheme, title?: string): string {
  const available = width - 2;
  let body: string;
  const titleText = title ? truncateToWidth(title, inner - 1, "…") : "";
  if (titleText) {
    // `╭` + one dash + " title " + the dashes that remain between the corners.
    const used = 1 + 2 + visibleWidth(titleText);
    body = `─ ${titleText} ${"─".repeat(Math.max(0, available - used))}`;
  } else {
    body = "─".repeat(Math.max(0, available));
  }
  return theme.fg("border", `╭${body}╮`);
}

/** Draw the bottom border. */
function bottomLine(width: number, theme: OverlayTheme): string {
  return theme.fg("border", `╰${"─".repeat(Math.max(0, width - 2))}╯`);
}

/**
 * Frame `lines` in a rounded border of exactly `width` visible cells. Widths below 10 are left as
 * they are, so a narrow overlay is not squeezed into a useless box.
 */
export function frameLines(lines: string[], width: number, theme: OverlayTheme, title?: string): string[] {
  if (width < 10) return lines;
  const inner = width - 4;
  return [topLine(width, inner, theme, title), ...lines.map((line) => contentLine(line, width, inner, theme)), bottomLine(width, theme)];
}

/**
 * Shadow `compositeOverlays` on this host instance while an overlay is open, dimming the transcript
 * behind it. Returns an idempotent restore. A host without the method, or one already patched, is
 * left alone.
 */
function installDimPatch(tui: TUI, theme: OverlayTheme): () => void {
  const host = tui as unknown as CompositeHost;
  const original = host.compositeOverlays;
  if (typeof original !== "function" || host[COMPOSITE_MARK] !== undefined) return () => {};
  host[COMPOSITE_MARK] = true;
  host.compositeOverlays = (lines: string[], termWidth: number, termHeight: number): string[] => {
    const open = typeof host.hasOverlay === "function" ? host.hasOverlay() : true;
    if (!open) return original.call(host, lines, termWidth, termHeight);
    const dimmed = lines.map((line) => (isImageLine(line) ? line : theme.fg("dim", stripTerminalSequences(line))));
    return original.call(host, dimmed, termWidth, termHeight);
  };
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    host.compositeOverlays = original;
    Reflect.deleteProperty(host, COMPOSITE_MARK);
  };
}

/**
 * Wrap `build`'s component in the frame and install the dim patch, restoring it when the overlay
 * closes (`done`) or is disposed. `build` receives the wrapped `done` so the overlay's own closures
 * (the hub's `SettingsList` handlers, the panel's `close`) restore the transcript too.
 */
export function withOverlayFrame<T>(
  tui: TUI,
  theme: OverlayTheme,
  build: (done: (result?: T) => void) => Component,
  done: (result?: T) => void,
): Component & { dispose?(): void } {
  const restore = installDimPatch(tui, theme);
  let restored = false;
  const finish = (result?: T): void => {
    if (!restored) {
      restored = true;
      restore();
    }
    done(result);
  };
  let inner: Component & { dispose?(): void };
  try {
    inner = build(finish);
  } catch (error) {
    // A throwing build never returns a component to dispose, so restore the dim patch here.
    if (!restored) {
      restored = true;
      restore();
    }
    throw error;
  }
  return {
    render: (width: number): string[] => frameLines(inner.render(width), width, theme),
    invalidate: (): void => inner.invalidate(),
    handleInput: (data: string): void => {
      inner.handleInput?.(data);
    },
    dispose: (): void => {
      if (!restored) {
        restored = true;
        restore();
      }
      inner.dispose?.();
    },
  };
}
