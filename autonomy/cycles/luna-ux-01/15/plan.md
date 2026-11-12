# Cycle 15 — Plan (run `luna-ux-01`, stream `ux`)

Mode: fix. Objective: repair the red gate that blocked cycle 14 and re-land its reviewed PG-09
owner-inbox work, with the documentation correction the review found.

## Items

### 1. Repair the journal gate and re-land the PG-09 owner inbox (board PG-09)

- **Justification.** Charter priority 0 (red gate) and priority 2 (board item PG-09). Cycle 14's
  only gate failure is a missing `autonomy/JOURNAL.md` line for its report; the code itself is
  reviewed and its targeted checks pass. The acceptance criterion for PG-09 is the answered card,
  the past-due card settling into its default and writing the decision record, and an unanswered
  non-expired card leaving its item `blocked`.
- **Change.** Cherry-pick `370fe90`, `e06be41`, `748202e`, `34dfa0e` (already applied on this
  branch) so the inbox model, command, smoke test, docs, README, CHANGELOG and the one
  `smoke:autonomy-inbox` script land unchanged. Add the missing
  `- luna-ux-01/14 | Board: PG-09 | successful | ...` journal line.
- **Checks.** `npm run smoke:autonomy-inbox`, `smoke:autonomy-cli`,
  `smoke:autonomy-selfimprove`, `smoke:autonomy-review-inputs`, `smoke:wiring`, `smoke:docs`,
  `test:typecheck`, `test:lint`. A reviewer reads the full diff against the charter.

### 2. Correct the inbox documentation (consolidation of item 1)

- **Justification.** `docs/autonomy.md:610` says an answer is recorded "on the next read"; the
  command settles in the same call (`packages/autonomy/cli.ts:590-596`) and the smoke pins it.
  Charter priority 6 (docs that don't match the code).
- **Change.** State that an answer is recorded by the `--answer` call itself; state the deadline
  format (`Z` or explicit offset, otherwise host-local) and the re-block invariant of a settled
  card.
- **Checks.** `smoke:docs`; the wording cites the existing smoke rather than new behaviour.

## Not taken

Diff from base is 29,763 characters before records, at the stop-new-items line. The scout's
deadline-validation, re-block-marker, concurrency and terminal-escaping findings need new
behaviour and tests; they go to a proposal and the handoff, not this cycle.
