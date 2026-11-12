# Cycle 08 completed the carried-over journal and gate work, and removed the wall-clock perf gates

Outcome: successful

Mode: fix

Board: PG-20 done - derive the team-journal line from the report and accept union-merge duplicates
Board: PG-45 done - plain-text workflow gates pass only on the verdict line; carry over the cycle-07 fix and repair the footprint it exposed
Board: DE-93 done - replace absolute wall-clock perf budgets with a load-independent sub-quadratic guard
Board: PG-46 blocked - review a red-gate cycle and carry its findings forward; not taken, the diff was already past the 30,000-character stop line

## What changed

Item PG-20 (carried from cycle 07): `packages/core/lib/journal.ts` gains `journalLineFor`, which
derives the `Board:`/outcome/summary/decisions line from a cycle `report.md`, and `syncJournal`,
which appends it for every report that lacks one; `checkJournal` still fails hard on a genuinely
missing entry, and byte-identical `merge=union` duplicates are accepted while conflicting ones are
not. `packages/core/journal.ts` is the CLI that writes the lines. This cycle also fixed a
round-trip defect an independent review found: `reportDecisions` now links only decisions files
that exist, so the generated line can no longer fail its own checker, and two new docs-smoke
fixtures pin both the missing-file and the existing-file case.

Item PG-45 (carried from cycle 07, plus the repair its rejection named): `gatePasses` in
`packages/extensions/third_party/subagent/workflow.ts` now matches a plain-text `pass` only on the
last non-empty line (the verdict line), so a `VERDICT: FAIL` that quotes an earlier PASS no longer
passes; the `/regex/` path is unchanged. `plan.ts` `PLAN_DESCRIPTION`, the generated
`docs/reference.md`, `docs/workflows.md` and the workflow-authoring skill describe the rule. The
footprint regression the cycle-07 rejection exposed is repaired by shortening the description and
recording the deliberate tool-text size in `packages/core/eval/footprint-baseline.json`.

Item DE-93: `tests/perf-budget.ts` adds `assertSubQuadratic`, which times the same input shape at
1x and 4x and fails only when the large run exceeds `max(small, 2 ms) * 10`, so host speed no
longer decides the gate. `tests/redaction-corpus-smoke.ts` and `tests/firewall-gate-smoke.ts` drop
their absolute millisecond budgets for it, and a fixture proves a synthetic quadratic function is
rejected while a 10x-slowed linear function passes.

Item PG-46 was not started: the reviewed diff reached 49,415 characters, past the
30,000-character "stop taking new items" line. A separate proposal records the pre-existing
`workflow-resume` checkout-queue flake found while verifying.

## Items

Item: 3c7c8ae feat(journal): derive the journal line from the report (PG-20)
Item: a482425 fix(workflow): plain-text gate must match the verdict line, not the prose (PG-45)
Item: c3a1ecb docs(workflow): describe the verdict-line gate in the model text and skill (PG-45)
Item: f1da979 docs(workflow): anchor the review-gate example (PG-45)
Item: 22fdf7f fix(workflow): keep the verdict-line gate inside the footprint budgets
Item: 4a5dfc7 test(redaction): assert sub-quadratic growth, not absolute wall-clock budgets (DE-93)
Item: ad0a040 docs(cycle-08): cite the renamed board ids (PG-20, PG-45, DE-93)
Item: 558744d fix(journal): link only decisions files that exist (PG-20)
Item: c74e679 test(journal): pin that a derived line links only existing decisions files (PG-20)

## Verification

All targeted checks pass at the verified head `c74e679`: `test:typecheck`, `test:lint`,
`smoke:docs`, `smoke:eval-footprint` 11/11, `smoke:subagent-roles-isolation` 7/7,
`smoke:workflow` 14/14, `smoke:workflow-plan` 91, `smoke:redaction-corpus` 6/6,
`smoke:firewall-gate` 19/19, `smoke:run-query`, `smoke:workflow-redaction` 4/4,
`node packages/core/journal.ts --check`, and `check:all --check-wiring`. The independent
whole-diff reviewer returned PASS; its one actionable warning (the decisions-link round trip) was
fixed and re-reviewed. `npm test` and `npm run check:all` were deliberately not run (the host gate
does). See `verify.md` for the command-by-command evidence.

## Follow-ups

- `autonomy/proposals/luna-ops-01-08-flaky-resume-checkout.md`: the `workflow-resume`
  checkout-queue check is timing-shaped and fails on the clean base; fix the resume/drain path or
  make the test wait for the run to settle.
- PG-46 remains ready for a cycle with budget.
