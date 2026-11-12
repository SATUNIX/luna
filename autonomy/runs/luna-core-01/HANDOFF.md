# Handoff — run `luna-core-01`, stream `core`

## Where the work stands

- Branch `pi/luna-core-01`, base `ff6083ca18b2` (head of `stream/core`, holds cycles 01–16).
  Cycle 17 commit: `3c1a9f3` (memory-vault first-turn recall over-fetches by the pinned count and
  only excludes already-injected rels, so pins no longer crowd out relevant memories and a
  truncated pin stays searchable), plus the records under `autonomy/cycles/luna-core-01/17/`.
  - Cycle 17 outcome: **successful** (fix). One scout-found defect fixed and pinned by a new
  `smoke:memory-vault` check 15 that fails on base `ff6083ca18b2` (`expected: /### Relevant
  memories/`) and passes on head. All targeted checks green; diff 11,112 chars over 3 files,
  +81/−26.
  - The independent reviewer subagent hung without a verdict for the second cycle running
  (`2026-11-11T22-23-38-772Z-reviewer-20dbf0` ends on a bare `tool_execution_start`). Verdict
  replaced by objective base-vs-head checks, as in cycle 16. A second item plan was refused
  (`plan-allowance`, 7/8 agents used); the implementer/reviewer fell back to `subagent`.
  - Cycle 17 left three proposals: `luna-core-01-17-context-sieve-message-framing.md` (LOW),
  `luna-core-01-17-doc-drift-64-token-and-guidelines.md` (doc-only one-liners), and
  `luna-core-01-17-skill-trigger-session-lifetime.md` (security-adjacent, operator decision).
  - Still deferred: HANDOFF #4 `tests/orchestrate-commands-smoke.ts` not clearing
  `PI_KIT_INTERNAL_CHILD` (test robustness only); V-07/V-08/V-10 still need the operator's finding
  list; #1 firewall timing noise is out of stream.

## What cycle 15 did

1. **Memory-vault first-prompt recall.** `memory-vault/index.ts` cleared `firstPrompt` on every
   `before_agent_start`, including a run started by an extension custom message, so the real first
   user prompt lost the earlier-session recap and pinned-memory block. Now the flag clears only on
   a user prompt and the recap block is gated on `firstPrompt && "prompt" in event`. Pinned by a
   new assertion in `tests/memory-vault-smoke.ts`; docs say "first user prompt".
2. **Dead code.** Removed the always-empty ternary in `effort/index.ts` and the `memory-vault` /
   `skill-router` ids in `context-sieve/index.ts` that no producer writes. Behaviour unchanged;
   `smoke:effort` 38/38 and `smoke:ctx-contributions` 13/13.

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
9. Remaining lower-priority found defect: HANDOFF #4, `tests/orchestrate-commands-smoke.ts` does
   not clear `PI_KIT_INTERNAL_CHILD`; test robustness only. The cycle-13 stale "wipe" docs and the
   cycle-15 dead-code sites are already fixed. V-07/V-08/V-10 still need the operator's finding list.
10. **context-sieve hidden-message framing is outside its budget** (LOW, token efficiency):
    `assembleWithBudget` bounds only the contribution text while the 78-char header and the
    `stillCurrent` line are appended after, and `message.tokens` measures only the blocks. Suggested
    fix and tests in `autonomy/proposals/luna-core-01-17-context-sieve-message-framing.md`.
11. **Two doc drifts, one line each:** `docs/architecture/memory-compaction-context.md`'s "never
    below 64 tokens" is false (the floor is itself capped at half the window; `tests/context-budget-smoke.ts:321`
    pins 50 for a 100-token window), and `packages/extensions/src/guidelines/README.md` lists a
    search path (`AGENTS.md`) the code never reads and omits the `pentest` profile. See
    `autonomy/proposals/luna-core-01-17-doc-drift-64-token-and-guidelines.md`.
12. **skill-router `re:` switch-off outlives the session** (security-adjacent, operator decision):
    `match.ts` mutates process-lifetime `compiled`/`refusedTriggers` and `session_start` never clears
    them, while the comment and two docs say "for the session". Options in
    `autonomy/proposals/luna-core-01-17-skill-trigger-session-lifetime.md`.

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
