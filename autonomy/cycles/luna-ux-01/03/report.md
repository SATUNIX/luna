Outcome: successful
Mode: fix

Board: V-09 done - recorded and pinned the workflow-panel height budget the vendored subagent SOURCE.md never named: a dated 2026-11-12 entry naming `wf-panel.ts` and commit `23725c2`, plus a docs-smoke case that isolates that entry and fails without it.
Board: DE-101 done - checked against the tree, not redone: the steward has it on `review`, and all six clauses are merged and tested at the base (`hub.ts:173-190`, `inbox.ts:56,69-70`, `cli.ts:721,724,733-737`, `remote-control/index.ts:133-168`).

Item: V-09 vendored workflow-panel provenance - c12d02a - `node tests/docs-smoke.ts` (`[docs-smoke] OK: 14 documented commands validated, 62 relative links resolved; ...`); fails before the entry with the assertion naming `wf-panel.ts` and `23725c2`.
Item: pairPanel row budget - f711b23, a4dedfb - `npm run -s smoke:tui-layout` (`tui-layout-smoke: 5 checks passed`, incl. the new QR row case) and `npm run -s smoke:remote-control` (`OK (16 checks)`); the new case failed on the base source with `pair panel 55: the note's 46 rows fit 38 lines`.

# Cycle 03: vendored workflow-panel provenance recorded; pairing panel row budget fixed

## What was asked

The steward's steer made this cycle narrow. `DE-101` moved to the board's `review` column, so it was
verified against the code and left alone. `V-09` was cut to exactly one clause: a dated 2026-11-12
entry in `packages/extensions/third_party/subagent/SOURCE.md` naming
`third_party/subagent/wf-panel.ts` and the `23725c2` change, and a `tests/docs-smoke.ts` case that
fails on the current tree and passes once the entry exists. No TUI width work was re-implemented and
no widget, animation or renderer was added.

## V-09 clause

Finding: `SOURCE.md`'s `- Changes:` log ended at 2026-11-11. The panel's `maxLines` height budget
landed in `23725c2` ("feat(ux): land the ux stream's accepted cycles 14 to 34"), and neither that
sha nor `maxLines` appeared in the file or in any test.

Fix: one dated entry describing what the code does (run view trims narration, then phase rows, then
the non-selected agent window, keeping the selected agent and its detail; the list view keeps a
stable cursor and the same budget; `undefined` still renders every section), and one docs-smoke case
that isolates the dated bullet and requires both `wf-panel.ts` and `23725c2` in it. Running
`node packages/core/gen-notices.ts` regenerated `THIRD_PARTY_NOTICES.md` (it embeds these entries, and
`verify`/`smoke:new-extension` fail while it is stale); that regeneration is in the same commit.

## Pairing panel row budget (defect, precedence 4)

Finding: `pairPanel` reserved ten rows for the rest of the UI and then chose a layout whose measured
height overran them. With the 49-module `pirc://pair` QR the host actually generates it returned
38 lines for 36 rows at 70×46, 36 for 35 at 80×45 and 38 for 36 at 60×46; a width×height sweep found
71 over-budget QR-shown cases. pi clips the top of an over-tall widget, so the title and the start of
the scan sentence scrolled away, and the details-only note understated the rows it needs.

Root cause: the fit checks measured `qr.length + 1` (beside) and one assumed line per wrapped
sentence (stacked), ignoring the title lines already emitted, the details column and `wrap()`'s
multi-line output.

Fix: build the beside and stacked bodies once, decide with `out.length + measuredBodyHeight <= room`,
keep already-fitting output byte-identical, and derive `rowsNeeded` from the same measurement.
`docs/remote-control.md` now states the ten-row reservation and the real QR size (49 modules, 27 text
rows, 53 columns) instead of "about 25 rows and 50 columns".

## Checks

Planned with `check-all --for-changed` over the eight changed paths; every planned check ran and
passed: `docs:check`, `smoke:docs`, `smoke:eval-footprint`, `smoke:new-extension`,
`smoke:subagent-roles-isolation`, `smoke:tui-layout`, `smoke:workflow-notify`, `test:lint`,
`test:typecheck`, `verify`, plus `smoke:remote-control`. `npm test`, `npm run check:all` and
`/opt/autonomy/gate.sh` were not run locally (host-gate only). Detail and proving lines are in
`verify.md`; the non-record diff is 14,564 characters.

## Review

Both changes got an independent `reviewer` PASS (workflow runs `2026-11-12T13-05-42-793Z-plan-367e`
and `2026-11-12T13-07-47-531Z-plan-aaf3`). No must-fix items. The pairPanel review left two
non-blocking warnings (beside-fallback coverage, note wording across widths), recorded in `verify.md`.

## Left

- `wf-panel.ts` footer/view divergence after `RunRegistry.prune()` — proposal
  `autonomy/proposals/luna-ux-01-03-workflow-panel-footer-after-prune.md`, needs its own failing test.
- The stale `03/` records from an earlier attempt were replaced; the journal line for
  `luna-ux-01/03` is regenerated to match this report.
