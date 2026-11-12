# Cycle 6 report — stream `fleet` (luna-fleet-01/06)

Outcome: partial
Mode: fix

Board: O-01 progress - carried and repaired PG-03, so `workflow_status` and `/workflows` list
autonomous container runs with title, status, spend, blocker and supervisor liveness; PG-06–PG-09
and the non-Claude walkthrough remain.
Board: A-92 blocked - not started; the cycle budget went to carrying the green PG-03 work, and a
half-done dispatch template would leave the branch red.

Item: carry cycle 5's PG-03 code and repair its red gate — `f86cee0`, `c559978`, `fdb0f85` — with
`node tests/run-query-smoke.ts` (8 groups), `eval-footprint-smoke` 11, `subagent-roles-isolation-smoke`
7, `new-extension-smoke`, `verify`, `workflow-panel-smoke` 14, `autonomy-run-smoke` 15,
`docs-smoke`, both `tsc` projects and eslint passing.

## Why the cycle is partial

Cycle 5 carried cycle 4's PG-03 code and passed an independent review, but the host acceptance was
red on `check-all:smoke:docs`. The cause is reproduced in `06/review.md`: `tests/docs-smoke.ts:491`
uses `checkJournal` from `packages/core/lib/journal.ts`, which requires one `autonomy/JOURNAL.md`
line per cycle `report.md`; cycle 5 had committed its report without that line. This cycle
cherry-picks the sound code (`bc82356`→`f86cee0`, `e53e06e`→`c559978`), adds the missing
`luna-fleet-01/05` journal line (`fdb0f85`), and records cycle 6 (`121836e`, this commit).

The reviewable diff is 45,557 characters excluding records and the lockfile, over the 30,000 stop
for new items and under the 60,000 review limit. PG-06–PG-09 and A-92 therefore were not started.

## What the carried code does

`packages/extensions/third_party/subagent/run-query.ts` reads `$PI_AUTONOMY_HOME/<run>` (else the
XDG/home chain), validates each `state.json` field, skips malformed state and invalid directory
names, and adds an `autonomy` row to the same list as workflow and subagent runs. The row shows the
contract title, status, dollars spent against the budget, and the blocker question; `workflow_status
{id}` shows phase/step, tasks, blocker and options, the last error, the run directory and
`supervisor.log`. Liveness mirrors `packages/autonomy/lib/runlock.ts` `assessLock`: a foreign host is
judged by heartbeat age, a same-host owner by pid, then start-time reuse, then a 120 s heartbeat.
`workflow-tools.ts` updates the `/workflows` and `workflow_status` descriptions. Docs and notices
are updated in `docs/autonomy.md`, `docs/workflows.md`, `docs/reference.md`, `docs/roadmap.md`,
`SOURCE.md` and `THIRD_PARTY_NOTICES.md`; `README.md` needed no change.

## Left for later

- O-01: PG-06 host event log, PG-07 live `/autonomy` widget, PG-08 console panel, PG-09 owner inbox,
  and the recorded non-Claude walkthrough.
- A-92: dispatch run template and atomic `board claim`; needs `tests/autonomy-dispatch-smoke.ts`.
- Carried proposal `autonomy/proposals/luna-fleet-01-04-autonomy-control-ids.md`: `/workflows`
  control completions still offer autonomy ids that `workflow_control` cannot act on.
- Cycle-03 PG-42 (`stop` verb, detached handle, awaited `tearDown`) remains on
  `origin/attempts/luna-fleet-01/cycle-03`, unmerged.
- Review warnings left open: `schemaVersion` is not checked on autonomy state; the /proc-only
  start-time read cannot detect pid reuse off Linux; blocked/budget-exhausted rows keep an
  open-ended elapsed time; the same-id precedence comment names only workflow/script rows.
