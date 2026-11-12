# Cycle 03 — Review (run luna-ux-01, stream `ux`)

- Branch `pi/luna-ux-01`, cycle base `dfb939dd9e0a` (head of `stream/ux`).
- Stream area: TUI overlays, the `/` menu, launch screen, animation and polish (V-01, V-02, V-03,
  V-05, V-09). Assigned board items: **DE-101** (P1) and **V-09** (P3); there is no board file.
- Mode chosen: **fix**. Both assigned items are already merged at the base, so the cycle verifies
  them and fixes the first real defect the review finds (work precedence 4).

## Precedence

No red gate and no upstream conflict at the base. Board items come first: DE-101 and V-09 were
checked against the code, not against the cycle reports.

## DE-101 — already complete at the base (verified)

The six landing-review findings are implemented, documented and pinned by tests that fail on the
earlier source (cycle 01 commits `c56acda`, `922e732`, `834963d`, `c638796` are ancestors of the
base):

1. `packages/extensions/src/control-center/hub.ts:173-190` — `HIDDEN_DISPLAY_CHARS` is the same
   `\p{Cf}\p{Cc}\p{Default_Ignorable_Code_Point}` class as `HIDDEN_CHARS` in
   `packages/autonomy/lib/notebook.ts:126`, applied after `stripTerminalSequences`, with the
   `MAX_DISPLAY_LENGTH = 500` bound. Cases for alternate screen, reset, C1 CSI, bidi and the cap are
   in `tests/control-center-smoke.ts`; `docs/control-center.md` describes the filter.
2. `packages/autonomy/lib/inbox.ts:56` uses `isIsoTimestamp()` imported from `./board.ts` (the same
   strict ISO-with-offset check the board uses).
3. `packages/autonomy/cli.ts:724` throws `CliError("refused", ...)` naming the card and its outcome
   when `--answer` targets a settled card (exit 3 per `EXIT` at `:61`).
4. `packages/autonomy/cli.ts:721,733-737` collapses card text and the recorded timestamp with
   `HIDDEN_CHARS` to one visible line, as `lib/store.ts` does.
5. `packages/autonomy/lib/inbox.ts:69-70` refuses `answer`/`outcome` in an uploaded file.
6. `packages/extensions/src/remote-control/index.ts:133-168` retries a wide grapheme on the next
   line after dropping the indent instead of dropping the rest of the word.

Ran `npm run -s smoke:control-center` (45/45) and `npm run -s smoke:autonomy-inbox` (7/7): both
pass at the base. No repair was needed.

## V-09 — both sub-items already merged (verified)

- Status bar, todo checklist and remote pairing panel cut by display columns; ASCII glyph set and
  ellipsis. `packages/extensions/third_party/custom-footer/render.ts`, `widgets.ts:10`
  (`renderTodoWidget(items, theme, max, ascii, width)`), `index.ts:296-299` (mounts a component so
  the checklist gets the live width), `width.ts`, and `remote-control/index.ts` `pairPanel`.
- The working line's tool phrase is cut by columns and whole graphemes (no lone surrogate, ASCII
  ellipsis in ASCII mode), `widgets.ts:53-66`.
- `tests/tui-layout-smoke.ts` asserts every line at widths 20/32/40/60/80/120 for all three footer
  modes, the todo widget, the workflow panel (run and list) and `pairPanel`, with wide and emoji
  input and the ASCII-mode no-non-ASCII check. `smoke:tui-layout` exits 0 at the base (4 checks).
- Wiring and vendored notices are already in place (`smoke:tui-layout` in `package.json`, dated
  entries in both `SOURCE.md`).

So no new V-09 work was invented; the acceptance checks were re-run instead.

## Cycle 02 carry-over

Cycle 02's claimed launch-screen change (`ctx.mode`/`hasUI` predicate passed into
`installLaunchHeader`) is **already in the base**: `packages/extensions/src/control-center/index.ts:103,129-132`
does exactly that and `tests/launch-screen-smoke.ts:352-362` pins the `mode: undefined` pair.
That branch's only commit was records; nothing sound remained to cherry-pick. Its report's V-05
claim is not repeated here — V-05 is not assigned to this cycle.

## Scout findings (read-only, code checked against the hypotheses)

One `scout` reviewed the TUI renderers and reported two real defects; both are in-stream, not
covered by the completed board items.

**Defect 1 (fixed this cycle).** `pairPanel` (`remote-control/index.ts:185-207`) computes
`room = termRows - 10` but its fit checks undercount the emitted height: beside, it uses
`qr.length + 1` and ignores the title lines already in `out` and the details column; stacked, it
ignores `out` and assumes the scan/approve sentences take one line although `wrap()` splits them on
narrower terminals. Measured with the 49-module QR the host actually generates: `pairPanel(offer,
70, 46)` returns 38 lines for 36 rows, `(80, 45)` 36 for 35, `(60, 46)` 38 for 36. pi clips the top
of an over-tall widget, so the title and the start of the scan sentence scroll away, and the
details-only note understates the rows it needs (says 46 where 48 are required). Evidence sweep:
widths 20-200 x heights 10-100 produced 71 over-budget QR-shown cases, worst 2 lines.

**Defect 2 (proposed, not fixed).** `wf-panel.ts` `footer()` (`:773-776`) follows `this.view`, while
`render()` (`:788`) falls back to the list when `RunRegistry.prune()` has dropped the open run. An
open run pruned after 20 newer finished runs leaves the list body with the run-view footer; the
first key press is swallowed. Written up as
`autonomy/proposals/luna-ux-01-03-workflow-panel-footer-after-prune.md`.

## Checked and set aside

- `overlay-frame.ts` framing/dim/mouse math, hub focus clipping, `hubKey` validation, workflow
  panel height budget, `/settings` folded into `/menu`, and the idle cat (documented as static in
  `docs/status-bar-and-costs.md`) are already implemented.
- `smoke:control-center` 45/45, `smoke:workflow-panel` 20/20, `smoke:launch-screen` 13/13,
  `smoke:command-menu` 14/14, `smoke:menu-settings` 4/4 pass at the base.
