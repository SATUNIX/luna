// The host side of the `dispatch` template (lib/templates/dispatch.ts): a self-improve run whose
// per-cycle work is the ONE steward-board item the cycle claims for its engineer. This module holds
// the contract option (templateOptions.dispatch), the claim a cycle makes under control/board.lock,
// the empty-queue test and the submission a merged, done cycle records. The board file stays
// host-owned: nothing here is mounted into a worker. Pinned by tests/autonomy-dispatch-smoke.ts.
import path from "node:path";
import { type ItemAttempts, withoutWithheld } from "./attempts.ts";
import { type BoardItem, type StewardBoard, claimBoardItem, claimNextItem, readBoard, withBoardLock } from "./board.ts";
import type { ProblemSink } from "./contract.ts";
import { isPlainObject, writeJsonAtomic } from "./fsutil.ts";

/** templateOptions.dispatch: which board streams the run works, and the engineers its cycles claim as. */
export interface DispatchOptions {
  streams: string[];
  engineers: string[];
}

const STREAM = /^[a-z0-9][a-z0-9._-]{0,63}$/;
// Conservative agent names: they become a board item's `assignee` and appear in the worker's prompt.
const ENGINEER = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/;
const MAX_NAMES = 20;

/** A list of 1..20 distinct names matching `re`, or the problem with it. */
function nameList(value: unknown, re: RegExp, what: string): string[] | string {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_NAMES) return `must be an array of 1 to ${MAX_NAMES} ${what}`;
  const names: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !re.test(entry)) return `each entry must match ${re.source}`;
    if (names.includes(entry)) return `"${entry}" is listed twice`;
    names.push(entry);
  }
  return names;
}

/** Check templateOptions.dispatch, reporting into the resolver's problems. */
export function validateDispatchOptions(templateOptions: Readonly<Record<string, unknown>>, { err }: Pick<ProblemSink, "err">): void {
  const d = templateOptions["dispatch"];
  if (!isPlainObject(d)) { err("templateOptions.dispatch", "the dispatch template needs { \"streams\": [...], \"engineers\": [...] }: the board streams it works and the engineers its cycles claim items as"); return; }
  for (const key of Object.keys(d)) if (key !== "streams" && key !== "engineers") err(`templateOptions.dispatch.${key}`, "unknown key");
  const streams = nameList(d["streams"], STREAM, "stream names");
  if (typeof streams === "string") err("templateOptions.dispatch.streams", streams);
  const engineers = nameList(d["engineers"], ENGINEER, "distinct engineer (agent) names");
  if (typeof engineers === "string") err("templateOptions.dispatch.engineers", engineers);
}

/** The run's dispatch options, or null for a contract that is not a valid dispatch contract. */
export function dispatchOptions(contract: { readonly template: string; readonly templateOptions: Readonly<Record<string, unknown>> }): DispatchOptions | null {
  if (contract.template !== "dispatch") return null;
  const d = contract.templateOptions["dispatch"];
  if (!isPlainObject(d)) return null;
  const streams = nameList(d["streams"], STREAM, "streams");
  const engineers = nameList(d["engineers"], ENGINEER, "engineers");
  return typeof streams === "string" || typeof engineers === "string" ? null : { streams, engineers };
}

/** The engineer cycle `n` (1-based) claims as first: the engineers in turn. */
export function cycleEngineer(options: DispatchOptions, n: number): string {
  return options.engineers[(n - 1) % options.engineers.length] ?? options.engineers[0] ?? "";
}

/** The run's engineers in the order cycle `n` offers them work: its own engineer first, then the rest in turn. */
export function cycleRotation(options: DispatchOptions, n: number): string[] {
  const start = (n - 1) % options.engineers.length;
  return [...options.engineers.slice(start), ...options.engineers.slice(0, start)];
}

/** An item the engineer claimed and has not yet submitted: the cycle continues it rather than claiming another. */
const isOpenClaim = (item: BoardItem, engineer: string): boolean =>
  item.status === "in_progress" && item.assignee === engineer && item.submittedAt === undefined && item.verdict !== "approved";

/**
 * The board names no stream, or one that is not among the run's streams: nothing on it is this
 * run's. A dispatch run is authorised for its streams, so a board without a stream offers nothing.
 */
const offStream = (board: StewardBoard, streams: readonly string[]): boolean => board.stream === undefined || !streams.includes(board.stream);

/**
 * The item this engineer works next, without writing: its open claim, else the top claimable item
 * (lib/board.ts claimNextItem), skipping items the host withheld (lib/attempts.ts). Pure.
 */
export function dispatchCandidate(board: StewardBoard, options: DispatchOptions, engineer: string, attempts: ItemAttempts | undefined): { item: BoardItem; open: boolean } | null {
  if (offStream(board, options.streams)) return null;
  const offered = withoutWithheld(board, attempts);
  const open = offered.items.find((item) => isOpenClaim(item, engineer));
  if (open) return { item: open, open: true };
  const next = claimNextItem(offered, undefined, options.streams);
  return next ? { item: next, open: false } : null;
}

/** A cycle's board snapshot: the one item it works, with the board's stream. */
const snapshot = (board: StewardBoard, items: BoardItem[]): StewardBoard => ({ ...(board.stream !== undefined ? { stream: board.stream } : {}), items });

