# Verify — cycle 10, run `luna-core-01`, stream `core`

Base `559f2d99edbf` (head of `stream/core`). This cycle's commits: `106bc4d` (review + plan),
`f24a144` (the fix), plus the records commit.

## Reviewable diff

`git diff --no-renames 559f2d99edbf..HEAD -- . ":(exclude)package-lock.json"
":(exclude)autonomy/cycles/luna-core-01/" ":(exclude)autonomy/runs/luna-core-01/" | wc -c`

Measured **7,317 chars** at `f24a144` — well under the 60,000 read budget and the 30,000
stop-new-items mark. Files: `docs/autonomy.md`, `packages/autonomy/lib/engine.ts`,
`packages/autonomy/lib/lifecycle.ts`, `packages/autonomy/lib/templates/self-improve.ts`,
`tests/autonomy-selfimprove-smoke.ts` (+50/-5). No lockfile, charter, operator control path, or
`package.json` `scripts` change, so the change is mergeable.

## Assigned items

### PG-55 [P0] — publish block must stop the run loudly (defect in the merged cycle-09 work)

The stop/prompt/status machinery from cycle 09 is present and tested; the defect was the operator
exit path (`review.md`). The fix makes `runStep` consume a `publish-blocked` `pendingAnswer` once
and run one cycle, then re-park if publication is still refused. One cycle per answer, self-limiting.

### PG-57 [P1] — a declared-output step names the output file

Implemented in cycle 09 (`3c643fc`) and merged; no defect found, no change this cycle.

## Checks run (all PASS; `npm test` and `npm run check:all` never run)

| Check | Result |
| --- | --- |
| `node tests/autonomy-selfimprove-smoke.ts` | all 42 checks passed (41 before; +1 new PG-55 answer case) |
| `node tests/autonomy-smoke.ts` | 32 passed |
| `node tests/autonomy-cli-smoke.ts` | 16 passed |
| `npx tsc -p tests/tsconfig.json` / `-p packages/autonomy/tsconfig.json` | exit 0 both (proper exit code, no pipe) |
| `npm run test:lint` | `LINT_EXIT=0` |
| `node tests/docs-smoke.ts` | green (journal gate included) |

### Fail-before-fix (independent reproduction)

Extracted base `106bc4d` to a scratch tree, overlaid only the new test file, symlinked
`node_modules`, and ran it: `AssertionError: exactly one cycle ran after the answer, not zero and
not more` / `2 !== 3`. The new case genuinely fails without the fix and passes with it.

## Independent review

`subagent` reviewer (isolated) on `git diff 106bc4d..HEAD`:

> The fix is correct and scoped: `runStep` consumes a `pendingAnswer` only when its blocker id is
> exactly `"publish-blocked"`, clears it, falls through to run one cycle, and re-parks on a fresh
> `enterBlocked` if `publishBlocker`/`publishBlockedCycles` persist — each operator answer yields
> exactly one cycle and there is no unbounded path. `PendingAnswer.id` is an optional `string` set
> from `q.id` only when a blocker exists; no `any`/casts. The new smoke case is meaningful … Docs
> state the one-cycle-per-answer rule and pin it to the test. Diff touches only the five relevant
> files — no leak-scan, threshold, or test-weakening changes.

`VERDICT: PASS`. Its one warning (the answer's free text is not forwarded) was addressed by
clarifying in `docs/autonomy.md` that the answer is consumed as the resume permission; the offered
option is a canned resume, so no behaviour was claimed that the test does not pin.

## Charter and scope

One logical change: finding, root cause, fix, test and doc in one commit. No new dependency. The
leak scan, its patterns, its exceptions and the two-cycle threshold are untouched (`PG-55`
constraint). Behaviour claims in `docs/autonomy.md` name `tests/autonomy-selfimprove-smoke.ts`.
