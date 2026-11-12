# The `/workflows` list view and the tiny-height fallback still exceed a short terminal

Status: implemented in cycle 23 (`8921a6a`); the list view now takes the remaining row budget and
the tiny-height collapse and confirm block are bounded. Tests: `smoke:workflow-panel`.

Cycle 21 gave the `/workflows` **run** view a height budget (`wf-panel.ts` `render(width, rows)`):
narration, extra phase rows and agent rows are trimmed, and the confirm/footer stay visible. Two
neighbouring cases were left alone because they are outside that cycle's handoff item.

## Problem

1. **List view.** `WorkflowPanel.render` applies `rows` only when a run is open. The default list
   view renders `renderListLines` with `LIST_ROWS = 12` plus a header/summary, the note, the footer
   and both rules without a budget. With 14 runs, `panel.render(160, 20)` returns 18 body lines and
   20 framed lines against the host's 18-row cap (`floor(20 * 0.9)`), so the footer and `esc close`
   are clipped. It needs roughly 10+ runs to trigger.
2. **Very small terminals.** At `rows` around 14 or less, `maxLines - fixed` reaches 0 while
   `renderRunLines` still returns its collapsed `header + "… n more"` (at least 3 lines), so the
   composite can exceed the cap. The 20/24-row test does not reach this.

## Suggested fix

Give the list view the same remaining-budget treatment: pass the budget to `renderListLines`, keep
the selected run in a window, and collapse the rest to one `… n more` line. Make the run-view
minimum fallback fit the budget (drop the header down to its first line, or return no middle lines
when the fixed block already fills it). Extend `tests/workflow-panel-smoke.ts` with a 14-run list
render at 20 rows through `frameLines`, and a run view at 12 rows, asserting the framed composite
fits and the footer/bottom rule are present.

## Evidence to pin

The measurements above come from `panel.render(160, 20)` with 14 runs and `frameLines`; the cycle-21
commit `65c01af` shows the framed-budget assertion pattern to reuse.
