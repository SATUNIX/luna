# Verify — cycle 09, run `luna-core-01`, stream `core`

Base `5a888fe5dcf2`. Every command below was run on the cycle tree (`pi/luna-core-01`) unless noted.
Never ran `npm test` or `npm run check:all`; only targeted checks.

## Rejection reproduced and fixed

- `node tests/docs-smoke.ts` in a worktree of `origin/attempts/luna-core-01/cycle-08` — **FAIL**:
  `AssertionError: autonomy/JOURNAL.md disagrees with the cycle reports` /
  `report with no journal entry: luna-core-01/08` (exit 1 at `tests/docs-smoke.ts:518`). This is the
  acceptance failure `check-all` / `check-all:smoke:docs` that blocked the cycle-08 merge.
- Fix: cycle-08's records are not carried, so no cycle-08 journal entry is owed; cycle-09 adds its
  own `autonomy/JOURNAL.md` line matched to its report. See the final `docs-smoke` line below.

## PG-55 (carried over `0471c71`, `bf74303`)

- `node tests/autonomy-selfimprove-smoke.ts` — **PASS**: `[autonomy-selfimprove-smoke] all 41 checks
  passed` (status/state expose the blocker and `unpublished`; the prompt names the refused commit and
  location; block after two merged-but-unpublished cycles; clean publish clears all three; a
  non-merged cycle no longer resets the streak).
- `node tests/autonomy-cli-smoke.ts` — **PASS**: `[autonomy-cli-smoke] all 16 checks passed`.
- `node tests/autonomy-smoke.ts` — **PASS**: `[autonomy-smoke] all 32 checks passed`.

## PG-57 (`3c643fc`)

- `node tests/workflow-smoke.ts` — **PASS**: `[workflow-smoke] all 13 checks passed`; the outputs
  fixture asserts both the passing and failing tasks name `path.join(dir, "report.md")` and "exact
  file is absent", the failure names the absolute path, and the missing-output path ran exactly one
  agent.
- `node tests/workflow-plan-smoke.ts` — **PASS**: `workflow-plan smoke: 91 checks passed`; exact
  failure string updated to `declared output(s) not written in ${dir}: ${path.join(dir,
  "report.md")}`.
- `npx tsc -p tests/tsconfig.json` — **PASS** (exit 0, no diagnostics).
- `npm run test:lint` — **PASS** (exit 0, `--max-warnings 0`).

## Docs / wiring

- `node tests/docs-smoke.ts` — **PASS**: `[docs-smoke] OK: 14 documented commands validated, 62
  relative links resolved; ... 97 shipped pages name no removed delegation surface` (exit 0; the
  journal gate is green with the new `luna-core-01/09` line).
- `node packages/core/check-all.ts --check-wiring` — **PASS**: `check-all: every test file is wired
  into a script and asserts something`.

## Independent review

A `subagent` reviewer that did not write the change reviewed `git diff 5a888fe5dcf2..HEAD` for the
PG-57 files and returned `VERDICT: PASS` (task now names the absolute output path and absence
contract; failure names the absolute path and still fails; single launch on the failing path; scope
limited to the four intended files; TypeScript clean). PG-55's implementation had already been
reviewed PASS in cycle 08 and was re-run green here.

## Diff budget

`git diff --no-renames 5a888fe5dcf2..HEAD -- . ":(exclude)package-lock.json"
":(exclude)autonomy/cycles/luna-core-01/" ":(exclude)autonomy/runs/luna-core-01/" | wc -c` =
**26,740** chars (under the 60,000 read budget; past the 30,000 stop-new-items mark, so no further
items were taken).

## Not run

The full suite (`npm test` / `npm run check:all`) and `tests/timing-load-check.ts` (PG-51 not
carried this cycle); the host gate runs the full suite on a clean checkout.
