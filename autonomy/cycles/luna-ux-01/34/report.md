# Cycle 34 — Report (run `luna-ux-01`, stream `ux`)

Outcome: successful
Mode: fix

Item: `/footer` and `/tips` keep the shared `ui.json` settings - be41afb (plan/review record:
5d08454) - `npm run smoke:status-bar` 27/27, new case `uiSettingsMergePreservesForeignKeys` fails
1/27 with only the base `custom-footer/index.ts` restored and passes at HEAD; `npm run smoke:docs`,
`npm run test:typecheck` and `npm run test:lint` pass; read-only independent reviewer
`VERDICT: PASS`.

## What changed

- `packages/extensions/third_party/custom-footer/index.ts`: `saveSettings()` now parses the existing
  `<agent dir>/pi-kit/ui.json` (absent or non-object → `{}`), merges the status bar's owned fields
  (`footer`, `mode`, `tips`, `todos`, `cat`, plus `ascii` only when on) over it, deletes `ascii`
  when it is off, and writes the merged object. A read or write failure still returns the message
  and never throws.
- `tests/status-bar-smoke.ts`: new case seeds `hubKey`, `commandMenu`, `pinnedCommands`,
  `hiddenCommands`, `launchScreen`, `reducedMotion`, then runs `/footer light`, `/footer ascii on`,
  `/footer ascii off` and `/tips off`, asserting each foreign value survives and the owned fields
  change. Fails on the base source.
- `docs/status-bar-and-costs.md`: the shared-file note now says the status bar keeps the hub, menu,
  launch-screen and motion keys.
- `CHANGELOG.md`: one `[Unreleased]` Fixed entry naming `npm run smoke:status-bar`.
- `autonomy/proposals/luna-ux-01-33-ui-json-settings-clobber.md`: marked closed (implemented here).

## Review history

The first whole-diff reviewer inspected everything and ran the smoke green but was killed by
context compaction before its verdict; a second reviewer independently reproduced the base failure
and then hung on its final turn, leaving the base source staged. The parent restored the file from
`HEAD` (verified by `cmp` against the reviewer's snapshot, then 27/27) and a third read-only
reviewer returned PASS. Details are in `verify.md`.

## Left for later

- Merging a top-level array-shaped `ui.json` spreads it into numeric keys; `isRecord` accepts
  arrays. Not reachable from a normal write and not a regression, but a shape check would be
  tighter. No case covers a malformed existing file on the merge path.
- `saveSettings()` writes in place, so a crash mid-write can truncate the now-shared file
  (pre-existing; a temp-file rename would harden it).
- Still deferred from earlier handoffs: idle-cat blink needs an intent decision; older pre-range ux
  changes and non-TUI user-visible changes still lack Unreleased entries.
- No package script, profile, charter or control path changed. No full suite was run by design; the
  host gate owns it.
