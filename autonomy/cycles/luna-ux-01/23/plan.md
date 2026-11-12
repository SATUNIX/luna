# Cycle 23 — Plan (run `luna-ux-01`, stream `ux`)

Mode: fix. Board item PG-12 is already implemented, tested and green at the cycle base, so the
cycle takes the carried short-terminal `/workflows` panel defect (charter priority 4, with the
cycle-21 proposal as evidence) and one stale doc comment (priority 6).

## Item 1 — Make the `/workflows` panel fit a short terminal in both views

Justification: measured defect (see `review.md`): with 14 runs, `panel.render(160, 20)` is 18 body
lines / 20 framed against an 18-row host cap, clipping the bottom rule and the list footer; the run
view returns a 3-line collapse even when its `maxLines` budget is 0, overshooting a 10–12 row
terminal. This is a UX overlay defect in this stream (V-02).

Change:

- `renderListLines(runs, paint, selected?, maxLines?)` (`wf-panel.ts:396`): when a budget is given,
  keep the header and a window around the selected run, reserve one line each for `… N above` and
  `… N more`, and never exceed `maxLines`. Without a budget (text fallback) keep `LIST_ROWS`.
- `WorkflowPanel.render` (`:727`): pass the list view its remaining budget after the top rule,
  blank/footer/note rows and bottom rule, as the run view already does.
- `renderRunLines` (`:303`): when `maxLines` is reached, the collapse must fit — `[]` at 0, the
  header lines only when there is no room for the `… n more` line, never more than `maxLines`.
- `WorkflowPanel.render`: when a confirm block plus rules cannot fit the budget, drop the optional
  `↑↓ choose …` hint and then the blank spacer before the confirm block, keeping the question, the
  No-first choices, the selected choice and the bottom rule.

Tests (`tests/workflow-panel-smoke.ts`): 14-run list at 20 rows through `frameLines` (framed fits
`floor(rows*0.9)`, footer and both rules present, selected run visible, `… N more` present); run
view at 12 rows with a confirm open (framed fits, confirm hint, choices and bottom rule present);
run view at 8 rows (framed fits, confirm question and choices and bottom rule present). Each case
must fail on the base.

Docs: `docs/workflows.md` run-list and short-terminal paragraphs describe the new budget; the
existing run-view claim stays true.

Checks: `npm run smoke:workflow-panel`, `npm run smoke:command-menu` (neighbouring panel code
unchanged but cheap), `npm run test:typecheck`, `npm run test:lint`, `npm run smoke:docs`.

## Item 2 — Correct the trunk-notice doc comment

Justification: `kit-update/index.ts:732-734` says the line names "the install's real channel"; all
call sites use `TRUNK_CHANNEL = "next"`, and `tests/update-notice-smoke.ts` asserts that. Comment
only, no behaviour change.

Checks: `npm run smoke:update-notice`.

## Budget and scope

Two small commits; expected non-record diff well under the 30000 stop line. Board PG-12 is
recorded done from the base. Nothing else is taken this cycle.
