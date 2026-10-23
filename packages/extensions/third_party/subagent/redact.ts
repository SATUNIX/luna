/**
 * Best-effort secret redaction for workflow run files (state.json and steps/<id>.md).
 *
 * This is display hygiene, not a secret-detection or isolation boundary: a secret in a shape the
 * rules below do not know is written as is. Extensions are self-contained, so the rules are COPIES:
 *   - TRACE_LEDGER_RULES are the four `.replace(...)` rules of targetOf() in
 *     src/trace-ledger/index.ts, in the same order and with the same replacements;
 *   - SECRET_GUARD_CONTENT_PATTERNS are SECRET_CONTENT_PATTERNS in src/secret-guard/index.ts.
 * tests/workflow-redaction-smoke.ts fails when either copy stops being byte-identical to its source.
 *
 * The work is linear in the text length. One copied rule (the URL user:password rule) backtracks
 * quadratically when run over a long colon-filled run with no "@", so it is only ever run on a
 * slice that ends at that "@" (redactUrlCredentials), where it matches in one pass. A private key
 * header with no END line redacts everything after it.
 */

// Copied from src/trace-ledger/index.ts targetOf(); keep byte-identical.
export const TRACE_LEDGER_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/(authorization\s*[:=]\s*["']?(?:bearer|basic)\s+)[^\s"']+/gi, "$1[REDACTED]"],
  [/((?<![\w-])(?=[\w-]{0,64}(?:password|passwd|secret|token|api[_-]?key))[\w-]{1,128}(?:\s*[=:]\s*|\s+))("[^"]*"|'[^']*'|[^\s;&|]+)/gi, "$1[REDACTED]"],
  [/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@"],
  [/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{16,})\b/g, "[REDACTED]"],
];

// Copied from src/secret-guard/index.ts SECRET_CONTENT_PATTERNS; keep byte-identical.
export const SECRET_GUARD_CONTENT_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/, label: "private key block" },
  { re: /\bAKIA[0-9A-Z]{16}\b/, label: "AWS access key id" },
  { re: /\baws_secret_access_key\b\s*[:=]/i, label: "AWS secret access key" },
  { re: /\bxox[baprs]-[0-9A-Za-z]{8,}-[0-9A-Za-z]{8,}/, label: "Slack token" },
  { re: /\bghp_[0-9A-Za-z]{30,}\b/, label: "GitHub personal access token" },
  { re: /\bgithub_pat_[0-9A-Za-z_]{20,}\b/, label: "GitHub fine-grained token" },
  { re: /\bsk-[A-Za-z0-9]{20,}\b/, label: "provider API key (sk-)" },
  { re: /\b(?:api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token)\s*[:=]\s*["']?[A-Za-z0-9+/_-]{20,}/i, label: "credential assignment" },
];

export const REDACTION_POLICY = "workflow-secrets-v1-best-effort";
const MARK = "[REDACTED]";

const global = (re: RegExp): RegExp => new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);

// The URL rule, run only on "scheme ... @" slices. Each slice holds no "/", so slices never overlap
// and every character is scanned at most twice.
function redactUrlCredentials(text: string, rule: readonly [RegExp, string]): string {
  const scheme = /https?:\/\//gi;
  const stop = /[\s/@]/;
  let out = "";
  let last = 0;
  for (let m = scheme.exec(text); m; m = scheme.exec(text)) {
    let end = scheme.lastIndex;
    while (end < text.length && !stop.test(text.charAt(end))) end++;
    if (text.charAt(end) !== "@") continue;
    out += text.slice(last, m.index) + text.slice(m.index, end + 1).replace(global(rule[0]), rule[1]);
    last = end + 1;
    scheme.lastIndex = last;
  }
  return last === 0 ? text : out + text.slice(last);
}

/** The trace-ledger rules, applied in the ledger's order over the whole text. */
export function redactTraceLedger(text: string): string {
  let out = text;
  TRACE_LEDGER_RULES.forEach((rule, i) => {
    out = i === 2 ? redactUrlCredentials(out, rule) : out.replace(rule[0], rule[1]);
  });
  return out;
}

// A private key header through its END line, or to the end of the text when there is none.
function redactPrivateKeys(text: string): string {
  const first = SECRET_GUARD_CONTENT_PATTERNS[0];
  if (!first) return text;
  const header = global(first.re);
  let out = "";
  let last = 0;
  for (let m = header.exec(text); m; m = header.exec(text)) {
    const endAt = text.indexOf("-----END ", header.lastIndex);
    const close = endAt < 0 ? -1 : text.indexOf("-----", endAt + 9);
    out += text.slice(last, m.index) + MARK;
    if (close < 0) return out;
    last = close + 5;
    header.lastIndex = last;
  }
  return last === 0 ? text : out + text.slice(last);
}

/** Redacts the secret shapes Luna knows. Returns the text and whether anything changed. */
export function redactText(text: string): { text: string; redacted: boolean } {
  let out = redactPrivateKeys(text);
  out = redactTraceLedger(out);
  for (const { re, label } of SECRET_GUARD_CONTENT_PATTERNS.slice(1)) {
    // An "aws_secret_access_key =" match is the key name only, so the value after it goes too.
    out = label === "AWS secret access key" ? out.replace(new RegExp(`(${re.source}\\s*["']?)[^\\s"']+`, `${re.flags}g`), `$1${MARK}`) : out.replace(global(re), MARK);
  }
  return { text: out, redacted: out !== text };
}

export const redact = (text: string): string => redactText(text).text;
