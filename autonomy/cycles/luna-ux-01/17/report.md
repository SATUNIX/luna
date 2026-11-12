# Cycle 17 — Report (run `luna-ux-01`, stream `ux`)

Outcome: successful
Mode: fix

Board: none assigned. The cycle carried over cycle 16's unmerged ux fixes (rejected only for an
unassigned PG-09), repaired two regressions found in that unmerged code, closed the docs gap the
rejection named, repaired a red `smoke:docs` gate inherited from the base, and fixed a `/boost`
autocomplete location defect. Note `a8e8553`'s message claims `smoke:docs` passed; the gate was red
at base from duplicate journal lines and was repaired in the next commit `40fdab7`. The four
cherry-picked commits keep their original subject-only messages because rewriting pushed history is
out of bounds; their finding/cause/fix/verification detail is in `review.md` and `plan.md`.

Item: Re-land the cycle-16 hub escaping, short-terminal fit, cat priority and informational-command fixes - 81289d9, 2c5ca7b, 0510bee, 69f3536 - smoke:control-center 37/37, smoke:cat-status 12/12
Item: Keep pointer hit-testing aligned with the shown hub title (regression in the re-land) - 1381aaa - smoke:control-center 37/37 (fails before)
Item: Re-arm the cat result timer when a held result suppresses a later one (regression) - 6cc6746 - smoke:cat-status 12/12 (fails before)
Item: Document informational-row commands in print/json and RPC - a8e8553 - smoke:docs OK
Item: Repair the duplicate luna-core journal entries that reddened smoke:docs at the base - 40fdab7 - smoke:docs OK
Item: Resolve a hidden command's hub location from its exact legacy row (/boost) - a04e4f8 - smoke:command-menu 13/13 (fails before)
Item: Align docs, title predicate and Doctor assertion with the review findings - bdeb5d6 - smoke:control-center 37/37, smoke:docs OK

## Why this work

Cycle 16 was rejected because it did not advance the then-assigned PG-09, not because its four ux
fixes were wrong, and those commits were never merged. At this base they are still absent:
`headerLine` interpolated raw marker values, the overlay returned more lines than a short terminal
had, `setResult` overwrote a held denial, and print/RPC dropped an informational row's command.
Re-landing is the correct handoff carry-over. Two scouts then found that the unmerged work had two
real regressions (mouse offset and an unarmed held-result timer), and the rejection itself named a
docs gap; both regression fixes and the docs sentence are included here with tests that fail on the
pre-fix source.

The base also carried a red acceptance check: `smoke:docs` rejected duplicate `luna-core-01/09..11`
journal entries kept by the cycle-15 merge. That is priority 0, repaired first.

## Verification

`smoke:control-center` 37/37, `smoke:cat-status` 12/12, `smoke:command-menu` 13/13, `smoke:docs`,
`smoke:launch-screen` 11/11, `test:typecheck`, `test:lint` and `verify` all pass after `bdeb5d6`.
An independent reviewer read the full diff against the charter and returned PASS; its three
non-blocking warnings were fixed in `bdeb5d6`. Full evidence is in `verify.md`.

## Left for later

- The TUI and RPC renderers still do not show a row's typed command although the Help page and
  `docs/control-center.md` promise it; captured in
  `autonomy/proposals/luna-ux-01-17-hub-typed-command-in-tui-rpc.md` because it needs a width and
  truncation decision.
- Existing proposals unchanged: idle-cat blink, inert Settings value rows, the lab group routed to
  the Work page, the stale `luna-ux-01-10` proposal, undeclared hub `ctx.mode` fallback and
  `TRUNK_CHANNEL`.
- The integration-candidate shard-3 note from cycle 16 still cannot be reproduced from this clone;
  no new evidence either way.
- Diff excluding records is 35,181 characters, so this cycle stopped taking new items; the next
  cycle has room but should not re-open the re-landed work without new evidence.
