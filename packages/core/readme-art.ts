#!/usr/bin/env node
/**
 * Generate the animated SVG illustrations the README, the documentation and the website show
 * (`docs/assets/luna-*.svg`), in the Proof style: paper and ink, 2px rules, square corners, mono
 * labels and one loud colour (lime).
 *
 * Each illustration is a vector file of a few kilobytes animated with CSS keyframes, so it renders
 * at the display's own resolution and frame rate wherever an `<img>` shows an SVG (GitHub renders
 * them through its image proxy). Nothing in a file runs script or loads anything: text uses font
 * stacks, not web fonts. Every illustration comes in a light and a dark variant (`-dark.svg`) for a
 * `<picture>` element, and its un-animated state is the finished frame, which is what a viewer
 * with `prefers-reduced-motion: reduce` sees.
 *
 * Deterministic: the same source always produces the same bytes. tests/site-smoke.ts fails when
 * the committed files differ from this output, so edit this file and regenerate:
 *
 *   node packages/core/readme-art.ts            # write docs/assets/luna-*.svg
 *   node packages/core/readme-art.ts --check    # exit 1 if a committed file is stale
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WORKSPACE_ROOT } from "./lib/paths.ts";

export const ART_DIR = path.join(WORKSPACE_ROOT, "docs", "assets");

/** Proof colour tokens (light theme first; dark is a full remap). */
interface Theme {
  id: "light" | "dark";
  bg: string; surface: string; fg: string; muted: string; hair: string; rule: string;
  accent: string; onAccent: string; link: string; invBg: string; invFg: string;
  codeBg: string; codeFg: string; codeDim: string;
  success: string; warning: string; danger: string;
  /** Signal colours as they read on the code ground, which is black in both themes. */
  codeSuccess: string; codeWarning: string; codeDanger: string;
}

const LIGHT: Theme = {
  id: "light", bg: "#ECECEA", surface: "#F5F5F3", fg: "#000000", muted: "#55554F", hair: "rgba(0,0,0,0.2)", rule: "#000000",
  accent: "#C4FF0D", onAccent: "#000000", link: "#4F00FF", invBg: "#000000", invFg: "#ECECEA",
  codeBg: "#000000", codeFg: "#ECECEA", codeDim: "#8E8E8E",
  success: "#005F73", warning: "#9A4F00", danger: "#C41E00",
  codeSuccess: "#4DD6E8", codeWarning: "#FFB020", codeDanger: "#FF6A4D",
};
const DARK: Theme = {
  id: "dark", bg: "#000000", surface: "#111111", fg: "#ECECEA", muted: "#A3A39D", hair: "rgba(236,236,234,0.25)", rule: "#ECECEA",
  accent: "#C4FF0D", onAccent: "#000000", link: "#C4FF0D", invBg: "#ECECEA", invFg: "#000000",
  codeBg: "#111111", codeFg: "#ECECEA", codeDim: "#8E8E8E",
  success: "#4DD6E8", warning: "#FFB020", danger: "#FF6A4D",
  codeSuccess: "#4DD6E8", codeWarning: "#FFB020", codeDanger: "#FF6A4D",
};
export const THEMES: readonly Theme[] = [LIGHT, DARK];

const SANS = "Archivo, 'Helvetica Neue', Helvetica, Arial, sans-serif";
const MONO = "'Martian Mono', ui-monospace, 'SF Mono', Menlo, Consolas, 'DejaVu Sans Mono', monospace";

/** Escape text for an XML text node or attribute. */
function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
/** A number as SVG writes it: at most two decimals, no trailing zeros. */
function n(value: number): string {
  return String(Math.round(value * 100) / 100);
}
const pct = (t: number, loop: number): string => `${n((t / loop) * 100)}%`;

/**
 * One illustration under construction: markup plus the keyframes it needs. Every animation shares
 * the loop length, so the timeline is written in seconds and converted to percentages here.
 */
class Art {
  readonly body: string[] = [];
  private readonly css: string[] = [];
  private count = 0;

  readonly width: number;
  readonly height: number;
  readonly loop: number;
  readonly theme: Theme;

  constructor(width: number, height: number, loop: number, theme: Theme) {
    this.width = width;
    this.height = height;
    this.loop = loop;
    this.theme = theme;
  }

  private name(): string {
    this.count += 1;
    return `k${this.count}`;
  }

  /** A class that hard-cuts the element in at `from` and out at `to` (step-end: no transitions). */
  show(from: number, to = this.loop - 0.4): string {
    const k = this.name();
    this.css.push(`@keyframes ${k}{0%{opacity:0}${pct(from, this.loop)}{opacity:1}${pct(to, this.loop)}{opacity:0}100%{opacity:0}}`);
    this.css.push(`.${k}{animation:${k} ${this.loop}s step-end infinite}`);
    return k;
  }

  /** A class that blinks the element on and off between `from` and `to`, then holds it on. */
  blink(from: number, to: number, end = this.loop - 0.4, period = 0.5): string {
    const k = this.name();
    const frames = [`0%{opacity:0}`];
    let on = true;
    for (let t = from; t < to; t += period / 2, on = !on) frames.push(`${pct(t, this.loop)}{opacity:${on ? 1 : 0}}`);
    frames.push(`${pct(to, this.loop)}{opacity:1}`, `${pct(end, this.loop)}{opacity:0}`, `100%{opacity:0}`);
    this.css.push(`@keyframes ${k}{${frames.join("")}}`, `.${k}{animation:${k} ${this.loop}s step-end infinite}`);
    return k;
  }

