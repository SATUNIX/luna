# Plan — cycle 11, run `luna-core-01`, stream `core`

Base: `d5c2cffe6d06`. Mode: **fix**. Reviewable-diff stop-new-items mark: 30,000 chars.

## Item A (carry-over, priority 3): PG-51 thread-scoped CPU timing guards

Justification: the HANDOFF's first carry-over; a real false-failure defect (process-wide CPU makes a
linear redaction read as quadratic under load). The tests-only range applies cleanly to HEAD.

Change: apply the 7-file PG-51 tests range from `origin/attempts/luna-core-01/cycle-08`
(`a6aa5c7..ea8027b`): `tests/timing.ts` (measure `process.threadCpuUsage()` with fallback, fix the
duplicated-words doc typo), `tests/timing-load-check.ts`, `tests/tool-capture-smoke.ts`,
`tests/trace-ledger-bound-smoke.ts`, `tests/workflow-redaction-smoke.ts` (best-of-nine, warm both
sizes), `tests/workflow-sandbox-smoke.ts`, `tests/workflow-structured-smoke.ts`, plus the
`CHANGELOG.md` entry. Do NOT apply the branch's `autonomy-selfimprove-smoke.ts`,
`workflow-plan-smoke.ts` or `workflow-smoke.ts` changes — HEAD is ahead there.

Checks: `node tests/timing-load-check.ts` green end to end (the harness); plus the converted smokes
`tool-capture`, `trace-ledger-bound`, `workflow-redaction`, `workflow-sandbox`,
`workflow-structured`, `compress` not affected. Also `node tests/docs-smoke.ts` if `CHANGELOG.md`
is read by it.

## Item B (defect, priority 4): `/compress` must not exceed its character budget

Justification: `packages/extensions/src/compress/index.ts:280` undercounts the final summary —
`previous` adds a separator not in `fixed`, and the omission marker (`:319`) is never charged to
`remaining`. Measured 4045 against a 4000 budget, contradicting the README.

Change: subtract the marker length and the `previous` separator from `remaining` before the final
join, so `summary.length <= lim.budget` always. Test: extend `tests/compress-smoke.ts`
`testBudgetKeepsFirstAndNewestTurns` (or add a case) with a `previousSummary` and a tight budget
that fails before the change and passes after. Docs: none needed unless the README's exact wording
must change; verify it already says "fits".

Checks: `node tests/compress-smoke.ts`.

## Not chosen (carried to the next cycle / proposals)

- Stale `session_start` wipe docs (`docs/capability-research-workflow.md:45-48`,
  `caveman/index.ts:194`) — priority 6.
- Dead code (`effort/index.ts:838`, `context-sieve/index.ts:67`) — priority 7.
- V-07/V-08/V-10 need the operator's finding list.

## Checks to run at the end

Targeted smokes for each changed file, then an independent reviewer on the whole diff. Never
`npm test` or `npm run check:all`.
