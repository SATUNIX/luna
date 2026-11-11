# Report — cycle 07, run `luna-core-01`, stream `core`

Outcome: **successful**
Mode: **fix**

Base `f0d6ede22af4`. Commits `8e290d3` (PG-51) and `29d7379` (reviewer's skill-routing bound fix).
Reviewable diff 36,933 chars (records and lockfile excluded) — under the 60,000 read
budget, past the 30,000 stop-new-items mark, so the cycle stopped after the two assigned items.

Workflow: the gated `workflow_run` plan ran; its `implement` step exceeded the 30-minute subagent
wall limit and the `reviewer` step never ran. Its committed output was inspected, verified and
committed by the coordinator, and an independent `subagent` reviewer was dispatched instead
(`VERDICT: PASS`, one warning fixed in `29d7379`). No plan was refused.

## Board

Board: PG-27 done - no work needed; the dated offline eval baseline and its 7-day freshness check
were already implemented and merged by cycle 06, and both still pass on this base.

Board: PG-51 done - the eight CPU-bound smoke timing guards now measure `process.cpuUsage()`
user+system (every budget unchanged), the load-check passes all 40 runs under full CPU load, and
the same load exposed and fixed a real skill-router defect plus a workflow-plan timer race.

## Items

Item: PG-51 make the CPU-bound smoke timing guards load-tolerant without weakening them - `8e290d3` - `node tests/timing-load-check.ts` (8 changed smokes x 5 runs, 40/40 under a CPU burner per core); `tests/firewall-gate-smoke.ts` proves a catastrophic `/^(a+)+$/` rule still fails a 40 ms CPU budget; all eight budgets preserved.

Item: PG-51 fix the skill-router `re:` trigger guard the load-check exposed (a busy host switched off a correct `codebase-navigation` trigger because `node:vm`'s 50 ms timeout is wall clock) - `8e290d3` - `node tests/skill-routing-smoke.ts` (5/5 under full load; fails 2/5 on the base under the same burners with `expected ["codebase-navigation"] got []`).

Item: PG-51 repair the `workflow-plan-smoke` plant timer race the load-check found (a 40 ms timer fired after run cleanup: `ENOENT ... symlink outside-secret.md`) - `8e290d3` - `node tests/workflow-plan-smoke.ts` (5/5 under full load, 91 checks idle).

Item: PG-51 make the skill-routing 2000 ms bound meaningful after review (best-of-three on a caching function measured two no-ops) - `29d7379` - `node tests/skill-routing-smoke.ts` (single real run; idle and 5/5 under load).

Item: PG-27 record the already-implemented dated eval baseline as done - no commit (bookkeeping) - `node tests/eval-baseline-smoke.ts` (4 checks) and `node packages/core/eval/baseline.ts --check` (exit 0, `2026-11-11.json`, 0 days old).

## Test justification

No test was weakened. Every converted guard keeps its original budget (reviewer checked all eight
sites: firewall-gate 200 ms, redaction-corpus 200/1000 ms, workflow-redaction ratio + 2000 ms, save
200 ms, tool-firewall 2000 ms, workflow-plan 300/150 ms, skill-routing 2000 ms, compress 2000 ms);
only the unit (wall clock to CPU time) and sampling changed. The firewall-gate self-test fails if
the guard is weakened to a no-op. `tests/timing-load-check.ts` is new but deliberately not wired
into the gate; it is referenced by `tests/timing.ts` so `check-all --check-wiring` passes.

## Left for next cycle

1. Skill-router `re:` trigger wall cap is now 500 ms per trigger (was 50 ms wall) because the CPU
   budget cannot interrupt a running match; bounded, but tightening it is an operator choice —
   `autonomy/proposals/luna-core-01-07-skill-trigger-wall-cap.md`.
2. Carry-overs from `HANDOFF.md` unchanged: npm/trunk guard untested until npm delivery; cycle 03
   env-ownership on an attempt branch; CODEOWNERS dead path and V-07/V-08/V-10 need the operator;
   owner-side `coverage` job.