  /** A class that draws a stroke (an element with pathLength="100") from `from` over `dur` seconds. */
  draw(from: number, dur: number, to = this.loop - 0.4): string {
    const k = this.name();
    const p = (t: number): string => pct(t, this.loop);
    this.css.push(
      `@keyframes ${k}{0%{stroke-dashoffset:100}${p(from)}{stroke-dashoffset:100}${p(from + dur)}{stroke-dashoffset:0}${p(to)}{stroke-dashoffset:0}${p(to + 0.01)}{stroke-dashoffset:100}100%{stroke-dashoffset:100}}`,
      `.${k}{stroke-dasharray:100 100;animation:${k} ${this.loop}s linear infinite}`,
    );
    return k;
  }

  /**
   * A class that moves the element through `stops` ([time, dx, dy] in seconds and user units) on a
   * linear path, hidden before the first stop and after the last.
   */
  move(stops: ReadonlyArray<readonly [number, number, number]>): string {
    const k = this.name();
    const first = stops[0];
    const last = stops[stops.length - 1];
    if (!first || !last) throw new Error("move needs at least one stop");
    const at = (t: number, x: number, y: number, o: number): string => `${pct(t, this.loop)}{transform:translate(${n(x)}px,${n(y)}px);opacity:${o}}`;
    const frames = [at(0, first[1], first[2], 0), at(Math.max(0, first[0] - 0.01), first[1], first[2], 0)];
    for (const [t, x, y] of stops) frames.push(at(t, x, y, 1));
    frames.push(at(last[0] + 0.01, last[1], last[2], 0), at(this.loop, last[1], last[2], 0));
    this.css.push(`@keyframes ${k}{${frames.join("")}}`, `.${k}{animation:${k} ${this.loop}s linear infinite}`);
    return k;
  }

  /** A class that slides a cover off typed text: `chars` steps over `dur` seconds from `from`. */
  type(from: number, dur: number, width: number, chars: number, to = this.loop - 0.4): string {
    const k = this.name();
    const p = (t: number): string => pct(t, this.loop);
    // The steps run inside the typing interval only; everything else holds.
    this.css.push(
      `@keyframes ${k}{0%{transform:translateX(0)}${p(from)}{transform:translateX(0);animation-timing-function:steps(${chars},end)}${p(from + dur)}{transform:translateX(${n(width)}px)}${p(to)}{transform:translateX(${n(width)}px);animation-timing-function:step-end}${p(to + 0.01)}{transform:translateX(0)}100%{transform:translateX(0)}}`,
      `.${k}{transform:translateX(${n(width)}px);animation:${k} ${this.loop}s linear infinite}`,
    );
    return k;
  }

  /** A class that scrolls content left by `distance` forever, on its own period. */
  marquee(distance: number, period: number): string {
    const k = this.name();
    this.css.push(`@keyframes ${k}{from{transform:translateX(0)}to{transform:translateX(${n(-distance)}px)}}`, `.${k}{animation:${k} ${period}s linear infinite}`);
    return k;
  }

  /** A class that turns the element about (cx, cy) once per `period` seconds, forever. */
  spin(cx: number, cy: number, period: number): string {
    const k = this.name();
    this.css.push(`@keyframes ${k}{to{transform:rotate(360deg)}}`, `.${k}{transform-origin:${cx}px ${cy}px;animation:${k} ${period}s linear infinite}`);
    return k;
  }

  /** A class that fills a Progress cell at `from` and empties it at `to`. */
  fill(from: number, colour: string, empty: string, to = this.loop - 0.4): string {
    const k = this.name();
    this.css.push(
      `@keyframes ${k}{0%{fill:${empty}}${pct(from, this.loop)}{fill:${colour}}${pct(to, this.loop)}{fill:${empty}}100%{fill:${empty}}}`,
      `.${k}{animation:${k} ${this.loop}s step-end infinite}`,
    );
    return k;
  }

  add(...markup: string[]): void {
    this.body.push(...markup);
  }

  /**
   * The finished document. A viewer who prefers reduced motion sees the loop frozen at `still`
   * seconds (every animation paused there), which is chosen to be the complete picture.
   */
  render(title: string, desc: string, still = this.loop - 0.6): string {
    const t = this.theme;
    const base = [
      `svg{background:${t.bg}}`,
      `.sans{font-family:${SANS}}`,
      `.mono{font-family:${MONO}}`,
      `.micro{font-family:${MONO};font-size:13px;font-weight:600;letter-spacing:0.04em}`,
      `@media (prefers-reduced-motion:reduce){*{animation-delay:-${n(still)}s!important;animation-play-state:paused!important}}`,
    ];
    return [
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${this.width} ${this.height}" width="${this.width}" height="${this.height}" role="img" aria-labelledby="t d">`,
      `<title id="t">${esc(title)}</title>`,
      `<desc id="d">${esc(desc)}</desc>`,
      `<style>${[...base, ...this.css].join("")}</style>`,
      `<rect width="${this.width}" height="${this.height}" fill="${t.bg}"/>`,
      ...this.body,
      `<rect x="1" y="1" width="${this.width - 2}" height="${this.height - 2}" fill="none" stroke="${t.rule}" stroke-width="2"/>`,
      `</svg>`,
      ``,
    ].join("\n");
  }
}

// ---- Shared furniture -------------------------------------------------------------------------

type Verdict = "allow" | "ask" | "deny" | "done";

/** A Proof glyph on the 24px grid, 2px stroke, square caps, mitred joins, scaled to `size`. */
function glyph(kind: "check" | "cross" | "ask" | "arrow", x: number, y: number, size: number, colour: string): string {
  const d = {
    check: "M4 12.5l5 5L20 6.5",
    cross: "M6 6l12 12M18 6L6 18",
    ask: "M8.5 9a3.5 3.5 0 1 1 5 3.2c-1 .5-1.5 1.2-1.5 2.3v1M12 19v1.5",
    arrow: "M4 12h15M13 6l6 6-6 6",
  }[kind];
  const s = size / 24;
  return `<path d="${d}" transform="translate(${n(x)} ${n(y)}) scale(${n(s)})" fill="none" stroke="${colour}" stroke-width="${n(2 / s)}" stroke-linecap="square" stroke-linejoin="miter"/>`;
}

