# Cycle 24 — Plan (run `luna-ux-01`, stream `ux`)

Mode: fix. Base `5e6b7a7b0f7f`. Two items, both in the stream area (TUI overlays).

## Item 1 — Hard-clamp the `/workflows` panel below its fixed-block height

Justification (charter item 1 + priority 4/consolidation): reproduced defect, evidence in
`review.md` F1. Cycle 23's improvement left the fixed block unclamped, so 4–6 terminal rows still
produce a body taller than the host's framed cap (body 4 vs 1–3; save-confirm body 5 vs 1–4).

Change:

- `packages/extensions/third_party/subagent/wf-panel.ts`: after the existing confirm fallback
  (hint, then spacer), hard-clamp the composed body to `maxLines` when `maxLines` is defined and
  the fixed block cannot fit. Keep the bottom rule and the last lines (tail-preserving), so a
  confirm keeps its choices + rule and the list keeps its footer + rule; never exceed the budget
  for any `rows`. Header/`maxLines` maths unchanged for the evidenced 8–20-row range.
- `tests/workflow-panel-smoke.ts`: add a case for 4, 5, 6 and 7 rows (list with 14 runs; a save
  confirm in the run view) asserting body <= `floor(rows*0.9)-2`, framed <= `floor(rows*0.9)` and
  that the bottom rule is the last body line. Pre-fix these fail on the measured numbers above.
- `docs/workflows.md`: describe the last-resort clamp below the fixed-block height.

Checks: `npm run smoke:workflow-panel`, `npm run test:typecheck`, `npm run test:lint`,
`npm run smoke:docs`. Never `npm test` / `npm run check:all`.

## Item 2 — Close the stale proposal 18 (docs accuracy)

Justification (priority 6: documentation that does not match the code): proposal 18 still says
`proposed`, but `hub.ts:404-410` keeps the focused row (`f8a85ce`, cycle 19) and
`tests/control-center-smoke.ts` already pins it with the moved-focus case at 3 and 4 terminal rows
("a very short overlay keeps the focused row when the cursor is not in the head"). The review
initially read only the neighbouring 8/10/24-row case; a second read found the dedicated test, so
no test change is needed (review F2).

Change:

- `autonomy/proposals/luna-ux-01-18-short-overlay-drops-focus.md`: mark `implemented` with the
  landing commit, the `hub.ts` branch and the test that pins it; keep the problem description.

Checks: `npm run smoke:control-center`, `npm run smoke:docs`.

## Order and limits

Item 1 then item 2, each through one `workflow_run` implementer + gated reviewer plan (fallback to
`subagent` on refusal), commit and push per item. Measure the review diff after each commit; stop
taking new items past 30000 characters. No control paths, no `package.json` scripts, no
dependencies.
