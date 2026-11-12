# Cycle 08 — plan

Goal: carry over the sound cycle-07 work with the footprint repair its rejection exposed (PG-20 and
the PG-45 verdict-line gate), then remove the two measured harness wastes: wall-clock gate budgets
(DE-93) and the red-gate cycle that skips its review (PG-46).

Mode: fix. All three board items are P0; board order is PG-20, DE-93, PG-46, and the 30,000-char
"stop taking new items" line is checked after each item.

## Item 1 — PG-20 carry-over + the PG-45 footprint repair

- Charter: evidence (red acceptance checks on the attempt; a documented workflow without tooling),
  tests (smoke:docs footprint fixtures), docs (docs/autonomy.md, cycle.md).
- Change already implemented by cherry-pick `3c7c8ae` (PG-20) and `a482425`/`c3a1ecb`/`f1da979`
  (PG-45). Repair the regression the rejection names: shorten `PLAN_DESCRIPTION` to
  "loops until the last non-empty line has pass", refresh the generated `docs/reference.md`, and
  record the deliberate `workflow_run` size in `packages/core/eval/footprint-baseline.json`
  (`balanced` and `lite`).
- Checks: `npm run -s smoke:docs`, `smoke:eval-footprint`, `smoke:subagent-roles-isolation`,
  `smoke:workflow`, `smoke:workflow-plan`, `node packages/core/journal.ts --check`.

## Item 2 — DE-93, make the redaction time assertions load-independent

- Charter: evidence (the steward's 272 ms/1069 ms/1362 ms observations; three cycles lost to false
  reds), tests (a fixture that fails on a quadratic function and passes on 10x-linear work).
- Change: add `tests/perf-budget.ts` with `assertSubQuadratic`: best-of-three timings for the same
  input shape at 1x and 4x, assert `large <= max(small, floor) * 10`. Replace the absolute budgets
  in `tests/redaction-corpus-smoke.ts:141-169` (256 KB vs 1 MB, all redactors) and
  `tests/firewall-gate-smoke.ts:585-594` (50 KB vs 200 KB). Add a fixture in
  `tests/redaction-corpus-smoke.ts` that a synthetic quadratic function is rejected and a
  10x-slowed linear function accepted, so the guard itself is tested.
- Checks: `npm run -s smoke:redaction-corpus`, `smoke:firewall-gate`, `test:typecheck`,
  `test:lint`, `smoke:check-all-npm` (wiring of the helper).

## Item 3 — PG-46, review a red-gate cycle and carry its findings forward

- Charter: evidence (cycle 05 re-did V-41 in 158 min/$0.20 because the red cycle's review never
  ran), tests (the red-cycle smoke asserts the reviewer ran and the concerns reach the next prompt).
- Change: in `packages/autonomy/lib/templates/self-improve.ts` stop returning before
  `reviewCycle` when `gate.green` is false; run the review with `gateGreen: false`, keep
  `merge:false`, and prefix `mergeReason` with `acceptance checks failed. review <verdict>: …` so
  the existing previous-cycle briefing carries the concerns. `packages/autonomy/lib/review.ts`
  gains the `gateGreen` flag so the reviewer prompt and bundle say the checks failed and the review
  is carry-over evidence, not a merge decision.
- Checks: `npm run -s smoke:autonomy-selfimprove`, `smoke:autonomy`, `test:typecheck`, `test:lint`.

## Order and budget

1. Item 1 is already applied; repair and verify it (small commit).
2. Item 2 (DE-93) through one `workflow_run` plan.
3. Re-measure the review diff; take PG-46 only while it is under 30,000 characters.
4. Record: this report, the journal line via `node packages/core/journal.ts`, the handoff, then an
   independent whole-diff reviewer.