/** A registration crosshair, the Proof corner mark. */
function crosshair(x: number, y: number, colour: string): string {
  return `<g fill="none" stroke="${colour}" stroke-width="1.2"><circle cx="${x}" cy="${y}" r="7"/><path d="M${x - 12} ${y}h24M${x} ${y - 12}v24"/></g>`;
}

/** Barcode pattern furniture (decorative). Deterministic widths from a fixed sequence. */
function barcode(x: number, y: number, width: number, height: number, colour: string): string {
  const bars: string[] = [];
  const seq = [2, 1, 3, 1, 1, 2, 4, 1, 2, 2, 1, 3, 1, 1, 2, 1, 3, 2, 1, 1];
  let cx = x;
  for (let i = 0; cx < x + width; i++) {
    const w = seq[i % seq.length] ?? 1;
    if (i % 2 === 0) bars.push(`M${n(cx)} ${y}h${w}v${height}h${-w}z`);
    cx += w + 1;
  }
  return `<path d="${bars.join("")}" fill="${colour}"/>`;
}

/** Tick-ruler pattern along a line (decorative). */
function ruler(x: number, y: number, width: number, colour: string, step = 8): string {
  const ticks: string[] = [];
  for (let i = 0; x + i * step <= x + width; i++) ticks.push(`M${x + i * step} ${y}v${i % 5 === 0 ? 10 : 5}`);
  return `<path d="${ticks.join("")}" stroke="${colour}" stroke-width="1"/>`;
}

/** A text node. */
function text(x: number, y: number, value: string, attrs: string): string {
  return `<text x="${n(x)}" y="${n(y)}" ${attrs}>${esc(value)}</text>`;
}

/** A Proof box: square, 2px rule, a heading and a mono sub-label. */
function box(x: number, y: number, w: number, h: number, label: string, sub: string, fill: string, ink: string, subInk: string, rule: string): string {
  return [
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" stroke="${rule}" stroke-width="2"/>`,
    text(x + 18, y + 38, label, `class="sans" font-size="26" font-weight="700" letter-spacing="-0.6" fill="${ink}"`),
    text(x + 18, y + 64, sub.toUpperCase(), `class="micro" fill="${subInk}"`),
  ].join("");
}

/** An arrow head at (x, y) pointing in direction `dir`. */
function head(x: number, y: number, dir: "r" | "l" | "d" | "u", colour: string): string {
  const pts = { r: [[0, 0], [-11, -6], [-11, 6]], l: [[0, 0], [11, -6], [11, 6]], d: [[0, 0], [-6, -11], [6, -11]], u: [[0, 0], [-6, 11], [6, 11]] }[dir];
  return `<path d="M${pts.map(([dx, dy]) => `${n(x + (dx ?? 0))} ${n(y + (dy ?? 0))}`).join("L")}z" fill="${colour}"/>`;
}

/** A verdict tag: glyph plus word plus colour, never colour alone. Right-aligned at `right`. */
function verdictTag(right: number, y: number, verdict: Verdict, t: Theme, onCode: boolean): string {
  const colour = verdict === "allow" ? (onCode ? t.codeSuccess : t.success) : verdict === "ask" ? (onCode ? t.codeWarning : t.warning) : verdict === "deny" ? (onCode ? t.codeDanger : t.danger) : t.onAccent;
  const word = verdict.toUpperCase();
  const w = 26 + word.length * 9.4 + 14;
  const g = verdict === "allow" || verdict === "done" ? "check" : verdict === "ask" ? "ask" : "cross";
  const fill = verdict === "done" ? t.accent : "none";
  return [
    `<rect x="${n(right - w)}" y="${y - 17}" width="${n(w)}" height="24" fill="${fill}" stroke="${colour}" stroke-width="1.5"/>`,
    glyph(g, right - w + 6, y - 14, 18, colour),
    text(right - 10, y, word, `class="micro" text-anchor="end" fill="${colour}"`),
  ].join("");
}

// ---- 1. Hero: the wordmark beside a session the firewall is gating ----------------------------

/**
 * The pi session panel the hero shows (and the website shows on its own): a typed prompt, six tool
 * calls with the firewall's verdicts, the checks, and the status bar. The verdicts follow the
 * firewall's tiers for these commands (tests/firewall-shell-smoke.ts: `rm -rf ~` is critical,
 * `git push --force` high).
 */
