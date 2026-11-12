# Proposal: the `workflow-resume` checkout-queue check is a pre-existing flake

Status: open, not taken in cycle 08 (outside the cycle's assigned board slice and diff budget).

## Finding

`tests/workflow-resume-smoke.ts:382` ("a stopped run's writer leaves the checkout queue") fails
intermittently on the cycle base `83a3ad872d47` **and** on this cycle's head, with an outcome
`omissions` of `undefined` where the test expects `[["cancelled", "stopped"]]`:

```
MISS: a stopped run's writer leaves the checkout queue: Expected values to be strictly deep-equal:
+ actual - expected
+ undefined
- [ [ 'cancelled', 'stopped' ] ]
AssertionError [ERR_ASSERTION]: resume review regressions
```

## Evidence

- Base `83a3ad872d47`, clean worktree, `node tests/workflow-resume-smoke.ts` → exit 1 with the
  error above (`/tmp/wr-base2.log`).
- This cycle's head, same command → exit 0, `workflow-resume-smoke: 41 checks passed`.
- The test is timing-shaped: a holder agent sleeps 1500 ms, the queued run uses `drainMs: 200`,
  and the test stops it after a fixed `sleep(300)`. When the queue/stop interleaving lands
  differently, the run is stopped before it records an omission, so `outcome.omissions` is
  `undefined`.

## Why it matters

`check:all` runs this test, so the acceptance gate can go red on host timing alone — the same
class of false red as PG-47/DE-93, but in run-coordination rather than a perf budget. A red gate
that is not the diff's fault costs a whole cycle.

## Suggested fix (for a later cycle with budget)

Either the run should always record a `cancelled`/`stopped` omission for a writer stopped in the
checkout queue (a real behaviour fix in the resume/drain path), or the test should wait for the
run's state to settle rather than sleeping a fixed 300 ms, plus an assertion that the queued run
had actually entered the queue before the stop. The first is preferred if the missing omission is
a real gap; the second if it is only a test race.

## Not in scope this cycle

The cycle's assigned slice is PG-20, DE-93, PG-46; the diff at 44,005 characters already exceeds the
30,000-character stop line, and this flake is pre-existing rather than introduced by the diff.
