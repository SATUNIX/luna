# Cycle 05 — Report (run luna-ops-01, stream `ops`)

Outcome: successful
Mode: fix

Workflow: refused the first DE-106 plan because its task text contained a literal GitHub matrix
expression (`workflow_run` rejects it); a second plan produced an implementer step with no output
and no change. The item was then applied directly and reviewed by a reviewer subagent (PASS), with
the review's two warnings fixed in `72c5af7`.

Board: DE-105 done - `assertSubQuadratic` now takes an injected clock and check 5 drives it with a
deterministic fake clock, so the guard's regression test no longer depends on real timing.
Board: DE-106 done - `pi-compat` now runs the same check suite as eight non-advisory lanes (two pi
versions x four shards) with the skip list and timeout unchanged; policy and docs pin the matrix.

Item: DE-105 make the sub-quadratic guard test timing-independent - 39c2e6c - `npm run -s
smoke:redaction-corpus` 20/20 under four busy cores; check 5 rejects the quadratic probe and passes
the linear and 10x-slower probes from the fake clock
Item: DE-106 shard the pi-compat CI matrix - f7c7031 72c5af7 - `npm run -s smoke:workflow-policy`
5 checks with 31 mutations caught; static matrix parse gives 8 non-advisory lanes, shards 1..4 per
pi version, `--shard=<i>/4 --jobs=2`, `ci-complete` still needs `pi-compat`

## What was done

1. **DE-105 (P0).** `tests/perf-budget.ts:assertSubQuadratic` read `performance.now()` directly, so
   `tests/redaction-corpus-smoke.ts` check 5 could only clear the 10x bound by about 13-14x on a
   quiet machine; a 1.4x disturbance flipped it, and it failed this way on a promotion PR. The
   helper now accepts `clock?: () => number` defaulting to `performance.now`, and check 5 passes a
   fake clock that advances by the probe's work: linear `len`, 10x-slower `10 * len`, quadratic
   `steps * steps` (`steps = ceil(len/100)`). Bound formula, 2 ms floor, `maxRatio`, warm-up, and
   messages are unchanged. Check 4 and `tests/firewall-gate-smoke.ts` keep real timing. The reviewer
   confirmed no real-clock read remains in the assertions.

2. **DE-106 (P0, pi-compat half).** `pi-compat` was the last unsharded `check:all` lane on the PR
   critical path (about 19-21 minutes per pi version, two versions). It now has a `pi` x `shard`
   matrix (`0.85.1`, `0.99.2` x `1..4`), keeping `advisory: false` on all eight lanes, the existing
   skip list (`smoke:package`, `test:typecheck`, `test:lint`), `--check-timeout=600`, timeout 25,
   Node 22 and the peer install step. `tests/workflow-policy-smoke.ts` now requires every job that
   directly runs `check:all` (verify and pi-compat) to be a shard matrix whose count matches the
   `--shard=<i>/n` flag, and proves it with mutations for a missing flag, a count disagreement and a
   missing shard axis. `docs/ci-security.md` describes the sharded lanes and keeps coverage as a
   measure-only job outside `ci-complete`. The coverage threshold half of the item was already
   superseded by the reviewed measure-only policy and was not changed.

## Not verified

The DE-106 acceptance target - median of three PR runs under 12 minutes - cannot be measured in
this offline checkout. The workflow-policy test and a static matrix expansion pin the change; the
GitHub-hosted PR runs remain the measurement. No claim is made here that the 12-minute median has
been observed.

## Leftovers

- `assertSubQuadratic`'s per-probe fake-clock accounting in check 5 is hand-maintained; if a probe's
  stride changes, its `clock.advance` must change with it. The comments name the coupling.
- No new proposals were needed; no shared backlog or charter edit was made.
