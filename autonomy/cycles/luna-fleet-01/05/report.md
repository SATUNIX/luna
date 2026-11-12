# Cycle 5 report — stream `fleet` (luna-fleet-01/05)

Outcome: partial
Mode: fix

Board: O-01 progress - carried and repaired PG-03, so `workflow_status` and `/workflows` now list autonomous container runs with title, status, spend, blocker and supervisor liveness; PG-06–PG-09 and the non-Claude walkthrough remain.
Board: A-92 blocked - not started; the cycle budget went to repairing the carried PG-03 red gate, and a half-done dispatch template would leave the branch red.

Item: Autonomous container runs in the run list — `bc82356`, `e53e06e` — `node tests/run-query-smoke.ts` (8 groups, including fresh/stale foreign-host locks, spend and blocker), with `eval-footprint-smoke` 11, `subagent-roles-isolation-smoke` 7, `new-extension-smoke`, `verify`, `workflow-panel-smoke` 14, `autonomy-run-smoke` 15, `docs-smoke`, both `tsc` projects and eslint passing.

## Why the cycle is partial

Cycle 4 delivered PG-03 but its branch failed acceptance, so this cycle spent its budget bringing
that sound work over and making it green. The reviewable diff is 44,622 characters; the cycle rule
stops new items once it passes 30,000, so PG-06–PG-09 and A-92 were not started.

## What was wrong and what changed

Cycle 4's branch failed three checks that are now repaired:

- `eval-footprint-smoke` 3/11: the longer `workflow_status` description moved balanced/lite/
  delegation text above the reviewed baseline. The description now names autonomous runs in fewer
  characters, and `packages/core/eval/footprint-baseline.json` records the measured `8901`/`4712`
  under the `9500`/`4900` ceilings.
- `subagent-roles-isolation-smoke`: delegation text was `4977`, over `4900`; it is now inside the
  budget.
- `new-extension-smoke` and `verify`: `THIRD_PARTY_NOTICES.md` was stale after the `SOURCE.md`
  change; `docs/reference.md` and the notices are regenerated.

An independent review then failed `bc82356` because a foreign-host lock with a fresh heartbeat read
not live (diverging from `packages/autonomy/lib/runlock.ts` `assessLock` and `pi-autonomy status`),
and because `/workflows` and the `promptSnippet` still described only workflow and subagent runs.
`e53e06e` judges a foreign host by heartbeat age, uses the bounded `readRunFile` helper for autonomy
JSON, documents `budget_exhausted` as non-terminal, updates both descriptions, regenerates the
reference and notices, and pins fresh-foreign-live and stale-foreign-dead in the smoke. A second
independent review returned PASS.

## Left for later

- O-01: PG-06 host event log, PG-07 live `/autonomy` widget, PG-08 web console panel, PG-09 owner inbox,
  and the recorded non-Claude walkthrough.
- A-92: dispatch run template and atomic `board claim`; needs `tests/autonomy-dispatch-smoke.ts`.
- Carried proposal `autonomy/proposals/luna-fleet-01-04-autonomy-control-ids.md`: `/workflows`
  control completions still offer autonomy ids that `workflow_control` cannot act on.
- Cycle-03 PG-42 (`stop` verb, detached handle, awaited `tearDown`) remains on
  `origin/attempts/luna-fleet-01/cycle-03`, unmerged.
- Review warnings left open: `schemaVersion` is not checked on autonomy state; the /proc-only
  start-time read cannot detect pid reuse off Linux; blocked/budget-exhausted rows keep an
  open-ended elapsed time; the same-id precedence comment names only workflow/script rows.

## Note for the next cycle

The next cycle starts from this branch if merged; PG-03 is now green here. Take PG-06 or PG-07 as its
own item and keep `node tests/run-query-smoke.ts` and `eval-footprint-smoke` in its checks when tool
text changes. Cycle 3's intermittent `smoke:workflow-resume` red was again not reproduced.