function session(a: Art, t: Theme, X: number, Y: number, PW: number, PH: number): void {
  a.add(`<rect x="${X}" y="${Y}" width="${PW}" height="${PH}" fill="${t.codeBg}" stroke="${t.rule}" stroke-width="2"/>`);
  a.add(`<rect x="${X}" y="${Y}" width="${PW}" height="34" fill="${t.accent}" stroke="${t.rule}" stroke-width="2"/>`);
  a.add(text(X + 16, Y + 22, "PI · ~/PROJECT", `class="micro" fill="${t.onAccent}"`));
  a.add(text(X + PW - 16, Y + 22, "FIREWALL ON", `class="micro" text-anchor="end" fill="${t.onAccent}"`));
  const lx = X + 22, right = X + PW - 18;
  const mono = (fill: string): string => `class="mono" font-size="16" fill="${fill}"`;
  // Prompt, typed.
  const prompt = "tidy the auth module, keep tests green";
  const py = Y + 74;
  a.add(text(lx, py, "›", `class="mono" font-size="16" font-weight="700" fill="${t.accent}"`));
  a.add(text(lx + 20, py, prompt, mono(t.codeFg)));
  const typed = a.type(0.4, 1.6, 9.8 * prompt.length + 12, prompt.length);
  a.add(`<g clip-path="url(#tc)"><rect x="${lx + 18}" y="${py - 18}" width="${n(9.8 * prompt.length + 14)}" height="26" fill="${t.codeBg}" class="${typed}"/></g>`);
  a.add(`<defs><clipPath id="tc"><rect x="${lx + 18}" y="${py - 18}" width="${n(9.8 * prompt.length + 14)}" height="26"/></clipPath></defs>`);

  const rows: Array<{ at: number; tool: string; arg: string; verdict: Verdict; note?: string }> = [
    { at: 2.4, tool: "read", arg: "src/auth.ts", verdict: "allow" },
    { at: 3.2, tool: "edit", arg: "src/auth.ts  +14 −9", verdict: "allow" },
    { at: 4.1, tool: "bash", arg: "npm test", verdict: "allow", note: "48 passed" },
    { at: 5.6, tool: "subagent", arg: "reviewer · bounded", verdict: "allow" },
    { at: 7.0, tool: "bash", arg: "rm -rf ~", verdict: "deny", note: "critical: denied, on the record" },
    { at: 9.2, tool: "bash", arg: "git push --force", verdict: "ask", note: "high: you approved it once" },
  ];
  let y = py + 44;
  for (const row of rows) {
    const cls = a.show(row.at);
    const tag = row.verdict === "ask" ? a.blink(row.at, row.at + 1.6) : cls;
    a.add(`<g class="${cls}">${text(lx, y, row.tool, mono(t.codeDim))}${text(lx + 96, y, row.arg, mono(t.codeFg))}</g>`);
    a.add(`<g class="${tag}">${verdictTag(right, y, row.verdict, t, true)}</g>`);
    if (row.note) {
      const noteAt = row.verdict === "ask" ? row.at + 1.6 : row.at + 0.5;
      const noteColour = row.verdict === "deny" ? t.codeDanger : row.verdict === "ask" ? t.codeWarning : t.codeDim;
      a.add(`<g class="${a.show(noteAt)}">${text(lx + 96, y + 20, `└ ${row.note}`, `class="mono" font-size="14" fill="${noteColour}"`)}</g>`);
      y += 20;
    }
    y += 30;
  }
  // Verification result.
  const doneAt = 11.6;
  a.add(`<g class="${a.show(doneAt)}">${text(lx, y + 4, "checks", mono(t.codeDim))}${text(lx + 96, y + 4, "tests · lint · types", mono(t.codeFg))}</g>`);
  a.add(`<g class="${a.show(doneAt + 0.6)}">${verdictTag(right, y + 4, "done", t, true)}</g>`);
  // Status bar.
  const sy = Y + PH - 30;
  a.add(`<path d="M${X} ${sy - 4}H${X + PW}" stroke="${t.codeDim}" stroke-width="1"/>`);
  a.add(text(lx, sy + 16, "● project │ on main │ ctx", `class="mono" font-size="13" fill="${t.codeDim}"`));
  for (let i = 0; i < 10; i++) {
    const cx = lx + 214 + i * 11;
    const at = 1 + i * 1.1;
    const cell = i < 4 ? a.fill(at, t.accent, "#333333") : "";
    a.add(`<rect x="${cx}" y="${sy + 5}" width="8" height="12" fill="${i < 4 ? t.accent : "#333333"}"${cell ? ` class="${cell}"` : ""}/>`);
  }
  a.add(text(right, sy + 16, "balanced │ E3 Standard", `class="mono" font-size="13" text-anchor="end" fill="${t.codeDim}"`));
}


function hero(t: Theme): string {
  const W = 1200, H = 600, L = 16;
  const a = new Art(W, H, L, t);
  // Top strip.
  a.add(text(40, 40, "LUNA / THE PI AGENT SYSTEM", `class="micro" fill="${t.fg}"`));
  a.add(text(W - 40, 40, "PUBLIC BETA · MIT", `class="micro" text-anchor="end" fill="${t.muted}"`));
  a.add(`<path d="M0 60H${W}" stroke="${t.rule}" stroke-width="2"/>`);
  a.add(crosshair(40, 92, t.fg), crosshair(560, 92, t.fg));

  // Moon mark: a lime disc with the ground cut out of it, in a hairline orbit.
  a.add(`<circle cx="130" cy="176" r="76" fill="none" stroke="${t.hair}" stroke-width="2"/>`);
  a.add(`<circle cx="130" cy="176" r="54" fill="${t.accent}" stroke="${t.rule}" stroke-width="2"/>`);
  a.add(`<circle cx="155" cy="160" r="49" fill="${t.bg}"/>`);
  a.add(`<g class="${a.spin(130, 176, 12)}"><rect x="124" y="94" width="12" height="12" fill="${t.fg}"/></g>`);
  // Wordmark.
  a.add(text(36, 414, "LUNA", `class="sans" font-size="176" font-weight="800" letter-spacing="-8" textLength="500" lengthAdjust="spacingAndGlyphs" fill="${t.fg}"`));
  a.add(text(40, 456, "A permission gate, governed delegation, verification", `class="sans" font-size="21" fill="${t.muted}"`));
  a.add(text(40, 484, "and durable memory for the pi coding agent.", `class="sans" font-size="21" fill="${t.muted}"`));

  session(a, t, 600, 92, 560, 412);

  // Bottom band: lime, ruled, with a scrolling line of the three promises.
  const by = H - 80;
  a.add(`<rect x="0" y="${by}" width="${W}" height="80" fill="${t.accent}"/>`);
  a.add(`<path d="M0 ${by}H${W}" stroke="${t.rule}" stroke-width="2"/>`);
  a.add(ruler(0, by + 2, W, t.onAccent));
  const phrase = "EVERY TOOL CALL GATED  ✕  EVERY RUN VERIFIED  ✕  EVERY DECISION ON THE RECORD  ✕  ";
  const span = 1100;
  const scroll = a.marquee(span, 22);
  a.add(`<defs><clipPath id="band"><rect x="0" y="${by}" width="${W}" height="80"/></clipPath></defs>`);
  a.add(`<g clip-path="url(#band)"><g class="${scroll}">${[0, 1, 2].map((i) => text(40 + i * span, by + 54, phrase, `class="sans" font-size="26" font-weight="800" letter-spacing="-0.5" textLength="${span - 24}" fill="${t.onAccent}"`)).join("")}</g></g>`);

  return a.render(
    "Luna, the pi agent system",
    "A pi session under Luna: reads, edits and tests are allowed, a reviewer sub-agent is delegated, rm -rf ~ is denied, a force push waits for your approval, and the checks finish with recorded evidence.",
  );
}

