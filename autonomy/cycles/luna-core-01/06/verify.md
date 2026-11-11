# Verify — cycle 06, run `luna-core-01`, stream `core`

Base `ce87a25c92de`; commits `70bd6d1` (records), `9139ad6` (PG-27), `5fe9e95` (trunk consolidation).
Reviewable diff 37,823 chars (lockfile and records excluded), under the 60,000 read budget.

## Targeted checks (command — result — proving line)

- `node tests/eval-baseline-smoke.ts` (also `smoke:eval-baseline`) — PASS — `[eval-baseline-smoke] all 4 checks passed`.
- `npx tsc -p packages/core/tsconfig.json` — PASS — no diagnostics.
- `npx tsc -p tests/tsconfig.json` — PASS — no diagnostics.
- `npm run test:lint` — PASS — `eslint --max-warnings 0 .` exit 0.
- `node tests/docs-smoke.ts` — PASS — `[docs-smoke] OK: 14 documented commands validated, 62 relative links resolved ...`.
- `node packages/core/check-all.ts --check-wiring` — PASS — `every test file is wired into a script and asserts something`.
- `npm run smoke:kit-update-channel` — PASS — `[kit-update-channel-smoke] all 7 checks passed` (was 6; the new npm/trunk case is #7).
- `npm run smoke:kit-update` — PASS — `[kit-update-smoke] all 40 checks passed`.
- `npm run smoke:distribution` — PASS — `[distribution-smoke] all 14 checks passed`.

Never ran `npm test` or `npm run check:all`; the host gate runs the full suite on a clean checkout.

## Independent review

- **PG-27 (`9139ad6`) — VERDICT: PASS** from a `reviewer` subagent that did not write the change.
  It ran the four targeted checks above, confirmed the smoke cannot pass at the base (the module it
  imports does not exist), that no existing test was weakened, that no `any`/cast/eslint-disable
  was added, that `package.json` gained exactly the one `smoke:eval-baseline` line, that `tokens`
  is honestly labelled an offline chars/4 estimate, and that the committed baseline parses and is
  not wired into a CI path that could go stale-red. Only cosmetic observations (guard totals unused,
  docs cite the script not the file); neither blocks acceptance.
- **Item 2 (`5fe9e95`) — review could not be delegated.** The gated `workflow_run` plan was refused
  by the effort child-budget (`up to 2 more would fit this request`), the `subagent` implementer ran,
  and the follow-up `subagent` reviewer was then denied (`child invocations for this request are used
  up (3/3)`). This reviewer of record inspected `git show 5fe9e95` against the plan and charter and
  re-ran every targeted check above (all green); the merge reviewer sees this diff. The install.ts
  guard is only reachable once `npm.enabled` is turned on, so it is covered by inspection, not by a
  test; the testable `kit-update` npm-switch refusal is covered by the new smoke case.
- **PG-27 gated plan note.** The first `workflow_run` for PG-27 launched all four agents but its
  final `reviewer` returned no output, so the gate reported FAIL after one loop with no finding to
  act on; the standalone `reviewer` subagent above is the review of record.

## Diff budget

37,823 chars at the final commit. The cycle stopped taking new items after this point (past the
30,000 stop-new-items mark), so no work beyond Items 1 and 2 was started; the PG-10 board item was
already merged and needed none.
