# `/footer` and `/tips` erase unrelated settings from the shared `ui.json`

Run `luna-ux-01`, cycle 33 (stream `ux`). Status: **closed** — implemented in cycle 34 by
`be41afb` (`saveSettings` merges the owned fields over the parsed file; new smoke case
`uiSettingsMergePreservesForeignKeys`; `docs/status-bar-and-costs.md` and `CHANGELOG.md` updated).

## Finding

`packages/extensions/third_party/custom-footer/index.ts` reads `<agent dir>/pi-kit/ui.json` as a
six-field projection (`loadSettings`, `:68-86`: `footer`, `mode`, `tips`, `todos`, `cat`, `ascii`)
and writes it back wholesale (`saveSettings`, `:89-97`). Every valid `/footer` and `/tips` command
persists through it (`:559-562`, `:647-648`).

The same file is the shared UI settings file: `control-center` reads `hubKey`, `commandMenu`,
`pinnedCommands`, `hiddenCommands`, `launchScreen` and `reducedMotion` from it
(`docs/control-center.md:20-27`, `docs/status-bar-and-costs.md:23`). One `/footer light`,
`/footer ascii off` or `/tips off` therefore rewrites the file without those keys.

## Impact

High, silent data loss: a user who configured `alt+k`, `commandMenu: "all"`,
`launchScreen: "off"` or reduced motion loses those settings after the next status-bar command,
so the hub key, menu scope and launch behaviour revert on reload.

## Suggested fix

In `saveSettings`, parse the existing file (falling back to `{}` when absent or malformed), merge
the six owned fields over it, and delete only `ascii` when `settings.ascii` is not `true`; keep
every foreign key byte-for-byte. Add a case to `tests/status-bar-smoke.ts`: seed `ui.json` with
`hubKey`, `commandMenu`, `launchScreen`, `reducedMotion`; run `/footer light` and `/tips off`;
assert the foreign keys survive and the owned fields changed.

## Evidence

- `custom-footer/index.ts:75-82` projection, `:89-92` wholesale write.
- `docs/control-center.md:20-27` shared-file contract.