/** The session panel alone, for the website's hero, where the page sets the wordmark itself. */
function sessionOnly(t: Theme): string {
  const a = new Art(560, 412, 16, t);
  session(a, t, 0, 0, 560, 412);
  return a.render(
    "A pi session under Luna",
    "Reads, edits and tests are allowed, a reviewer sub-agent is delegated, rm -rf ~ is denied, a force push waits for your approval, and the checks finish with recorded evidence.",
  );
}

// ---- 2. Firewall: every tool call meets the gate -----------------------------------------------

function firewall(t: Theme): string {
  const W = 1200, H = 460, L = 13;
  const a = new Art(W, H, L, t);
  a.add(text(40, 58, "Every tool call meets the gate", `class="sans" font-size="38" font-weight="800" letter-spacing="-1.2" fill="${t.fg}"`));
  a.add(text(W - 40, 54, "TOOL FIREWALL · DEFAULT DENY", `class="micro" text-anchor="end" fill="${t.muted}"`));
  a.add(`<path d="M0 84H${W}" stroke="${t.rule}" stroke-width="2"/>`);

  const by = 140, bh = 96;
  a.add(box(40, by, 250, bh, "pi agent", "your session", t.surface, t.fg, t.muted, t.rule));
  a.add(box(910, by, 250, bh, "Tool", "shell · files · net", t.surface, t.fg, t.muted, t.rule));
  // Wires.
  const wy = by + bh / 2;
  a.add(`<path d="M290 ${wy}H475M725 ${wy}H910" stroke="${t.rule}" stroke-width="2"/>`);
  a.add(head(475, wy, "r", t.rule), head(910, wy, "r", t.rule));
  // Approval box under the gate.
  const ay = 300;
  a.add(`<path d="M600 ${by + bh}V${ay}" stroke="${t.rule}" stroke-width="2" stroke-dasharray="6 6"/>`);
  a.add(`<rect x="525" y="${ay}" width="150" height="44" fill="${t.surface}" stroke="${t.rule}" stroke-width="2"/>`);
  a.add(text(600, ay + 28, "YOU APPROVE", `class="micro" text-anchor="middle" fill="${t.fg}"`));

  // Three calls, one after another.
  const calls: Array<{ start: number; label: string; verdict: Verdict; say: string }> = [
    { start: 0.4, label: "read src/app.ts", verdict: "allow", say: "routine: auto-allowed" },
    { start: 4.4, label: "git push --force", verdict: "ask", say: "high: asked you, approved once" },
    { start: 8.4, label: "rm -rf ~", verdict: "deny", say: "critical: denied" },
  ];
  const ledgerY = 392;
  a.add(text(40, ledgerY - 14, "AUDIT RECORD", `class="micro" fill="${t.muted}"`));
  a.add(`<path d="M40 ${ledgerY - 4}H${W - 40}" stroke="${t.hair}" stroke-width="1"/>`);
  calls.forEach((c, i) => {
    const colour = c.verdict === "allow" ? t.success : c.verdict === "ask" ? t.warning : t.danger;
    const s = c.start;
    // The packet: an ink chip carrying the call, agent → gate.
    const chipW = 150;
    // It waits at the gate's door, then passes behind the gate (drawn after it) to the tool.
    const x0 = 290 + 6, held = 475 - 8 - chipW - x0, through = 910 - 8 - chipW - x0;
    const pathStops: Array<readonly [number, number, number]> =
      c.verdict === "allow" ? [[s, 0, 0], [s + 1.0, held, 0], [s + 1.5, held, 0], [s + 2.6, through, 0]]
        : c.verdict === "ask" ? [[s, 0, 0], [s + 1.0, held, 0], [s + 2.4, held, 0], [s + 3.4, through, 0]]
          : [[s, 0, 0], [s + 1.0, held, 0], [s + 1.6, held, 0], [s + 2.6, 0, 0]];
    const mv = a.move(pathStops);
    a.add(`<g class="${mv}"><rect x="${x0}" y="${wy - 30}" width="${chipW}" height="26" fill="${t.invBg}"/>${text(x0 + chipW / 2, wy - 12, c.label, `class="mono" font-size="13" text-anchor="middle" fill="${t.invFg}"`)}</g>`);
    // Verdict stamp over the gate.
    const stampAt = s + 1.2;
    const stampEnd = c.verdict === "ask" ? s + 3.4 : s + 2.8;
    const stamp = c.verdict === "ask" ? a.blink(stampAt, s + 2.4, stampEnd) : a.show(stampAt, stampEnd);
    a.add(`<g class="${stamp}"><rect x="525" y="${by - 40}" width="150" height="30" fill="${t.bg}" stroke="${colour}" stroke-width="2"/>${glyph(c.verdict === "allow" ? "check" : c.verdict === "ask" ? "ask" : "cross", 538, by - 36, 22, colour)}${text(662, by - 19, c.verdict.toUpperCase(), `class="micro" text-anchor="end" fill="${colour}"`)}</g>`);
    if (c.verdict === "ask") {
      const ok = a.show(s + 2.0, s + 3.4);
      a.add(`<rect class="${ok}" x="525" y="${ay}" width="150" height="44" fill="${t.accent}" stroke="${t.rule}" stroke-width="2"/>`);
      a.add(`<g class="${ok}">${text(600, ay + 28, "YOU APPROVE", `class="micro" text-anchor="middle" fill="${t.onAccent}"`)}</g>`);
    }
    if (c.verdict === "deny") {
      const back = a.show(s + 1.6, s + 2.8);
      a.add(`<path class="${back}" d="M475 ${wy + 26}H290" stroke="${t.danger}" stroke-width="2" stroke-dasharray="6 6"/>`);
      a.add(`<g class="${back}">${head(290, wy + 26, "l", t.danger)}</g>`);
    }
    if (c.verdict !== "deny") {
      const res = a.show(s + (c.verdict === "ask" ? 3.4 : 2.6), s + 3.9);
      a.add(`<path class="${res}" d="M910 ${wy + 26}H290" stroke="${t.muted}" stroke-width="2" stroke-dasharray="6 6"/>`);
      a.add(`<g class="${res}">${head(290, wy + 26, "l", t.muted)}${text(600, wy + 46, "RESULT", `class="micro" text-anchor="middle" fill="${t.muted}"`)}</g>`);
    }
    // Ledger row, which stays.
    const x = 40 + i * 380;
    const row = a.show(s + 1.4);
    a.add(`<g class="${row}">${glyph(c.verdict === "allow" ? "check" : c.verdict === "ask" ? "ask" : "cross", x, ledgerY + 6, 20, colour)}${text(x + 28, ledgerY + 22, c.verdict.toUpperCase(), `class="micro" fill="${colour}"`)}${text(x + 92, ledgerY + 22, c.label, `class="mono" font-size="14" fill="${t.fg}"`)}${text(x + 28, ledgerY + 44, c.say, `class="sans" font-size="15" fill="${t.muted}"`)}</g>`);
  });
  a.add(box(475, by, 250, bh, "Firewall", "parse · tier · decide", t.accent, t.onAccent, t.onAccent, t.rule));
  return a.render(
    "Every tool call meets the gate",
    "Three tool calls pass through the Luna firewall: a file read is allowed, a git push waits for your approval and then runs, and a destructive delete is denied. Each decision is written to the audit record.",
  );
}

