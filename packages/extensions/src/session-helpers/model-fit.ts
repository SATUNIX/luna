/**
 * Model fit: what a model's context window means for compaction, as data and one pure function. The
 * window sizes in use run from 4k (a small local model) to 1M; pi's own defaults (16k reserve, 20k
 * kept) do not fit the small end, and numbers hand-set in several places drift apart.
 *
 * `modelFit(window)` answers with the tier and the compaction settings that suit it. The only consumer
 * is the compaction advice (compaction-state.ts); nothing else reads a tier. The numbers live only in
 * FIT_TIERS.
 *
 * Self-containment rule: no imports.
 */

export type FitTier = "tiny" | "small" | "normal";

export interface TierSpec {
  tier: FitTier;
  /** Windows below this many tokens are in the tier (the last tier takes the rest). */
  below: number;
  /** Compaction reserve and kept-recent tokens, as a fraction of the window (undefined: pi's own defaults). */
  reserveFraction?: number;
  keepFraction?: number;
}

export const FIT_TIERS: readonly TierSpec[] = [
  { tier: "tiny", below: 12_000, reserveFraction: 0.12, keepFraction: 0.2 },
  { tier: "small", below: 48_000, reserveFraction: 0.12, keepFraction: 0.2 },
  { tier: "normal", below: Infinity },
];

/** pi's own compaction defaults, used where a tier gives no fraction. */
const PI_RESERVE = 16_384;
const PI_KEEP = 20_000;
/** pi-ai keeps this many tokens of a window spare (finish-reason-retry PI_CONTEXT_SAFETY_TOKENS); a threshold below keep + this compacts every turn. */
const SAFETY = 4096;
/** The fewest recent tokens worth keeping. */
const MIN_KEEP = 512;

export interface ModelFit {
  tier: FitTier;
  /** The window the answer is for; null when the model reports none (treated as normal). */
  window: number | null;
  compaction: { reserveTokens: number; keepRecentTokens: number };
  /**
   * Whether `compaction` leaves a compaction threshold that clears keep + pi's safety margin. False for
   * a window of roughly 5.8k tokens or less: no setting makes compaction work there, only a larger window does.
   */
  compactionFits: boolean;
}

export function modelFit(contextWindow: number | null | undefined): ModelFit {
  const window = typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0 ? Math.floor(contextWindow) : null;
  const spec = (window === null ? FIT_TIERS.at(-1) : FIT_TIERS.find((t) => window < t.below)) ?? FIT_TIERS[FIT_TIERS.length - 1];
  if (!spec) throw new Error("FIT_TIERS is empty");
  const reserve = window !== null && spec.reserveFraction !== undefined ? Math.max(512, Math.floor(window * spec.reserveFraction)) : PI_RESERVE;
  let keep = window !== null && spec.keepFraction !== undefined ? Math.max(1024, Math.floor(window * spec.keepFraction)) : PI_KEEP;
  let compactionFits = true;
  if (window !== null && spec.reserveFraction !== undefined) {
    // The threshold (window - reserve) must clear keep + safety, so keep gives way to it.
    keep = Math.min(keep, window - reserve - SAFETY);
    if (keep < MIN_KEEP) {
      compactionFits = false;
      keep = MIN_KEEP;
    }
  }
  return { tier: spec.tier, window, compaction: { reserveTokens: reserve, keepRecentTokens: keep }, compactionFits };
}

/**
 * Whether a provider's base URL points at this machine or a private network (loopback, RFC 1918,
 * link-local, `.local`/`.lan`/`.internal` names, or a bare host name). The price is deliberately not
 * used: hosted free tiers also cost nothing. A private gateway in front of a hosted model looks local by
 * address alone; PI_KIT_LOCAL_MODELS=off says it is not (=on the reverse). The same rule is in
 * tool-firewall/judge.ts and subagent/config.ts; each extension carries its own copy because extensions
 * are self-contained, and tests/model-fit-smoke.ts pins the three to one table.
 */
export function isLocalBaseUrl(baseUrl: string | undefined): boolean {
  const forced = process.env.PI_KIT_LOCAL_MODELS?.trim().toLowerCase();
  if (forced === "on" || forced === "1" || forced === "off" || forced === "0") return forced === "on" || forced === "1";
  if (!baseUrl) return false;
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return false;
  }
  if (host === "localhost" || host === "::1" || host.endsWith(".local") || host.endsWith(".lan") || host.endsWith(".internal")) return true;
  const v4 = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(host);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  return /^f[cd][0-9a-f]{2}:/.test(host) || (!host.includes(".") && !host.includes(":"));
}
