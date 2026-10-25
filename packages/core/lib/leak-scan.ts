/**
 * The blocked-identifier scan shared by the public export and the pre-push hook.
 *
 * A line is blocked when it contains a private host name (`*.internal`, `*.lan`, `*.local`,
 * `*.home.arpa`, `*.ts.net`), a user home path (`/home/<user>`, `/Users/<user>`,
 * `<drive>:\Users\<user>`), a private or shared IPv4 address (10/8, 172.16/12, 192.168/16 and the
 * carrier-grade NAT block 100.64/10), an IPv6 unique-local address (the fc and fd prefixes),
 * a PEM private-key header of any common type (RSA, EC, DSA, OpenSSH, encrypted PKCS#8, PGP) or
 * an SSH2 (RFC 4716 style) private-key header, a
 * GitHub or AWS access-key shape, a private security-review finding ID (`SR-` and a number: the
 * review report is private, so a public file describes the risk instead of citing it), a private
 * roadmap or review item ID (an upper-case `R`, `P`, `M` or `D`, a hyphen and one or two digits,
 * as a whole token; the roadmap is private too), or a term
 * from the operator's private denylist (below). One
 * audited exception admits one exact match on one exact line of one file: it pins the SHA-256 of
 * the match and of the whole line, so any edit to the line needs a new review. The exceptions live
 * in `packages/core/leak-scan-exceptions.json`. Values are never printed: a finding names the file
 * and line number only.
 *
 * Operator denylist: when `PI_LEAK_SCAN_DENYLIST` names a file (kept outside the repository, for
 * example in the private sidecar), every non-empty line of it that is not a `#` comment is a
 * literal term, matched case-insensitively. It is how private host names and account names that
 * fit no pattern (a bare machine name) are blocked without publishing them. A named file that
 * cannot be read throws, so a misconfigured denylist refuses instead of passing.
 *
 * Pinned by `tests/prepush-scan-smoke.ts` (one case per identifier class, and the denylist) and,
 * for the export, the private export smoke.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { array, number, object, optional, parseJsonAs, string, type Infer } from "./guard.ts";

/** An audited exact-line exception to the blocked-identifier scan. */
export const ScanExceptionSchema = object({ path: string(), matchSha256: string(), lineSha256: string(), reason: optional(string()) });
export type ScanException = Infer<typeof ScanExceptionSchema>;
const ScanExceptionsFileSchema = object({ schemaVersion: optional(number()), scanExceptions: array(ScanExceptionSchema) });

/** Where the reviewed exceptions live, relative to the repository root. */
export const SCAN_EXCEPTIONS_FILE = "packages/core/leak-scan-exceptions.json";
const defaultExceptionsPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../leak-scan-exceptions.json");

// Case-insensitive classes: host suffixes, Linux and Windows home paths (Windows paths are
// case-insensitive, and the drive-letter form is never a URL route), addresses, key headers and
// token shapes.
const BLOCKED = /(?:[a-z0-9-]+\.)+(?:internal|lan|local|home\.arpa|ts\.net)\b|\/home\/[a-zA-Z0-9_-]+|\b[a-z]:(?:\\{1,2}|\/)users(?:\\{1,2}|\/)[a-z0-9._-]+|\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])(?:\.\d{1,3}){2})\b|\bf[cd][0-9a-f]{2}:(?:[0-9a-f]{0,4}:){1,6}[0-9a-f]{0,4}|-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----|-{4,5} ?BEGIN SSH2 (?:ENCRYPTED )?PRIVATE KEY ?-{4,5}|\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/gi;
// Case-sensitive classes: macOS home paths (a lower-case `/users/` is a common URL route),
// private security-review finding IDs (`SR-` and digits; upper case only, so `sr-only` style names
// pass) and private roadmap item IDs (`R`, `P`, `M` or `D`, a hyphen, one or two digits, as a whole
// token: upper case only, so `mkdir -p` and `-d` flags pass; the two-digit cap and the trailing
// boundary let `P-256`, `SHA-256` and `Node-22` pass, and the leading boundary keeps a longer ID
// such as `SR-` from also counting here).
const BLOCKED_CASE = /\/Users\/[A-Za-z0-9._-]+|\bSR-\d+\b|\b[RPMD]-\d{1,2}\b/g;

/** The environment variable naming the operator's private denylist file. */
export const DENYLIST_ENV = "PI_LEAK_SCAN_DENYLIST";
let denylist: { file: string; terms: string[] } | null = null;

/** The operator's literal denylist terms (lower case), read once per file named by PI_LEAK_SCAN_DENYLIST. */
export function operatorDenylist(env: NodeJS.ProcessEnv = process.env): string[] {
  const file = env[DENYLIST_ENV];
  if (!file) return [];
  if (denylist?.file !== file) {
    const terms = fs.readFileSync(file, "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map((l) => l.toLowerCase());
    denylist = { file, terms };
  }
  return denylist.terms;
}

function denylistMatches(line: string): string[] {
  const terms = operatorDenylist();
  if (!terms.length) return [];
  const lower = line.toLowerCase();
  const out: string[] = [];
  for (const term of terms) {
    for (let at = lower.indexOf(term); at >= 0; at = lower.indexOf(term, at + term.length)) out.push(line.slice(at, at + term.length));
  }
  return out;
}

export const sha256 = (text: string): string => crypto.createHash("sha256").update(text).digest("hex");

/** Every blocked identifier in one line (no line terminator). */
export function blockedMatches(line: string): string[] {
  return [...(line.match(BLOCKED) ?? []), ...(line.match(BLOCKED_CASE) ?? []), ...denylistMatches(line)];
}

/** True when an audited exception admits `match` on exactly this `line` of `file`. */
export function isExcepted(exceptions: readonly ScanException[], file: string, match: string, line: string): boolean {
  const matchSha = sha256(match), lineSha = sha256(line);
  return exceptions.some((e) => e.path === file && e.matchSha256 === matchSha && e.lineSha256 === lineSha);
}

/** The number of matches on `line` that no exception admits. */
export function unexceptedCount(exceptions: readonly ScanException[], file: string, line: string): number {
  return blockedMatches(line).filter((m) => !isExcepted(exceptions, file, m, line)).length;
}

/** Check exceptions-file text; a field of the wrong shape throws a ValidationError naming it. */
export function parseScanExceptions(text: string): ScanException[] {
  return parseJsonAs(ScanExceptionsFileSchema, text, "leak-scan-exceptions").scanExceptions;
}

/** Read and check the exceptions file; a field of the wrong shape throws a ValidationError naming it. */
export function readScanExceptions(file = defaultExceptionsPath): ScanException[] {
  return parseScanExceptions(fs.readFileSync(file, "utf8"));
}
