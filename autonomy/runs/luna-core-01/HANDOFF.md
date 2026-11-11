# Handoff — run `luna-core-01`, stream `core`

## Where the work stands

- Branch `pi/luna-core-01`, base `559f2d99edbf` (head of `stream/core`, holds cycles 01–09).
  Cycle 10 commits, all pushed: `106bc4d` (review+plan), `f24a144` (PG-55 exit-path fix), plus the
  records under `autonomy/cycles/luna-core-01/10/` and the `luna-core-01/10` line in
  `autonomy/JOURNAL.md`.
- Cycle 10 outcome: **successful** (fix).
- Reviewable diff 7,317 chars — under the 60,000 read budget and the 30,000 stop-new-items mark.

## What cycle 10 did

1. **Assigned board work was already merged.** PG-55 (blocked publication stops the run loudly) and
   PG-57 (declared-output step names its file) were both implemented in cycle 09; PG-57 needed no
   further action.
2. **Found and fixed a defect in the merged PG-55 work.** The block offered the operator "Remove the
   identifier and resume", but `runStep` re-parked before any worker started, so the answer was
   lost and only "Stop the run" worked. Root cause: the stop condition is a pure predicate over
   `publishBlockedCycles`, and `pendingAnswer` is cleared only on a cycle resume. Fix: carry the
   blocker `id` on `PendingAnswer` (`lifecycle.ts`), set it in `engine.answer` (`engine.ts`), and
   consume a `publish-blocked` answer once in `runStep` (`self-improve.ts`) so exactly one cycle
   runs, re-parking if publication is still refused. `docs/autonomy.md` states the rule; a new smoke
   case fails before the fix (`2 !== 3`) and passes after. `autonomy-selfimprove-smoke` 42/42.

## Checks that were run

`autonomy-selfimprove-smoke` (42), `autonomy-smoke` (32), `autonomy-cli-smoke` (16),
`npx tsc -p tests/tsconfig.json` and `-p packages/autonomy/tsconfig.json` (exit 0), `test:lint`
(exit 0), `docs-smoke` (green, journal gate included) — all PASS. Never ran `npm test` or
`npm run check:all`. Independent reviewer on `git diff 106bc4d..HEAD`: `VERDICT: PASS`. See
`verify.md`.

## Merge

Every targeted check passes and an independent reviewer returned PASS. Merge `pi/luna-core-01` into
`stream/core` only after the host acceptance checks pass on a clean checkout.

## Carry over to the next cycle

1. **PG-51 (cycle-08 carry-over, not carried).** The load-tolerant smoke timing guards are sound and
   verified on `origin/attempts/luna-core-01/cycle-08` (`cfe2ea0`, `84894cc`, `3329032`, `ea8027b`,
   27,519 reviewable chars) but did not fit this cycle's diff budget. Re-carry or re-implement and
   run `tests/timing-load-check.ts` green end to end.
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
