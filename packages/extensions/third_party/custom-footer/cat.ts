/**
 * The ASCII cat: a small, data-driven face that shows the semantic state of the agent while the
 * spinner/working line shows ongoing activity. Pure: no timers, no pi API, no disk. The extension
 * decides which signals are active and when to look at the clock; this file owns the animation
 * table, the state priority and the frame arithmetic.
 *
 * Every frame is printable US-ASCII (0x20-0x7E) and is padded to CAT_WIDTH, so a frame change never
 * moves the text beside it.
 */

export const CAT_STATES = [
  "idle", "thinking", "crunching", "working", "tool", "streaming", "waiting", "waiting_for_user",
  "checking", "success", "warning", "denied", "error", "retrying", "cancelled", "sleeping", "alert",
] as const;
export type CatState = (typeof CAT_STATES)[number];

export type CatAnimation = {
  frames: string[];
  /** Milliseconds per frame. Ignored when there is one frame. */
  intervalMs: number;
  /**
   * loop: repeat while the state holds (work in progress).
   * once: play through, then hold the last frame until the state is replaced (a result).
   */
  mode: "loop" | "once";
  /** Plain status text for the state, used when nothing more specific (a tool name) is known. */
  label: string;
  /** Theme colour for the face. */
  colour: string;
};

/** The widest frame in the table; every rendered frame is padded to this many columns. */
export const CAT_WIDTH = 7;

export const ANIMATIONS: Record<CatState, CatAnimation> = {
  idle: { frames: ["=^..^="], intervalMs: 1000, mode: "loop", label: "Ready", colour: "muted" },
  thinking: { frames: ["=^o.^=", "=^.o^=", "=^..^=", "=^.o^=", "=^o.^=", "=^..^="], intervalMs: 320, mode: "loop", label: "Thinking", colour: "accent" },
  crunching: { frames: ["=^..^=", "=^.:^=", "=^::^=", "=^:.^=", "=^..^="], intervalMs: 220, mode: "loop", label: "Crunching", colour: "accent" },
  working: { frames: ["=^..^=", "=^o.^=", "=^oo^=", "=^.o^=", "=^..^="], intervalMs: 280, mode: "loop", label: "Working", colour: "accent" },
  tool: { frames: ["=^..^=", "=^>.^=", "=^>>^=", "=^.>^=", "=^..^="], intervalMs: 240, mode: "loop", label: "Running tool", colour: "accent" },
  streaming: { frames: ["=^..^=", "=^.^=", "=^..^=", "=^.^="], intervalMs: 550, mode: "loop", label: "Responding", colour: "muted" },
  waiting: { frames: ["=^..^=", "=^...^=", "=^..^=", "=^...^="], intervalMs: 700, mode: "loop", label: "Waiting", colour: "muted" },
  waiting_for_user: { frames: ["=^..^=", "=^?^=", "=^..^=", "=^?^="], intervalMs: 800, mode: "loop", label: "Waiting for input", colour: "warning" },
  checking: { frames: ["=^?.^=", "=^.?^=", "=^?.^="], intervalMs: 350, mode: "loop", label: "Checking action", colour: "warning" },
  success: { frames: ["=^..^=", "=^.^=", "=^-^=", "=^.^="], intervalMs: 200, mode: "once", label: "Complete", colour: "success" },
  warning: { frames: ["=^..^=", "=^!!^=", "=^..^=", "=^!!^=", "=^!^="], intervalMs: 220, mode: "once", label: "Warning", colour: "warning" },
  denied: { frames: ["=^..^=", "=^>.<^=", "=^#.#^=", "=^>.<^="], intervalMs: 220, mode: "once", label: "Action denied", colour: "error" },
  error: { frames: ["=^x.x^=", "=^X.x^=", "=^x.X^=", "=^X.X^=", "=^x.x^="], intervalMs: 160, mode: "once", label: "Error", colour: "error" },
  retrying: { frames: ["=^x.^=", "=^..^=", "=^.x^=", "=^..^="], intervalMs: 400, mode: "loop", label: "Retrying", colour: "warning" },
  cancelled: { frames: ["=^..^=", "=^-.-^=", "=^---^=", "=^-.-^="], intervalMs: 220, mode: "once", label: "Cancelled", colour: "muted" },
  sleeping: { frames: ["=^-.-^=", "=^---^=", "=^-.-^=", "=^-.-^="], intervalMs: 1200, mode: "loop", label: "Resting", colour: "dim" },
  alert: { frames: ["=^o.o^=", "=^O.O^=", "=^o.o^=", "=^O.O^="], intervalMs: 250, mode: "once", label: "Attention required", colour: "error" },
};

