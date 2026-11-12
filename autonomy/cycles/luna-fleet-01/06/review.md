# Cycle 6 review — stream `fleet` (luna-fleet-01/06)

Base: `bf6d2bbf7228` (head of `stream/fleet`). Mode: **fix**.

## Branch state

- `git log --oneline bf6d2bbf7228..HEAD` was empty at review time: no fleet cycle was merged into
  this base, and `autonomy/cycles/luna-fleet-01/` did not exist here.
- Cycle 5 ended `Outcome: partial` with a PASS independent review of its code, but the host
  acceptance was red on `check-all` and `check-all:smoke:docs` (exit 1), so none of its work is on
  this branch. Its commits are on `origin/attempts/luna-fleet-01/cycle-05`: `bc82356` (PG-03
  autonomy runs), `e53e06e` (liveness/description repair), `c22dc0e` (records).
- Cycle 4's PG-03 work is the same code, carried through cycle 5; it is not separately mergeable.

## Why cycle 5 was rejected (reproduced)

Cherry-picking `bc82356`, `e53e06e`, `c22dc0e` onto this base is clean, and every targeted check
passes except `node tests/docs-smoke.ts`, which fails with:

```
AssertionError: autonomy/JOURNAL.md disagrees with the cycle reports
+ [ 'report with no journal entry: luna-fleet-01/05; add: - luna-fleet-01/05 | Board: O-01, A-92 | partial | <summary>' ]
- []
    at tests/docs-smoke.ts:491
```

Root cause: `packages/core/lib/journal.ts` `checkJournal` requires one `autonomy/JOURNAL.md` line
per `autonomy/cycles/**/report.md`; cycle 5 committed its report without that line. This is the
`check-all:smoke:docs` failure the host named, and it is a records defect, not a code defect.

## Assigned items checked against the code

### O-01 [P0] — owner visibility (PG-03, PG-06, PG-07, PG-08, PG-09)

PG-03 is delivered by the carried code: `packages/extensions/third_party/subagent/run-query.ts:213`
(`autonomyStateOf`), `:421`/`:488` (rows and status), `:676` (prompt snippet), with
`workflow-tools.ts` listing autonomy runs. It shows title, status, spend/budget, blocker question
and supervisor liveness, and `tests/run-query-smoke.ts` pins fresh/stale/reused locks. PG-06, PG-07,
PG-08, PG-09 and the non-Claude walkthrough are still absent from the code and remain open.

### A-92 [P0] — dispatch template and atomic board claim

Not started. `packages/autonomy/lib/board.ts` has no `claim` operation and no dispatch run kind
exists; the acceptance test `tests/autonomy-dispatch-smoke.ts` does not exist. This is a larger
change than the remaining review budget allows after the carry.

## Budget

The carried diff is 45,557 characters (records and lockfile excluded), already over the 30,000
character stop for taking new items and under the 60,000 review limit. This cycle therefore carries
the sound cycle-5 work, repairs its red gate, and records the remainder; it does not start PG-06 or
A-92.

## Other findings

- `autonomy/proposals/luna-fleet-01-04-autonomy-control-ids.md` (carried): `/workflows` control
  completions offer autonomy ids that `workflow_control` cannot act on. Not a blocker.
- No new defect outside the stream was found that outranks the red gate.
