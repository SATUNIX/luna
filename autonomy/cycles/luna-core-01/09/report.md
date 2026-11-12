# Report — cycle 09, run `luna-core-01`, stream `core`

Outcome: **successful**
Mode: **fix**

Base `5a888fe5dcf2` (head of `stream/core`; cycle 08 was not merged). Cycle-08's sound PG-55
implementation was carried over by cherry-pick; the merge rejection was a missing journal entry for
the dropped cycle-08 records, so neither its records nor its PG-51 carry-over were brought over.
Workflow: PG-55 carried by cherry-pick, not re-implemented. PG-57's first `workflow_run` plan failed
during prompt templating (a literal `{{file:}}` in my task text) with 0 agents launched; the retry
was refused by the E3 agent allowance, so it ran through `subagent` (implementer then an independent
reviewer, `VERDICT: PASS`).

Workflow: refused the workflow run could not be budgeted (plan-allowance): 6 agents already planned or started this request (E3 allows 8), and the 4-agent implement+gate plan did not fit.

## Board

Board: PG-55 done - a publication the leak scan refuses now exposes the blocker and merged-but-unpublished count in run status and `state.json`, is carried (locations only) into the next cycle's prompt, blocks the run with an operator question after two merged-but-unpublished cycles, and a clean publish clears all three.

Board: PG-57 done - a step that declares `outputs` now receives a task that names each declared file by absolute path and states the step fails without it, and the failure message names the absolute path; the failing path launches exactly one agent.

## Items

Item: PG-55 stop a run whose publication the leak scan refuses - `0471c71`, `bf74303` - `node tests/autonomy-selfimprove-smoke.ts` (41 checks) plus `node tests/autonomy-cli-smoke.ts` (16) and `node tests/autonomy-smoke.ts` (32).

Item: PG-57 name a declared output's absolute path to the subagent and on failure - `3c643fc` - `node tests/workflow-smoke.ts` (13 checks: the passing and failing tasks name `path.join(dir,"report.md")` and "exact file is absent", the failure names the absolute path, and the failing write runs exactly one agent) and `node tests/workflow-plan-smoke.ts` (91, exact new failure text).

## Test justification

No bound or assertion was weakened. `tests/workflow-smoke.ts` previously matched the old failure
text with a regex; it now additionally requires the absolute path, the absence clause in the task,
and one launch on the failing path (the new no-re-review guarantee). `tests/workflow-plan-smoke.ts`
updates one exact string to the new message. `tests/autonomy-selfimprove-smoke.ts` is carried over
unchanged from cycle 08.

## Left for next cycle

1. PG-51 (cycle-08 carry-over): the load-tolerant smoke timing guards are sound and verified on
   `origin/attempts/luna-core-01/cycle-08` (`cfe2ea0`, `84894cc`, `3329032`, `ea8027b`) but were not
   brought over this cycle: PG-55 (22,039 chars) plus PG-57 would have pushed the reviewable diff
   toward the 60,000 read budget. Re-carry or re-implement with a green `timing-load-check.ts` run.
2. Cycle-08's records stay on the attempt branch; if a later cycle brings
   `autonomy/cycles/luna-core-01/08/report.md` over, it must add the matching `autonomy/JOURNAL.md`
   entry `- luna-core-01/08 | Board: PG-55, PG-51 | successful | ...` (the omission that reddened
   `smoke:docs` and blocked the merge).
3. Unchanged HANDOFF carry-overs needing the operator: skill-trigger wall cap proposal, npm/trunk
   guard, cycle-03 env-ownership attempt branch, dead CODEOWNERS path, V-07/V-08/V-10, owner-side
   `coverage` job, and the sandbox-watchdog load proposal.
