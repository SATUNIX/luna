/**
 * Ultracode standing mode (docs/effort.md, "Ultracode"): the session state, its command arguments
 * and its session entry. Pure helpers; index.ts owns the command, the prompt and the registry.
 *
 * Self-containment rule: no imports outside this extension.
 */

/** The session entry (pi.appendEntry) that records every change, so a reload or resume restores it. */
export const STANDING_ENTRY_TYPE = "luna-effort-standing";
/** The hidden per-turn reminder message's custom type. */
export const STANDING_REMINDER_TYPE = "luna-effort-standing-reminder";
/**
 * The custom type of a script workflow's completion message. A copy of RESULT_MESSAGE_TYPE in
 * third_party/subagent/wf-tool.ts (extensions are self-contained); tests/effort-standing-smoke.ts
 * checks the two agree.
 */
export const WORKFLOW_RESULT_TYPE = "luna-workflow-result";
/** The tool whose calls standing mode pre-authorises and whose presence shows the standing block. */
export const WORKFLOW_TOOL = "workflow";
/** Completion turns in a row (no message from you between them) before you are asked to continue. */
export const WAKE_CHAIN_CAP = 5;
export const DEFAULT_SIZE = 50;
/** The size guideline's upper bound: the engine's per-run agent cap. */
export const MAX_SIZE = 1000;
/** The largest --budget accepted, in output tokens. */
export const MAX_BUDGET = 1_000_000_000;

export interface StandingState {
  on: boolean;
  /** True when the operator answered Yes: the firewall then lets `workflow` calls run without asking. */
  preauthorised: boolean;
  /** Soft guideline for agents per workflow, shown in the standing block. */
  size: number;
  /** Output-token budget given to each workflow run the tool starts, or null for none. */
  budget: number | null;
}

export const STANDING_OFF: StandingState = { on: false, preauthorised: false, size: DEFAULT_SIZE, budget: null };

export type StandingArgs =
  | { ok: true; action: "on"; size: number | null; budget: number | null | undefined }
  | { ok: true; action: "off" }
  | { ok: true; action: "status" }
  | { ok: false; error: string };

/** A whole number, with an optional k (thousand) or m (million) suffix; null when it is not one. */
export function parseCount(text: string): number | null {
  const m = /^(\d{1,10})([km]?)$/i.exec(text.trim());
  if (!m) return null;
  const base = Number(m[1]);
  const unit = (m[2] ?? "").toLowerCase();
  const n = unit === "k" ? base * 1000 : unit === "m" ? base * 1_000_000 : base;
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * The words after `/effort ultracode`, `/effort uc` or `/effort e5 --standing` (the tier word and
 * `--standing` already removed): `off`, `status`, or `--size N` and `--budget N|none`.
 * `budget` is undefined when not given (keep the current one), null for `none`.
 */
export function parseStandingArgs(words: string[]): StandingArgs {
  const rest = [...words];
  const first = rest[0]?.toLowerCase();
  if (first === "off" || first === "status") {
    if (rest.length > 1) return { ok: false, error: `"${rest.slice(1).join(" ")}" does not go with ${first}` };
    return { ok: true, action: first };
  }
  if (first === "on") rest.shift();
  let size: number | null = null;
  let budget: number | null | undefined;
  while (rest.length) {
    const flag = (rest.shift() ?? "").toLowerCase();
    const value = rest.shift();
    if (flag !== "--size" && flag !== "--budget") return { ok: false, error: `unknown option "${flag}"` };
    if (value === undefined) return { ok: false, error: `${flag} needs a value` };
    if (flag === "--size") {
      const n = parseCount(value);
      if (n === null || n < 1 || n > MAX_SIZE) return { ok: false, error: `--size needs a whole number from 1 to ${String(MAX_SIZE)}` };
      size = n;
    } else if (/^(none|off)$/i.test(value)) budget = null;
    else {
      const n = parseCount(value);
      if (n === null || n < 1 || n > MAX_BUDGET) return { ok: false, error: "--budget needs a positive number of output tokens (for example 200000 or 200k), or none" };
      budget = n;
    }
  }
  return { ok: true, action: "on", size, budget };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A recorded state, read with type guards only; null when the data is not one. */
export function standingFromData(data: unknown): StandingState | null {
  if (!isRecord(data) || data.version !== 1) return null;
  const { on, preauthorised, size, budget } = data;
  if (typeof on !== "boolean" || typeof preauthorised !== "boolean") return null;
  if (typeof size !== "number" || !Number.isInteger(size) || size < 1 || size > MAX_SIZE) return null;
  if (budget !== null && (typeof budget !== "number" || !Number.isInteger(budget) || budget < 1 || budget > MAX_BUDGET)) return null;
  return { on, preauthorised: on && preauthorised, size, budget };
}

/** The entry data for a state. */
export function standingData(state: StandingState): Record<string, unknown> {
  return { version: 1, on: state.on, preauthorised: state.preauthorised, size: state.size, budget: state.budget };
}

/**
 * The state the last standing entry among session entries (the current branch, oldest first)
 * records, or null when there is none. A malformed last entry is null too: an older entry never
 * stands in for it, so a later "off" that cannot be read never brings back an earlier "on".
 */
export function lastStandingEntry(entries: readonly unknown[]): StandingState | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (isRecord(entry) && entry.type === "custom" && entry.customType === STANDING_ENTRY_TYPE) return standingFromData(entry.data);
  }
  return null;
}
