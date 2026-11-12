// Host-owned steward assignments. This file is never mounted into a worker container.
import fs from "node:fs";
import path from "node:path";
import { parseJson } from "../../core/lib/guard.ts";
import { isPlainObject } from "./fsutil.ts";

export type BoardVerdict = "pending" | "approved" | "rejected";

/** Every key a board item may carry; a board file with any other key is rejected. */
export const ITEM_KEYS = [
  "id", "title", "detail", "priority", "acceptance", "status", "assignee", "claimedAt", "submittedAt", "sha", "rounds", "verdict", "verdictBy", "findings",
] as const;

export interface BoardItem {
  id: string;
  title: string;
  detail?: string;
  priority: "P0" | "P1" | "P2" | "P3";
  acceptance?: string;
  status?: "ready" | "in_progress" | "blocked";
  /** The worker that claimed the item; absent when it is unowned. */
  assignee?: string;
  /** When the item was claimed, ISO 8601. Rewritten only when a new owner wins the claim. */
  claimedAt?: string;
  /** When the owner submitted its work, ISO 8601. */
  submittedAt?: string;
  /** The 40-character lowercase commit the submission points at. */
  sha?: string;
  /** Review rounds used so far. */
  rounds?: number;
  verdict?: BoardVerdict;
  /** Who last judged the submission (non-empty, at most 200 characters). */
  verdictBy?: string;
  findings?: string[];
}
export interface StewardBoard { stream?: string; items: BoardItem[] }
export interface BoardReport { id: string; status: "done" | "progress" | "blocked"; note: string }

/** The stable result of a claim attempt. The board is unchanged for `already` and `loser`. */
export interface ClaimBoardResult {
  outcome: "winner" | "already" | "loser";
  /** The item as it is after the attempt (for a winner, with assignee, claimedAt and in_progress). */
  item: BoardItem;
  board: StewardBoard;
}

export const WORK_PRECEDENCE = "(0) red gate / broken branch, (1) upstream merge conflict, (2) these board items in order, (3) HANDOFF carry-overs, (4) defects you find, (5) security, (6) tests/docs, (7) cleanup";
const ID = /^[A-Z]+-[0-9]{1,4}$/;
const SHA = /^[0-9a-f]{40}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
/** A strict ISO-8601 timestamp: date, time and `Z` or an explicit numeric offset. */
export function isIsoTimestamp(value: unknown): boolean {
  return typeof value === "string" && ISO_TIMESTAMP.test(value) && !Number.isNaN(Date.parse(value));
}
const PRIORITY_ORDER: Readonly<Record<BoardItem["priority"], number>> = { P0: 0, P1: 1, P2: 2, P3: 3 };
// Fits all 50 maximum-sized items even when JSON escapes every text character.
const MAX_BYTES = 2 * 1024 * 1024;

