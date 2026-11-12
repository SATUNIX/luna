# Review — cycle 11, run `luna-core-01`, stream `core`

Base: `d5c2cffe6d06` (head of `stream/core`, holds cycles 01–10). Mode chosen: **fix** — the cycle
carries a verified HANDOFF item and fixes two evidenced defects.

## State checked

- No assigned board items. `autonomy/runs/luna-core-01/HANDOFF.md` and cycle 10's report were read;
  `git log --oneline d5c2cffe6d06..HEAD` is empty, so no upstream conflict and no red gate.
- Reviewable diff at the base: 0 chars.
- Open proposals read (`luna-core-01-01/05/07`, `V-04`); the operator-decision ones stay proposals.

## Carry-over (priority 3): PG-51 thread-scoped CPU timing guards

The HANDOFF names PG-51 as the first carry-over. Scout inspection of
`origin/attempts/luna-core-01/cycle-08` (range `a6aa5c7..ea8027b`) found the tests-only diff
(16,448 chars) applies cleanly to HEAD (`git apply --check` exit 0) and builds only on symbols
already on HEAD (`cpuMs`, `bestCpuMs`, `assertCpuWithin`). Root finding: `tests/timing.ts` measures
process-wide CPU, so worker threads pollute the window and a linear redaction read as quadratic
under load (`tests/workflow-redaction-smoke.ts`). Fix: measure `process.threadCpuUsage()` with a
`process.cpuUsage()` fallback, make the redaction guard best-of-nine and warm both sizes, scope the
load harness to CPU-bound smokes. The branch's other test files are stale relative to HEAD
(`f24a144`, `3c643fc`); only the 7-file PG-51 range is portable. Evidence: `tests/timing.ts:1-70`,
`tests/timing-load-check.ts`. Verification harness: `tests/timing-load-check.ts` end to end.

## Defect (priority 4): `/compress` can exceed its character budget

`packages/extensions/src/compress/index.ts:280` sizes `fixed` from five elements but the final
`summary` (`:325`) joins up to six (`previous` adds one separator) and the omission marker
(`:319`, ~45 chars) is never subtracted from `remaining`. A case with a small residual `remaining`
and a `previousSummary` produces `summary.length = 4045` against a 4000 budget. The README
(`packages/extensions/src/compress/README.md:43`) and the module contract say the summary fits.
The existing pin `tests/compress-smoke.ts` `testBudgetKeepsFirstAndNewestTurns` only passes because
its case has slack. Fix: charge the marker and the extra separator to `remaining`. Target:
`node tests/compress-smoke.ts`.

## Defects found, not chosen this cycle

- `docs/capability-research-workflow.md:45-48` and `packages/extensions/third_party/caveman/index.ts:194`
  describe a `session_start` "wipe" that context-sieve does not perform; inclusion is mtime-scoped
  (`packages/extensions/src/context-sieve/index.ts:144-149,286-300`) and pinned by
  `tests/compaction-continuity-smoke.ts:62-80`. Docs-vs-code mismatch (priority 6); carried.
- Dead code: no-op ternary `packages/extensions/src/effort/index.ts:838`; unreachable
  `DYNAMIC_IDS` entries in `packages/extensions/src/context-sieve/index.ts:67` (priority 7); carried.
- V-07/V-08/V-10 still have no in-tree finding list (only carry-over notes and one board-parse test
  fixture at `tests/autonomy-selfimprove-smoke.ts:121-122`); not actionable without the operator.

## Out of scope

No upstream conflict; no red gate; no operator control path touched.
