# Review — cycle 09, run `luna-core-01`, stream `core`

Base: `5a888fe5dcf2` (head of `stream/core`, cycle 08 not merged). Branch `pi/luna-core-01`.
Charter read in full (`autonomy/CHARTER.md`). No `refs/upstream/trunk` exists, so priority 1 is
clear. Cycle 08 was **not merged**: the acceptance check `check-all` / `check-all:smoke:docs` was
red.

## Root cause of the cycle-08 rejection (priority 0)

`docs-smoke` fails on the cycle-08 tree with:

```
AssertionError: autonomy/JOURNAL.md disagrees with the cycle reports
+ report with no journal entry: luna-core-01/08; add:
   - luna-core-01/08 | Board: PG-55, PG-51 | **successful** | <summary>
    at tests/docs-smoke.ts:518
```

Reproduced in a detached worktree of `origin/attempts/luna-core-01/cycle-08` (exit 1). Cycle 08
wrote `autonomy/cycles/luna-core-01/08/report.md` but never added its `autonomy/JOURNAL.md` line,
which `packages/core/lib/journal.ts` / `tests/docs-smoke.ts:518` require. This is bookkeeping, not a
code defect; the cycle-08 code itself was reviewed PASS.

## Assigned board items

### PG-55 [P0] — a blocked publish must stop the run loudly

**Finding: implemented and verified on the attempt branch; sound, bring it over.** Commits
`8992891` and `a6aa5c7` on `origin/attempts/luna-core-01/cycle-08` implement the acceptance:
`publishNow`/`closeCycle` track `publishBlockedCycles`; `statusReport`/`statusText`
(`packages/autonomy/cli.ts`) and `state.json` expose `publishBlocker` and the merged-but-unpublished
count; `cyclePrompt` prefixes a `## Publication blocked` block naming the refused commit and
locations only; `runStep` calls `engine.enterBlocked` with an operator question once
`publishBlockedCycles >= 2`; a successful publish clears all three. `a6aa5c7` ensures a non-merged
cycle does not reset the streak and a generic error does not erase a real blocker. The leak scan and
its patterns are untouched. Carry-over diff is 22,039 reviewable chars.

### PG-57 [P1] — a declared `outputs` step fails because the task never says to write the file

**Finding: reproduced in the code.** `packages/extensions/third_party/subagent/workflow.ts:922-924`
builds `task` from `step.task`; the only mention of writing files is `BLACKBOARD_NOTE` at 824-832,
which is passed as `appendSystemPrompt` (953) and never names the declared `outputs`. The step still
fails at 1015-1018:

```
st.error = `declared output(s) not written in ${runDir}: ${missingOutputs.join(", ")}`;
```

The subagent sees only its task, so the contract is invisible until after the tokens are spent
(evidence: `luna-ux-01` c05 16,991 output tokens / $0.0206 and c10 48,445 / $0.1414; the gated
review never ran). Existing tests assert the current text: `tests/workflow-smoke.ts:295`,
`tests/workflow-plan-smoke.ts:317`. Fix is local to `runStep`.

## Priority 1 upstream conflict

None: `packages/core/verify.ts`/the release flow sees no `refs/upstream/trunk`.

## Priority 2 (board) vs priority 3 (HANDOFF carry-overs)

The two assigned items are PG-55 and PG-57. Cycle 08's other item, PG-51 (load-tolerant smoke timing
guards, 27,519 reviewable chars), is a carry-over: bringing it over on top of PG-55 plus PG-57 would
push the reviewable diff past 60,000 chars. It stays on `origin/attempts/luna-core-01/cycle-08`
(`cfe2ea0`, `84894cc`, `3329032`, `ea8027b`); recorded in the handoff. Cycle-08's `report.md`,
`plan.md`, `verify.md` and `review.md` are **not** brought over, so no cycle-08 journal entry is
required (the journal check requires a report and its entry to match).

Remaining HANDOFF carry-overs are unchanged and need the operator: skill-trigger wall cap, npm/trunk
guard, cycle-03 env-ownership attempt branch, dead CODEOWNERS path, V-07/V-08/V-10, owner-side
`coverage` job, and the sandbox-watchdog load proposal.

## New problems found

None beyond the two board items. No security-relevant gap found in the touched files.
