# Run `luna-ux-01` — handoff

State after cycle 34 (branch `pi/luna-ux-01`, cycle base `93481e6b8904`, code head `be41afb` plus
the records commit). Report: `autonomy/cycles/luna-ux-01/34/report.md`, evidence in `verify.md`.

## What cycle 34 landed

- `be41afb` fixes the carry-over `ui.json` settings clobber: `saveSettings()` in
  `packages/extensions/third_party/custom-footer/index.ts` now parses the shared file (absent or
  non-object → `{}`), merges the status bar's owned fields (`footer`, `mode`, `tips`, `todos`,
  `cat`, `ascii` only when on) over it, and writes the merged object. `/footer light`,
  `/footer ascii off` and `/tips off` no longer drop `hubKey`, `commandMenu`, `pinnedCommands`,
  `hiddenCommands`, `launchScreen` or `reducedMotion`; a read or write failure returns the message
  and never throws.
- New case `uiSettingsMergePreservesForeignKeys` in `tests/status-bar-smoke.ts` seeds all six
  foreign keys and runs `/footer light`, `/footer ascii on`, `/footer ascii off` and `/tips off`.
  It fails 1/27 with only the base source restored and passes 27/27 at HEAD. `smoke:docs`,
  `test:typecheck` and `test:lint` pass; the non-record diff is 6303 characters.
- `docs/status-bar-and-costs.md` and `CHANGELOG.md` (Unreleased/Fixed) describe the merge.
- Proposal `luna-ux-01-33-ui-json-settings-clobber.md` is implemented and marked closed.
- Independent verdict came from a deliberately read-only `reviewer` subagent (`VERDICT: PASS`)
  after two earlier reviewer runs were killed/hung mid-turn; the second left the base source staged
  and the parent restored it from `HEAD` before the verdict.

## Next cycle should know

- Never run `npm test` / `npm run check:all`; the host gate owns the full suite.
- Any new `autonomy/cycles/<run>/<NN>/report.md` needs its `autonomy/JOURNAL.md` line in the same
  push or `smoke:docs` fails.
- A reviewer subagent that runs the base-vs-head check may leave the reverted source staged. Always
  check `git status` and restore the file before recording a verdict; `cmp` against a saved
  snapshot plus a green `smoke:status-bar` is the safe confirmation.
- Gated `workflow_run` plans here have reported `passed` even when the reviewer's final line was
  `VERDICT: FAIL`; read the reviewer output and act on it.
- Open, low-priority follow-ups from cycle 34's review: an array-shaped top-level `ui.json` is
  spread into numeric keys (`isRecord` accepts arrays); `saveSettings()` writes in place (a crash
  can truncate the shared file); no case covers a malformed existing file on the merge path.
- Still deferred: idle-cat blink needs an intent decision; older pre-range ux changes and non-TUI
  user-visible changes still lack Unreleased entries.
