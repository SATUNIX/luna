/**
 * Terminal display width, without a pi-tui dependency (extensions stay self-contained).
 *
 * The status bar sizes its lines in terminal columns, not code points: East Asian wide and
 * fullwidth characters and emoji take two columns, combining marks, joiners and variation
 * selectors take none, and ANSI colour sequences and OSC 8 hyperlinks take none. A grapheme
 * cluster (an emoji with a skin-tone modifier or a ZWJ sequence, a base letter plus accents) is
 * measured as one unit, so it is never cut in half.
 */

// CSI sequences (colours, cursor) and OSC 8 hyperlinks, both BEL- and ST-terminated. Built from
// named control characters: matching them is the point.
const ESC = "\u001b";
const BEL = "\u0007";
const ANSI = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]|${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`, "g");

const segmenter: { segment(input: string): Iterable<{ segment: string }> } | null = (() => {
  try {
    // Absent on runtimes built without full ICU, so it is read as possibly undefined.
    const Segmenter: typeof Intl.Segmenter | undefined = Intl.Segmenter;
    return Segmenter ? new Segmenter(undefined, { granularity: "grapheme" }) : null;
  } catch {
    return null;
  }
})();

const ZERO_WIDTH = /^[\p{Mn}\p{Me}\p{Cf}\p{Cc}]$/u;
const EMOJI_PRESENTATION = /\p{Emoji_Presentation}/u;

// Ranges that terminals draw two columns wide (Unicode East Asian Width W and F).
const WIDE: Array<[number, number]> = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0xa4cf], [0xa960, 0xa97f],
  [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f], [0x1f680, 0x1f6ff], [0x1f900, 0x1f9ff], [0x1fa70, 0x1faff], [0x20000, 0x3fffd],
];

function codePointWidth(cp: number, ch: string): number {
  if (ZERO_WIDTH.test(ch)) return 0;
  if (cp >= 0xfe00 && cp <= 0xfe0f) return 0;
  if (EMOJI_PRESENTATION.test(ch)) return 2;
  for (const [lo, hi] of WIDE) if (cp >= lo && cp <= hi) return 2;
  return 1;
}

function clusterWidth(cluster: string): number {
  let width = 0;
  for (const ch of cluster) {
    const w = codePointWidth(ch.codePointAt(0) ?? 0, ch);
    if (w > width) width = w;
  }
  // A cluster made only of zero-width code points still occupies nothing.
  return width;
}

function clusters(text: string): string[] {
  if (segmenter) return [...segmenter.segment(text)].map((s) => s.segment);
  return Array.from(text);
}

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

/** Columns the text occupies on a terminal (ANSI sequences ignored). */
export function displayWidth(text: string): number {
  let width = 0;
  for (const c of clusters(stripAnsi(text))) width += clusterWidth(c);
  return width;
}

/**
 * Cut `text` to at most `width` columns, keeping ANSI sequences intact, never splitting a grapheme
 * cluster, and ending with `ellipsis` (and a colour reset) when something was removed.
 */
export function truncateDisplay(text: string, width: number, ellipsis = "…"): string {
  if (width <= 0) return "";
  if (displayWidth(text) <= width) return text;
  const room = width - displayWidth(ellipsis);
  if (room <= 0) return ellipsis === "" ? "" : [...clusters(ellipsis)].slice(0, 1).join("").slice(0, width);
  let out = "";
  let used = 0;
  let last = 0;
  let sawAnsi = false;
  const cut = (segment: string): boolean => {
    for (const c of clusters(segment)) {
      const w = clusterWidth(c);
      if (used + w > room) return false;
      out += c;
      used += w;
    }
    return true;
  };
  for (const m of text.matchAll(ANSI)) {
    const index = m.index ?? 0;
    if (!cut(text.slice(last, index))) return `${out}${sawAnsi ? "\x1b[0m" : ""}${ellipsis}`;
    out += m[0];
    sawAnsi = true;
    last = index + m[0].length;
  }
  cut(text.slice(last));
  return `${out}${sawAnsi ? "\x1b[0m" : ""}${ellipsis}`;
}

/** Pad with spaces on the right up to `width` columns (no truncation). */
export function padDisplay(text: string, width: number): string {
  const w = displayWidth(text);
  return w >= width ? text : text + " ".repeat(width - w);
}
