# Cycle 32 — Verification (run `luna-ux-01`, stream `ux`)

Item: DE-98. Code head reviewed: `7cf9075` (with `794434c` the review/plan record). Base
`88572f57c2ed`.

## Changed-test justification

`tests/tui-layout-smoke.ts` changes only the pairing QR fixture from `size = 21` back to
`size = 25`; both long addresses stay. `git show eb739d5` shows cycle 29 cut the fixture to 21
while lengthening the addresses, so no behaviour or assertion is weakened. The original 25-row
fixture (`dd11dd9`) had short addresses, so the restored fixture is stricter than the original and
matches `docs/remote-control.md` ("about 25 rows"). No opt-out or loosened bound was added.

## Checks

| Check | Result | Proving line |
| --- | --- | --- |
| `npm run smoke:tui-layout` | PASS | `tui-layout-smoke: 4 checks passed` |
| `npm run smoke:docs` | PASS | `[docs-smoke] OK: 14 documented commands validated, 62 relative links resolved ...` |
| `npm run smoke:remote-control` | PASS | `remote-control extension smoke: OK (16 checks)` |
| `npm run smoke:status-bar` | PASS | `status-bar-smoke: 26/26 passed` |
| `npm run smoke:workflow-panel` | PASS | `workflow-panel-smoke: 20 checks passed` |
| `npm run smoke:control-center` | PASS | `[control-center-smoke] all 45 checks passed` |
| `npm run test:typecheck` | PASS | all eight `tsc -p ...` projects completed, exit 0 |
| `npm run test:lint` | PASS | `eslint --flag unstable_native_nodejs_ts_config --max-warnings 0 .`, exit 0 |
| `npm run verify` | PASS | `[verify] All checks passed.` |
| Diff size (non-record, no lockfile) | PASS | `4648` characters, below the 30,000 stop-new-work threshold |

The full suite (`npm test`, `npm run check:all`) was not run; the host gate owns it.

## Independent review

A fresh `reviewer` subagent that did not write the change reviewed
`git diff 88572f57c2ed..HEAD` against `autonomy/CHARTER.md` and DE-98. It checked all seven entries
against file:line evidence (`wf-panel.ts:686-831`, `hub.ts:187`/`values.ts:304-306`,
`custom-footer/index.ts:268-281,301-305,513`, `widgets.ts:10-50`, `render.ts:92-97,311-386`,
`remote-control/index.ts:2,133-157`, `width.ts:41-56`), confirmed the 25-row fixture with both long
addresses, confirmed only `CHANGELOG.md` and the fixture line changed, re-ran the six targeted
smokes and reported `VERDICT: PASS` with no critical or warning finding.

## Correction made during review

The scout found that the `/remote` entry originally said the fix was pinned by
`smoke:remote-control`; that smoke uses an ASCII fixture and passed before the CJK fix. The entry
now names `smoke:tui-layout` as the pin and says `smoke:remote-control` also exercises the panel.
The corrected entry is in `7cf9075`; the independent reviewer verified the corrected text.
