# Cycle 34 — Review (run `luna-ux-01`, stream `ux`)

Mode: **fix**. Base `93481e6b8904`; branch `pi/luna-ux-01`. No assigned board items.

## Charter and inputs

`autonomy/CHARTER.md` is the acceptance standard (evidence, test, docs, green checks, one logical
change per commit). Read: cycle 33's `report.md`, `autonomy/runs/luna-ux-01/HANDOFF.md`, all open
`autonomy/proposals/luna-ux-01-*.md`, and `git log --oneline 93481e6b8904..HEAD` (empty; the branch
is at the stream head). No red gate and no upstream conflict.

## Findings (evidence)

### Carry-over defect: `/footer` and `/tips` clobber the shared `ui.json`

The handoff names `autonomy/proposals/luna-ux-01-33-ui-json-settings-clobber.md` as the
highest-value open defect. Re-checked against HEAD, it is real:

- `packages/extensions/third_party/custom-footer/index.ts:68-86` `loadSettings()` returns a
  six-field projection (`footer`, `mode`, `tips`, `todos`, `cat`, optional `ascii`), discarding
  every other key in the file.
- `:89-97` `saveSettings()` writes that projection wholesale with
  `JSON.stringify(settings, null, 2)`.
- Every valid `/footer` change (`:560`) and `/tips` (`:648`) persists through it.
- The same file is shared: `hubKey` (`control-center/index.ts:70,91-92`), `commandMenu` /
  `pinnedCommands` / `hiddenCommands` (`control-center/command-menu.ts:79,139-141`),
  `launchScreen` and `reducedMotion` (`control-center/launch-screen.ts:62` and
  `docs/control-center.md:20-44`).

So one `/footer light` or `/tips off` silently drops the user's hub key, `/` menu scope, launch
screen choice and reduced-motion setting; they revert on reload. This is in the ux stream's area
(the `/` menu, launch screen and motion settings are the keys lost). Silent data loss, priority 4
(defect) and the first item in the handoff's "next cycle should know".

Existing coverage does not catch it: `tests/status-bar-smoke.ts:360-425` asserts the exact
six-key file after `/footer config` and never seeds a foreign key, so the clobber passes today.

### Other candidates checked

- **Idle-cat blink**: still needs an intent decision recorded in the handoff; not a defect with a
  demonstrable user impact, so no change this cycle.
- **Older pre-range ux changes without `[Unreleased]` entries**: documentation bookkeeping, below a
  data-loss defect; leave for a later documentation pass.
- No new defect was found in overlays, the `/` menu, launch screen or animation beyond this one.

## Item and precedence

1. Fix `saveSettings()` to merge its owned fields over the existing JSON object (preserving foreign
   keys) and add a seeded-file test plus the docs/CHANGELOG update. Fix mode, one logical change.
2. The remaining candidates are recorded above and in the handoff, not started.
