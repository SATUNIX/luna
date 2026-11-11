# Proposal — flag a journal entry with no cycle report

Status: open. Stream: autonomy. Board: none. Raised by cycle `luna-ops-01/02` (A-01).

## What

`checkJournal` (packages/core/lib/journal.ts) checks both directions except one: a report with no
entry is a failure, and an entry whose cycle *directory* is missing is a failure, but an entry
whose directory exists with no `report.md` is accepted. Today's `- luna-ops-01/02 | ...` line is
exactly that shape until the cycle's report lands, so the check cannot flag a stray or typo'd
entry that happens to sit next to a directory.

## Why it matters

The stated invariant is "one entry per cycle report". As written it is enforced report→entry only,
so a copied or mistyped key can linger forever. The A-01 board item called this out as future
hardening, not a blocker: enforcing it now would have failed `smoke:docs` for the current cycle
until its report was written.

## Change

In `checkJournal`, when looking up an entry's cycle directory, also require the corresponding
`report.md` and report `journal entry has no report: <key>` otherwise. Two details:

- The close-out exception must stay: a host close-out report is still a report, so its directory
  has `report.md`; no change there.
- Sequence the change with the cycle that writes the first entry, or accept that the entry and the
  report must land in the same commit.

## Evidence

- `packages/core/lib/journal.ts` `checkJournal` (entry→directory check around lines 108-117).
- `autonomy/cycles/luna-ops-01/02/verify.md` records the current behaviour.
