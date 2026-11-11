# Report — cycle 05, run `luna-core-01`, stream `core`

Outcome: **successful**
Mode: **fix** (P0 gate) then **improve** (PG-10)

Base `266dcf6e2ef5`; commits `4ab96f8`, `27d638b`, `2be85f8`. Reviewable diff 49,852 chars
(records and lockfile excluded), under the 60,000 read budget.

## Board

Board: PG-10 done - added an opt-in `trunk` channel (head of `integration/luna`) to the
distribution metadata, `install.ts --channel trunk` and `kit-update`, so a merged cycle is
dogfoodable without a `main` merge; `latest` stays the default.
Board: PG-27 blocked - deferred to the next cycle: the reviewable diff was already past the
30,000 stop-new-items mark, and a scout only confirmed the baseline artefact is absent.

## Items

Item: P0 red CI gate — record luna-core-01/02 in the team journal and fix cycle-02 Board lines
— `4ab96f8` — `node tests/docs-smoke.ts` exits 0 (was `report with no journal entry:
luna-core-01/02`); `npm run smoke:redaction-corpus` exits 0.
Item: PG-10 trunk channel for the integration branch — `27d638b` (feature), `2be85f8` (docs) —
`npm run smoke:kit-update-channel` (6 checks), `npm run smoke:kit-update` (40 checks),
`npm run test:typecheck`, `npm run test:lint`, `node packages/core/reference.ts --check`.

## Test justification

No existing test was weakened. The gate fix changes only `autonomy/JOURNAL.md` and the
`Board:` lines of `autonomy/cycles/luna-core-01/02/report.md` so the committed data matches
`packages/core/lib/journal.ts`'s `REPORT_BOARD` grammar; `tests/docs-smoke.ts` is untouched.
`tests/kit-update-channel-smoke.ts` is a new file and `smoke:kit-update-channel` is the one
allowed `package.json` addition (`node tests/<name>-smoke.ts`). The gate enumerates it via
`packages/core/lib/wiring.ts`.

## What happened

Cycle 04 was rejected for a failing acceptance gate, not on its merits, so this cycle re-lands
its sound work on the current base. `4ab96f8` is the cherry-picked gate fix: PR #62's
`verify (2)`, `coverage` and both `pi-compat` lanes were one cause, `smoke:docs` failing on a
missing `luna-core-01/02` journal line plus non-canonical cycle-02 board lines. All three
smokes named red in cycle 04's acceptance (`redaction-corpus`, `env-isolation`,
`workflow-resume`) pass on this base; the red set was the `check-all` cascade. `27d638b` +
`2be85f8` are the cherry-picked PG-10 trunk channel, commit-message id reworded to the new
`PG-10` form. A `reviewer` subagent that did not write the change returned `VERDICT: PASS` on
the whole diff.

## Left for next cycle

1. **PG-27 (eval baseline).** Confirmed absent (`packages/core/eval/baseline.ts`,
   `tests/eval-baseline-smoke.ts` and any score artefact); `npm run eval` runs 17/17 fixtures
   but records nothing. The next board item; implement on a clean diff.
2. **`trunk` on npm delivery** (`--mode npm --channel trunk` would build the non-existent
   dist-tag `npm:@satunix/pi-system@trunk`; `latest|next|trunk` is advertised on the npm
   pinned note) and four prose channel enumerations that omit `trunk` — filed as
   `autonomy/proposals/luna-core-01-05-npm-trunk-channel.md`. Not on the live path (npm
   delivery is disabled).
3. Cycle 03's env-ownership work is still only on `origin/attempts/luna-core-01/cycle-03`.
4. Proposal `luna-core-01-03-codeowners-dead-path.md`: `.github/` is a control path, operator
   decision.
5. The `coverage` CI job is red owner-side; not touched, per the steward.
