# Handoff — run `luna-core-01`, stream `core`

## Where the work stands

- Branch `pi/luna-core-01`, base `5a888fe5dcf2` (head of `stream/core`; cycle 08 was never merged).
  Cycle 09 commits, all pushed: `21d75cf` (review+plan), `0471c71` + `bf74303` (PG-55 carry-over,
  cherry-picked from the cycle-08 attempt branch), `3c643fc` (PG-57), plus the records under
  `autonomy/cycles/luna-core-01/09/` and the `luna-core-01/09` line in `autonomy/JOURNAL.md`.
- Cycle 09 outcome: **successful** (fix).
- Reviewable diff 26,740 chars — under the 60,000 read budget, past the 30,000 stop-new-items mark.

## What cycle 09 did

1. **Root cause of the cycle-08 rejection.** `smoke:docs` (and so `check-all`) failed on the cycle-08
   tree only because `autonomy/cycles/luna-core-01/08/report.md` had no matching `autonomy/JOURNAL.md`
   line (`report with no journal entry: luna-core-01/08`, `tests/docs-smoke.ts:518`). Cycle 09 did not
   carry the cycle-08 records, so it owes no cycle-08 entry, and it added its own.
2. **Board PG-55 (P0, fix).** Carried over by cherry-pick; the run exposes the leak-scan publish
   blocker and merged-but-unpublished count in status and `state.json`, the next cycle's prompt names
   the refused commit and locations only, the run blocks with an operator question after two
   merged-but-unpublished cycles, and a clean publish clears all three. `node
   tests/autonomy-selfimprove-smoke.ts` 41/41, `autonomy-cli-smoke` 16, `autonomy-smoke` 32.
3. **Board PG-57 (P1, fix).** `runStep` now appends a `## Required output` block to the step task
   naming each declared file by absolute path and stating the step fails if the exact file is absent;
   the failure names the absolute path. `workflow-smoke` 13/13, `workflow-plan-smoke` 91. Independent
   `subagent` reviewer: `VERDICT: PASS`.

## Checks that were run

`autonomy-selfimprove-smoke` (41), `autonomy-cli-smoke` (16), `autonomy-smoke` (32),
`workflow-smoke` (13), `workflow-plan-smoke` (91), `npx tsc -p tests/tsconfig.json`, `test:lint`,
`docs-smoke` (green, journal gate included), `check-all --check-wiring` — all PASS. Never ran
`npm test` or `npm run check:all`. See `verify.md`.

## Merge

Every targeted check passes and an independent reviewer returned PASS for PG-57 (PG-55 was reviewed
PASS in cycle 08 and re-ran green). Merge `pi/luna-core-01` into `stream/core` only after the host
acceptance checks pass on a clean checkout.

## Carry over to the next cycle

1. **PG-51 (cycle-08 carry-over, not carried).** The load-tolerant smoke timing guards are sound and
   verified on `origin/attempts/luna-core-01/cycle-08` (`cfe2ea0`, `84894cc`, `3329032`, `ea8027b`,
   27,519 reviewable chars) but did not fit this cycle's diff budget next to PG-55 + PG-57. Re-carry
   or re-implement and run `tests/timing-load-check.ts` green end to end (cycle 08 left it 54/55 with
   the redaction fix applied and never re-ran the full 11-smoke sweep).
2. **Cycle-08 records live only on the attempt branch.** If a later cycle brings
   `autonomy/cycles/luna-core-01/08/report.md` over, it must add the matching journal line
   `- luna-core-01/08 | Board: PG-55, PG-51 | successful | ...` or `smoke:docs` goes red again.
3. Skill-router `re:` trigger wall cap is 500 ms per trigger (was 50 ms) because a CPU budget cannot
   interrupt a match — operator choice: `autonomy/proposals/luna-core-01-07-skill-trigger-wall-cap.md`.
4. `packages/core/install.ts`'s npm/`trunk` guard is untested until `distribution.json` has an npm
   channel (`autonomy/proposals/luna-core-01-05-npm-trunk-channel.md`).
5. Cycle 03's env-ownership work (`472a37f`, `0b02622`, `31d77ca`) is on
   `origin/attempts/luna-core-01/cycle-03` only; sound but not re-verified on this base.
6. `.github/CODEOWNERS:43` names a path with 0 tracked files — `.github/` is a control path; operator
   decision (`autonomy/proposals/luna-core-01-03-codeowners-dead-path.md`).
7. Sandbox `sliceMs` loses to the wall-clock `idleMs` watchdog under load; operator decision on the
   runner's watchdog semantics (`autonomy/proposals/luna-core-01-08-sandbox-watchdog-load.md`).
8. Defect IDs V-07/V-08/V-10 still need the operator's in-tree finding list; the owner-side
   `coverage` CI job is red and untouched.

## Rules for the next session

One logical change per commit (finding, root cause, fix, verification), push after each commit,
targeted checks only, reviewable-diff read budget 60,000 chars and stop new items past 30,000, never
edit `.github/`, `autonomy/CHARTER.md`, or operator control paths (propose them instead). Cite only
the new board-id shape (`PG-<n>`, `DE-<n>`). Never run `npm test` or `npm run check:all`. A
`workflow_run` task text must not contain a literal `{{...}}` that is not a valid template — it fails
the step before any agent launches. A long subagent can hit the wall limit — check its staged output
rather than re-dispatching blind.
