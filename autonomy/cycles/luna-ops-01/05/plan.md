# Cycle 05 — Plan (run luna-ops-01, stream `ops`)

Mode: **fix**. Review: `review.md`. Base `4da2716e9c9f`.

## Item A — DE-105 [P0]: make the sub-quadratic guard's own regression test deterministic

- **Justification**: charter priority 2, assigned board item. Evidence: board's failing `verify (4)`
  on the 2026-11-12 PR; `tests/perf-budget.ts:14-39` reads the clock directly;
  `tests/redaction-corpus-smoke.ts:175-198` only clears the 10x bound by 13-14x on real time.
- **Change**:
  - `tests/perf-budget.ts`: add optional `clock?: () => number` to the `opts` type, default
    `() => performance.now()`, and use it for both `started` and elapsed in `bestOf`. Bound formula,
    2 ms floor, `maxRatio`, `runs`, message and warm-up stay exactly as they are.
  - `tests/redaction-corpus-smoke.ts` check 5: drive the three probes with a fake clock that
    advances by the work each probe does — linear `text.length`, ten-times-slower `10 * length`,
    quadratic `steps * steps` where `steps = ceil(length/100)`. Expected: linear and 10x-slower
    pass, quadratic rejected (`16x > 10x`), with no real clock read.
  - Do not touch check 4 or `tests/firewall-gate-smoke.ts`; they keep exercising real timing.
- **Tests/checks**: `npm run -s smoke:redaction-corpus` (check 5 and check 4),
  `npm run -s smoke:firewall-gate`, `npm run -s test:typecheck`, `npm run -s test:lint`,
  `npm run -s smoke:docs`, `npm run -s verify`; then 20 consecutive `smoke:redaction-corpus` runs
  under parallel load to show the flake is gone.

## Item B — DE-106 [P0]: shard the pi-compat lane like verify

- **Justification**: assigned board item; the board's measurement names pi-compat at ~20 min per
  lane as a critical-path cost. `verify` already shards (`ci.yml:28-51`); `pi-compat` does not
  (`ci.yml:120-152`). The coverage half is already superseded by the reviewed measure-only policy
  (`tests/workflow-policy-smoke.ts:110-125`, `docs/ci-security.md:52-73`), so only the pi-compat
  half is taken; a threshold/merge job would be a policy proposal, not an edit here.
- **Change**:
  - `ci.yml` `pi-compat`: add `shard: [1, 2, 3, 4]` to the matrix, pass
    `--shard=${{ matrix.shard }}/4 --jobs=2` to `check:all`, keep both pi versions non-advisory,
    keep the same `--skip` set and `--check-timeout`, keep `ci-complete` needing `pi-compat`.
  - `tests/workflow-policy-smoke.ts`: validate every sharded `check:all` matrix in ci.yml (matrix
    shard list 1..n matches `--shard=.../n`, `--jobs`, `--check-timeout`) for `pi-compat` as well
    as `verify`; add mutations that remove the pi-compat shard or make its count disagree.
  - `docs/ci-security.md`: describe the sharded pi-compat lane and that the union of shards is the
    same suite at both pi versions.
- **Tests/checks**: `npm run -s smoke:workflow-policy`, `npm run -s smoke:pi-host-peers`,
  `npm run -s smoke:release-workflow`, `npm run -s smoke:docs`, `npm run -s docs:check`,
  `npm run -s test:typecheck`, `npm run -s test:lint`.
- **Not claimed**: the board's "PR under 12 min median of 3" measurement cannot be reproduced in
  this offline sandbox; the report records that as the remaining acceptance step.

## Sequencing and budget

DE-105 first (P0 reliability), then DE-106. Each item goes through one `workflow_run` plan:
implementer, then a reviewer that did not write it, gate `PASS`, `max_loops` 1. Commit and push after
each item. Stop taking new items once the review diff passes 30000 characters.

## Checks not run here

`npm test` and `npm run check:all` are forbidden (10+ min each; the host gate runs them).
Only the targeted scripts above are run; `verify.md` records each RAN/SKIPPED.