// ---- 3. Delegation stays bounded ---------------------------------------------------------------

function delegation(t: Theme): string {
  const W = 1200, H = 460, L = 12;
  const a = new Art(W, H, L, t);
  a.add(text(40, 58, "Delegation stays bounded", `class="sans" font-size="38" font-weight="800" letter-spacing="-1.2" fill="${t.fg}"`));
  a.add(`<path d="M0 84H${W}" stroke="${t.rule}" stroke-width="2"/>`);
  // Budget meter, top right.
  const cells = 12;
  a.add(text(W - 40 - cells * 16 - 12, 54, "BUDGET", `class="micro" text-anchor="end" fill="${t.muted}"`));
  for (let i = 0; i < cells; i++) {
    const x = W - 40 - (cells - i) * 16;
    // Cells drain from the right as work is handed out.
    const drainAt = i >= 9 ? 1.6 + (11 - i) * 0.25 : i >= 5 ? 4.0 + (8 - i) * 0.3 : -1;
    const drain = drainAt > 0 ? a.fill(drainAt, t.surface, t.accent) : "";
    a.add(`<rect x="${x}" y="38" width="12" height="20" fill="${drainAt > 0 ? t.surface : t.accent}" stroke="${t.rule}" stroke-width="1.5"${drain ? ` class="${drain}"` : ""}/>`);
  }

  const actors = ["You", "Lead", "Scout", "Reviewer"];
  const subs = ["task and limits", "plans, integrates", "read-only search", "independent check"];
  const xs = [150, 450, 750, 1050];
  const top = 110, bw = 220, bh = 70, bottom = H - 30;
  actors.forEach((name, i) => {
    const x = xs[i] ?? 0;
    const lead = name === "Lead";
    a.add(`<path d="M${x} ${top + bh}V${bottom}" stroke="${t.hair}" stroke-width="2" stroke-dasharray="4 6"/>`);
    a.add(`<rect x="${x - bw / 2}" y="${top}" width="${bw}" height="${bh}" fill="${lead ? t.invBg : t.surface}" stroke="${t.rule}" stroke-width="2"/>`);
    a.add(text(x, top + 34, name, `class="sans" font-size="24" font-weight="700" letter-spacing="-0.5" text-anchor="middle" fill="${lead ? t.invFg : t.fg}"`));
    a.add(text(x, top + 56, (subs[i] ?? "").toUpperCase(), `class="micro" text-anchor="middle" fill="${lead ? t.invFg : t.muted}"`));
  });
  const msgs: Array<{ from: number; to: number; label: string; at: number; reply?: boolean; ok?: boolean }> = [
    { from: 0, to: 1, label: "task + budget", at: 0.5 },
    { from: 1, to: 2, label: "bounded ask: find the callers", at: 1.6 },
    { from: 2, to: 1, label: "findings, with paths", at: 3.0, reply: true },
    { from: 1, to: 3, label: "diff to review", at: 4.0 },
    { from: 3, to: 1, label: "verdict: approve", at: 5.6, reply: true, ok: true },
    { from: 1, to: 0, label: "done, with evidence", at: 7.0, reply: true, ok: true },
  ];
  msgs.forEach((m, i) => {
    const y = 226 + i * 38;
    const x1 = xs[m.from] ?? 0, x2 = xs[m.to] ?? 0;
    const dir = x2 > x1 ? "r" : "l";
    const colour = m.ok ? t.success : t.rule;
    const shown = a.show(m.at + 0.5);
    if (m.reply) {
      const cls = a.show(m.at);
      a.add(`<path class="${cls}" d="M${x1} ${y}H${x2 + (dir === "r" ? -2 : 2)}" stroke="${colour}" stroke-width="2" stroke-dasharray="7 6"/>`);
    } else {
      const cls = a.draw(m.at, 0.5);
      a.add(`<path class="${cls}" d="M${x1} ${y}H${x2 + (dir === "r" ? -2 : 2)}" pathLength="100" stroke="${colour}" stroke-width="2" fill="none"/>`);
    }
    a.add(`<g class="${shown}">${head(x2, y, dir, colour)}</g>`);
    const mid = (x1 + x2) / 2;
    a.add(`<g class="${m.reply ? a.show(m.at) : shown}"><rect x="${n(mid - (m.label.length * 8.2) / 2 - 8)}" y="${y - 24}" width="${n(m.label.length * 8.2 + 16)}" height="18" fill="${t.bg}"/>${text(mid, y - 10, m.label.toUpperCase(), `class="micro" text-anchor="middle" fill="${m.ok ? t.success : t.fg}"`)}</g>`);
  });
  return a.render(
    "Delegation stays bounded",
    "You give the lead agent a task and a budget. It hands a read-only scout a bounded question and a reviewer a diff; each returns its findings or verdict, the budget meter drains, and the lead reports back with evidence.",
  );
}

