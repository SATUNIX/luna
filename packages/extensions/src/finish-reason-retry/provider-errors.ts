/**
 * The one classifier for provider failures: credit or key limits (HTTP 402 and its wordings), rate
 * limits (429), and server trouble (5xx, overloaded). Pure text in, a class out, so the retry hook,
 * the provider-router fallback list and the autonomy runner (which imports this file) agree on what a
 * failure means.
 *
 * A 402 that says how many output tokens the account can still afford ("can only afford 1234") is
 * recoverable: the request is asked again with a smaller maximum. Everything else in the credit class
 * is terminal for the model that produced it.
 *
 * Self-containment rule: no imports.
 */

export type ProviderErrorKind = "credit" | "rate_limit" | "server" | "other";

export interface ProviderErrorClass {
  kind: ProviderErrorKind;
  /** Credit only: the output-token maximum to retry with, when the provider said what it can afford. */
  clampTo?: number | undefined;
}

/** The smallest output maximum worth retrying with; below this the reply is too short to be useful. */
export const MIN_CLAMP_TOKENS = 256;

const CREDIT = /(?:^|\b(?:http|status|code|error)\W{0,3})402\b|requires more credits|fewer max_tokens|insufficient[ _]?(?:credits?|funds|quota)|exceeded your (?:current )?quota|(?:key|credit|spend|weekly|billing) limit|out of credits/i;
const RATE_LIMIT = /(?<![a-z0-9])429(?![a-z0-9])|rate[ _-]?limit|too many requests/i;
const SERVER = /(?<![a-z0-9])(?:500|502|503|504|520|524)(?![a-z0-9])|overloaded|server[ _]?(?:error|busy)|internal[ _]?error|service[ _]?(?:is[ _])?(?:temporarily[ _])?unavailable|provider returned error/i;
const AFFORD = /can only afford\s+([\d,]+)/i;

/** The tokens a 402 says the account can afford, with a margin for the provider's rounding, or undefined. */
export function affordableTokens(text: string): number | undefined {
  const m = AFFORD.exec(text);
  if (!m?.[1]) return undefined;
  const n = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(n)) return undefined;
  const clamp = Math.floor(n * 0.9);
  return clamp >= MIN_CLAMP_TOKENS ? clamp : undefined;
}

export function classifyProviderError(text: string): ProviderErrorClass {
  // A rate limit is transient even when the same text mentions a limit; credit wording wins only without one.
  if (CREDIT.test(text) && !RATE_LIMIT.test(text)) return { kind: "credit", clampTo: affordableTokens(text) };
  if (RATE_LIMIT.test(text)) return { kind: "rate_limit" };
  if (SERVER.test(text)) return { kind: "server" };
  return { kind: "other" };
}

/** Provider text safe to surface: links (which can carry a key in the query string) and key-like parameters are removed. */
export function redactProviderError(text: string, max = 400): string {
  return text
    .replace(/https?:\/\/\S+/gi, "<url>")
    .replace(/\b((?:api[_-]?)?key|token|secret)=[^\s&"']+/gi, "$1=<redacted>")
    .slice(0, max);
}

/**
 * Lower every output-token maximum in a provider request payload to `cap`. Only fields the payload
 * already has are touched, since the spelling differs by API. Returns whether anything changed.
 */
export function clampOutputTokens(payload: unknown, cap: number): boolean {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return false;
  const body: Record<string, unknown> = Object.fromEntries(Object.entries(payload));
  let changed = false;
  for (const key of ["max_tokens", "max_completion_tokens", "max_output_tokens", "maxOutputTokens"]) {
    const value = body[key];
    if (typeof value === "number" && value > cap) {
      Reflect.set(payload, key, cap);
      changed = true;
    }
  }
  return changed;
}
