/**
 * Agent mailboxes: agents on this machine leave each other short messages, one inbox per agent id.
 *
 *   <state dir>/luna/mailbox/<recipient id>/<ms>-<random>.json     beside the agent-state files
 *                                                                  (override with LUNA_MAILBOX_DIR)
 *
 * A message is data, never an instruction, an approval or a grant: whoever reads one decides what to do
 * with it, as with any other text an agent receives. The library keeps the files honest and small:
 *   - the sender and the reader are checked against their agent-state record (`agent-state.ts`): the
 *     record must exist for the id, be a regular file and name the calling process's pid, so one agent
 *     cannot send as, or read the inbox of, another agent that is registered on this machine;
 *   - the recipient must have an agent-state record (no inbox for an agent that never existed);
 *   - subject and body pass through the kit's redaction table (`redact.ts`) before they are stored;
 *   - a message is created exclusively (O_CREAT|O_EXCL|O_NOFOLLOW) with mode 0600 in a 0700 inbox; a
 *     symbolic link at the mailbox root, an inbox or a message is refused, never followed;
 *   - size caps: BODY_MAX characters of body, INBOX_MAX_MESSAGES and INBOX_MAX_BYTES per inbox, and a
 *     message file larger than MESSAGE_MAX_BYTES is skipped on read.
 * Not covered: every agent runs as the same user, who can write any of these files directly, so the pid
 * check stops one agent process from impersonating another through this library, not a determined
 * process of the same user; nothing is signed or encrypted. tests/agent-mailbox-smoke.ts pins each rule.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { agentStateDir, oneLine, parseAgentState, safeAgentId } from "./agent-state.ts";
import { redactSecrets } from "./redact.ts";
import { createFileExclusive, ensureDirSafe, UnsafePathError } from "./safe-fs.ts";

export const MAILBOX_SCHEMA = 1;
export const SUBJECT_MAX = 160;
export const BODY_MAX = 8000;
export const MESSAGE_MAX_BYTES = 64 * 1024;
export const INBOX_MAX_MESSAGES = 100;
export const INBOX_MAX_BYTES = 512 * 1024;

export interface MailMessage {
  schema: typeof MAILBOX_SCHEMA;
  /** The file name without `.json`: sortable by send time. */
  id: string;
  from: string;
  to: string;
  /** ISO 8601 send time. */
  at: string;
  subject: string;
  body: string;
  /** The id of the message this one answers, when it is a reply. */
  replyTo?: string | undefined;
  /** How many secret shapes redaction replaced in subject and body. */
  redacted: number;
}

export type MailResult<T> = { ok: true; value: T } | { ok: false; reason: string };

/** The mailbox root: a sibling of the agent-state directory, unless LUNA_MAILBOX_DIR names one. */
export function mailboxDir(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  const override = env.LUNA_MAILBOX_DIR?.trim();
  if (override) return path.resolve(override);
  return path.join(path.dirname(agentStateDir(env, home)), "mailbox");
}

