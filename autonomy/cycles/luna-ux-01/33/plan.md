# Cycle 33 — Plan (run `luna-ux-01`, stream `ux`)

Mode: **fix**. Base `3925c17a2485`. Goal: close the carry-over V-02 focus-theft defect where the
resume question and `ask_human` card can open over one of the broker's two run approval cards,
without changing the broker's two-card contract; verify DE-98 stays complete.

## Item 1 — DE-98 verification (no code commit)

- Justification: assigned board item. Cycle 32's `7cf9075` already added the seven accurate
  `## [Unreleased]` entries and restored the 25-row QR fixture; the scout re-checked every entry
  against HEAD. No further change is warranted, so this cycle records the item done with the
  cycle-32 commit as evidence.
- Checks: `npm run smoke:tui-layout`, `npm run smoke:docs` (already green in review).

## Item 2 — run-card input hold for the resume question and `ask_human` (V-02)

- Justification: carry-over defect in `autonomy/runs/luna-ux-01/HANDOFF.md` and proposal 30.
  `packages/extensions/src/human-console/index.ts:347-358, 546-557` gate only on `inputHeld()`;
  run cards are deliberately outside the shared registry, so a second open run card is invisible
  and `showWhenFree` stacks the newer prompt on it. The two-card broker contract (pinned by
  `tests/firewall-overlay-queue-smoke.ts:877-879`) must not change.
- Change: keep run cards out of the global hold. Add a bounded local drain of `runCardHolder()`
  (using the caller's own timeout budget) plus a callback re-check in `askToResume` and
  `ask_human`. If a run card is still open when the budget ends, fail closed (the run stays
  paused / the question times out) exactly as the existing overlay path does.
- Tests: new case 2g in `tests/firewall-workflow-approvals-smoke.ts`: answer the 11th distinct
  approval while the broker's second run card is still open; assert no resume card appears until
  that card closes, then the resume question appears. Run `npm run smoke:firewall-workflow-approvals`
  and `npm run smoke:firewall-overlay-queue` (the two-card pin).
- Docs: `docs/security.md` input-owner paragraph: say the resume question and `ask_human` also
  wait behind open run cards.
- Checks: the two smokes above, plus typecheck/lint for the changed files.

## Out of scope this cycle

- `ui.json` settings clobber found in review: propose for the steward
  (`autonomy/proposals/luna-ux-01-33-ui-json-settings-clobber.md`); it outranks neither DE-98 nor
  the carry-over defect.
- No source change for DE-98, so the diff stays small and reviewable.
