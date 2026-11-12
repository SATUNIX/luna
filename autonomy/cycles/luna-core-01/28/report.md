Outcome: successful
Mode: fix

Board: PG-66 done - cycle 27 landed the live-session half (steer, then refuse with the measured
number); this cycle closed the last gap, so a worker that writes its report and then exits is now
refused by the cycle's own pre-report check instead of closing `completed`.

Item: Dead-session over-budget refusal (PG-66) - 496e1c1 - `npm run smoke:autonomy-selfimprove`
  (45/45, was 44; new check "a session that records an over-budget report and then dies is refused
  by its own pre-report check, never merged" asserts `partial` + `refused_budget` + `merged:false`
  + no merge-review model call; removing the two `budgetRefusal()` calls makes it fail).
  `docs/autonomy.md` documents that the check covers a session that exits after recording.
Item: Cycle-28 records (review, plan, verify, report, journal, handoff) and proposals -
  d42bbeb, 0743040, 225b70d, fe0862f - records/proposals only, no behaviour change. The single
  behaviour commit is 496e1c1; any record commit made after this line is the same record chain
  and is exempt (a commit cannot name its own sha).

## What changed and why

`packages/autonomy/lib/cycle.ts`: added `budgetRefusal()`, which measures `rt.diffBudget()` once
and returns the same `refused_budget: ...` wording `budgetStale` uses, without steering or
touching `budgetWarnedHeads`. The dead-session branch (`if (dead)`) now calls it at the two points
that previously closed `completed` (report recorded; host salvage after session exit) and closes
`partial` instead when the diff is over budget. The auto-restart path and the live
steer-then-refuse path are unchanged; `mergeDecision` remains the fail-closed backstop.

## Left-overs and other findings

- **Cycle-27 memory-vault reload proposal refuted (no-op).** `luna-core-01-27-memory-vault-reload-recap.md`
  assumes the same extension instance survives a reload; pi replaces the extension runtime (pi's
  bundled extension docs, `@earendil-works/pi-coding-agent` `docs/extensions.md` lines 50 and 145),
  so `firstPrompt`/`injected` restart at `true`/empty per factory invocation and the proposed
  "skip the reset" fix changes nothing. Do not implement it.
- **Item B (first-recall flag) not landed, not testable.** `memory-vault/index.ts:140` consumes
  `firstPrompt` before the throwing work, but every file read in the recall path is already guarded
  (`vault.ts:418-462`, `578-582`, `673-676`), so no realistic state throws after `:140`; the only
  seam that throws (a directory under `Recaps/`) throws before `:140` and passes on the base. Per
  the "claim names a test" rule it was left out. Fix + seam proposed in
  `luna-core-01-28-memory-vault-first-recall-flag.md`.
- **New proposal** `luna-core-01-28-memory-vault-injected-path.md`: `injected` is keyed by relative
  path, so a memory updated in-session is never re-shown and the model keeps acting on the stale
  snippet.
- Carried HANDOFF items 1-8 are unchanged and out of scope this cycle.
- Recovery note: the 6-stall signal was a false positive (it fired on read-only verification after
  the commits were already pushed); recorded at `.pi/recovery/6-stall.md`.

## Checks

See `verify.md`. Never ran `npm test` or `npm run check:all`. Merge into `stream/core` after the
host gate on a clean checkout.
