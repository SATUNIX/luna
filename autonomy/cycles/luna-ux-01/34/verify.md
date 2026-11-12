# Cycle 34 — Verification (run `luna-ux-01`, stream `ux`)

Item: `/footer` and `/tips` must not erase the shared `ui.json` settings. Code head `be41afb`;
base `93481e6b8904`.

## Checks

| Check | Result | Proving line |
| --- | --- | --- |
| `npm run smoke:status-bar` | PASS | `status-bar-smoke: 27/27 passed` (includes new case `uiSettingsMergePreservesForeignKeys`) |
| Base-vs-head proof | PASS | With only `packages/extensions/third_party/custom-footer/index.ts` reverted to `93481e6b8904`, the new case fails: `FAIL uiSettingsMergePreservesForeignKeys` / `+ undefined - 'alt+k'` at `assertForeign`, `status-bar-smoke: 1/27 failed`; restored file (`cmp` against a pre-copy snapshot) gives `27/27 passed` |
| `npm run smoke:docs` | PASS | `[docs-smoke] OK: 14 documented commands validated, 62 relative links resolved; balanced profile resolved; ...` |
| `npm run test:typecheck` | PASS | all eight `tsc -p` projects exit 0 |
| `npm run test:lint` | PASS | `eslint --flag unstable_native_nodejs_ts_config --max-warnings 0 .` exits 0 |
| Diff size (non-record, no lockfile) | PASS | 6303 characters, well below the 30000 stop-new-work threshold |

The full suite (`npm test`, `npm run check:all`) was not run; the host gate owns it.

## Independent review

The first reviewer attempt (`reviewer-9f4787`) inspected the full diff, both commits, `CHANGELOG.md`,
`docs/status-bar-and-costs.md` and the new test, then ran `smoke:status-bar` green and was
interrupted by automatic context compaction before returning a verdict. A second attempt
(`reviewer-850132`) independently re-ran the base-vs-head check (`FAIL uiSettingsMergePreservesForeignKeys`
with the base source, restored, 27/27) and then hung on its final turn; it also left the index with
the base file staged. The parent restored `packages/extensions/third_party/custom-footer/index.ts`
from `HEAD`, confirmed `cmp` against the snapshot the reviewer had taken (`SAME_AS_HEAD_SNAPSHOT`)
and re-ran `27/27`. A third, deliberately read-only `reviewer` subagent (no test runs, no writes)
then returned `VERDICT: PASS` with no critical finding.

Warnings it left, not blockers (recorded as leftovers): `isRecord` accepts a top-level array, so an
array-shaped `ui.json` is spread into numeric keys instead of being ignored; the write is not atomic
(pre-existing); no case covers a malformed existing file on the merge path.

## Changed-test justification

No existing assertion was weakened or deleted; the diff adds one case. `uiSettingsMergePreservesForeignKeys`
seeds `ui.json` with `hubKey`, `commandMenu`, `pinnedCommands`, `hiddenCommands`, `launchScreen` and
`reducedMotion`, then runs `/footer light`, `/footer ascii on`, `/footer ascii off` and `/tips off`
and asserts every foreign value survives while the owned fields change and `ascii` is gone when off.
It fails on the base source and passes at HEAD.
