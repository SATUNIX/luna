# Cycle 08 report: curated / menu ASCII under PI_KIT_ASCII

Outcome: successful
Mode: fix

Board: V-09 done - already merged and pinned on the base (bolded 2026-11-12 subagent SOURCE.md entry naming wf-panel.ts/23725c2, docs-smoke provenance scan); re-checked by the independent reviewer, not reopened.
Board: V-93 done - already merged and verified on the base (one shared visible-text.ts, generated copies, no re-declarations); re-checked with imports and the generated-copy drift check, no code change.

Item: Curated `/` menu hints honour PI_KIT_ASCII - 4ff581a5, 7b500bd8 - `node tests/command-menu-smoke.ts` 15/15; the new case fails on the base (`ASCII mode uses the printable separator and arrow`) and on 4ff581a5 (unfolded `Plan → implement → review`).
Item: V-09 provenance clause - no code commit (already merged at the base) - `npm run smoke:docs`, which runs the subagent `SOURCE.md` assertion and the every-vendored-SOURCE dated scan.
Item: V-93 shared hidden-character filter - no code commit (already merged at the base) - `npm run verify` (generated-copy drift), `smoke:docs`; reviewer confirmed one hand-written source and the import sites.

## What changed and why

The curated `/` menu's hidden-suggestion hints were hard-coded to `moved → /menu ▸ Page ▸ Row`
and a ` — ` description separator. `docs/reference.md:447` assigns `PI_KIT_ASCII` to
control-center, and the launch screen and vendored footer already render printable ASCII under
`PI_KIT_ASCII=1`, so on exactly that terminal the `/` suggestions still contained U+2192, U+25B8
and an em dash.

`command-menu.ts` now takes an `ascii` option (default false, so default output is byte-identical)
through `locationOfRow`, `hubLocationFor`, `locationFor` and `CurationOptions`, adds
`ALL_COMMANDS_LOCATION_ASCII`, and folds page/row label glyphs (`→` to `->`, `▸` to `>`, dashes,
bullets, ellipsis). `index.ts` passes `process.env.PI_KIT_ASCII === "1"`. The first commit made the
menu's own glyphs ASCII but interpolated labels verbatim; an independent review caught that
`/orchestrate-implement-review` still emitted U+2192 from `model.ts:165`, and `7b500bd8` folds the
labels and narrows the docs claim (a command's own description after the hint is unchanged). The
new smoke case pins the ASCII location, the no-row and no-description paths, the folded label and
the unchanged Unicode default.

Verification: `check-all --for-changed` named 7 checks; all RAN and PASS (table in `verify.md`),
plus a scoped eslint run. Two independent reviewers: the first FAILed on the label leak, the
second PASSed the fix.

## Left and next

- Off-limits but evidenced: a single right-side critical footer chip is dropped at 20-37 columns
  by `custom-footer/render.ts:229-232`; proposed in
  `autonomy/proposals/luna-ux-01-08-footer-critical-chip-narrow.md`, together with the latent
  `asciiThemeName` env-clause drift.
- Not taken: the `/` hint follows `PI_KIT_ASCII` only, not the theme-name ASCII choice
  (`iso`/`ansi`/`tty`/`ascii`), so a future theme-driven hint would need that parity; and
  `asciiLabel` folds a fixed glyph set, so a future non-ASCII hub title should extend it (a
  model-wide ASCII assertion would make that self-enforcing).
- Cycle 08 records from an earlier merged attempt (V-73/PG-12, base `e22aac206685`) were replaced
  by this cycle's records; those code changes remain in the tree.
