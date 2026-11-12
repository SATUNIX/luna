# Cycle 08 — Verify (run luna-ux-01, stream `ux`)

Base `e22aac206685` (head of `stream/ux` after cycle 07), branch `pi/luna-ux-01`, head `f546953`
before the record commit. `npm test` and `npm run check:all` were not run, per the cycle rules.

## Targeted checks

| Command | Result | Proof line |
| --- | --- | --- |
| `npm run smoke:command-contract` | PASS | `[command-contract-smoke] all 12 checks passed` |
| `npm run smoke:control-center` | PASS | `[control-center-smoke] all 30 checks passed` |
| `npm run smoke:workflow-panel` | PASS | `workflow-panel-smoke: 14 checks passed` |
| `npm run smoke:firewall-approvals` | PASS | `[firewall-approvals-smoke] all 13 checks passed` |
| `npm run smoke:firewall-gate` | PASS | `[firewall-gate-smoke] all 19 checks passed` |
| `npm run smoke:redaction-corpus` | PASS | `[redaction-corpus-smoke] all 5 checks passed` |
| `npm run smoke:update-notice` | PASS (PG-12 check) | `[update-notice-smoke] all 7 checks passed` |
| `npm run test:typecheck` | PASS | all `tsc -p …` projects complete, exit 0 |
| `npm run test:lint` | PASS | `eslint --max-warnings 0 .` exits 0 |
| `node packages/core/reference.ts --check` | PASS | `[reference] OK: docs/reference.md is up to date.` |
| `npm run verify` | PASS | `[verify] All checks passed.` |

Item-specific proof:

- V-73: `git grep -n 'Alias for' packages/extensions/src` prints nothing (exit 1). The changed
  descriptions start `Alias of /<target>`: `tool-firewall/index.ts:1400`/`:1403`,
  `web-console/index.ts:657`. `npm run catalog` exits 0 and leaves no diff beyond the committed
  `docs/reference.md`. The `alias-target-missing` fixture pair (a registered-command / built-in /
  prompt-template target passes, `/ghost` is reported) and the parser fixtures are in
  `tests/command-contract-smoke.ts`; `aliasDeclarationsInSource` is a separate helper and
  `registeredCommandsInSource` is unchanged.
- Overlay dim leak: new `tests/control-center-smoke.ts` case (f) asserts a throwing `build`
  propagates and `compositeOverlays` returns the undimmed base. Without the try/catch the patch
  stays installed, so that second assertion fails; with it the smoke passes.
- The two `overlay-frame.ts` copies are still byte-identical (`diff` empty; smoke asserts it).

## Independent review

One `reviewer` subagent, which wrote nothing in this cycle, reviewed
`git diff e22aac206685..HEAD` against the plan and `autonomy/CHARTER.md` and returned
**VERDICT: PASS**, with no must-fix issue. It confirmed both changes are real and tested, the base
lacks each fix (so the new assertions fail without them), no test was weakened or deleted, no
`package.json` scripts / command names / `HARNESS_COMMANDS` changed, both overlay copies remain
byte-identical, the branch is pushed (`git ls-remote origin refs/heads/pi/luna-ux-01` ==
`git rev-parse HEAD`), `git status` is clean, and the diff excluding the lockfile and records is
23,155 characters (< 30,000). Its one warning — the pre-implementation plan/review prose still
called the dim fix "not taken" — is corrected in the updated `plan.md`/`review.md`.

## Process note

The first `workflow_run` implementer staged the V-73 cherry-pick but did not commit; its reviewer
returned FAIL on exactly that, and the host gate mis-matched the verdict. The second workflow's
implementer returned no output, so the change was finished directly: removed the stray cycle-05
record files, added the reviewer's prompt-template fixture and the slice-boundary comment, then
committed and pushed. A second independent reviewer passed the final head.

## Gate / budget

Full diff `e22aac206685..HEAD` is **23,155** characters excluding the lockfile and records (under
the 30,000 stop-taking threshold and the 60,000 review threshold). Changed non-record files:
`packages/core/lib/command-contract.ts`, `packages/extensions/src/tool-firewall/index.ts`,
`packages/extensions/src/web-console/index.ts`,
`packages/extensions/src/control-center/overlay-frame.ts`,
`packages/extensions/third_party/subagent/overlay-frame.ts`, `tests/command-contract-smoke.ts`,
`tests/control-center-smoke.ts`, `docs/reference.md`. No `package.json` change; no control path.
