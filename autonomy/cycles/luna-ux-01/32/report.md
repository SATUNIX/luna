# Cycle 32 — Report (run `luna-ux-01`, stream `ux`)

Outcome: successful
Mode: fix

Board: DE-98 done - the seven user-visible ux changes merged in the board's range now have accurate
`## [Unreleased]` CHANGELOG entries, the `/remote` entry names the smoke that actually pins the CJK
fix, and the pairing QR fixture is back at 25 rows.

Item: DE-98 release record and QR fixture restore - 7cf9075 - `npm run smoke:tui-layout` 4/4,
`smoke:docs`, `smoke:remote-control` 16/16, `smoke:status-bar` 26/26, `smoke:workflow-panel` 20/20,
`smoke:control-center` 45/45, `test:typecheck`, `test:lint`, `verify`; fresh independent reviewer
`VERDICT: PASS`.

## What changed

- `CHANGELOG.md` `## [Unreleased]` / `### Fixed` gains one entry per user-visible change the board
  listed: workflow-panel selection by run id and short-terminal fit, the Security page reading
  `securityEffective`, the todo widget re-cut at pi's width, the `/remote` pairing wrap by visible
  width, footer tool-phrase/ASCII handling, status-bar and todo column-aware cuts, and
  VS16/keycap/tab width parity. Each names the smoke that pins it.
- `tests/tui-layout-smoke.ts`: the pairing QR fixture goes back to `size = 25`, keeping both long
  IPv4/IPv6 addresses. Cycle 29 had cut it to 21 while lengthening the addresses. The restored
  fixture is stricter than the original 25-row one (which had short addresses) and matches
  `docs/remote-control.md`. The changed-test justification is at the top of `verify.md`.

## Correction to the carried-over work

Cycle 31's sound source change was on `origin/pi/luna-ux-01-cycle31`, not the attempts ref that the
merge review saw. This cycle brought it over as `7cf9075`. A scout found one inaccurate claim in
it: the `/remote` entry said `smoke:remote-control` pinned the CJK fix, but that smoke uses an
ASCII fixture and passed before the fix. The entry now names `smoke:tui-layout` as the pin and says
`smoke:remote-control` also exercises the panel. The independent reviewer verified the corrected
text and every other entry against the merged code.

## Left for later

- No source behaviour changed beyond the fixture; no script, profile, charter or control path
  changed. Non-record diff is 4,648 characters, far below the stop-new-work threshold.
- The full suite was not run by design; the host gate owns it.
- Open proposal `autonomy/proposals/luna-ux-01-30-run-card-input-hold.md` (run approval cards never
  register an input hold) is a real deferred defect; it needed its own reproduction and was below
  the board item.
- The scout noted pre-range ux changes and non-TUI user-visible changes with no Unreleased entry;
  they were outside DE-98's assigned list and are recorded in `HANDOFF.md` for a future
  release-hygiene item.
