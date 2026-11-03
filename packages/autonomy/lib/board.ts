// Host-owned steward assignments. This file is never mounted into a worker container.
import fs from "node:fs";
import path from "node:path";
import { parseJson } from "../../core/lib/guard.ts";
import { isPlainObject } from "./fsutil.ts";

export interface BoardItem {
  id: string;
  title: string;
  detail?: string;
  priority: "P0" | "P1" | "P2" | "P3";
  acceptance?: string;
  status?: "ready" | "in_progress" | "blocked";
}
export interface StewardBoard { stream?: string; items: BoardItem[] }
export interface BoardReport { id: string; status: "done" | "progress" | "blocked"; note: string }

export const WORK_PRECEDENCE = "(0) red gate / broken branch, (1) upstream merge conflict, (2) these board items in order, (3) HANDOFF carry-overs, (4) defects you find, (5) security, (6) tests/docs, (7) cleanup";
const ID = /^[A-Z]+-[0-9]{1,4}$/;
// Fits all 50 maximum-sized items even when JSON escapes every text character.
const MAX_BYTES = 2 * 1024 * 1024;

function keys(o: Record<string, unknown>, allowed: readonly string[]): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw new Error(`unknown board key: ${k}`);
}
function bounded(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${name} must be a non-empty string of at most ${max} characters`);
  return value;
}
export function validateBoard(raw: unknown): StewardBoard {
  if (!isPlainObject(raw)) throw new Error("board must be an object");
  keys(raw, ["stream", "items"]);
  if (!Array.isArray(raw.items) || raw.items.length > 50) throw new Error("board.items must be an array of at most 50 items");
  const seen = new Set<string>();
  const items: BoardItem[] = raw.items.map((item: unknown) => {
    if (!isPlainObject(item)) throw new Error("board item must be an object");
    keys(item, ["id", "title", "detail", "priority", "acceptance", "status"]);
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
    return result;
  });
  return { ...(raw.stream !== undefined ? { stream: bounded(raw.stream, "stream", 200) } : {}), items };
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

export function boardPrompt(board: StewardBoard, proposals = "autonomy/BACKLOG.md"): string {
  return `\n\n## Assigned work (steward board)\n${assignedItems(board).map((i) => `- ${i.id} [${i.priority}] ${i.title}\n  ${i.detail ?? ""}\n  Acceptance: ${i.acceptance ?? "Demonstrate the item with tests and evidence."}`).join("\n") || "(No assigned items.)"}\n\nPrecedence: ${WORK_PRECEDENCE}.\nOwn new ideas go into ${proposals} as proposals, not into this cycle, unless they block the assigned item.${board.items.length ? "\nPut one line per item worked on in report.md: `Board: <ID> done|progress|blocked - <one sentence>`." : ""}`;
}
