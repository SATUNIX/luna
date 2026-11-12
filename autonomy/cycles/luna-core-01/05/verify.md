# Verify — cycle 05, run `luna-core-01`, stream `core`

Base `266dcf6e2ef5`, head `2be85f8`. Commits: `4ab96f8` (gate), `27d638b` + `2be85f8` (PG-10).
Reviewable diff (lockfile and the run's record dirs excluded): **49,852 chars** (measured with
`git diff --no-renames 266dcf6e2ef5..HEAD ...`), under the 60,000 read budget.

## Targeted checks (one line per run)

- `node tests/docs-smoke.ts` (also `npm run smoke:docs`) — **PASS** — `[docs-smoke] OK: 14 documented commands validated, 62 relative links resolved; ... 97 shipped pages name no removed delegation surface.` (was `AssertionError: autonomy/JOURNAL.md disagrees with the cycle reports`, `report with no journal entry: luna-core-01/02`).
- `npm run smoke:kit-update` — **PASS** — `[kit-update-smoke] all 40 checks passed`.
- `npm run smoke:kit-update-channel` — **PASS** — `[kit-update-channel-smoke] all 6 checks passed`, including `a trunk update and channel switch plan the integration branch, not a tag or main` and `the installer resolves --channel trunk to the integration branch offline`.
- `npm run smoke:redaction-corpus` — **PASS** — `[redaction-corpus-smoke] all 5 checks passed` (a smoke named red in the cycle-04 acceptance).
- `npm run smoke:env-isolation` — **PASS** — `[env-isolation-smoke] OK` (a smoke named red in the cycle-04 acceptance).
- `npm run smoke:workflow-resume` — **PASS** — `workflow-resume-smoke: 41 checks passed` (a smoke named red in the cycle-04 acceptance).
- `node packages/core/reference.ts --check` — **PASS** — `[reference] OK: docs/reference.md is up to date.`
- `npm run test:typecheck` — **PASS** — exit 0 (all workspace tsconfigs, including `tests/`).
- `npx tsc -p tests/tsconfig.json` — **PASS** — exit 0.
- `npm run test:lint` — **PASS** — exit 0, `eslint ... --max-warnings 0 .`.

Never ran `npm test` or `npm run check:all` (host gate runs the full suite on a clean checkout).

## Independent review

A `reviewer` subagent that did not write the change read the whole diff against
`autonomy/CHARTER.md` and returned `VERDICT: PASS`: the gate fix corrects malformed data
rather than weakening the check (`tests/docs-smoke.ts` untouched), `latest` remains the
default, `trunk` is opt-in, the new smoke is enumerated by the gate
(`packages/core/lib/wiring.ts`), and the change is scoped. Warnings were the npm-delivery edge
and the prose enumerations, filed as `autonomy/proposals/luna-core-01-05-npm-trunk-channel.md`
and not on the live path.

## Not run, by rule

`coverage` is red owner-side (the steward says do not touch it); `check-all`,
`ci-complete` and the `pi-compat` lanes run the full suite and are the host's.