function keys(o: Record<string, unknown>, allowed: readonly string[]): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw new Error(`unknown board key: ${k}`);
}
function bounded(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${name} must be a non-empty string of at most ${max} characters`);
  return value;
}
function timestamp(value: unknown, name: string): string {
  if (typeof value !== "string" || !isIsoTimestamp(value)) throw new Error(`${name} must be an ISO timestamp`);
  return value;
}
function rounds(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 1000) throw new Error("rounds must be an integer from 0 to 1000");
  return value;
}
function findings(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 10) throw new Error("findings must be an array of at most 10 strings");
  return value.map((entry, index) => bounded(entry, `findings[${index}]`, 1000));
}
export function validateBoard(raw: unknown): StewardBoard {
  if (!isPlainObject(raw)) throw new Error("board must be an object");
  keys(raw, ["stream", "items"]);
  if (!Array.isArray(raw.items) || raw.items.length > 50) throw new Error("board.items must be an array of at most 50 items");
  const seen = new Set<string>();
  const items: BoardItem[] = raw.items.map((item: unknown) => {
    if (!isPlainObject(item)) throw new Error("board item must be an object");
    keys(item, ITEM_KEYS);
    const id = bounded(item.id, "id", 64);
    if (!ID.test(id) || seen.has(id)) throw new Error(`invalid or duplicate board id: ${id}`);
    seen.add(id);
    const priority = item.priority;
    if (priority !== "P0" && priority !== "P1" && priority !== "P2" && priority !== "P3") throw new Error("priority must be P0, P1, P2 or P3");
    const result: BoardItem = { id, title: bounded(item.title, "title", 200), priority };
    if (item.detail !== undefined) result.detail = bounded(item.detail, "detail", 2000);
    if (item.acceptance !== undefined) result.acceptance = bounded(item.acceptance, "acceptance", 2000);
    if (item.status !== undefined) {
      if (item.status !== "ready" && item.status !== "in_progress" && item.status !== "blocked") throw new Error("status must be ready, in_progress or blocked");
      result.status = item.status;
    }
    // The claim metadata is validated in place, never defaulted: an old board keeps exactly the
    // fields it carried, and a board file that omits them round-trips unchanged.
    if (item.assignee !== undefined) result.assignee = bounded(item.assignee, "assignee", 200);
    if (item.claimedAt !== undefined) result.claimedAt = timestamp(item.claimedAt, "claimedAt");
    if (item.submittedAt !== undefined) result.submittedAt = timestamp(item.submittedAt, "submittedAt");
    if (item.sha !== undefined) {
      if (typeof item.sha !== "string" || !SHA.test(item.sha)) throw new Error("sha must be 40 lowercase hexadecimal characters");
      result.sha = item.sha;
    }
    if (item.rounds !== undefined) result.rounds = rounds(item.rounds);
    if (item.verdict !== undefined) {
      if (item.verdict !== "pending" && item.verdict !== "approved" && item.verdict !== "rejected") throw new Error("verdict must be pending, approved or rejected");
      result.verdict = item.verdict;
    }
    if (item.verdictBy !== undefined) result.verdictBy = bounded(item.verdictBy, "verdictBy", 200);
    if (item.findings !== undefined) result.findings = findings(item.findings);
    return result;
  });
  return { ...(raw.stream !== undefined ? { stream: bounded(raw.stream, "stream", 200) } : {}), items };
}

/**
 * Claim one item without touching the filesystem. Missing, blocked and approved items are refused;
 * an item already owned by the same agent is idempotent (`already`, no timestamp rewrite), and one
 * owned by anybody else is a `loser` that carries the current owner. Pure.
 */
export function claimBoardItem(board: StewardBoard, id: string, by: string, at: string): ClaimBoardResult {
  const owner = bounded(by, "claimant", 200);
  const claimedAt = timestamp(at, "claimedAt");
  const item = board.items.find((candidate) => candidate.id === id);
  if (!item) throw new Error(`board item ${id} is not on the board`);
  if (item.status === "blocked") throw new Error(`board item ${id} is blocked`);
  // A ready item is the only claimable state: an ownerless in_progress item is a stale claim, and
  // silently re-claiming it would hide that from the steward.
  if (item.status === "in_progress" && item.assignee === undefined) throw new Error(`board item ${id} is already in progress`);
  if (item.verdict === "approved") throw new Error(`board item ${id} is already approved`);
  if (item.assignee !== undefined) {
    return { outcome: item.assignee === owner ? "already" : "loser", item, board };
  }
  const claimed: BoardItem = { ...item, assignee: owner, claimedAt, status: "in_progress" };
  return { outcome: "winner", item: claimed, board: { ...board, items: board.items.map((candidate) => (candidate.id === id ? claimed : candidate)) } };
}

/**
 * The next item dispatch may claim: a ready, unowned item that is not approved, chosen by the
 * board's priority order (P0 first, file order for ties) with the optional stream filter. With an
 * owner, the returned item is the claimed item; the board is not mutated.
 */
export function claimNextItem(board: StewardBoard, ownerName?: string, streams?: readonly string[], at = new Date().toISOString()): BoardItem | null {
  if (streams?.length && board.stream !== undefined && !streams.includes(board.stream)) return null;
  const candidate = board.items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => (item.status ?? "ready") === "ready" && item.assignee === undefined && item.verdict !== "approved")
    .sort((a, b) => PRIORITY_ORDER[a.item.priority] - PRIORITY_ORDER[b.item.priority] || a.index - b.index)[0]?.item;
  if (!candidate) return null;
  return ownerName === undefined ? candidate : claimBoardItem(board, candidate.id, ownerName, at).item;
}

/** Missing boards are compatible with existing runs; malformed boards are never silently ignored. */
export function readBoardFile(file: string): StewardBoard {
  // One descriptor for the size check and the read, so the file cannot change in between.
  const fd = fs.openSync(file, "r");
  try {
    if (fs.fstatSync(fd).size > MAX_BYTES) throw new Error("board file exceeds 2 MiB");
    return validateBoard(parseJson(fs.readFileSync(fd, "utf8")));
  } finally {
    fs.closeSync(fd);
  }
}
export function readBoard(control: string): StewardBoard {
  const file = path.join(control, "board.json");
  return fs.existsSync(file) ? readBoardFile(file) : { items: [] };
}
export const assignedItems = (board: StewardBoard): BoardItem[] => board.items.filter((i) => i.status !== "blocked").sort((a, b) => a.priority.localeCompare(b.priority)).slice(0, 2);

/** Only exact, bounded Board: lines count; prose and malformed claims are ignored. */
export function parseBoardReport(report: string | null): BoardReport[] {
  const out: BoardReport[] = [];
  const seen = new Set<string>();
  for (const line of (report ?? "").split(/\r?\n/)) {
    if (line.length > 600) continue;
    const match = /^Board: ([A-Z]+-[0-9]{1,4}) (done|progress|blocked) - (\S[^\r\n]{0,499})$/.exec(line);
    const [, id, status, note] = match ?? [];
    if (!id || id.length > 64 || !note || (status !== "done" && status !== "progress" && status !== "blocked") || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, status, note });
    if (out.length === 50) break;
  }
  return out;
}

/**
 * The assigned items as the cycle prompt shows them (prompts/cycle.md {{BOARD}}, right after the
 * budget). The precedence and the own-ideas rule are stated once in the prompt itself.
 */
export function boardPrompt(board: StewardBoard): string {
  return `\n\n## Assigned work (steward board)\n${assignedItems(board).map((i) => `- ${i.id} [${i.priority}] ${i.title}\n  ${i.detail ?? ""}\n  Acceptance: ${i.acceptance ?? "Demonstrate the item with tests and evidence."}`).join("\n") || "(No assigned items.)"}${board.items.length ? "\nPut one line per item worked on in report.md: `Board: <ID> done|progress|blocked - <one sentence>`." : ""}`;
}
