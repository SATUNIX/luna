# Cycle 18 — Plan (run `luna-ux-01`, stream `ux`)

Mode: **fix**. No assigned board items. Work order: handoff carry-over (the typed-command
proposal), then an evidenced docs defect.

## Item 1 — Show each row's typed command in the TUI and RPC

**Justification.** Charter priority 3 (handoff carry-over) and 4 (documented contract not met):
`autonomy/proposals/luna-ux-01-17-hub-typed-command-in-tui-rpc.md` records that
`docs/control-center.md:3-5,45` and the Help row (`hub.ts:186`) promise every row shows its typed
command, but only the print/json renderer does. The RPC `rowLabel` (`hub.ts:308-313`) renders only
an informational row's `command`, and the TUI `SettingItem` (`hub.ts:329-340`) renders neither
`legacy` nor `prefill`. Reproduce in the existing fakes: an RPC `/menu ▸ Autonomy` dialog has no
`/auto`; a TUI render of that page has no `/auto` either.

**Change.** In `hub.ts`, add one helper that resolves a row's typed command
(`legacy ?? trimmed non-empty prefill ?? command`), strips terminal sequences and remaining control
characters, and returns a two-space `[command]` suffix that is omitted when the label already is the
command. Use it in `textPage`, `rowLabel` and the TUI `SettingItem` label. Keep `row.label`,
`description` and `currentValue` untouched: `SettingsList` uses `description` only for the focused
row and `currentValue` for value cycling, and the model's label is used by search and tests. Append
the suffix before the existing `(unavailable)` marker so unavailable rows keep their reason.

**Tests.** Extend `tests/control-center-smoke.ts`:
- an RPC `Autonomy` dialog option contains `[/auto]`, and a `Session` option contains `[/compact]`
  (a prefill row);
- a TUI render of `Autonomy` contains `[/auto]`, and the Help/Doctor informational row still shows
  its command;
- an `All commands` render and RPC dialog does not duplicate a command whose label is already
  `/<name>` (the existing exact-option assertion must stay green);
- a narrow-width (for example 30 columns) render keeps the row label even when the suffix no longer
  fits.

Each new assertion must fail against the pre-fix source, then pass. Update
`docs/control-center.md` to state the chosen behaviour: every renderer shows the typed command in
`[command]` form, the row name is kept first on a narrow terminal, and the All commands page does
not repeat its own name.

**Checks.** `npm run smoke:control-center`, `npm run smoke:command-menu`, `npm run smoke:docs`,
`npm run test:typecheck`, `npm run test:lint`, `npm run verify`. Never `npm test` /
`npm run check:all`.

## Item 2 — Correct the stale `alert` claim in the cat docs

**Justification.** Charter priority 4 and 6 (documentation accuracy). `docs/status-bar-and-costs.md`
lists `alert` as a reachable result ("needs attention") in both the priority sentence and the table,
but no `setResult` caller passes it (`custom-footer/index.ts:507,524,534`), so the cat's `alert`
animation can never play. The same page already names `retrying` and `sleeping` as faces nothing
reports; `alert` is the missing one.

**Change.** Remove `alert` from the reachable-result row and add it to the "Not covered" sentence
with the other unreported faces. Keep the animation table and priority list unchanged: the face
stays available for a future driver.

**Checks.** `npm run smoke:docs`, `npm run test:typecheck`, `npm run test:lint`, `npm run verify`.

## Out of this cycle

- Overlay below five terminal rows drops the focused row -> proposal
  `autonomy/proposals/luna-ux-01-18-short-overlay-drops-focus.md`.
- `/kit` and `/helpers` hidden hints point at All commands: the docs define that fallback as
  intended; no change.
- No `npm test` / `npm run check:all` in this cycle; the host gate owns the full suite.
- Keep the diff under 30,000 characters excluding records and lockfile.
