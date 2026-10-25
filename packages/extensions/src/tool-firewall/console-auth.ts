// console-auth.ts — authenticated human-console answers.
//
// A headless requester (tool-firewall, pentest-governance-domain, ask_human) files a request as
// <console>/pending/<id>.json and waits for <console>/resolved/<id>.json. Both directories sit where
// the agent works, so a file there proves nothing about who wrote it. An answer therefore counts only
// when it carries an HMAC-SHA256, made with the console answer key, over the request id, the SHA-256
// of the exact pending bytes the requester wrote, and the decision. A forged answer (no MAC, a wrong
// MAC, or one made for a different or rewritten request) is rejected, and the requester keeps waiting
// until its deadline, so the outcome is at worst a timeout: never an approval nobody gave.
//
// Key placement: <agent dir>/human-console/response.key (PI_CODING_AGENT_DIR, default ~/.pi/agent),
// 32 random bytes as hex, mode 0600 in a 0700 directory. Only the interactive console creates it
// (atomically: a private temp file hard-linked into place); a requester never does, so a requester
// that finds no key files nothing and reports that the console must be started first. The key and
// its directory are refused when either is a symbolic link, is not this user's, or is open to other
// users. The file is outside the workspace and outside the console directory, and the tool firewall
// classifies the whole <agent dir>/human-console directory as a credential for reads (the file, the
// directory, a glob or recursive read under it: high) and as a security control for writes (high):
// see tests/human-console-auth-smoke.ts. The kit's own code reads it
// directly, which is the point: the requester and the console are the kit, the agent's tool calls are not.
//
// What this does not stop: code running inside a pi process (an extension), a process of the same
// user that is not an agent tool call (a key file is only as private as the account), an operator
// who approves the agent's request to read the key, or inline interpreter code that builds the key's
// path at run time, which the firewall cannot see statically. Answers are bound to one request, so a captured
// answer cannot be replayed onto another request.
//
// Extensions are self-contained, so tool-firewall, human-console and pentest-governance-domain each
// carry this same file; tests/human-console-auth-smoke.ts fails when the copies differ.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DOMAIN = "pi-kit.human-console.answer.v1";
const KEY_RE = /^[0-9a-f]{64}\n?$/;
const MAC_RE = /^[0-9a-f]{64}$/;

/** Where the console answer key lives (see the header). */
export function consoleKeyPath(env: NodeJS.ProcessEnv = process.env): string {
  const agentDir = env.PI_CODING_AGENT_DIR?.trim() || path.join(os.homedir(), ".pi", "agent");
  return path.join(agentDir, "human-console", "response.key");
}

export type ConsoleKey = { ok: true; key: Buffer; file: string } | { ok: false; why: string; file: string };

function errText(error: unknown): string {
  const code: unknown = typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined;
  return typeof code === "string" ? code : error instanceof Error ? error.message : String(error);
}

function createKey(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, `${crypto.randomBytes(32).toString("hex")}\n`, { mode: 0o600, flag: "wx" });
  try {
    fs.linkSync(tmp, file); // fails with EEXIST when another process created it first: theirs is used
  } catch (error) {
    if (errText(error) !== "EEXIST") throw error;
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
  }
}

/** Why a path is not a private, real, own entry (null when it is). */
function notPrivate(p: string, st: fs.Stats, kind: "file" | "directory"): string | null {
  if (st.isSymbolicLink()) return `${p} is a symbolic link`;
  if (kind === "file" ? !st.isFile() : !st.isDirectory()) return `${p} is not a ${kind === "file" ? "regular file" : "directory"}`;
  if (process.platform === "win32") return null;
  if (st.mode & 0o077) return `${p} is open to other users (mode ${(st.mode & 0o777).toString(8)}; it must be ${kind === "file" ? "600" : "700"})`;
  const uid = typeof process.getuid === "function" ? process.getuid() : -1;
  if (uid !== -1 && st.uid !== uid) return `${p} belongs to another user`;
  return null;
}