// ---- 4. Nothing counts as done unverified ------------------------------------------------------

function verify(t: Theme): string {
  const W = 1200, H = 420, L = 12;
  const a = new Art(W, H, L, t);
  a.add(text(40, 58, "Nothing counts as done unverified", `class="sans" font-size="38" font-weight="800" letter-spacing="-1.2" fill="${t.fg}"`));
  a.add(`<path d="M0 84H${W}" stroke="${t.rule}" stroke-width="2"/>`);
  const by = 160, bh = 196;
  // Change.
  a.add(`<rect x="40" y="${by}" width="280" height="${bh}" fill="${t.surface}" stroke="${t.rule}" stroke-width="2"/>`);
  a.add(text(60, by + 40, "Change", `class="sans" font-size="26" font-weight="700" letter-spacing="-0.6" fill="${t.fg}"`));
  a.add(text(60, by + 66, "SMALLEST STEP", `class="micro" fill="${t.muted}"`));
  const diffs = ["+ export function signIn(", "− function login(", "+   assertScope(user)"];
  diffs.forEach((d, i) => a.add(text(60, by + 104 + i * 22, d, `class="mono" font-size="14" fill="${d.startsWith("+") ? t.success : t.danger}"`)));
  // Fix line, shown on the second pass.
  const fixAt = 5.2;
  a.add(`<g class="${a.show(fixAt)}"><rect x="54" y="${by + bh - 30}" width="252" height="22" fill="${t.accent}"/>${text(62, by + bh - 14, "+ fix: unused import", `class="mono" font-size="14" fill="${t.onAccent}"`)}</g>`);

  // Checks.
  const cx = 460, cw = 300;
  a.add(`<rect x="${cx}" y="${by}" width="${cw}" height="${bh}" fill="${t.surface}" stroke="${t.rule}" stroke-width="2"/>`);
  a.add(text(cx + 20, by + 40, "Checks", `class="sans" font-size="26" font-weight="700" letter-spacing="-0.6" fill="${t.fg}"`));
  a.add(text(cx + 20, by + 66, "RUN BY THE GATE, NOT CLAIMED", `class="micro" fill="${t.muted}"`));
  const checks = ["tests", "lint", "types"];
  checks.forEach((name, i) => {
    const y = by + 104 + i * 22;
    a.add(text(cx + 20, y, name, `class="mono" font-size="14" fill="${t.fg}"`));
    // Progress cells: first pass at 1.0s, second at 6.0s.
    for (let c = 0; c < 8; c++) {
      const first = 1.0 + i * 0.5 + c * 0.05;
      const second = 6.0 + i * 0.45 + c * 0.05;
      const failFirst = name === "lint";
      const k1 = a.fill(first, failFirst && c > 4 ? t.danger : t.fg, t.hair, fixAt);
      const k2 = a.fill(second, t.fg, t.hair);
      a.add(`<rect x="${cx + 92 + c * 14}" y="${y - 12}" width="10" height="14" fill="${t.hair}" class="${k1}"/>`);
      a.add(`<rect x="${cx + 92 + c * 14}" y="${y - 12}" width="10" height="14" fill="${t.fg}" class="${k2}"/>`);
    }
    const okFirst = a.show(1.4 + i * 0.5, fixAt);
    const ok2 = a.show(6.5 + i * 0.45);
    const firstGlyph = name === "lint" ? glyph("cross", cx + cw - 40, y - 15, 18, t.danger) : glyph("check", cx + cw - 40, y - 15, 18, t.success);
    a.add(`<g class="${okFirst}">${firstGlyph}</g>`, `<g class="${ok2}">${glyph("check", cx + cw - 40, y - 15, 18, t.success)}</g>`);
  });
  // Wires.
  const wy = by + 50;
  a.add(`<path d="M320 ${wy}H${cx}" stroke="${t.rule}" stroke-width="2"/>`, head(cx, wy, "r", t.rule));
  a.add(text(390, wy - 12, "RUN", `class="micro" text-anchor="middle" fill="${t.fg}"`));
  // Fail loop, flashing.
  const loopCls = a.show(3.0, fixAt + 0.4);
  a.add(`<g class="${loopCls}"><path d="M${cx + cw / 2} ${by}V${by - 44}H180V${by - 2}" fill="none" stroke="${t.danger}" stroke-width="2" stroke-dasharray="7 6"/>${head(180, by - 2, "d", t.danger)}<rect x="${cx - 160}" y="${by - 58}" width="140" height="26" fill="${t.bg}" stroke="${t.danger}" stroke-width="1.5"/>${glyph("cross", cx - 154, by - 55, 20, t.danger)}${text(cx - 30, by - 39, "FAIL → FIX", `class="micro" text-anchor="end" fill="${t.danger}"`)}</g>`);
  // Done.
  const dx = 900, dw = 260;
  const doneAt = 8.0;
  a.add(`<path d="M${cx + cw} ${wy}H${dx}" stroke="${t.rule}" stroke-width="2"/>`, head(dx, wy, "r", t.rule));
  a.add(`<g class="${a.show(doneAt)}">${text(830, wy - 12, "PASS", `class="micro" text-anchor="middle" fill="${t.success}"`)}</g>`);
  a.add(`<rect x="${dx}" y="${by}" width="${dw}" height="${bh}" fill="${t.surface}" stroke="${t.rule}" stroke-width="2"/>`);
  a.add(`<rect class="${a.show(doneAt)}" x="${dx}" y="${by}" width="${dw}" height="${bh}" fill="${t.accent}" stroke="${t.rule}" stroke-width="2"/>`);
  a.add(text(dx + 20, by + 40, "Done", `class="sans" font-size="26" font-weight="700" letter-spacing="-0.6" fill="${t.fg}"`));
  a.add(`<g class="${a.show(doneAt)}">${text(dx + 20, by + 40, "Done", `class="sans" font-size="26" font-weight="700" letter-spacing="-0.6" fill="${t.onAccent}"`)}${text(dx + 20, by + 66, "EVIDENCE, NOT A CLAIM", `class="micro" fill="${t.onAccent}"`)}${glyph("check", dx + 20, by + 88, 56, t.onAccent)}</g>`);
  a.add(barcode(40, H - 44, 300, 18, t.fg));
  a.add(text(W - 40, H - 28, "TESTS · LINT · TYPES · DOCS", `class="micro" text-anchor="end" fill="${t.muted}"`));
  return a.render(
    "Nothing counts as done unverified",
    "A change goes to the checks. On the first pass lint fails and the work loops back for a fix; on the second pass tests, lint and types all pass and the work is marked done, with the evidence recorded.",
  );
}

