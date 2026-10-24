/**
 * The blocked-identifier scan shared by the public export and the pre-push hook.
 *
 * A line is blocked when it contains a private host name (`*.internal`, `*.lan`, `*.local`), a
 * `/home/<user>` path, a private IPv4 address (10/8, 172.16/12, 192.168/16), a PEM private-key
 * header, or a GitHub or AWS access-key shape. One audited exception admits one exact match on
 * one exact line of one file: it pins the SHA-256 of the match and of the whole line, so any edit
 * to the line needs a new review. The exceptions live in `packages/core/leak-scan-exceptions.json`.
 * Values are never printed: a finding names the file and line number only.
 *
 * Pinned by `tests/prepush-scan-smoke.ts` (and, for the export, the private export smoke).
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

const BLOCKED = /(?:[a-z0-9-]+\.)+(?:internal|lan|local)\b|\/home\/[a-zA-Z0-9_-]+|\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/gi;

export const sha256 = (text: string): string => crypto.createHash("sha256").update(text).digest("hex");

/** Every blocked identifier in one line (no line terminator). */
export function blockedMatches(line: string): string[] {
  return line.match(BLOCKED) ?? [];
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

/** Read and check the exceptions file; a field of the wrong shape throws a ValidationError naming it. */
export function readScanExceptions(file = defaultExceptionsPath): ScanException[] {
  return parseJsonAs(ScanExceptionsFileSchema, fs.readFileSync(file, "utf8"), "leak-scan-exceptions").scanExceptions;
}
