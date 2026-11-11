# Proposal — the load harness still fails firewall-gate's redaction guard

Status: proposed (not implemented). Author: cycle 11, run `luna-core-01`.

## Context

Cycle 11 carried over the PG-51 load-tolerant timing guards (`tests/timing.ts`,
`tests/timing-load-check.ts` and the smokes that use `assertCpuWithin`) from
`origin/attempts/luna-core-01/cycle-08`. On this host the full harness
`node tests/timing-load-check.ts` reports **53 of 55 runs passed**, not 55. The two failures are
`tests/firewall-gate-smoke.ts` run 1/5 and 5/5:

```text
FAIL tests/firewall-gate-smoke.ts run 5/5 (status 1)
AssertionError [ERR_ASSERTION]: redact on 200 KB of "curl -u " took 219 ms of CPU (budget 200 ms)
    at assertCpuWithin (file:///work/tests/timing.ts:72:10)
```

The guard at `tests/firewall-gate-smoke.ts:590` was **not** touched by the PG-51 range; it was
already in the harness's smoke list and keeps the default best-of-three measurement.

## Why this is worth a look

- The failure is reproducible only in aggregate. Measured on its own under twelve CPU burners, the
  same guard reads 95 ms (best-of-three), 94 ms (best-of-nine) and 91 ms (best-of-fifteen), and
  process-wide CPU reads 97 ms. So the 219 ms is contention noise accumulating across a long
  harness run, not a property of one sampled call.
- The cycle-08 change already moved `tests/workflow-redaction-smoke.ts` to best-of-nine "because a
  noisier measurement may need more repeats than the default three" (`tests/timing.ts:29-30`).
  `firewall-gate-smoke.ts` is the same shape of 200 KB redaction scan and was left at best-of-three.
- CPU time is load-tolerant against descheduling but **not** against memory/cache contention: the
  guarded scan walks 200 KB, and a saturated host slows those accesses, so the *thread's* CPU time
  rises too. More repeats average that noise out; raising the 200 ms budget would not (and
  `tests/timing.ts:66-69` forbids it).

## Suggestion

Give `tests/firewall-gate-smoke.ts`'s redaction loop the same best-of-nine treatment as
`workflow-redaction-smoke.ts` (call `bestCpuMs(9, () => redact(text))` and keep the 200 ms budget),
or add a repeat count parameter to `assertCpuWithin` and use nine here. Then re-run
`node tests/timing-load-check.ts` and record whether all 55 runs pass; if a run still fails, the
guard is genuinely too tight for a saturated host and needs an operator decision, not a larger
budget.

This is a test-harness robustness change, so it does not alter product behaviour. The harness is not
part of `check:all` / the CI gate, so the finding does not block the cycle; it only weakens the
load-tolerance evidence cycle 11 relied on.
