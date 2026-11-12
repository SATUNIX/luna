# Proposal — tighten the skill-router `re:` trigger wall-clock cap

Status: proposed (not implemented). Author: cycle 07, run `luna-core-01`.

## Context

Cycle 07 changed the untrusted project `re:` trigger guard in
`packages/extensions/src/skill-router/match.ts` from a 50 ms `node:vm` wall-clock timeout to a
50 ms **CPU-time** budget. A busy host no longer switches off a correct trigger; the change is
pinned by `tests/skill-routing-smoke.ts` and reviewed as acceptable (`verify.md`).

The CPU budget cannot interrupt a running match — it is applied after the match returns. The only
interruption is the wall-clock cap, set in that change to `TRIGGER_TEST_WALL_MS = TRIGGER_TEST_MS *
10` = 500 ms, plus one retry. So a single untrusted `re:` trigger can now consume up to roughly
500 ms CPU / 1 s wall before it is switched off, where the old guard cut it at 50 ms wall.

## Why it is bounded (why this is not urgent)

- Switch-off is per session and permanent for the trigger, and `compiled` is a map keyed by
  trigger string, so one pattern cannot repeatedly burn the budget.
- `packages/core/shared/safe-regex.ts` already refuses nested quantifiers, backreferences and
  over-long patterns before the match runs.
- The escalation is a bounded constant, not an amplification loop.

## Suggestion

If the operator wants the tighter bound back, one of:

1. Lower `TRIGGER_TEST_WALL_MS` (for example to `TRIGGER_TEST_MS * 2`): still long enough for a
   descheduled fast regex to finish in one retry on a loaded host, but caps a runaway at ~100 ms.
2. Add a per-prompt cap on how many trigger tests may spend the budget, so many slow-but-under-
   budget triggers cannot sum up within one prompt.

Both need the load-check (`node tests/timing-load-check.ts`) and `tests/skill-routing-smoke.ts` to
confirm a busy host still does not lose a correct trigger. This is an operator decision, not a
cycle defect: the shipped change fixes a reproduced bug (a loaded host dropping a correct
`codebase-navigation` match) without removing the guard.
