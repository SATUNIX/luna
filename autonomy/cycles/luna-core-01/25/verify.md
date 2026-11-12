# Cycle 25 verification

Base `69945c63d794`, branch `pi/luna-core-01`. One code commit: `1865ed4` (standing-reminder
dedup). Review/plan commit `b035a01`; records follow. No existing test was weakened.

## Proving the finding on the base

- Base `packages/extensions/src/effort/index.ts:772-775` (shown by
  `git show 69945c63d794:...`): `const hidden = [reminder, card]...` with
  `customType: reminder ? STANDING_REMINDER_TYPE : WORKFLOW_CARD_TYPE` — the reminder is returned
  every turn while `standingShown`, with no comparison against the previous one.
- Measured reminder length 152 chars (no budget) / 168 chars (with budget) via `wc -c`; the full
  `policy/standing.md` is already in that turn's system prompt, so the copy is redundant.

## Test runs (targeted only; never `npm test` / `npm run check:all`)

- `npm run smoke:effort-standing` — PASS, `[effort-standing-smoke] all 13 checks passed`. The new
  second-unchanged-turn assertion (`messageOf(unchanged) === null`) fails on the base, which always
  returned the reminder; the size-change turn re-emits it with the new size.
- `npm run smoke:effort` — PASS, `[effort-smoke] all 38 checks passed`.
- `npx tsc -p tests/tsconfig.json` — PASS, exit 0.
- `npx eslint packages/extensions/src/effort/index.ts tests/effort-standing-smoke.ts` — PASS, exit 0.
- `npm run smoke:docs` — run after this cycle's records and JOURNAL line were written (see below).

## Independent review

Reviewer subagent (read-only, did not write the change) reviewed commit `1865ed4` against the plan
and `autonomy/CHARTER.md`: confirmed the finding is real, the fix is correct and minimal
(`emitReminder` gate, `lastReminder = null` when standing is off, clears in `session_start` and
`session_compact`, `customType` tied to the emitted reminder), the new assertion fails on the base,
only the three expected files changed, no assertion weakened, and docs match. `npm run
smoke:effort-standing` 13/13. Verdict: **PASS**, no must-fix.

## Reverted attempt (recorded for the next cycle)

Review Finding A (cycle 24's `-es` branch maps `buses -> buse`, missing `bus`) was attempted first.
The implementer's variant was rejected by an independent reviewer (**FAIL**): any rule that detects
"the singular ends in s" from the plural's stripped base also catches silent-e plurals whose base
ends in s (`cases -> cas` vs `case -> case`, `houses -> hous`, `causes -> caus`), a broader
regression than the miss it fixed. The commit and working tree were reverted with
`git reset --hard b035a01`; the cycle base `search.ts` is untouched. No net-positive heuristic fix
without a lexicon. Handed to the next cycle with the evidence in `review.md`.

## Residual limits

- The stemmer still cannot meet short s-ending singulars with their `-es` plurals
  (`bus`/`buses`, `gas`/`gases`, `lens`/`lenses`) without a lexicon; documented heuristic limit.
- Finding C (E5 `PLAN_STEER` / workflow card duplication) and Finding D (brand-smoke scope) are
  proposals, not implemented.
