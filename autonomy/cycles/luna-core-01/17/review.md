# Cycle 17 review — `luna-core-01`, stream `core`

Base `ff6083ca18b2` (head of `stream/core`, cycles 01–16). Charter read. No assigned board items.
Carry-overs read from `autonomy/runs/luna-core-01/HANDOFF.md`: #1 firewall timing (out of stream),
#4 `tests/orchestrate-commands-smoke.ts` never clears `PI_KIT_INTERNAL_CHILD` (test-only), the two
low doc drifts, and V-07/V-08/V-10 (still no in-tree finding list). Proposals 01/05/07/11 read; none
block this cycle.

Mode: **fix** (default). Three parallel scouts checked the stream areas against the code. Findings,
each verified by reading the source:

1. **memory-vault first-turn recall drops relevant memories — MED (fixed this cycle).**
   `packages/extensions/src/memory-vault/index.ts:143-146` built `chosen` from `injected` plus every
   pinned rel, but the search over-fetched only `cfg.recallLimit + injected.size`. On the first turn
   `injected.size` is 0, so pinned notes that rank in the top `recallLimit` slots consume the slots,
   are then filtered out, and the turn shows **no** `### Relevant memories` even when a non-pinned
   memory passes the floor just below them. Same code: a pinned line cut by the `RECALL_CHARS` cap
   was added to `chosen` but not `injected`, so it was hidden from the relevance search forever.
2. **context-sieve hidden-message framing is outside the message budget — LOW.**
   `context-sieve/index.ts:311-312,337,347`: `assembleWithBudget` bounds only the contribution text,
   then the injected content prepends a 78-char header and appends `stillCurrent` outside that bound;
   `message.tokens` telemetry measures only the assembled blocks. On a tiny window this is ~40% over
   the message budget.
3. **`docs/architecture/memory-compaction-context.md:90` "never below 64 tokens" is false.**
   `budgetFor` (`context-sieve/index.ts:204-205`) applies the 64 floor and then clamps to half the
   window, so `contextWindow=100` yields 50. `tests/context-budget-smoke.ts:321` pins 50 as correct,
   so the doc is wrong. (Deferred doc drift in HANDOFF.)
4. **`packages/extensions/src/guidelines/README.md` contradicts `index.ts`.** The README's search
   order names `AGENTS.md`, which `index.ts:5-9` deliberately never reads, and its profile list omits
   `pentest` (`guidelines/extension.json:11`). Doc drift only.
5. **skill-router `re:` switch-off is process-lifetime, not session-lifetime.** `match.ts` mutates
   module-level `compiled`/`refusedTriggers`, and `index.ts:47-53` never clears them on
   `session_start`, while the comment and `docs/security.md:502` say "for the session". Re-enabling a
   refused untrusted trigger is a security-adjacent decision, so this is proposed, not fixed here.

Decision: fix item 1 (real, in-stream memory-recall defect) with a test and docs. Items 2–5 are
recorded as proposals rather than taken, because the cycle's remaining agent budget and the repeated
reviewer-hang make a second code change unverifiable. Item 4's doc fix and item 3 are one-line
corrections bundled into a proposal so the next cycle can take them cheaply.