/**
 * Highest first. When several signals are active the first one in this list wins, not the most
 * recent event, so a late `streaming` signal cannot hide an approval prompt or a failure.
 */
export const PRIORITY: CatState[] = [
  "error", "alert", "denied", "waiting_for_user", "checking", "warning", "retrying", "tool", "crunching",
  "thinking", "working", "streaming", "waiting", "cancelled", "success", "idle", "sleeping",
];

/** States that are a result, shown briefly after the event and then given up. */
export const TRANSIENT: ReadonlySet<CatState> = new Set<CatState>(["success", "warning", "denied", "error", "cancelled", "alert"]);

/** How long a transient result stays visible (its animation plus a hold), by state. */
export function transientHoldMs(state: CatState): number {
  const a = ANIMATIONS[state];
  const play = a.frames.length * a.intervalMs;
  return state === "error" || state === "denied" ? play + 3500 : play + 1500;
}

/** Highest-priority state among those active; `idle` when none is. */
export function resolveCatState(active: Iterable<CatState>): CatState {
  const set = new Set(active);
  for (const state of PRIORITY) if (set.has(state)) return state;
  return "idle";
}

/** Characters the cat is allowed to use: the 95 printable US-ASCII characters. */
export const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

export function padFrame(frame: string): string {
  return frame.length >= CAT_WIDTH ? frame : frame + " ".repeat(CAT_WIDTH - frame.length);
}

/** Padded frames for a state, ready to hand to a spinner or to index by time. */
export function catFrames(state: CatState): string[] {
  return ANIMATIONS[state].frames.map(padFrame);
}

/** The frame to show `elapsedMs` after the state began. A `once` animation holds its last frame. */
export function frameAt(state: CatState, elapsedMs: number): string {
  const a = ANIMATIONS[state];
  const frames = catFrames(state);
  // Every animation in the table has at least one frame, so the `?? ""` fallbacks never apply.
  if (frames.length === 1) return frames[0] ?? "";
  const index = Math.max(0, Math.floor(elapsedMs / a.intervalMs));
  if (a.mode === "once") return frames[Math.min(index, frames.length - 1)] ?? "";
  return frames[index % frames.length] ?? "";
}

/** True once a `once` animation has played through (always false for a loop). */
export function finished(state: CatState, elapsedMs: number): boolean {
  const a = ANIMATIONS[state];
  return a.mode === "once" && elapsedMs >= a.frames.length * a.intervalMs;
}

export type Paint = (colour: string, text: string) => string;

/**
 * Frames for pi's working indicator (`ctx.ui.setWorkingIndicator`). Pi renders custom frames
 * verbatim, so the colour is applied here. A once-only state is flattened to its last frame, because
 * pi's indicator can only loop; the footer plays those through.
 */
export function indicatorFor(state: CatState, paint: Paint): { frames: string[]; intervalMs: number } {
  const a = ANIMATIONS[state];
  const frames = a.mode === "once" ? [catFrames(state).at(-1) ?? ""] : catFrames(state);
  return { frames: frames.map((f) => paint(a.colour, f)), intervalMs: a.intervalMs };
}

/** One coloured, fixed-width frame of the cat for the footer. */
export function renderCat(state: CatState, elapsedMs: number, paint: Paint): string {
  return paint(ANIMATIONS[state].colour, frameAt(state, elapsedMs));
}

export type CatStyle = "compact";
export const CAT_STYLES: CatStyle[] = ["compact"];

/**
 * Map a tool error to a cat state. Nothing publishes a structured denial, so this reads the text:
 * a refusal by a guard is `denied`, any other failure is a recoverable `warning`.
 */
export function classifyToolError(result: unknown): CatState {
  let text = "";
  // `String(value)` for a value of any type: a tool result is whatever the tool returned.
  const toText = (value: unknown): string => String(value);
  try {
    const parts = (result as { content?: Array<{ text?: unknown }> } | undefined)?.content;
    text = Array.isArray(parts) ? parts.map((p) => toText(p?.text ?? "")).join(" ") : toText(result ?? "");
  } catch { /* unreadable result: treat as a plain failure */ }
  return /\b(blocked|denied|not permitted|refused|forbidden|policy)\b/i.test(text.slice(0, 600)) ? "denied" : "warning";
}
