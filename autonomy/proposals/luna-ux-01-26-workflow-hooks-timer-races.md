# Proposal — fixed-timer races in `workflow-hooks-smoke.ts` (run `luna-ux-01`, cycle 26)

**Area:** tests (subagent workflow smokes). **Priority:** low (not observed failing the gate).

Cycle 26 reproduced and fixed a real wall-clock ordering race in
`tests/workflow-resume-smoke.ts` (the "stopped writer leaves the checkout queue" case held the
checkout with a 1500 ms timer and then slept 300 ms; under CPU contention the holder released
first). A scout audit of the sibling smokes found two more cases of the same shape in
`tests/workflow-hooks-smoke.ts`, with a larger margin so they did not fail the gate:

- **r14 (`:307-315`)**: a slow child has `delayMs: 5000` while the run ends after a ~200 ms
  child; the assertion expects the slow step to be an omission. If ~5 s elapses between the
  slow child's spawn and the run's end under severe contention, the child completes and the
  omission disappears.
- **r14 unkillable (`:330-334`)**: a slow child at `delayMs: 1500`, drain `drainMs: 100`, with a
  ~200 ms path; the expected reason text changes if the child completes before the drain ends.

Both are "at least" timing assumptions, roughly 15-20x margins, so they are far less likely than
the reproduced case. They weaken coverage under load (a broken pause/skip could pass) and could
still produce a red gate on a heavily loaded host.

**Suggested fix (a later cycle):** replace each timer-bounded child with the file-gated `git`
wrapper pattern now used in both `workflow-resume-smoke.ts` queue cases (a `git` shim in `PATH`
that blocks on a `hold` file), and gate the run's end on a file the child writes rather than a
`delayMs`. No production code should need to change.

**Evidence:** `tests/workflow-resume-smoke.ts:383-421` (fixed example, commit `1cd4579`) and the
scout's line-by-line audit recorded in cycle 26's review. Do not implement this without
reproducing the failure under load first; the existing margins may be adequate.
