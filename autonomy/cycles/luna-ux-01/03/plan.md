# Cycle 03 — Plan (run luna-ux-01, stream `ux`)

Mode: **fix**. `/goal`: finish the one assigned V-09 clause (vendored provenance + the test that pins
it), then fix the first real in-stream defect the review found (precedence 4), leaving the rest to a
proposal. Every changed behaviour is pinned by a test that fails on the tree before the change.

## Assignment

- `DE-101` (P1) is on the board's `review` column: accepted, merged at the base, and verified by the
  steward panel. Not redone; `review.md` records where each of its six clauses lives.
- `V-09` (P3) is narrowed by the steward's steer to exactly one clause:
  - a dated `2026-11-12` entry in `packages/extensions/third_party/subagent/SOURCE.md` naming
    `third_party/subagent/wf-panel.ts` and the `23725c2` change;
  - a case in `tests/docs-smoke.ts` that isolates that entry, requires both facts, and fails on the
    current tree.
  The TUI width work the older V-09 text covered is merged; nothing is re-implemented, and no
  animation, widget or renderer is touched.

## Item 1 — V-09 clause: workflow-panel provenance is recorded and pinned

Justification (charter 1, 2, 3): a vendored directory whose `SOURCE.md` stops at 2026-11-11 does not
record the `maxLines` height budget that `23725c2` added to `wf-panel.ts`; nothing checks it, so the
provenance can drift unnoticed. That is a missing, testable fact, not a cosmetic wording change.

Change: one dated entry under `- Changes:` in
`packages/extensions/third_party/subagent/SOURCE.md` (after the 2026-11-11 entry), and one case in
`tests/docs-smoke.ts` near the other subagent provenance checks. The case reads `SOURCE.md` through
the existing `readRel` helper, isolates the bullet whose bolded heading carries `2026-11-12`, and
requires that entry to name both `wf-panel.ts` and `23725c2` — not a loose whole-file regex.
Regenerating `THIRD_PARTY_NOTICES.md` (`node packages/core/gen-notices.ts`) is part of the change,
because it embeds these entries and `verify` fails when it is stale.

Checks:

- `node tests/docs-smoke.ts` fails before the entry with the assertion naming what is missing, and
  prints `[docs-smoke] OK: ...` after it.
- `npm run -s test:typecheck`, `npm run -s test:lint`, `npm run -s verify`.

## Item 2 — `pairPanel` must budget the rows it actually emits (defect)

Justification: `pairPanel` reserves 10 rows for the rest of the UI, then chooses a QR layout whose
measured height exceeds the remaining room. On the 49-module QR the host really generates it returns
38 lines for 36 rows at 70×46 (and similarly at 80×45 and 60×46); pi clips the top of an over-tall
widget, so the panel's title and the start of the scan sentence disappear, and the details-only note
understates the rows it needs. User-visible wrong behaviour, not a cosmetic gap.

Change: in `packages/extensions/src/remote-control/index.ts`, build the beside and stacked bodies
once and decide with `out.length + measuredBodyHeight <= room`; keep the emitted lines unchanged for
layouts that already fit; compute `rowsNeeded` from the same measurement so the note is honest. Add
a grid case in `tests/tui-layout-smoke.ts` section 4 (realistic 49-module QR, widths 40-160, heights
40-60): whenever a QR is shown, `lines.length <= termRows - 10`, the note's stated minimum rows do
show the QR and fit, and every line still fits the requested width. Update `docs/remote-control.md`
(the ten-row reservation and the corrected QR size: 49 modules, 27 text rows, 53 columns).

Checks: `smoke:tui-layout`, `smoke:remote-control`, `test:typecheck`, `test:lint`, `verify`.

## Item 3 — Proposal, not this cycle

`wf-panel.ts` `footer()` can describe a run view while `render()` falls back to the list after the
open run is pruned from the registry. Written up as
`autonomy/proposals/luna-ux-01-03-workflow-panel-footer-after-prune.md`; it is outside the assigned
clause and needs its own failing test against the registry's prune path.

## Diff budget

Stop taking new items once the non-record diff passes 30,000 characters. The planned diff is under
half of that.

## Review

Each change goes through a `workflow_run` step pair: `implementer`, then a gated `reviewer` that did
not write it (`max_loops` 1), requiring a final line of exactly `VERDICT: PASS`.
