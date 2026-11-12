# Run `luna-ux-01` — handoff

State after cycle 03 (branch `pi/luna-ux-01`, cycle base `dfb939dd9e0a`, code head `c12d02a` plus
the records commit). Report: `autonomy/cycles/luna-ux-01/03/report.md`, evidence in `verify.md`.

## Assignment state

- **DE-101** is on the board's `review` column (accepted; the steward panel verified all six
  clauses). It was checked against the tree but **not redone**. The six fixes are cycle 01's
  `c56acda` (control-centre `displayText()` filter), `922e732` (inbox hardening + `wrap()` wide
  grapheme carry), and the `4e2938e`/`834963d`/`c638796` documentation and review follow-ups.
- **V-09** was narrowed by the steward to one clause, now done: `c12d02a` adds the dated
  2026-11-12 `SOURCE.md` entry naming `third_party/subagent/wf-panel.ts` and `23725c2`, a
  `tests/docs-smoke.ts` case that isolates that entry and fails without it, and the regenerated
  `THIRD_PARTY_NOTICES.md`. Do not re-open the TUI width work — it is merged and pinned by
  `tests/tui-layout-smoke.ts`.

## What cycle 03 landed beyond the assignment

- `f711b23` fixes `pairPanel` (`packages/extensions/src/remote-control/index.ts`): it reserved ten
  rows then emitted more (49-module QR: 38 lines for 36 rows at 70×46; sweep found 71 over-budget
  cases), so pi clipped the title and the start of the scan sentence. It now measures the beside and
  stacked bodies it actually emits and derives `rowsNeeded` from the same measurement. The new grid
  case in `tests/tui-layout-smoke.ts` failed on the base source with
  `pair panel 55: the note's 46 rows fit 38 lines`.
- `a4dedfb` corrects `docs/remote-control.md` (ten-row reservation; the QR is 49 modules / 27 text
  rows / 53 columns, not "about 25 rows and 50 columns").
- Two non-blocking reviewer warnings remain: the grid's heights never exercise the wide-but-short
  beside fallback, and the details-only row figure is measured at the current inner width.

## Next cycle should know

- Never run `npm test` / `npm run check:all`; the host gate owns the full suite (`/opt/autonomy/gate.sh`
  is skipped locally for the same reason).
- Any new `autonomy/cycles/<run>/<NN>/report.md` needs its `autonomy/JOURNAL.md` line in the same
  push or `smoke:docs` fails. `journal.ts` does not rewrite an existing line for the same cycle id;
  replace it by hand with `journalLineFor` output when a cycle is re-recorded (done this cycle).
- Changing a vendored directory's `SOURCE.md` makes `THIRD_PARTY_NOTICES.md` stale: run
  `node packages/core/gen-notices.ts` in the same commit or `verify` and `smoke:new-extension` fail.
- Gated `workflow_run` plans here have reported `passed` with no implementation; always inspect
  `git status`/`git log` after a step. Implementers may also neglect `git push` — check
  `git status -sb` for `ahead N` and push.
- A `reviewer` step can return empty text while the workflow reports passed; an empty step file is
  not a PASS. Re-run it with a narrower task when a reviewer burns its turn budget verifying.
- Follow-ups not taken: `wf-panel.ts` `footer()` vs `render()` divergence after `RunRegistry.prune()`
  (proposal `autonomy/proposals/luna-ux-01-03-workflow-panel-footer-after-prune.md`, needs a failing
  test on the prune path); the hub's `MAX_DISPLAY_LENGTH` counts code points, not columns; the wrap
  test proves behaviour through the exported `wrap`, not through `pairPanel`'s old drop branch.
- Cycle 02 remains rejected and unmerged; its records are superseded by this cycle's `03/` records.
