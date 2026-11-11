# Review — cycle 10, run `luna-core-01`, stream `core`

Base: `559f2d99edbf` (head of `stream/core`, holds cycles 01–09). Mode chosen: **fix** — the
assigned board work and the carried-over defect below are repairs.

## Assigned board items

- **PG-55 [P0]** A publish blocked by the leak scan must stop the run loudly, not cycle unpublished.
  Cycle 09 implemented it (`0471c71`, `bf74303`) and it is merged. The status/state exposure, the
  next-cycle prompt note, the two-cycle stop and the clean-publish clear are all present
  (`packages/autonomy/lib/templates/self-improve.ts:302-306,401-406,507-509`,
  `packages/autonomy/cli.ts:272,298`, `packages/autonomy/lib/lifecycle.ts:219-221`) and tested
  (`tests/autonomy-selfimprove-smoke.ts:575-729`).
- **PG-57 [P1]** A declared-output step must name the output file. Cycle 09 implemented it
  (`3c643fc`) and it is merged; the required-output block and the absolute-path failure text are
  present (`packages/extensions/third_party/subagent/workflow.ts:928,1022`) and tested.

## Finding — PG-55's operator exit path does not work (defect in merged cycle-09 work)

**Evidence (code).** When two merged cycles stay unpublished, `runStep` parks the run:

```ts
// self-improve.ts:401-406
if (!si.current && (si.publishBlockedCycles ?? 0) >= 2) {
  await engine.enterBlocked({ kind: "external", id: "publish-blocked", ..., options: ["Remove the identifier and resume", "Stop the run"] });
  return;
}
```

An operator answer goes through `engine.answer` (`engine.ts:564-576`): it records
`state.pendingAnswer`, sets `startReason = "answer"` and `go("running")`. The engine loop then calls
`runStep` again (`engine.ts:488`). `si.current` is still `null` and `publishBlockedCycles` is still
`>= 2`, so **the same branch re-enters `blocked` before any worker session can start**. The
`pendingAnswer` is never consumed on this path (the engine clears it only in `briefing()` when a
session resumes, `engine.ts:1045`, and a blocked publish never resumes a cycle), so the answer is
lost and the "Remove the identifier and resume" option is a no-op — the only working option is
"Stop the run".

**Evidence (test gap).** `tests/autonomy-selfimprove-smoke.ts:638-668` only asserts the run parks
after the second blocked cycle; the `onSleep` hook stops the engine the moment it sees `blocked`
(`:646`). No test sends `answer` on the `publish-blocked` blocker, so the missing exit path is
uncovered.

**Root cause.** The stop condition is a pure predicate over `publishBlockedCycles`; it has no term
for "an answer was just given", so the run cannot distinguish "no operator yet" from "operator
answered; give the worker a cycle".

**Fix (intended).** Consume a `publish-blocked` operator answer exactly once in `runStep`: when
`pendingAnswer` is the answer to the publish question, clear it and let one cycle run; otherwise
park as before. Because a still-blocked merge in that cycle does not clear `publishBlocker` /
`publishBlockedCycles`, the next `runStep` parks again — one cycle per answer, never a silent
unbounded cycle, and a successful publish clears everything as today. To identify the answer
unambiguously, add the blocker `id` to `PendingAnswer` (`lifecycle.ts:201-207`) and set it in
`engine.answer` (`engine.ts:572`); no in-tree code constructs `PendingAnswer` elsewhere.

**Docs.** `docs/autonomy.md:579-585` describes the stop and the question but says nothing about
resuming; it must state that an answer buys one cycle and the run parks again if the publication is
still refused.

## Other checks (no action this cycle)

- PG-57 is complete; no consolidation needed.
- No red gate: the branch is `559f2d99edbf` with no commits yet.
- No upstream conflict: `stream/core` is the base.
- The remaining HANDOFF carry-overs (PG-51 timing guards, proposal items needing the operator,
  V-07/V-08/V-10) are not in this cycle's scope: the publish-block exit is P0 and outranks them.
