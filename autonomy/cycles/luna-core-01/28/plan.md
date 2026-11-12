# Cycle 28 plan — luna-core-01

Goal: close the remaining PG-66 acceptance gap (the cycle's own over-budget refusal must also
cover a session that dies after writing its report) and fix one evidenced memory-recall
reliability defect; record the refuted cycle-27 reload proposal and a proposal for the `injected`
staleness defect.

Mode: **fix** (board P0 plus one defect). Base `ee45b3cc3636`.

## Item A — PG-66: refuse an over-budget diff when the session is dead

- **Justification (charter §"What counts as an improvement" 1; board PG-66 acceptance clause 3).**
  `cycle.ts:243-249` closes a dead session `completed` without measuring the diff; the board
  requires "a cycle that would exceed the budget is refused by its own pre-report check with the
  measured number". The live path does this (`cycle.ts:259-266`); the dead path does not.
- **Change.** Add a `budgetRefusal()` helper next to `budgetStale` that measures `rt.diffBudget()`
  once and returns the `refused_budget: ...` string when over budget (no steer, since a dead agent
  cannot act). Call it in the dead branch where a report exists or was salvaged, and close
  `partial` with that reason instead of `completed`. Keep `mergeDecision` as the backstop.
- **Docs.** `docs/autonomy.md` describes the pre-report refusal; extend the sentence to say it
  covers a session that exits after recording its report. (Locate the exact current wording.)
- **Checks.** `npm run smoke:autonomy-selfimprove` (new fixture: report + >60000-char commit +
  `t.crash()`; asserts `outcome === "partial"`, `reason` matches `^refused_budget:`, `merged`
  false, and no merge-review model call). Falsify by removing the helper call.

## Item B — memory-vault: do not consume the first-prompt flag when recall fails

- **Justification (charter 4; stream "memory recall").** `memory-vault/index.ts:140` sets
  `firstPrompt = false` before the work that can throw; a thrown recall (catch at `:186-188`)
  permanently loses the first-turn recap and pinned block for the session.
- **Change.** Consume the flag only after the recall body succeeds: move the assignment to a point
  that is reached only when the try block completes, so a thrown search leaves `firstPrompt` true
  for the next prompt. No behaviour change on success.
- **Docs.** `docs/memory.md` frames recall as once-per-first-prompt; add that a failed recall is
  retried on the next prompt if the wording needs it.
- **Checks.** `npm run smoke:memory-vault` (new check: make `searchMemories`/assemble throw on the
  first prompt, assert no message and that the next prompt still emits the recap). Falsify by
  restoring the old assignment point.

## Proposals / records

- Refute `luna-core-01-27-memory-vault-reload-recap.md` in `review.md` (runtime is replaced; the
  proposed fix is a no-op).
- New proposal `autonomy/proposals/luna-core-01-28-memory-vault-injected-path.md` for the
  `injected`-keyed-by-path staleness defect.

## Task graph

1. Item A implementation (implementer) → gated reviewer.
2. Item B implementation (implementer) → gated reviewer.
3. Whole-diff verification and records.

## Budget

Targeted smokes only; never `npm test`/`npm run check:all`. Stop new items once the measured diff
passes 30,000 characters; the merge review budget is 60,000.
