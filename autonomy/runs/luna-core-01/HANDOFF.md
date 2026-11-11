# Handoff — run `luna-core-01`, stream `core`

## Where the work stands

- Branch `pi/luna-core-01`, base `68d70c78940c` (head of `stream/core`, holds cycles 01–13).
  Cycle 14 commits: `aa676c2` (compress zero-turn guard), `003b36b` (footprint baseline guard),
  plus the records under `autonomy/cycles/luna-core-01/14/` and the `luna-core-01/14` line in
  `autonomy/JOURNAL.md`.
- Cycle 14 outcome: **successful** (fix). Board empty. Two evidenced defects fixed: `/compress`
  threw `turn 0 is out of range` on a history with no groupable turns, and the footprint CLI
  crashed with a stack trace on a malformed `--baseline` (now a clean exit 2). Targeted smokes
  green, independent reviewer PASS. Reviewable diff 47 insertions / 6 deletions over 5 files.
- Deferred with evidence in `autonomy/cycles/luna-core-01/14/review.md`: dead code
  (`effort/index.ts:838` empty ternary; `context-sieve/index.ts:67` two dead `DYNAMIC_IDS` entries),
  `memory-vault/index.ts:133` consuming `firstPrompt` on a promptless run, and
  `tests/orchestrate-commands-smoke.ts` not clearing `PI_KIT_INTERNAL_CHILD`.

## What cycle 12 did

1. **PG-55: the publish-blocked answer can now publish.** The answer rolls the local integration
   branch back to the last published head with an ancestor-guarded `update-ref`, drops every run
   tag whose commit is not an ancestor of that head (`cycle-NN` and `abandoned-NN` alike), marks
   those history entries `discarded` so the next prompt says to redo the work, and keeps the
   blocker/streak until a real push. A new smoke parks on two refused merges, answers, removes the
   leak, and asserts a later cycle starts.
2. **PG-19: paperwork budget.** `packages/core/paperwork-budget.ts` caps a cycle's four record
   files at 60 lines and requires exactly one matching `JOURNAL.md` line (exit 1 on overrun, 2 on
   bad args). It is a documented manual steward check, not a merge gate. This cycle's own four
   files are 49/60.
3. **V-81: footprint CLI.** `node packages/core/eval/footprint.ts --profile <name> [--json]
   [--write-baseline]` prints the tool text, derived tokens and baseline problems; the write is
   atomic and byte-identical when the record has not changed. Documented in
   `docs/efficiency-and-loops.md`; `smoke:eval-footprint` is 13 checks.

## Checks that were run

`smoke:autonomy-selfimprove` (43/43), `smoke:paperwork-budget` (5/5), `smoke:eval-footprint`
(13/13), `test:typecheck`, targeted `eslint`, `smoke:docs`, and the paperwork CLI on this cycle
(49/60, one journal line). Never ran `npm test` or `npm run check:all`. Independent reviewer on
`363dba0b9a25..be8f294`: **VERDICT PASS** after `be8f294`.

## Merge

All targeted checks pass and the independent review passed. Merge `pi/luna-core-01` into
`stream/core` once the host acceptance checks pass on a clean checkout.

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
