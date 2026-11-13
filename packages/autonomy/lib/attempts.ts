// One ordinary attempt plus one bounded repair per board item. A cycle that was assigned an item
// and did not merge is an attempt against it; after `limit` of them (the original and one
// repair) the host stops offering the item and records why, instead of letting later cycles pay
// for the same failure again. A merge clears the item's count. The record is run state
// (state.selfImprove.itemAttempts), so a restart keeps it. Re-filing the item under a new ID is
// how the steward offers it again. tests/autonomy-attempts-smoke.ts pins the rule.

import type { StewardBoard } from "./board.ts";

/** What the host knows of one board item's failed attempts. */
export interface ItemAttempt {
  /** Cycles that were assigned the item and did not merge, since its last merge. */
  attempts: number;
  /** Why the latest one was not merged (clipped). */
  lastReason: string;
  /** True once `attempts` reached the limit: the item is no longer offered. */
  withheld: boolean;
  /** When the item was withheld, ISO 8601; absent while it is still offered. */
  withheldAt?: string;
}

export type ItemAttempts = Record<string, ItemAttempt>;

/** The ordinary attempt and one repair. */
export const ATTEMPTS_PER_ITEM = 2;

/** The board without the items the host has stopped offering. */
export function withoutWithheld(board: StewardBoard, attempts: ItemAttempts | undefined): StewardBoard {
  if (!attempts) return board;
  return { ...board, items: board.items.filter((item) => attempts[item.id]?.withheld !== true) };
}

/**
 * Record how a cycle ended for the items it worked on. Returns the IDs withheld by this call.
 * `ids` are the items the cycle was assigned or claimed; a merged cycle clears them.
 */
export function recordAttempts(attempts: ItemAttempts, ids: readonly string[], { merged, reason, at, limit = ATTEMPTS_PER_ITEM }: { merged: boolean; reason: string; at: string; limit?: number }): string[] {
  const withheld: string[] = [];
  for (const id of ids) {
    if (merged) { Reflect.deleteProperty(attempts, id); continue; }
    const previous = attempts[id];
    if (previous?.withheld) continue;
    const count = (previous?.attempts ?? 0) + 1;
    const now = count >= limit;
    attempts[id] = { attempts: count, lastReason: reason.slice(0, 300), withheld: now, ...(now ? { withheldAt: at } : {}) };
    if (now) withheld.push(id);
  }
  return withheld;
}