export interface CycleClaim {
  /** The cycle's board snapshot: one item, or none when nothing is claimable. */
  board: StewardBoard;
  outcome: "claimed" | "continued" | "none";
  /** The engineer the cycle works as: the one whose claim it continues or makes (the first offered when none). */
  engineer: string;
}

/**
 * Claim the cycle's item under control/board.lock. The engineers are offered work in the given
 * order (cycleRotation): the first one that holds an open claim or can claim the top ready item of
 * the run's streams wins the cycle, so an engineer whose turn finds nothing never stalls another
 * engineer's unfinished claim. A new claim sets assignee, claimedAt and in_progress in one atomic
 * write of control/board.json.
 */
export async function claimForCycle(control: string, { options, engineers, attempts, at }: { options: DispatchOptions; engineers: readonly string[]; attempts: ItemAttempts | undefined; at: string }): Promise<CycleClaim> {
  const first = engineers[0] ?? "";
  return withBoardLock(control, () => {
    const board = readBoard(control);
    for (const engineer of engineers) {
      const candidate = dispatchCandidate(board, options, engineer, attempts);
      if (!candidate) continue;
      if (candidate.open) return { board: snapshot(board, [candidate.item]), outcome: "continued", engineer };
      const result = claimBoardItem(board, candidate.item.id, engineer, at);
      if (result.outcome !== "winner") continue;
      writeJsonAtomic(path.join(control, "board.json"), result.board, { mode: 0o600 });
      return { board: snapshot(result.board, [result.item]), outcome: "claimed", engineer };
    }
    return { board: snapshot(board, []), outcome: "none", engineer: first };
  });
}

/**
 * Record a merged, done item's submission: `submittedAt` and the integration head `sha`, under the
 * board lock, so the next cycle does not continue it. Nothing else on the item changes (the review
 * verdict is a later step). Returns why nothing was written, or null when it was.
 */
export async function recordSubmission(control: string, { id, engineer, sha, at }: { id: string; engineer: string; sha: string; at: string }): Promise<string | null> {
  if (!/^[0-9a-f]{40}$/.test(sha)) return `integration head ${sha.slice(0, 64)} is not a 40-character commit`;
  return withBoardLock(control, () => {
    const board = readBoard(control);
    const item = board.items.find((candidate) => candidate.id === id);
    if (!item) return `board item ${id} is no longer on the board`;
    if (item.assignee !== engineer) return `board item ${id} is now assigned to ${item.assignee ?? "nobody"}, not ${engineer}`;
    if (item.submittedAt !== undefined) return `board item ${id} was already submitted at ${item.submittedAt}`;
    const submitted: BoardItem = { ...item, submittedAt: at, sha };
    writeJsonAtomic(path.join(control, "board.json"), { ...board, items: board.items.map((candidate) => (candidate.id === id ? submitted : candidate)) }, { mode: 0o600 });
    return null;
  });
}

/** A submission whose integration commit was rewritten (`to`) or is no longer on the integration branch (`to: null`). */
export interface RevisedSubmission { id: string; from: string; to: string | null }

/**
 * Re-check the submissions the run's engineers recorded after the host rewrote or discarded
 * integration history: `revise` maps a recorded sha to the commit it now is, or null when that
 * work is no longer on the integration branch. A null clears `submittedAt` and `sha`, so the item
 * is an open claim again and its engineer redoes it; a new commit replaces the sha. One locked
 * write, only when something changed.
 */
export async function reviseSubmissions(control: string, engineers: readonly string[], revise: (sha: string) => string | null): Promise<RevisedSubmission[]> {
  return withBoardLock(control, () => {
    const board = readBoard(control);
    const revised: RevisedSubmission[] = [];
    const items = board.items.map((item): BoardItem => {
      if (item.sha === undefined || item.assignee === undefined || !engineers.includes(item.assignee)) return item;
      const to = revise(item.sha);
      if (to === item.sha) return item;
      revised.push({ id: item.id, from: item.sha, to });
      if (to !== null && /^[0-9a-f]{40}$/.test(to)) return { ...item, sha: to };
      const reopened: BoardItem = { ...item };
      delete reopened.submittedAt;
      delete reopened.sha;
      return reopened;
    });
    if (revised.length) writeJsonAtomic(path.join(control, "board.json"), { ...board, items }, { mode: 0o600 });
    return revised;
  });
}

/**
 * The claimed item as the cycle prompt shows it (prompts/cycle.md {{BOARD}}). The heading keeps
 * "Assigned work", which the rest of the prompt refers to.
 */
export function dispatchBoardPrompt(board: StewardBoard, engineer: string, options: DispatchOptions): string {
  const item = board.items[0];
  const stream = board.stream ?? options.streams.join(", ");
  if (!item) return `\n\n## Assigned work (dispatch)\nNo board item of stream ${stream} could be claimed for ${engineer} this cycle; there is no board work. Do only the host work named in this prompt.`;
  return `\n\n## Assigned work (dispatch: one claimed item)\nThis is the ONE board item claimed for this cycle by ${engineer} (stream ${stream}). Work on it and on nothing else from the board.\n- ${item.id} [${item.priority}] ${item.title}\n  ${item.detail ?? ""}\n  Acceptance: ${item.acceptance ?? "Demonstrate the item with tests and evidence."}\nPut one line for it in your cycle note: \`Board: ${item.id} done|progress|blocked - <one sentence>\`. Report \`done\` only when the acceptance above is met.`;
}
