# Cycle 23 — Report (run `luna-ux-01`, stream `ux`)

Outcome: successful
Mode: fix

Board: PG-12 done - the one-line trunk-ahead notice was already implemented and covered at the
cycle base (`smoke:update-notice` 8/8); the board evidence was stale, and only a misplaced,
inaccurate doc comment on `trunkNotice` needed correcting.

Item: Budget the `/workflows` list view and tiny-height fallback - 8921a6a - smoke:workflow-panel 17/17 (new 14-run list at 20 rows and confirm at 12/8 rows; base measured 20 framed rows vs 18 at 20 rows)
Item: Attach the trunk-notice comment to the function it describes - fd49793 - smoke:update-notice 8/8

## What changed

The `/workflows` overlay clipped a short terminal: `WorkflowPanel.render` passed the height budget
only to the run view, so the list view always rendered `LIST_ROWS = 12` rows, and `renderRunLines`
returned its 3-line collapse even when its budget was 0. Measured with the real modules: 14 runs
gave 18 body / 20 framed rows against an 18-row host cap at 20 terminal rows, and a run view with a
confirm gave 10/12 against caps of 8 at 12 rows and 7 at 10 rows.

`renderListLines` now takes an optional row budget and shows a window around the selected run with
`… n above` / `… n more` indicators; `renderRunLines`' collapse is bounded by `maxLines`; and the
confirm fallback drops its optional hint and then the blank spacer before the question, choices and
bottom rule. `docs/workflows.md` describes the list budget and the confirm fallback; the cycle-21
proposal is marked implemented. The kit-update comment now sits on `trunkNotice` and states the
line names the trunk channel (`next`), matching every call site and the test.

## Tests and docs changed

- `tests/workflow-panel-smoke.ts`: additions only; a 14-run list at 20 rows (framed cap, rules,
  footer, selected run, indicator) and a stop confirm at 12 and 8 rows (framed cap, question,
  choices, bottom rule; hint at 12 rows). Both fail on the base measurements above.
- `docs/workflows.md`: list-view window/indicators and the confirm hint/spacer fallback.
- `autonomy/proposals/luna-ux-01-21-workflow-list-height.md`: status set to implemented.
- No test was loosened; no `eslint-disable`, `any`, dependency or control-path change.

## Verify

All checks pass at `fd49793`: `smoke:workflow-panel` 17/17, `smoke:update-notice` 8/8,
`smoke:docs`, `test:typecheck`, `test:lint`. Independent reviewer read
`git diff cf7d7865ea81..HEAD` against the charter and ended `VERDICT: PASS`.

## Left for later

- At ≤7 terminal rows the fixed rules/spacer/footer can still exceed the body budget, and a save
  confirm that survives registry pruning takes the list branch's fixed count. Both are pre-existing,
  below the evidenced 10–20-row range and outside this item; the reviewer flagged them as
  non-blocking warnings. A follow-up could add a hard clamp for those two edges.
- Older open proposals unchanged (idle-cat blink, inert Settings rows, Work page lab group, hub
  `ctx.mode` fallback, `TRUNK_CHANNEL` alias).

## For the next cycle

- The gated `workflow_run` reviewer step again produced only a first-message stall ("I'll start by
  reading..."), though the implementer did land its change; `subagent` calls answered fully. The
  reviewer in this cycle was a `subagent`.
- Add the `autonomy/JOURNAL.md` line with the report in the same push (`smoke:docs` gate).
