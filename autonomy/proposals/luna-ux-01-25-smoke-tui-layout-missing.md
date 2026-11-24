# Proposal: the DE-123 acceptance names a check that does not exist

Found while doing DE-123 in cycle 25. The board item's acceptance requires
`smoke:status-bar and smoke:tui-layout green`, but this branch has no
`smoke:tui-layout` script in `package.json` and no `tests/tui-layout-smoke.ts`
(confirmed with `grep -rn tui-layout` over the tree: only proposal and cycle
records mention it). The footer layout suites that do exist are
`smoke:status-bar` and `smoke:cat-status`.

## Why this cycle did not satisfy it

The cycle may not change the `scripts` of any `package.json`; the merge is
refused before review for that path. Adding the missing script is therefore an
operator/steward action, not a worker one. The cycle ran `smoke:status-bar`
(14/14, including the new `singleCriticalRightChipSurvivesNarrowWidths`) and
recorded `smoke:tui-layout` as skipped.

## Options

1. Add `"smoke:tui-layout": "node tests/tui-layout-smoke.ts"` and a test that
   asserts the footer lines fit and keep their warnings at widths 20 to 120,
   reusing the fixtures already in `tests/status-bar-smoke.ts`. This is the
   option the earlier cycles assumed existed.
2. Correct the board acceptance to name `smoke:status-bar` and
   `smoke:cat-status`, the suites that actually cover footer layout.
3. Drop the clause, since `smoke:status-bar` already sweeps every mode at widths
   20 to 120 and asserts the line fits.

Pick one before a future cycle is judged against a check it cannot run.
