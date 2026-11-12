# Cycle 08 — review (run luna-ops-01, stream ops)

Base `83a3ad872d47` (head of `stream/ops`). Charter read in full. Read the cycle-07 attempt
(`origin/attempts/luna-ops-01/cycle-07`), its report/handoff, this run's proposals and the handoff.

## Cycle 07 carry-over is sound, but PG-45 breaks two footprint checks

Cycle 07's rejection list names `check-all:smoke:eval-footprint` and
`check-all:smoke:subagent-roles-isolation`. Cherry-picking its four code commits onto this base
reproduces both, and neither fails on the base:

```
$ npm run -s smoke:eval-footprint
  FAIL: balanced: ... matching the baseline
    balanced: workflow_run tool text matches the baseline
[eval-footprint-smoke] 3/11 FAILED
$ npm run -s smoke:subagent-roles-isolation
AssertionError: the delegation tool text is 4908 chars, over the 4,900 budget
```

Root cause: PG-45 rewrote `PLAN_DESCRIPTION` (`packages/extensions/third_party/subagent/plan.ts:31`)
from "loops until the output has pass" to "loops until the verdict line (last non-empty line) has
pass" (+28 chars). `workflow_run`'s measured text is therefore 1113 chars against the baseline's
1085, `delegation.toolText` 4758 against 4730, and the 4,900-char delegation ceiling is exceeded by
8 chars. The rule is real; the wording can be 12 chars shorter ("last non-empty line has pass"),
and `packages/core/eval/footprint-baseline.json` must record the deliberate new size. The other
three named failures (`run-query`, `workflow-redaction`, `workflow-resume`) pass on this tree:
`smoke:run-query` exit 0, `smoke:workflow-redaction` exit 0; no reproduction was found.

PG-20 and PG-45's code themselves are sound: `smoke:docs` 0, `smoke:workflow` 14/14,
`smoke:workflow-plan` 91/91. They are carried over, with the footprint repair, as the first item.

## PG-20 — generator exists after the carry-over; finish record use

`node packages/core/journal.ts` and `journalLineFor`/`syncJournal` are present after the
cherry-pick (`packages/core/lib/journal.ts:100` area); `smoke:docs` now has the identical-duplicate
and conflicting-duplicate fixtures and the pinned missing-entry fixture is unchanged. Remaining
work: use the generator for this cycle's own report and confirm `--check` is clean.

## DE-93 — absolute wall-clock budgets are the measured gate-red cause

Evidence (steward): `tests/redaction-corpus-smoke.ts:157` uses a 1000 ms budget and `:168` fails
`['table, curl -u without a password: 1362 ms']`; `tests/firewall-gate-smoke.ts:592` asserts
`ms < 200` and saw 275 ms on 200 KB. Both inputs are linear in the implementation; a loaded host
scales the number and the test goes red, costing whole cycles (three finished cycles, 273 min,
$0.405). `tests/workflow-redaction-smoke.ts:147` already uses the correct shape: 1x vs 4x timings
and a 10x ratio bound. Separate the budget from host speed, keep a fixture that makes a genuinely
quadratic function fail, and prove linear work still passes under a 10x-linear-overhead "slow host".

## PG-46 — a red gate skips the merge review, so its findings never reach the next cycle

`mergeDecision` returns at `packages/autonomy/lib/templates/self-improve.ts:533`
(`if (!gate.green) return { merge: false, reason: "acceptance checks failed" }`) before
`reviewCycle` at `:596`. A red cycle's review therefore never runs: the next cycle is told only
"acceptance checks failed", and the same item gets re-picked (cycle 05 re-did cycle 04's V-41 for
158 min/$0.20). The review is cheap relative to the repeat and its concerns are the carry-over
evidence. Fix: still review a red cycle, keep `merge:false`, and put the verdict and concerns into
`mergeReason` (already surfaced in the next cycle's prompt). Record the existing contract in
`tests/autonomy-selfimprove-smoke.ts`.

## Other findings (not taken)

- The installer CLI raw stack trace for a bad `--profile` remains the restored proposal
  `autonomy/proposals/luna-ops-01-06-installer-cli-error-handling.md`; not assigned this cycle.
- V-04 doc sweep remains open from cycle 04; not assigned.

## Mode

**Fix mode**: a red footprint check from the carried-over PG-45, the measured DE-93 gate waste, and
PG-46's missing red-cycle review. PG-20 is carried over with its generator.
