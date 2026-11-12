# Proposal: decide whether coverage should gate again

Run: `luna-ops-01`, cycle 06. Stream: `ops`. Related board item: DE-106.

## What the board asked for

DE-106's acceptance criterion says the coverage lane must "enforce the existing coverage threshold"
before integration moves. That threshold does not exist.

## Evidence

- `.github/workflows/ci.yml` describes the coverage job as measuring and "not gate on a threshold".
- `docs/ci-security.md` says the same in "Test coverage".
- Reviewed change `25f9c40e` ("stop the measure-only coverage job gating `ci-complete`") removed the
  job from the required check because a slow runner cancelled it at 30 minutes. Its commit message
  and the cycle 04 review record that decision.
- `tests/workflow-policy-smoke.ts` lists `coverage` in `MEASURE_ONLY_JOBS`; the job must not appear
  in `ci-complete`'s `needs`.
- `packages/core/coverage.ts` has no threshold comparison or minimum setting.
- `docs/releasing.md` records that a release still waits for the whole of `ci.yml`, so coverage
  already gates a release even though it does not gate a pull request.

Cycle 06 sharded the lane and added `coverage-merge` (see `autonomy/cycles/luna-ops-01/06/`). It
deliberately did not add a threshold: inventing one would reverse a reviewed policy and could turn
a slow runner into a blocked pull request again.

## Decision needed

Choose one:

1. **Keep measure-only** (current policy). The release gate still measures; pull requests only need
   `ci-complete`. No change needed.
2. **Add a gating threshold** but keep it off the pull-request critical path: enforce it in the
   release gate (`release.yml`'s `plan`, or a release-only job) with a documented floor and an
   explicit failure message. This needs a threshold value and a rule for new untested files.
3. **Gate pull requests on coverage** by adding `coverage-merge` to `ci-complete` and setting a
   threshold. This reverses `25f9c40e` and needs a measured headroom study first.

The operator should supply the threshold value and the intended scope; a value cannot be derived
from this repository's current tests.
