# Cycle 16 review — `luna-core-01`, stream `core`

Base `8669a88` (head of `stream/core`, cycles 01–15). Charter read. No assigned board items.
Cycle 15 (fix) merged; its report is `autonomy/cycles/luna-core-01/15/report.md`.

## Carry-overs checked (HANDOFF)
- #4 `tests/orchestrate-commands-smoke.ts` never clears `PI_KIT_INTERNAL_CHILD`/`PI_SUBAGENT_CHILD`;
  `orchestrator/index.ts:55` returns no commands when it is set. Test robustness only (gate env is
  clean), so it cannot fail the host gate today.
- #1 firewall timing (out of stream), #2 no action, #3/#5–#8 are proposals/operator decisions, not
  changes this cycle can make. V-07/V-08/V-10 still have no in-tree finding list (`grep` over
  `docs/` and `autonomy/` finds only carry-over notes), so they cannot be worked.

## Scouts (parallel, 3 scouts; 2 returned nothing because the firewall refused their inline write)
Treating docs and roadmaps as hypotheses, verified against code:

1. **memory-vault first-prompt truncation loses pinned/relevant recalls — MED, high confidence.**
   `memory-vault/index.ts:129-141` pushes recap, pinned and relevant blocks and calls
   `injected.add()` at 132/141 *before* the `RECALL_CHARS` cap at 148-156. The body is
   head-sliced, so a verbose recap set (the recap text is model-written and uncapped) pushes
   `### Pinned memories` and `### Relevant memories` past the cut; the rels are already in
   `injected`, so they are filtered from every later `searchMemories` and never recalled again
   this session. `tests/memory-vault-smoke.ts:344-372` only proves the header/footer survive a
   huge body with no other block present, so the loss is untested. The docs promise pinned
   memories at the start of a session (`docs/memory.md:42-44`).
2. **context-sieve budget leak from uncharged separators — LOW, high confidence.**
   `context-sieve/index.ts:244` charges only `text.length`; the blocks are joined with `"\n\n"`
   (`:304`, `:324`, `:335`, `:339`), so the assembled text exceeds `budgetChars` by up to
   `2*(included-1)` and `sieve-budget.json` can record `totalTokens > budget`. The same class
   was fixed in `compress` (`6c98e36`); `tests/context-budget-smoke.ts` never uses an exact fill.
3. **context-sieve zero-contribution early return skips `lastInjected` cleanup — LOW, high
   confidence.** `context-sieve/index.ts:290` returns before the cleanup at `:320`, so when all
   contributions vanish the map keeps their ids; a later byte-identical re-add is treated as
   unchanged and never injected. Docs say "a contribution that disappears is dropped from
   `lastInjected`, so it is injected again if it comes back"
   (`docs/architecture/memory-compaction-context.md:90`). The existing dedupe test removes one
   contribution while two remain, so it never reaches the empty case.

Nothing higher severity (no crash, data loss or secret exposure) in these modules.

Decision: **fix mode**. Take item 1 (defect, medium) and item 2 (two small, same-file context-sieve
defects, token efficiency). Defer HANDOFF #4 (test-only, needs no product fix) and the doc drifts.
