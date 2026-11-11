# Cycle 16 review — `luna-core-01`, stream `core`

Base `8669a88` (head of `stream/core`, cycles 01–15). Charter read. No assigned board items.
Carry-overs: #4 (`tests/orchestrate-commands-smoke.ts` never clears `PI_KIT_INTERNAL_CHILD`; `orchestrator/index.ts:55`) is test-only, deferred; #1 firewall timing (out of stream) and V-07/V-08/V-10 (no in-tree finding list) are not actionable.

## New defects (scouts, verified against code)
1. **memory-vault loses pinned/relevant recalls — MED.** `memory-vault/index.ts` pushes recap/pinned/relevant blocks and calls `injected.add()` before the `RECALL_CHARS` (2400) cap head-slices the body, so oversized recaps push `### Pinned memories`/`### Relevant memories` past the cut while their rels stay injected and are filtered from every later `searchMemories`. `tests/memory-vault-smoke.ts` only proves header/footer survive with no other block; `docs/memory.md` promises pinned memories each session.
2. **context-sieve uncharged join separators — LOW.** `assembleWithBudget` charges only `text.length` while blocks join with `"\n\n"`, so assembled text exceeds `budgetChars` by up to `2*(included-1)` and `sieve-budget.json` can record `totalTokens > budget` (same class fixed in `compress` at `6c98e36`).
3. **context-sieve zero-contribution early return skips the `lastInjected` cleanup — LOW.** It returns before the cleanup, so vanished contributions stay cached and a byte-identical re-add is never injected, against `docs/architecture/memory-compaction-context.md`.

Decision: fix mode; take 1 and 2 (item 2 = both context-sieve defects). Defer #4 and two low doc drifts.
