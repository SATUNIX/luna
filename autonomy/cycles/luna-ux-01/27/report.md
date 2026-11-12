# Cycle 27 — Report (run `luna-ux-01`, stream `ux`)

Outcome: successful
Mode: fix

Board: V-09 done - narrow-terminal and glyph-consistency hardening of the existing TUI renderers
Item: status bar and todo checklist cut in terminal columns with the theme's ellipsis - 84fd8df, 71f7c0e, 5eb4d82 - `npm run smoke:tui-layout` 4/4; on base the todo header was 50 columns at width 20 and ASCII cuts ended in U+2026
Item: remote-control pairing panel wrapped by display columns - dd11dd9, 71f7c0e, 5eb4d82 - `npm run smoke:tui-layout` 4/4; on base `pair panel@20: line 19 is 22 columns`

## What changed

**V-09 was scoped to two evidenced layout defects in existing renderers.** The review of the
four surfaces found three real narrow-terminal/glyph problems and one already-correct surface:
the status bar cut with U+2026 even when the ASCII glyph set was selected; the todo checklist
had no width input, so a 20-column terminal got a 50-column header and pi wrapped it; and the
remote-control pairing panel wrapped by code units, so wide graphemes could exceed the frame.
The workflow panel already fitted and is only pinned against regression.

**Item 1 — footer and todo (84fd8df, completed by 5eb4d82).** `renderTodoWidget` takes an
optional width and cuts every line with `truncateDisplay`; `index.ts` passes
`process.stdout.columns` when it is finite and positive. `fitLine` and `statusChip` take the
ellipsis, and every generated cut in `renderFooter` threads `glyphs.ellipsis` through, so ASCII
mode emits `...` and the default themes keep `…`. The first independent review then found a
remaining hardcoded U+2026 in `shortCwd` (deep cwd in ASCII mode) and in `toolPhrase`.
`5eb4d82` gives `shortCwd` an ellipsis parameter, passes `glyphs.ellipsis`, gives `toolPhrase`
an ASCII flag from `settings.ascii`, and drops an unfittable wide grapheme instead of leaving
an over-wide remainder. No width keeps the old full-text todo behaviour.

**Item 2 — pairing panel (dd11dd9, completed by 5eb4d82).** `wrap()` in
`remote-control/index.ts` now measures with `visibleWidth` and slices with
`sliceByColumn(rest, 0, room, true)`, so CJK, emoji, QR blocks and ANSI sequences stay inside
the requested width. `extension.json` declares the `@earendil-works/pi-tui` peer and
`docs/remote-control.md` states the column measurement.

**Evidence and records.** `tests/tui-layout-smoke.ts` is one consolidated smoke over all four
surfaces: widths 20, 32, 40, 60, 80 and 120 (pairing also 2 and 3), plain and ANSI-dark themes,
ASCII, CJK and emoji input, and an all-ASCII assertion for ASCII mode. It fails on the base
code for both items. `docs/status-bar-and-costs.md` and the dated
`custom-footer/SOURCE.md` entry document the cuts, the shortened path and the tool phrase;
`THIRD_PARTY_NOTICES.md` is regenerated. `package.json` gains only the additive
`smoke:tui-layout` script, following the existing smoke-script convention; no existing script
is changed.

## Test justification

The new smoke adds assertions only; no existing assertion in `status-bar-smoke` or
`workflow-panel-smoke` was changed. It uses a fixed clock and no timers, model or network. The
ASCII state uses a deep cwd so the `shortCwd` path is actually exercised, and the pairing case
asserts both the narrow "needs a terminal of at least" message and the wide QR output. The
`wrap` progress fallback drops the remainder of a word that starts with an unfittable wide
grapheme at absurd widths (2-3 columns); this is bounded and is the intended no-overflow
behaviour, not a weakened check.

## Left for later

- Non-blocking review note: the `wrap` fallback at widths 2-3 discards the rest of the word,
  including the emoji fingerprint; acceptable at those widths, but a future pass could render a
  placeholder instead.
- Open proposals unchanged: idle-cat frames (needs an intent decision), hub 1-4-row frame/mouse
  edges, inert Settings value rows, `TRUNK_CHANNEL` alias, inbox deadline edges, and the
  `workflow-hooks-smoke.ts` timer races.
- No new proposal was needed for this cycle.

## For the next cycle

- Never run `npm test` / `npm run check:all`; the host gate owns the full suite.
- Add the `autonomy/JOURNAL.md` line in the same push as a new `report.md` or `smoke:docs` fails.
- Gated `workflow_run` plans do not auto-retry after a reviewer `VERDICT: FAIL`; read the
  verdict yourself and issue the retry as a second plan.
- A whole-diff reviewer can be killed by automatic compaction. Per-item gated reviewers plus a
  negative run against base are the accepted substitute, and the substitution must be stated in
  `verify.md`.
- Non-record diff is 32,738 characters, above the 30,000 stop-new-work threshold but below the
  60,000 review limit; no new item was started after it crossed, and the remainder was the
  review fix and records.