/**
 * The console answer key. `create` (the interactive console only) makes it when it does not exist
 * yet; a requester passes `create: false` and gets a refusal instead. A key, or a key directory, that
 * is a symbolic link, is not this user's, or is open to other users is refused: an answer can then
 * not be authenticated, so none is accepted.
 */
export function loadConsoleKey({ create, env = process.env }: { create: boolean; env?: NodeJS.ProcessEnv }): ConsoleKey {
  const file = consoleKeyPath(env);
  const dir = path.dirname(file);
  try {
    let st: fs.Stats;
    try {
      st = fs.lstatSync(file);
    } catch (error) {
      if (errText(error) !== "ENOENT") throw error;
      if (!create) return { ok: false, why: `${file} does not exist yet: start the human console (it creates the key; a requester never does)`, file };
      createKey(file);
      st = fs.lstatSync(file);
    }
    const dirWhy = notPrivate(dir, fs.lstatSync(dir), "directory");
    if (dirWhy) return { ok: false, why: dirWhy, file };
    const fileWhy = notPrivate(file, st, "file");
    if (fileWhy) return { ok: false, why: fileWhy, file };
    const text = fs.readFileSync(file, "utf8");
    if (!KEY_RE.test(text)) return { ok: false, why: `${file} does not hold a key`, file };
    return { ok: true, key: Buffer.from(text.trim(), "hex"), file };
  } catch (error) {
    return { ok: false, why: `${file} cannot be used (${errText(error)})`, file };
  }
}

/** SHA-256 (hex) of the exact bytes of a pending request file. */
export function requestDigest(bytes: string | Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

/** The fields an answer's MAC covers. */
export type AnswerFields = { id: string; requestDigest: string; approved: boolean; answer: string | null; note: string | null };

function mac(key: Buffer, a: AnswerFields): string {
  return crypto.createHmac("sha256", key).update(JSON.stringify([DOMAIN, a.id, a.requestDigest, a.approved, a.answer, a.note])).digest("hex");
}

/** The resolved/<id>.json record for an answer: its fields plus their MAC. */
export function signedAnswer(key: Buffer, a: AnswerFields, extra: { decidedAt?: string } = {}): Record<string, unknown> {
  return { id: a.id, ...(extra.decidedAt === undefined ? {} : { decidedAt: extra.decidedAt }), approved: a.approved, answer: a.answer, note: a.note, requestDigest: a.requestDigest, mac: mac(key, a) };
}

export type VerifiedAnswer = { ok: true; approved: boolean; answer: string | null; note: string | null } | { ok: false; why: string };

const fieldOf = (value: unknown, key: string): unknown => (typeof value === "object" && value !== null && !Array.isArray(value) ? Reflect.get(value, key) : undefined);

/**
 * Check a resolved answer against the request this process filed. Only an answer whose MAC matches
 * the id, the digest of the pending bytes this process wrote and the decision is accepted.
 */
export function verifyAnswer(key: Buffer, expected: { id: string; requestDigest: string }, value: unknown): VerifiedAnswer {
  if (fieldOf(value, "id") !== expected.id) return { ok: false, why: "the answer names another request" };
  const digest = fieldOf(value, "requestDigest");
  if (typeof digest !== "string") return { ok: false, why: "the answer is not authenticated (no request digest)" };
  if (digest !== expected.requestDigest) return { ok: false, why: "the answer was made for a different or rewritten request" };
  const given = fieldOf(value, "mac");
  if (typeof given !== "string" || !MAC_RE.test(given)) return { ok: false, why: "the answer is not authenticated (no MAC)" };
  const rawAnswer = fieldOf(value, "answer");
  const rawNote = fieldOf(value, "note");
  const fields: AnswerFields = { id: expected.id, requestDigest: digest, approved: fieldOf(value, "approved") === true, answer: typeof rawAnswer === "string" ? rawAnswer : null, note: typeof rawNote === "string" ? rawNote : null };
  if (!crypto.timingSafeEqual(Buffer.from(given, "hex"), Buffer.from(mac(key, fields), "hex"))) return { ok: false, why: "the answer's MAC does not match" };
  return { ok: true, approved: fields.approved, answer: fields.answer, note: fields.note };
}
