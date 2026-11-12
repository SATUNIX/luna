# Cycle 06 — Plan (run luna-ops-01, stream `ops`)

Mode: **fix**. Review: `review.md`. Base `70650a313022`.

## Item A — DE-105 [P0]: verify the cycle-05 clock injection (no code change)

- **Justification**: board item; already implemented in cycle 05. Re-verify it on this base rather
  than redo it.
- **Change**: none. Confirm `tests/perf-budget.ts:21-25` takes the injected clock, check 5
  (`tests/redaction-corpus-smoke.ts:176-214`) drives linear / ten-times-slower / quadratic probes
  with it, and check 4 plus `tests/firewall-gate-smoke.ts` keep real timing.
- **Checks**: `npm run -s smoke:redaction-corpus` (6/6), plus 20 consecutive runs under four busy
  cores for the board's flake acceptance.

## Item B — DE-106 [P0]: shard the coverage lane and merge its raw V8 reports

- **Justification**: charter priority 2, assigned board item. Measured evidence: the board's
  coverage lane is 31.1 / 28.6 minutes, the slowest remaining lane; `ci.yml:55-66` runs it once and
  `packages/core/coverage.ts:294-303` discards the raw data after one summary. Sharding cuts the
  lane to a shard's share and keeps the same suite.
- **Constraint from reviewed policy**: coverage is deliberately measure-only and has **no
  threshold** (`tests/workflow-policy-smoke.ts:129-137`, `docs/ci-security.md:64-66`, reviewed
  change `25f9c40e`). The board's "existing threshold" does not exist. Do not invent one or make
  coverage gate `ci-complete`; write a proposal for that policy question. The improvement is
  wall-time, measured at the matrix/report level offline and by the host's PR runs.
- **Change**:
  - `packages/core/coverage.ts`: accept `--coverage-out=<dir>`, keep the raw `NODE_V8_COVERAGE`
    directory there instead of a temp directory it deletes, and still report on it; default
    behaviour is unchanged. Add an exported, pure argument splitter so the flag is testable.
  - `.github/workflows/ci.yml`: `coverage` becomes a 4-shard matrix running
    `npm run -s coverage -- --shard=${{ matrix.shard }}/4 --coverage-out=coverage-raw
    --check-timeout=600`, uploading `coverage-raw-${{ matrix.shard }}`. A new `coverage-merge` job
    (needs `coverage`) downloads all shard artifacts into `coverage-raw` and runs
    `npm run -s coverage -- --report coverage-raw`. Both stay measure-only (not in `ci-complete`).
  - `tests/workflow-policy-smoke.ts`: `MEASURE_ONLY_JOBS` gains `coverage-merge`; assert the
    coverage job is a shard matrix whose `--shard=…/n` matches, that it passes `--coverage-out`,
    that `coverage-merge` exists, needs `coverage`, downloads `coverage-raw-*` and runs
    `coverage --report`; add mutations for each rule. Coverage remains exempt from `ci-complete`
    and keeps its timeout/check-timeout rules.
  - `tests/check-all-npm-smoke.ts`: pin the `--coverage-out` splitter and its `--report` handling.
  - Docs: `docs/ci-security.md` (CI table, sharded coverage, merge job, still measure-only and no
    threshold; release gate unchanged), `docs/operator-checklist.md` and `docs/releasing.md` where
    they describe the coverage job.
- **Tests/checks**: `npm run -s smoke:workflow-policy`, `npm run -s smoke:check-all-npm`,
  `npm run -s test:typecheck`, `npm run -s test:lint`, `npm run -s smoke:docs`,
  `npm run -s docs:check`, `npm run -s verify`, `npm run -s smoke:release-workflow`.
- **Not claimed offline**: the median-of-three PR wall time. The matrix, artifact merge and local
  report merge are pinned; GitHub run timing is the host's measurement.

## Proposal

`autonomy/proposals/luna-ops-01-06-coverage-threshold-policy.md`: the board asks for an "existing
threshold" that was deliberately removed in `25f9c40e`; record the conflict and ask the operator
whether coverage should regain a gating threshold, without changing policy here.

## Sequencing and budget

DE-105 verification first (cheap), then DE-106 through one `workflow_run` plan (implementer, then a
reviewer that did not write it, gate `PASS`, `max_loops` 1). Commit and push after each item. Stop
taking new items once the review diff passes 30000 characters.

## Checks not run here

`npm test` and `npm run check:all` are forbidden (10+ min each; the host gate runs them).