export interface MailboxPaths {
  /** The mailbox root (mailboxDir()). */
  dir: string;
  /** The agent-state directory identities are checked against (agentStateDir()). */
  stateDir: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;

function lstatOrNull(p: string): fs.Stats | null {
  try { return fs.lstatSync(p); } catch { return null; }
}

/** An id exactly as safeAgentId would write it; anything else is refused, not silently rewritten. */
function validId(id: string): boolean {
  return id.length > 0 && safeAgentId(id) === id;
}

/** Null when `id`'s agent-state record names `pid`, else why not. */
export function identityProblem(stateDir: string, id: string, pid: number): string | null {
  if (!validId(id)) return `"${oneLine(id, 80)}" is not an agent id`;
  const file = path.join(stateDir, `${id}.json`);
  const st = lstatOrNull(file);
  if (!st) return `no agent-state record for ${id}`;
  if (!st.isFile()) return `the agent-state record for ${id} is not a regular file`;
  let record: unknown;
  try { record = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return `the agent-state record for ${id} is unreadable`; }
  const state = parseAgentState(record);
  if (state?.id !== id) return `the agent-state record for ${id} is not valid`;
  if (state.pid !== pid) return `process ${String(pid)} is not agent ${id} (its record names process ${String(state.pid)})`;
  return null;
}

/** The mailbox root, refused when it (or the inbox under it) is a symbolic link or not a directory. */
function inboxOf(dir: string, id: string, create: boolean): string {
  const root = path.resolve(dir);
  const st = lstatOrNull(root);
  if (st && !st.isDirectory()) throw new UnsafePathError(root, st.isSymbolicLink() ? "the mailbox root is a symbolic link" : "the mailbox root is not a directory");
  const inbox = path.join(root, id);
  if (create) ensureDirSafe(inbox, { root, dirMode: 0o700 });
  else {
    const ist = lstatOrNull(inbox);
    if (ist && !ist.isDirectory()) throw new UnsafePathError(inbox, ist.isSymbolicLink() ? "the inbox is a symbolic link" : "the inbox is not a directory");
  }
  return inbox;
}

const messageFiles = (inbox: string): string[] => {
  try { return fs.readdirSync(inbox).filter((n) => /^\d{13}-[0-9a-f]{12}\.json$/.test(n)).sort(); } catch { return []; }
};

export interface SendInput {
  from: string;
  to: string;
  subject: string;
  body: string;
  replyTo?: string | undefined;
  /** The calling process (defaults to this one); it must be the sender's agent-state pid. */
  pid?: number;
  now?: Date;
}

/** Send one message. Never throws: a refusal is a result with the reason. */
export function sendMessage(paths: MailboxPaths, input: SendInput): MailResult<MailMessage> {
  try {
    const sender = identityProblem(paths.stateDir, input.from, input.pid ?? process.pid);
    if (sender) return { ok: false, reason: `sender refused: ${sender}` };
    if (!validId(input.to)) return { ok: false, reason: `"${oneLine(input.to, 80)}" is not an agent id` };
    if (!lstatOrNull(path.join(paths.stateDir, `${input.to}.json`))?.isFile()) return { ok: false, reason: `no agent ${input.to} on this machine` };
    if (input.body.length > BODY_MAX) return { ok: false, reason: `the body is ${String(input.body.length)} characters; the limit is ${String(BODY_MAX)}` };
    const subject = redactSecrets(oneLine(input.subject, SUBJECT_MAX));
    const body = redactSecrets(input.body.replace(/[^\P{Cc}\n\t]/gu, " "));
    const replyTo = input.replyTo !== undefined && /^\d{13}-[0-9a-f]{12}$/.test(input.replyTo) ? input.replyTo : undefined;
    const inbox = inboxOf(paths.dir, input.to, true);
    const existing = messageFiles(inbox);
    const used = existing.reduce((n, f) => n + (lstatOrNull(path.join(inbox, f))?.size ?? 0), 0);
    const now = input.now ?? new Date();
    const id = `${String(now.getTime()).padStart(13, "0")}-${crypto.randomBytes(6).toString("hex")}`;
    const message: MailMessage = { schema: MAILBOX_SCHEMA, id, from: input.from, to: input.to, at: now.toISOString(), subject: subject.text, body: body.text, ...(replyTo ? { replyTo } : {}), redacted: subject.count + body.count };
    const text = `${JSON.stringify(message)}\n`;
    if (existing.length >= INBOX_MAX_MESSAGES || used + Buffer.byteLength(text) > INBOX_MAX_BYTES) return { ok: false, reason: `the inbox of ${input.to} is full` };
    if (!createFileExclusive(path.join(inbox, `${id}.json`), text, { root: path.resolve(paths.dir), mode: 0o600, dirMode: 0o700 })) return { ok: false, reason: "a message with that name already exists" };
    return { ok: true, value: message };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** A stored message read back without following links, or null when the file is not one. */
function readMessage(file: string, owner: string): MailMessage | null {
  let fd: number;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | O_NOFOLLOW); } catch { return null; }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || st.size > MESSAGE_MAX_BYTES) return null;
    if (typeof process.getuid === "function" && st.uid !== process.getuid()) return null;
    const raw: unknown = JSON.parse(fs.readFileSync(fd, "utf8"));
    if (!isRecord(raw) || raw.schema !== MAILBOX_SCHEMA || raw.to !== owner) return null;
    const { id, from, at, subject, body, redacted } = raw;
    if (typeof id !== "string" || typeof from !== "string" || !validId(from) || typeof at !== "string" || typeof subject !== "string" || typeof body !== "string") return null;
    if (`${id}.json` !== path.basename(file)) return null;
    return { schema: MAILBOX_SCHEMA, id, from, to: owner, at, subject: oneLine(subject, SUBJECT_MAX), body: body.slice(0, BODY_MAX),
      ...(typeof raw.replyTo === "string" ? { replyTo: raw.replyTo } : {}), redacted: typeof redacted === "number" ? redacted : 0 };
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

export interface ReceiveInput {
  /** The reader; it must be the calling process's agent. */
  id: string;
  pid?: number;
  /** Delete each message once read. */
  consume?: boolean;
}

/** The reader's messages, oldest first, and how many files were skipped as not messages. */
export function receiveMessages(paths: MailboxPaths, input: ReceiveInput): MailResult<{ messages: MailMessage[]; skipped: number }> {
  try {
    const reader = identityProblem(paths.stateDir, input.id, input.pid ?? process.pid);
    if (reader) return { ok: false, reason: `reader refused: ${reader}` };
    const inbox = inboxOf(paths.dir, input.id, false);
    const messages: MailMessage[] = [];
    let skipped = 0;
    for (const name of messageFiles(inbox)) {
      const file = path.join(inbox, name);
      const message = readMessage(file, input.id);
      if (!message) { skipped++; continue; }
      messages.push(message);
      if (input.consume) fs.rmSync(file, { force: true });
    }
    return { ok: true, value: { messages, skipped } };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
