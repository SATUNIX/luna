// The empty-queue test. When nothing is assigned, nothing is failing and nothing is carried
// over, the host sleeps: no worker session, manager call or review is started to go looking for
// work. The worker brief (prompts/cycle.md) forbids scouting for the same reason; this is the
// host side of it, so an idle run costs nothing. tests/autonomy-lean-smoke.ts pins it.

import type { StewardBoard } from "./board.ts";

/** Rows of autonomy/BACKLOG.md still to do: status `open` or `in-progress` in the second column. */
export function openBacklogRows(text: string | null): number {
  let n = 0;
  for (const line of (text ?? "").split(/\r?\n/)) {
    const cells = line.split("|").map((c) => c.trim());
    if (cells.length >= 4 && cells[0] === "" && /^(open|in-progress)$/i.test(cells[2] ?? "")) n++;
  }
  return n;
}

export interface QueueFacts {
  /** The run takes its work from a steward board (a stream, or a board with items). */
  stewarded: boolean;
  /** The board after the host withheld exhausted items. */
  offered: StewardBoard;
  backlogText: string | null;
  steerMessages: number;
  /** An upstream merge conflict, a publication blocker or an unaccepted worker commit is work. */
  hostWork: boolean;
  /** The previous cycle, when it left work behind: red gate, or a report of `partial`. */
  last: { merged: boolean; discarded?: boolean | undefined; gate: string; reportOutcome: string | null } | undefined;
  cycles: number;
}

/** Why the queue is not empty, or null when it is. */
export function queueWork(f: QueueFacts): string | null {
  if (f.hostWork) return "the host has work for the cycle (upstream conflict, publication blocker or refused commits)";
  if (f.steerMessages > 0) return "an operator steer is waiting";
  if (f.stewarded) {
    const assignable = f.offered.items.filter((i) => i.status !== "blocked");
    return assignable.length ? `${assignable.length} board item(s) are offered` : null;
  }
  // A run without a board has the brief and BACKLOG.md; its first cycle always runs.
  if (f.cycles === 0) return "the run's first cycle";
  if (f.last && !f.last.discarded && !f.last.merged && f.last.gate === "red") return "the previous cycle's gate is red";
  if (f.last?.merged && f.last.reportOutcome === "partial") return "the previous cycle reported partial work";
  const open = openBacklogRows(f.backlogText);
  return open ? `${open} open backlog row(s)` : null;
}
