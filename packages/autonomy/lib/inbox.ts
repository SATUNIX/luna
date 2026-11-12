// Owner decision cards for a self-improve run. Recording only: settling a card never starts,
// pauses, steers or otherwise controls the run. A card's outcome unblocks its linked board item.
import fs from "node:fs";
import path from "node:path";
import { parseJson } from "../../core/lib/guard.ts";
import { isIsoTimestamp, type StewardBoard } from "./board.ts";
import { clone, isPlainObject, writeJsonAtomic } from "./fsutil.ts";

export interface InboxOutcome {
  at: string;
  via: "answer" | "deadline";
  text: string;
}
export interface InboxCard {
  id: string;
  question: string;
  default: string;
  deadline: string;
  board?: string;
  answer?: string;
  outcome?: InboxOutcome;
}
export interface Inbox { cards: InboxCard[] }

const CARD_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const BOARD_ID = /^[A-Z]+-[0-9]{1,4}$/;
// Fits all 50 maximum-sized cards even when JSON escapes every text character.
const MAX_BYTES = 2 * 1024 * 1024;

function keys(o: Record<string, unknown>, allowed: readonly string[]): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw new Error(`unknown inbox key: ${k}`);
}
function bounded(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${name} must be a non-empty string of at most ${max} characters`);
  return value;
}
function outcome(value: unknown): InboxOutcome {
  if (!isPlainObject(value)) throw new Error("outcome must be an object");
  keys(value, ["at", "via", "text"]);
  if (value.via !== "answer" && value.via !== "deadline") throw new Error("outcome.via must be answer or deadline");
  return { at: bounded(value.at, "outcome.at", 200), via: value.via, text: bounded(value.text, "outcome.text", 2000) };
}
export function validateInbox(raw: unknown, uploaded = false): Inbox {
  if (!isPlainObject(raw)) throw new Error("inbox must be an object");
  keys(raw, ["cards"]);
  if (!Array.isArray(raw.cards) || raw.cards.length > 50) throw new Error("inbox.cards must be an array of at most 50 cards");
  const seen = new Set<string>();
  const cards: InboxCard[] = raw.cards.map((card: unknown) => {
    if (!isPlainObject(card)) throw new Error("inbox card must be an object");
    keys(card, ["id", "question", "default", "deadline", "board", "answer", "outcome"]);
    const id = bounded(card.id, "id", 64);
    if (!CARD_ID.test(id) || seen.has(id)) throw new Error(`invalid or duplicate card id: ${id}`);
    seen.add(id);
    const deadline = bounded(card.deadline, "deadline", 200);
    // A deadline needs an explicit offset so it means the same instant on every host.
    if (!isIsoTimestamp(deadline)) throw new Error(`deadline is not an ISO timestamp with an offset: ${deadline}`);
    const result: InboxCard = {
      id,
      question: bounded(card.question, "question", 500),
      default: bounded(card.default, "default", 2000),
      deadline,
    };
    if (card.board !== undefined) {
      const board = bounded(card.board, "board", 64);
      if (!BOARD_ID.test(board)) throw new Error(`invalid board id: ${board}`);
      result.board = board;
    }
    // An uploaded file proposes cards; only the owner, a deadline or an existing host file records a decision.
    if (uploaded && card.answer !== undefined) throw new Error(`card ${id} cannot carry an answer in an uploaded file`);
    if (uploaded && card.outcome !== undefined) throw new Error(`card ${id} cannot carry an outcome in an uploaded file`);
    if (card.answer !== undefined) result.answer = bounded(card.answer, "answer", 2000);
    if (card.outcome !== undefined) result.outcome = outcome(card.outcome);
    return result;
  });
  return { cards };
}

/** Missing inboxes are compatible with existing runs; malformed inboxes are never silently ignored. */
export function readInboxFile(file: string, uploaded = false): Inbox {
  // One descriptor for the size check and the read, so the file cannot change in between.
  const fd = fs.openSync(file, "r");
  try {
    if (fs.fstatSync(fd).size > MAX_BYTES) throw new Error("inbox file exceeds 2 MiB");
    return validateInbox(parseJson(fs.readFileSync(fd, "utf8")), uploaded);
  } finally {
    fs.closeSync(fd);
  }
}
export function readInbox(control: string): Inbox {
  const file = path.join(control, "inbox.json");
  return fs.existsSync(file) ? readInboxFile(file) : { cards: [] };
}
export function writeInbox(control: string, inbox: Inbox): void {
  writeJsonAtomic(path.join(control, "inbox.json"), inbox, { mode: 0o600 });
}

/**
 * Record an answer or a passed deadline on every card that has no outcome yet. A card that already
 * has an outcome is never changed. Only the cards decided in this call are returned in `decided`.
 */
export function settleInbox(inbox: Inbox, now: Date): { inbox: Inbox; decided: InboxCard[] } {
  const settled = clone(inbox);
  const decided: InboxCard[] = [];
  const at = now.toISOString();
  for (const card of settled.cards) {
    if (card.outcome) continue;
    if (card.answer !== undefined) card.outcome = { at, via: "answer", text: card.answer };
    else if (Date.parse(card.deadline) <= now.getTime()) card.outcome = { at, via: "deadline", text: card.default };
    else continue;
    decided.push(card);
  }
  return { inbox: settled, decided };
}

/** Unblock the board item linked to every card that has an outcome; other statuses stay as they are. */
export function applyOutcomes(board: StewardBoard, inbox: Inbox): { board: StewardBoard; unblocked: string[] } {
  const next = clone(board);
  const unblocked: string[] = [];
  const seen = new Set<string>();
  for (const card of inbox.cards) {
    if (!card.outcome || !card.board || seen.has(card.board)) continue;
    const item = next.items.find((i) => i.id === card.board);
    if (item?.status !== "blocked") continue;
    item.status = "ready";
    seen.add(card.board);
    unblocked.push(card.board);
  }
  return { board: next, unblocked };
}
