# Cycle 24 — Report (run `luna-ux-01`, stream `ux`)

Outcome: successful
Mode: fix

Workflow: refused the item-2 `workflow_run` plan (plan-allowance: 4 agents would not fit the E3
per-request allowance; item 1 had already planned 6). Item 1 ran through its implementer + gated
reviewer plan, but the gated reviewer step only emitted its first message; the independent review
was a `reviewer` `subagent`, which ran fully. Item 2's implementer `subagent` produced no output
(no files changed), so its small docs-only change was made in the coordinating context and
checked against the existing test.

Item: Hard-clamp the `/workflows` panel body below its fixed-block height - 74fa83e, b235a6b - smoke:workflow-panel 19/19 (new 4-7-row list and save-confirm cases fail on the base measurements of body 4 vs 1-3 and body 5 vs 1-4)
Item: Close the stale proposal 18 (moved focus already fixed and pinned) - d83a940 - smoke:control-center 45/45

## What changed

Item 1: cycle 23 bounded the panel's middle and the confirm hint/spacer, but not the fixed block.
Below about seven terminal rows the composed body was still taller than the host overlay's framed
cap: with 14 runs the list view gave 4 body lines against budgets of 1/2/3 at 4/5/6 rows, and a
save confirm whose run had been pruned from the registry gave 5 lines against 1-4 at 4-7 rows.
`WorkflowPanel.render` now clamps the composed body to `maxLines` from the bottom up after the
existing fallbacks, so the bottom rule always survives and the neighbouring lines survive where
the budget allows. The 8-20-row behaviour is unchanged. `docs/workflows.md` describes the clamp,
including what a one-line budget leaves.

Item 2: proposal 18 claimed the focused row can be clipped on a very short overlay. It was already
fixed in cycle 19 (`f8a85ce`, the `focus` branch in `hub.ts`) and already pinned by
`tests/control-center-smoke.ts` ("a very short overlay keeps the focused row when the cursor is not
in the head", focus moved to `cmd19` at 3 and 4 rows). The review first read only the neighbouring
cmd0 short-terminal case and planned a new test; a second read found the dedicated one. The
proposal is now marked implemented with the commit, branch and test pointers, and the cycle
review/plan carry the corrected finding. No code or test change was needed.

No test was loosened; no `any`, `eslint-disable`, dependency, `package.json` script,
`autonomy/CHARTER.md` or control-path change.

## Verify

All green at `d83a940`: `smoke:workflow-panel` 19/19, `smoke:control-center` 45/45, `smoke:docs`,
`test:typecheck`, `test:lint`. The targeted checks and pre-fix numbers are in `verify.md`. Item 1's
independent reviewer ended `VERDICT: PASS` and its one doc-wording warning was fixed in `b235a6b`.
A whole-cycle independent review could not be launched (E3 child budget exhausted by the stalled
runs); the host gate and the merge review are the independent check for the full diff (8411
characters outside records).

## Left for later

- The whole-cycle reviewer was refused for the child budget, not because of a finding. If the
  merge review wants one before merging, it is the only missing check.
- Open proposals unchanged: idle-cat blink, inert Settings value rows, Work page lab group, hub
  `ctx.mode` fallback, `TRUNK_CHANNEL` alias. The `/workflows` ≤7-row edge is now closed.

## For the next cycle

- Never run `npm test` / `npm run check:all`; the host gate owns the full suite.
- Add the `autonomy/JOURNAL.md` line with the report in the same push (`smoke:docs` gate).
- Subagents and gated reviewer steps stalled repeatedly this cycle (first message only, or no
  output). Budget for retries or do small docs-only items directly; check what an implementer
  actually changed in the working tree before assuming it ran.
- A stale proposal's `Status` line is worth checking against `git log -L` before planning tests:
  cycles 19 and 23 landed more than the proposal files record.
