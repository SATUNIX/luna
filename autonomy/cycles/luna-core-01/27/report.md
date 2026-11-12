# Cycle 27 report — luna-core-01

Outcome: successful
Mode: fix

- Run: `luna-core-01`, cycle 27, stream `core`
- Branch: `pi/luna-core-01`, base `6642ee5ceeba` (head of `stream/core`, cycle 26 merged)
- Cycle status: completed

Board: PG-66 done - the cycle's own pre-report check now refuses an over-budget diff that is still
over budget after the split steer, closing the cycle `partial` with a `refused_budget:` reason that
names the measured number; the same edit keys the warned set on the head `diffBudget` actually
measured, so the once-per-head dedup can no longer loop.
Board: V-102 not worked (already done on the base; only touched if a changed file needed it).
Board: V-10/V-11/V-07/V-08 not worked (V-10 done on the base; V-11/V-07/V-08 still need the
operator's finding list).

Item: PG-66 the cycle refuses an over-budget diff itself, with the measured number - `66e7c51` -
`npm run smoke:autonomy-selfimprove` all 44 checks pass, including the over-budget fixture which
now asserts both refused cycles closed `outcome === "partial"` with a `^refused_budget: ...`
`reason` carrying the exact measured count; removing the refusal makes it fail.
Item: docs wording for the `refused_budget` reason - `4ece751` - `npm run smoke:docs` passes; the
sentence now says "naming the measured number when it is known".
Item: memory-vault does not tombstone an unreadable memory-local store - `6f8702f` -
`npm run smoke:memory-vault` all 16 checks pass (was 15); the new check writes invalid JSON,
asserts return 0 and no `.pi-index/migrated-memory-local` marker, then a valid file imports.

## What was done

### PG-66 (P0) — the cycle refuses before the merge review

Finding: after cycle 26 the pre-report probe only steered; an over-budget cycle still closed
`"completed"` and the refusal came from `mergeDecision` (`self-improve.ts:694-695`), so the board
acceptance clause "a cycle that would exceed the budget is refused by its own pre-report check with
the measured number" was unmet. A scout also found a real probe bug: `budgetStale` keyed
`budgetWarnedHeads` on `rt.headSha()` (`cycle.ts:204`) while `diffBudget` independently measured
`repo.head()` (`self-improve.ts:434`), so a commit between the reads stored the wrong sha and the
once-per-head dedup could steer forever.

Root cause: `budgetStale` returned `boolean` and never changed the outcome; the warned head and the
measured head were two different reads.

Fix (`66e7c51`): `diffBudget` returns the measured `head`; `budgetStale` measures first, keys the
set on `b.head`, steers a first over-budget head, and returns
`refused_budget: the diff this cycle would submit is <n> characters, over the merge review's budget
of <budget> characters` when that same head is still over budget. The loop closes `"partial"` with
that reason. `"partial"` is deliberate: `mergeDecision:666` accepts it and still hits the unchanged
over-budget branch, so the fail-closed backstop and the merge-reason shape are preserved and no
merge is enabled. The fixture pins the refusal; the merge-review model is still never called for an
over-budget diff.

### Defect — memory-vault migration tombstone

Finding: `migrateMemoryLocal` (`vault.ts:743-760`) wrote the `.pi-index/migrated-memory-local`
marker even when `readJson` returned `null` (invalid JSON or unreadable source), permanently
recording "migrated 0"; a later repair was never imported, and `docs/memory.md:98` only promised
"imported automatically once". Fix (`6f8702f`): return 0 without writing the marker when the source
is not an array; a valid array (even empty) still marks exactly once. Test check 8b and a docs
sentence pin it.

## Checks

See `verify.md`. Targets: `smoke:autonomy-selfimprove` 44/44, `smoke:memory-vault` 16/16,
`smoke:docs`, `test:typecheck`, targeted eslint. Independent reviewer on the whole diff: VERDICT
PASS, no must-fix. Diff 13,975 chars (under the 30,000 stop). No security control, test
assertion, CHARTER or `package.json` script was touched.

## For the next cycle

- Non-blocking reviewer warnings: (1) an over-budget cycle whose session already exited takes the
  `dead` branch (`cycle.ts:242-247`) and still closes `completed` without `budgetStale`, so its
  refusal remains `mergeDecision`'s; the backstop still holds. (2) The memory-vault guard de-indents
  the import loop (avoidable diff churn, behaviour correct).
- Still open from earlier cycles: the `logs`/`log` four-letter stemmer and the `-es`/`bus`/`buses`
  cases need a lexicon or an operator decision; the `session_start` reload re-injects recaps
  (proposal recorded this cycle); host-driven one-item carry (proposal 26 item 2) stays a proposal.
- `t31` on the board (`-es` stemmer repair) stays pending, deliberately not done here.
