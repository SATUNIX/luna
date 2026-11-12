# Cycle 03 — Plan (run luna-ux-01, stream `ux`)

Mode: **fix**. Board items DE-101 (P1) and V-09 (P3) are verified complete at the base; the cycle
fixes the one real defect the review found in the same TUI renderers and records the second as a
proposal. `/goal`: keep the assigned TUI surfaces correct at narrow and short terminals, with every
changed behaviour pinned by a test that fails on the base source.

## Item 0 — Verify the assigned board items (no code change)

Justification (charter 1, 2, 3): the assigned work must be checked against the code before new work
starts. Evidence is in `review.md`; the checks are the existing `smoke:control-center`,
`smoke:autonomy-inbox` and `smoke:tui-layout`, which pass at the base.

## Item 1 — `pairPanel` must budget the rows it actually emits (defect, precedence 4)

Justification (charter 1, 2, 3): `pairPanel` reserves 10 rows for the rest of the UI, then chooses a
QR layout whose measured height exceeds the remaining room. On a realistic 49-module QR the panel
returns 38 lines for 36 rows at 70x46 (and similar at 80x45, 60x46); pi clips the top of an over-tall
widget, so the panel's title and the start of the scan sentence disappear, and the details-only note
understates the row count it needs. This is user-visible wrong behaviour, not a cosmetic gap.

Change: in `packages/extensions/src/remote-control/index.ts`, build the beside and stacked bodies
once and decide with `out.length + measuredBodyHeight <= room`; keep emitted lines unchanged for
layouts that already fit; compute `rowsNeeded` from the same measured height so the note is honest.

Checks:

- New grid case in `tests/tui-layout-smoke.ts` section 4 (realistic 49-module QR, widths 40-160,
  heights 40-60, plain and ANSI): whenever a QR code is shown,
  `lines.length <= termRows - 10`; the note's stated minimum rows really do show the QR and fit; and
  `fits()` still holds every line within the requested width. It fails on the base source
  (`pair panel 55: the note's 46 rows fit 38 lines`).
- `npm run -s smoke:tui-layout`, `npm run -s smoke:remote-control`, `npm run test:typecheck`,
  `npm run test:lint`, and the `--for-changed` plan (`smoke:new-extension`, `verify`).
- No docs change: `docs/remote-control.md` documents the wrap behaviour and the panel's contents but
  never states a row/column minimum, so the note is the only user-visible text and it is now derived
  from the measurement. The implementer must confirm this while making the change.

Review: the workflow's `reviewer` step, then a fresh independent `reviewer` (the first run's reviewer
step produced no text, which is not evidence of a pass).

## Item 2 — Proposal, not this cycle

`wf-panel.ts` `footer()` can describe a run view while `render()` falls back to the list after the
open run is pruned from the registry. Written up as
`autonomy/proposals/luna-ux-01-03-workflow-panel-footer-after-prune.md`; not assigned, so it waits
for the steward. Rationale for not taking it: one finished, verified change per cycle, and the
proposal needs its own failing test against the registry's prune path.

## Diff budget

Stop taking new items if the non-record diff passes 30,000 characters. This plan's expected diff is
well under that.
