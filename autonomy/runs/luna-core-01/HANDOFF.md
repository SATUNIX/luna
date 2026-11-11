# Handoff — run `luna-core-01`, stream `core`

## Where the work stands

- Branch `pi/luna-core-01`, base `d5c2cffe6d06` (head of `stream/core`, holds cycles 01–10).
  Cycle 11 commits, all pushed: `7ec19bf` (review+plan), `822fcc8` (PG-51 carry-over), `6c98e36`
  (`/compress` budget fix), plus the records under `autonomy/cycles/luna-core-01/11/` and the
  `luna-core-01/11` line in `autonomy/JOURNAL.md`.
- Cycle 11 outcome: **successful** (fix).
- Reviewable diff 23,627 chars — under the 60,000 read budget and the 30,000 stop-new-items mark.

## What cycle 11 did

1. **Carried the PG-51 timing guards (HANDOFF item 1).** Applied the cycle-08 tests-only range:
   `tests/timing.ts`'s `cpuMs()` now reads the calling thread's CPU (`process.threadCpuUsage()`,
   `process.cpuUsage()` fallback), the `workflow-redaction` guard is best-of-nine and warms both
   sizes, and the load harness lists only CPU-bound smokes. No product code changed.
2. **Fixed a `/compress` budget overrun.** `packages/extensions/src/compress/index.ts` undercounted
   the final summary: `previous` added a separator not in `fixed`, and the ~45-char omission marker
   was never charged to `remaining`. Measured 4047 against a 4000 budget. The fix charges
   `## Conversation\n` to `fixed` and reserves the marker and its separator before the older-turns
   loop; a new case `testBudgetReservesOmissionMarker` fails before and passes after.

## Checks that were run

`compress-smoke` (9/9), `tool-capture-smoke` (14), `trace-ledger-bound-smoke` (5),
`workflow-redaction-smoke` (4), `workflow-structured-smoke` (7), `workflow-sandbox-smoke` (19),
`docs-smoke` (green, journal gate included) — all PASS. `timing-load-check` **53/55**: the two
failures are `firewall-gate-smoke.ts`'s `redact on 200 KB` guard, which is not in this cycle's diff
— see the new proposal below. Never ran `npm test` or `npm run check:all`. Independent reviewer on
Item A: `VERDICT: PASS`; Item B had no independent reviewer (E3 child allowance exhausted) and needs
one at merge review. See `verify.md`.

## Merge

Every targeted check passes, but Item B lacks an independent review. Merge `pi/luna-core-01` into
`stream/core` only after the host acceptance checks pass on a clean checkout and merge review covers
Item B.

## Carry over to the next cycle

1. **`firewall-gate-smoke.ts:590` redaction guard is noisy under full load.** It keeps best-of-three
   while `workflow-redaction-smoke.ts` is best-of-nine, so `tests/timing-load-check.ts` reports 53/55,
   not 55. Measured alone under load it reads 95 ms vs a 200 ms budget, so it is contention noise,
   not a too-tight budget. Fix: best-of-nine here too, then re-run the harness
   (`autonomy/proposals/luna-core-01-11-load-guard-firewall-noise.md`).
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
9. Lower-priority found defects, not chosen: stale `session_start` "wipe" docs
   (`docs/capability-research-workflow.md:45-48`, `third_party/caveman/index.ts:194`; code is
   mtime-scoped) and dead code (`effort/index.ts:838`, `context-sieve/index.ts:67`).

## Rules for the next session

One logical change per commit (finding, root cause, fix, verification), push after each commit,
targeted checks only, reviewable-diff read budget 60,000 chars and stop new items past 30,000, never
edit `.github/`, `autonomy/CHARTER.md`, or operator control paths (propose them instead). Cite only
the new board-id shape (`PG-<n>`, `DE-<n>`). Never run `npm test` or `npm run check:all`. A
`workflow_run` task text must not contain a literal `{{...}}` that is not a valid template — it fails
the step before any agent launches. A long subagent can hit the wall limit — check its staged output
rather than re-dispatching blind. The E3 child allowance is 3 per request; once spent, `workflow_run`
and `subagent` both refuse until the next user message, so keep the last slot for a reviewer.

## Gotcha: `timing-load-check.ts` orphans its CPU burners if killed

`tests/timing-load-check.ts` spawns one burner per core and kills them in a `finally`, but a killed
parent (`SIGKILL`/a stopped subagent) leaves twelve hour-long burners running. In cycle 11 an earlier
background run was left behind and saturated the host, making `workflow-sandbox-smoke` fail its
watchdog (`'idle' !== 'timeout'`) and stalling a reviewer. Check `ps` for `3_600_000` before trusting
a load-sensitive failure or running the harness.
