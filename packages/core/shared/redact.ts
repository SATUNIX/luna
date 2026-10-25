/**
 * The kit's one secret-redaction table (docs/security.md, "Redaction").
 *
 * Text that the kit stores (the memory vault, `/save` snapshots, the firewall's feedback and audit
 * records, autonomy notebooks, workflow run files, role-runner telemetry, mem0 memories) passes
 * through `redactSecrets` first. It replaces the secret shapes below with `[REDACTED]`, keeping a
 * key name or header in front of the value where there is one.
 *
 * This is best-effort hygiene, not a detection boundary: a secret in a shape the table does not
 * know is kept as written. Every rule is linear in the text length (bounded runs, no nested
 * quantifiers, an unterminated private key is redacted to the end of the text instead of every
 * header re-scanning for an END line); tests/redaction-corpus-smoke.ts checks each copy against
 * tests/fixtures/secret-corpus.json, for leaks and for time on adversarial input.
 *
 * Canonical source: packages/core/shared/redact.ts. Extensions and packages that cannot import it
 * hold generated, byte-checked copies (`npm run gen:shared`; `npm run verify` fails on drift).
 */

/** One rule. `to` is the replacement: `$1` keeps the first group (the key name, header or scheme). */
export interface RedactionRule {
  readonly id: string;
  readonly re: RegExp;
  readonly to: string;
}

export const REDACTION_MARK = "[REDACTED]";
export const REDACTION_TABLE = "kit-secrets-v2-best-effort";

// A rule that keeps a prefix skips a value already replaced ((?!\[REDACTED\])), so a key=value
// rule after a token rule does not count one secret twice.
export const REDACTION_RULES: readonly RedactionRule[] = [
  // PEM and PGP private keys, through the END line or to the end of the text.
  { id: "private-key", re: /-----BEGIN [A-Z ]{0,40}PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z ]{0,40}PRIVATE KEY(?: BLOCK)?-----|$)/g, to: "[REDACTED]" },
  // Authorization headers and bare bearer tokens: the header and scheme stay.
  { id: "authorization-header", re: /(\bauthorization["']?\s*[:=]\s*["']?(?:(?:bearer|basic|token|bot)\s+)?)(?!\[REDACTED\])[^\s"',;]{8,}/gi, to: "$1[REDACTED]" },
  { id: "bearer-token", re: /(\bbearer\s+)(?!\[REDACTED\])[A-Za-z0-9._~+/=-]{12,}/gi, to: "$1[REDACTED]" },
  // user:password@ in a URL: the scheme and host stay.
  { id: "url-credentials", re: /([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/@:]{0,256}:[^\s/@]{1,512}@/gi, to: "$1[REDACTED]@" },
  // Provider token shapes.
  { id: "aws-access-key-id", re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, to: "[REDACTED]" },
  { id: "github-token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, to: "[REDACTED]" },
  { id: "gitlab-token", re: /\bgl(?:pat|ptt|dt|rt|cbt|soat|oas)-[A-Za-z0-9_-]{16,}/g, to: "[REDACTED]" },
  { id: "provider-sk-key", re: /\bsk-(?:ant-|proj-|or-|lf-)?[A-Za-z0-9_-]{20,}/g, to: "[REDACTED]" },
  { id: "short-sk-pk-key", re: /\b(?:sk|pk)-[A-Za-z0-9]{8,}\b/g, to: "[REDACTED]" },
  { id: "stripe-key", re: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g, to: "[REDACTED]" },
  { id: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, to: "[REDACTED]" },
  { id: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g, to: "[REDACTED]" },
  { id: "huggingface-token", re: /\bhf_[A-Za-z0-9]{30,}\b/g, to: "[REDACTED]" },
  { id: "npm-token", re: /\bnpm_[A-Za-z0-9]{30,}\b/g, to: "[REDACTED]" },
  { id: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, to: "[REDACTED]" },
  // aws_secret_access_key = value (the key name alone is not a secret).
  { id: "aws-secret-access-key", re: /(\baws_secret_access_key["']?\s*[:=]\s*["']?)(?!\[REDACTED\])[^\s"',;]+/gi, to: "$1[REDACTED]" },
  // KEY=value and "key": "value", including a prefixed or suffixed key (DB_PASSWORD, GITLAB_TOKEN,
  // x-api-key, "apiKey"). The keyword starts the key or follows a `_`-separated segment, and every
  // run is bounded.
  { id: "secret-assignment", re: /(?<![A-Za-z0-9_])((?=(?:[A-Za-z0-9-]{0,32}_){0,4}(?:api[_-]?key|secret|token|password|passwd|pwd|auth|credentials?)(?![a-z]))[A-Za-z0-9_-]{1,128}["']?\s*[:=]\s*["']?)(?!\[REDACTED\])[^\s"',;]{6,}/gi, to: "$1[REDACTED]" },
  // camelCase keys (accessToken, clientSecret, dbPassword) in code and JSON.
  { id: "camel-case-secret", re: /(?<![A-Za-z0-9_])([a-z][a-zA-Z0-9]{0,32}(?:Token|Secret|Password|Passwd|ApiKey|AccessKey|SecretKey|PrivateKey)["']?\s*[:=]\s*["']?)(?!\[REDACTED\])[^\s"',;]{6,}/g, to: "$1[REDACTED]" },
  // --password value, --token value (a space-separated flag value).
  { id: "secret-flag", re: /((?:^|\s)--?(?:[a-z0-9]{1,32}-){0,3}(?:password|passwd|secret|token|api-?key)\s+)(?!\[REDACTED\])[^\s"';&|-][^\s"';&|]*/gi, to: "$1[REDACTED]" },
  // mysql/mariadb -p<password> (a bare -p prompts instead). Case-sensitive: -P is the port.
  { id: "mysql-password", re: /(\b(?:mysql|mariadb|mysqldump|mysqladmin)\b[^\n|;&]{0,256}?\s-p)(?!\[REDACTED\])[^\s"',;|&]+/g, to: "$1[REDACTED]" },
  // curl -u / --user / -U / --proxy-user user:password: the user stays.
  { id: "curl-user", re: /(\bcurl\b[^\n|;&]{0,512}?\s(?:-u|--user|-U|--proxy-user)(?:\s+|=)?["']?[^\s"':]{1,256}:)(?!\[REDACTED\])[^\s"']+/g, to: "$1[REDACTED]" },
];

function apply(rule: RedactionRule, text: string, onHit: () => void): string {
  return text.replace(rule.re, (...args: unknown[]) => {
    onHit();
    const first = args[1];
    return rule.to.replace("$1", typeof first === "string" ? first : "");
  });
}

/** `text` with every secret shape replaced, and how many replacements were made. */
export function redactSecrets(text: string): { text: string; count: number } {
  let out = text;
  let count = 0;
  for (const rule of REDACTION_RULES) out = apply(rule, out, () => { count++; });
  return { text: out, count };
}

/** `text` with every secret shape replaced. */
export function redact(text: string): string {
  return redactSecrets(text).text;
}
