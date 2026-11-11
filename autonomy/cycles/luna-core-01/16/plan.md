# Cycle 16 plan — `luna-core-01`, stream `core`

Mode: **fix**. No assigned board items. Two in-stream items (scout-verified, review.md).

## Item 1 — memory-vault first-prompt recall silently loses pinned/relevant memories
Finding: `packages/extensions/src/memory-vault/index.ts:129-156` adds pinned and relevant rels to
`injected` before the `RECALL_CHARS` cap head-slices the body. Verbose recaps (uncapped, model
text) push `### Pinned memories` / `### Relevant memories` past the cut while their rels stay
marked injected, so they are suppressed for the rest of the session. Contract:
`docs/memory.md` "The first user prompt … gets the last three recaps … pinned memories at the
start of every session".
Change: build the final content first, then mark a rel injected only when its rendered line
survives the cap; give the recap block its own sub-cap so pinned/relevant memories keep room, and
fall back to dropping the whole recap block rather than cutting another block's head.
Test: extend `tests/memory-vault-smoke.ts` check 13 with a pinned memory and a first-prompt match
alongside the oversized recaps; assert both appear (fails on base) and that a rel is not marked
injected when its text was cut. Checks: `smoke:memory-vault`, `test:typecheck`, targeted eslint,
`smoke:docs`. Docs: `docs/memory.md` if the sentence needs to match.

## Item 2 — context-sieve: uncharged join separators and missed `lastInjected` cleanup
Finding A: `context-sieve/index.ts:244` charges only `text.length` while blocks are joined with
`"\n\n"` (`:304/:324/:335/:339`), so the assembled system text can exceed `budgetChars` and
`sieve-budget.json` can record `totalTokens > budget` — the same class fixed in `compress`
(`6c98e36`). Finding B: `:290` returns before the `lastInjected` cleanup at `:320`, so after all
contributions disappear their ids stay cached and an identical return is never injected, against
`docs/architecture/memory-compaction-context.md:90`.
Change: charge the separator in `assembleWithBudget`; clear `lastInjected` before the empty
early return. Behaviour otherwise unchanged.
Test: exact-fill contributions assert assembled length `<= budgetChars` and no `totalTokens >
budget`; remove every contribution then re-add one byte-identical and assert it is injected.
Checks: `smoke:ctx-contributions`, `smoke:context-budget`, `test:typecheck`, targeted eslint,
`smoke:docs`.

## Verification
Per changed file, targeted smokes; then an independent reviewer on `git diff 8669a88..HEAD`
against this plan and the charter; fix or revert failures; write `verify.md` line by line.

## Not taken
HANDOFF #4 test-env hardening (test-only); #1 out of stream; V-07/V-08/V-10 have no finding list;
proposals 05/07/11; the two low doc drifts (memory "at most once per session", 64-token floor).
