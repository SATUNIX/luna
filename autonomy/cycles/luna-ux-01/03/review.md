# Cycle 03 — Review (run luna-ux-01, stream `ux`)

- Branch `pi/luna-ux-01`, cycle base `dfb939dd9e0a` (head of `stream/ux`).
- Stream area: TUI overlays, the `/` menu, launch screen, animation and polish (V-01, V-02, V-03,
  V-05, V-09). Assigned board items this cycle: **DE-101** (P1) and **V-09** (P3).
- Mode: **fix**. Both assigned items were checked against the code before anything was changed.
- The steward's mid-cycle steer is authoritative for this cycle: DE-101 is on the board's `review`
  column (do not redo it), and V-09's acceptance is narrowed to one clause — a dated vendored-docs
  entry plus the test that pins it. That clause is what this cycle implemented.

## Precedence

No red gate and no upstream conflict at the base. Board items come first: DE-101 and the V-09 clause
were checked against the tree, not against earlier cycle reports.

## DE-101 — already merged, on the board's `review` column (not redone)

The six landing-review findings are in the base and pinned by tests (cycle 01 commits `c56acda`,
`922e732`, `834963d`, `c638796` are ancestors of it):

1. `packages/extensions/src/control-center/hub.ts:173-190` — `HIDDEN_DISPLAY_CHARS`
   (`\p{Cf}\p{Cc}\p{Default_Ignorable_Code_Point}`, the same class as `HIDDEN_CHARS` in
   `packages/autonomy/lib/notebook.ts:126`) applied after `stripTerminalSequences`, bounded by
   `MAX_DISPLAY_LENGTH = 500`; cases in `tests/control-center-smoke.ts`.
2. `packages/autonomy/lib/inbox.ts:56` — `isIsoTimestamp()` shared with `lib/board.ts`.
3. `packages/autonomy/cli.ts:724` — `--answer` on a settled card is refused, naming the card.
4. `packages/autonomy/cli.ts:721,733-737` — the listing collapses card text with `HIDDEN_CHARS`.
5. `packages/autonomy/lib/inbox.ts:69-70` — `answer`/`outcome` refused in an uploaded file.
6. `packages/extensions/src/remote-control/index.ts:133-168` — a wide grapheme moves to the next
   line instead of dropping the rest of the word.

`smoke:control-center` (45/45) and `smoke:autonomy-inbox` (7/7) pass at the base, so no repair was
needed and none was attempted.

## V-09 — the one assigned clause was missing, and is now done

The steward narrowed V-09 to a single clause: a dated 2026-11-12 entry in
`packages/extensions/third_party/subagent/SOURCE.md` naming `third_party/subagent/wf-panel.ts` and
the `23725c2` change, plus a `tests/docs-smoke.ts` case that fails without it. The width work the
older V-09 text described is already merged (`tests/tui-layout-smoke.ts`), so it was not
re-implemented and no widget, animation or renderer was touched.

What the review found: `SOURCE.md`'s `- Changes:` log stops at **2026-11-11**; `git log -S maxLines`
places the panel's height budget in `23725c2` ("feat(ux): land the ux stream's accepted cycles 14 to
34"), and neither that sha nor `wf-panel.ts`'s `maxLines` appears anywhere in `SOURCE.md`. Nothing in
the test set required the entry, so the vendored file's provenance could silently drift.

## Defect found in-stream (fixed, precedence 4)

`pairPanel` (`packages/extensions/src/remote-control/index.ts:177-207`) computes
`room = termRows - RESERVED_ROWS` (10) but its fit checks undercount the height it emits: beside, it
uses `qr.length + 1` and ignores the title lines already in `out` and the details column; stacked, it
ignores `out` and assumes the scan/approve sentences take one line although `wrap()` splits them on
narrower terminals. Measured with the 49-module `pirc://pair` QR the host actually generates:
`(70,46) → 38 lines for 36 rows`, `(80,45) → 36 for 35`, `(60,46) → 38 for 36`; a sweep of widths
20-200 × heights 10-100 found 71 over-budget QR-shown cases. pi clips the **top** of an over-tall
widget, so the title and the start of the scan sentence scroll away, and the details-only note
understated the rows it needs (says 46 where 48 are required).

## Checked and set aside

- `wf-panel.ts` `footer()` keys off `this.view` while `render()` falls back to the list after
  `RunRegistry.prune()` drops the open run: the list body is shown under the run-view legend and the
  first `down` is swallowed. Real, but outside the assigned clause → proposal
  `autonomy/proposals/luna-ux-01-03-workflow-panel-footer-after-prune.md`, not fixed here.
- `docs/remote-control.md` said the QR is "about 25 rows tall and 50 columns wide"; the real link
  yields 49 modules (27 text rows, 53 columns). Corrected in the same docs commit as the row note.
- Already merged and verified, not redone: overlay frame and transcript dim, hub focus clipping,
  `hubKey` validation, workflow panel height budget, `/settings` folded into `/menu`, launch screen
  `mode`/`hasUI` (cycle 02's claimed fix is in the base at `control-center/index.ts:103,129-132`).

## Records replaced

The `03/review.md`, `03/plan.md`, `03/report.md` and `03/verify.md` present at the cycle base
described an earlier attempt (base `876471a5`, V-01/V-03). They are replaced by this cycle's records;
the same replacement updates the `luna-ux-01/03` journal line to what this cycle actually did.
