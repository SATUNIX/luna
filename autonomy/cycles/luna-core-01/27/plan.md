# Cycle 27 plan — luna-core-01 (stream `core`)

Mode: **fix**. Base `6642ee5ceeba`. Budget ~$5 / 3h. Reviewable-diff read budget 60,000 chars;
stop new items past 30,000. Never run `npm test` or `npm run check:all`.

## Item 1 — PG-66: the cycle's own pre-report check refuses with the measured number

Justification (charter priority 2, the assigned P0 board item; acceptance clause 3):
the probe added in cycle 26 only steers, so an over-budget cycle still closes `"completed"` and
the refusal is `mergeDecision`'s. The board requires the cycle's own check to refuse with the
measured number. The same edit fixes a real probe bug (the warned set is keyed on a head that is
not the one measured, so the once-per-head dedup can loop).

Change:
- `packages/autonomy/lib/cycle.ts`: `CycleRuntime.diffBudget` returns the measured `head`; add it
  to the result type and doc comment. Rewrite `budgetStale` to measure first, return
  `{ steered: boolean; refused?: string }`, dedupe on the measured head, and return
  `refused_budget: the diff this cycle would submit is <n> characters, over the merge review's
  budget of <budget> characters` when the same measured head is still over budget. The loop call
  site closes `"partial"` with that reason; a first-seen over-budget head still steers.
- `packages/autonomy/lib/templates/self-improve.ts`: `diffBudget` includes `head` in every return.
- `tests/autonomy-selfimprove-smoke.ts`: in the over-budget fixture, assert both refused cycles
  closed `outcome === "partial"` with a `reason` matching `^refused_budget: ...` and the measured
  number, in addition to the existing merge-reason, attempts and steer assertions.

Checks: `npm run smoke:autonomy-selfimprove` (fails without the refusal), `test:typecheck`,
targeted eslint on the two files. No change to `mergeDecision` behaviour or the merge-review model.

## Item 2 — memory-vault: do not tombstone an unreadable memory-local store

Justification (charter priority 4, a defect; stream `core` covers memory recall):
`vault.ts:743-760` writes the `.pi-index/migrated-memory-local` marker even when `readJson`
returned `null`, so a malformed or unreadable `memories.json` is recorded as "migrated 0" and a
later repair is never imported.

Change:
- `packages/extensions/src/memory-vault/vault.ts`: return `0` without writing the marker when the
  source exists but is not an array; a valid array (even empty) still marks as before.
- `tests/memory-vault-smoke.ts`: new check 8b — invalid JSON leaves no marker and returns 0; the
  repaired file imports on the next call.
- `docs/memory.md`: one sentence that an unreadable store is retried, not tombstoned.

Checks: `npm run smoke:memory-vault`, `test:typecheck`, targeted eslint on the two files.

## Risks / rollback
- Item 1 changes a cycle outcome from `completed` to `partial` only for an over-budget diff that
  `mergeDecision` refuses anyway; no merge is enabled. Rollback is a single revert of `cycle.ts`
  plus the adapter field.
- Item 2 only leaves the marker unwritten on a read failure; existing once-only behaviour for a
  readable store is unchanged.

## Out of this cycle (proposals / next)
- Stemmer `logs`/`log` and `-es` cases need a lexicon or operator decision (cycle-24/25 note).
- `session_start` reload re-injects recaps (scout candidate C): record as a proposal.
- Host-driven one-item-at-a-time carry (proposal 26 item 2) stays a proposal; larger, outcome-changing.