// ---- 5. Profiles: one package, seven shapes ----------------------------------------------------

function profiles(t: Theme): string {
  const list: Array<[string, string]> = [
    ["quick", "Fast edits with the safety guards and checkpoints, no ceremony."],
    ["balanced", "Everyday work with verification and context helpers (the default)."],
    ["long-horizon", "Multi-hour work: goals, task graph, branches, delegation."],
    ["autonomous", "Long-running sessions, including unattended runs."],
    ["self-improving", "Research use: memory services, dual review and skill mining."],
    ["pentest", "Authorised engagements: strict firewall policy, scope and rules."],
    ["lite", "Small local models and short contexts."],
  ];
  const W = 1200, H = 300, step = 2, L = list.length * step;
  const a = new Art(W, H, L, t);
  a.add(text(40, 50, "/profile", `class="mono" font-size="22" font-weight="700" fill="${t.fg}"`));
  a.add(text(W - 40, 48, "ONE PACKAGE · SEVEN PROFILES", `class="micro" text-anchor="end" fill="${t.muted}"`));
  a.add(`<path d="M0 74H${W}" stroke="${t.rule}" stroke-width="2"/>`);
  const tw = (W - 80) / list.length;
  list.forEach(([name, desc], i) => {
    const x = 40 + i * tw;
    const on = a.show(i * step, (i + 1) * step);
    a.add(`<rect x="${n(x)}" y="104" width="${n(tw)}" height="96" fill="${t.surface}" stroke="${t.rule}" stroke-width="2"/>`);
    a.add(`<rect class="${on}" x="${n(x)}" y="104" width="${n(tw)}" height="96" fill="${t.accent}" stroke="${t.rule}" stroke-width="2"/>`);
    a.add(text(x + 14, 132, String(i + 1).padStart(2, "0"), `class="micro" fill="${t.muted}"`));
    a.add(text(x + 14, 178, name, `class="sans" font-size="${name.length > 11 ? 19 : 22}" font-weight="700" letter-spacing="-0.4" fill="${t.fg}"`));
    a.add(`<g class="${on}">${text(x + 14, 132, String(i + 1).padStart(2, "0"), `class="micro" fill="${t.onAccent}"`)}${text(x + 14, 178, name, `class="sans" font-size="${name.length > 11 ? 19 : 22}" font-weight="700" letter-spacing="-0.4" fill="${t.onAccent}"`)}</g>`);
    a.add(`<g class="${on}">${text(40, 246, desc, `class="sans" font-size="22" fill="${t.fg}"`)}${text(W - 40, 246, `/profile ${name}`, `class="mono" font-size="17" text-anchor="end" fill="${t.link}"`)}</g>`);
  });
  // A viewer who prefers reduced motion sees the default profile, balanced, highlighted.
  return a.render(
    "Seven profiles in one package",
    "The seven Luna profiles, highlighted one after another with what each is for: quick, balanced (the default), long-horizon, autonomous, self-improving, pentest and lite.",
    step * 1.5,
  );
}

const ARTS: ReadonlyArray<[string, (t: Theme) => string]> = [
  ["luna-hero", hero],
  ["luna-session", sessionOnly],
  ["luna-firewall", firewall],
  ["luna-delegation", delegation],
  ["luna-verify", verify],
  ["luna-profiles", profiles],
];

/** Every generated file: name under docs/assets -> contents. */
export function artFiles(): Map<string, string> {
  const out = new Map<string, string>();
  for (const [name, make] of ARTS) for (const theme of THEMES) out.set(`${name}${theme.id === "dark" ? "-dark" : ""}.svg`, make(theme));
  return out;
}

function main(argv: readonly string[]): number {
  const check = argv.includes("--check");
  let stale = 0;
  for (const [name, body] of artFiles()) {
    const file = path.join(ART_DIR, name);
    const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
    if (current === body) continue;
    if (check) {
      console.error(`stale: docs/assets/${name} (run node packages/core/readme-art.ts)`);
      stale += 1;
    } else {
      fs.writeFileSync(file, body);
      console.log(`wrote docs/assets/${name} (${Buffer.byteLength(body)} bytes)`);
    }
  }
  return stale === 0 ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
