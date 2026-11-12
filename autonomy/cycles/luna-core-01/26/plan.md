# Cycle 26 plan — luna-core-01

Mode: **fix**. Base `29eeab10123a`. Steward objective: find and fix real, evidenced problems.

## Items

### PG-66 [P0] — add the in-cycle (pre-report) diff probe to the self-improve loop

Justification (charter: real evidenced problem, tested, documented, one logical change): a run
whose cycles are rejected on the 60,000-char review budget cannot recover, because the host
measures the diff only after the worker session ends, so the worker re-lands too much and every
cycle is re-rejected until the run dies. Evidence and root cause in `review.md`. The reset half
of the item already holds; the missing half is the pre-report measurement.

Intended change (bounded, no control-path edit, no security weakening):

1. `packages/autonomy/lib/review.ts`: add an optional `characters?: number` to the over-budget
   (`ok:false`) review-diff variant, set from the measured byte length, so callers can report the
   same number the refusal will later cite. Type-only for the caller.
2. `packages/autonomy/lib/templates/self-improve.ts`: add `diffBudget()` to the cycle runtime
   that measures the same `startSha..head` diff with the same exclusions as `mergeDecision`, and
   returns `{ characters, budget, overBudget, detail? }`.
3. `packages/autonomy/lib/cycle.ts`: add the optional `diffBudget?()` to `CycleRuntime` and a
   `budgetStale()` probe mirroring `reportStale`. When the would-be diff is over budget and the
   head has not already been warned, log it, steer the live worker with the measured number and
   the instruction to land only the current item's work (carried items stay on
   `attempts/<run>/cycle-NN`), and force one more turn. `mergeDecision` stays the fail-closed
   backstop; the probe changes no outcome by itself.
4. Tests: extend `tests/autonomy-selfimprove-smoke.ts` with a 3-cycle fixture — cycle 1 a 70k
   change (refused, over budget), cycle 2 re-lands it plus 10k (refused, accumulated), cycle 3
   only the 10k (under budget, merges) — asserting: the next cycle starts from the seed
   (integration) head, both refusals carry the measured number, the attempts tags/branches
   exist, exactly one merge-review model call happens, and the live worker received a steer
   naming the measured number and the budget. Add a `diffBudget` stub only where the interface
   requires it in `tests/autonomy-smoke.ts`.

Proving checks: `npm run smoke:autonomy-selfimprove`, `npm run smoke:autonomy-run` (if the
runtime interface changes), `npm run test:typecheck`, `npm run verify`, targeted eslint on the
changed files.

Acceptance: the new fixture passes and demonstrates that an over-budget cycle is caught pre-report
with the measured number while the worker is alive; the run resets to the last merged head and
keeps rejected work on the attempts branch; no existing check weakened.

Remaining (recorded as next-cycle / proposal, not this cycle): the item's full "re-land one item
at a time" orchestration beyond the steer, and the usd-per-merge metric.

### V-102 [P1] — verify V-10b (UI strings, installer/helper output, test assertions, brand scope)

Justification: an assigned board item; reconnaissance shows the work is already on the base (cycle
22 `85e93fa` plus `e19f880`/`f7554ce`) and every remaining `pi-system` is a documented identity
token. This cycle re-verifies it so the board can close it `done` without a code commit, rather
than manufacturing churn.

Proving checks: `npm run smoke:brand`, `npm run smoke:kit-update`, `npm run smoke:install-marker`,
plus `npm run verify` and `npm run test:security`; confirm `/update status` prints
`Luna update status` and that `git diff` introduces no new `pi-system`.

Acceptance: all named smokes pass; no new `pi-system` outside `docs/branding.md` tokens.

## Order

1. PG-66 implementation + gated review (workflow: implementer, then a reviewer that did not write
   the change, `max_loops` 1).
2. V-102 verification smokes (host, no agent needed).
3. PG-66 refinement from the reviewer, if any.
4. `verify.md` + `report.md`; update `HANDOFF.md`.

## Budget safeguard

After every commit: `git diff --no-renames 29eeab10123a..HEAD -- . ":(exclude)package-lock.json"
":(exclude)autonomy/cycles/luna-core-01/" ":(exclude)autonomy/runs/luna-core-01/" | wc -c`. Stop
taking new items at 30,000 chars; both items are small so we expect well under.
