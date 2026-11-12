# Cycle 34 — Plan (run `luna-ux-01`, stream `ux`)

Mode: **fix**. One item, chosen from the handoff carry-over.

## Item 1 — `/footer` and `/tips` must not erase the shared `ui.json` settings

**Justification (charter).** Real, evidenced defect: `saveSettings()` rewrites
`<agent dir>/pi-kit/ui.json` from a six-field projection
(`packages/extensions/third_party/custom-footer/index.ts:68-97`), so `/footer light`, `/footer
ascii off` and `/tips off` drop `hubKey`, `commandMenu`, `pinnedCommands`, `hiddenCommands`,
`launchScreen` and `reducedMotion`, all owned by `control-center` and stored in the same file
(`docs/control-center.md:20-44`). Silent loss of the stream's launch/menu/motion settings; highest
value open item in `autonomy/runs/luna-ux-01/HANDOFF.md`.

**Change.**

- `saveSettings()`: read and parse the existing file as an object (absent or malformed → `{}`),
  merge the six owned fields over it, drop `ascii` only while it is not `true`, and write the
  merged object. Foreign keys keep their values; a write failure still returns the message and
  never throws.
- `tests/status-bar-smoke.ts`: extend `commandsRejectInvalidArgumentsWithoutMutation` (or add a
  sibling case) to seed `ui.json` with `hubKey`, `commandMenu`, `pinnedCommands`,
  `hiddenCommands`, `launchScreen` and `reducedMotion`, then run `/footer light`, `/footer ascii on`,
  `/footer ascii off` and `/tips off`, asserting every foreign key survives with its value while
  the owned fields change. The case must fail on base.
- `docs/status-bar-and-costs.md`: say the status bar keeps the other keys in the shared
  `ui.json` (hub, menu, launch screen, motion).
- `CHANGELOG.md`: one `[Unreleased]` Fixed entry naming the smoke that pins it.

**Checks.** `npm run smoke:status-bar`, `npm run smoke:docs` (docs/CHANGELOG bookkeeping),
`npm run test:typecheck`, `npm run test:lint`. Never `npm test` / `npm run check:all` (host gate).

**Acceptance.** The new case fails on `93481e6b8904` and passes with the fix; no behaviour outside
the settings write changes; independent reviewer PASS.
