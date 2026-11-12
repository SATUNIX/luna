# Cycle 12 — Plan (run `luna-ux-01`, stream `ux`)

Mode: **fix**. Priority 0 (red gate) first, then the steward's V-02 item.

## Item 1 — Repair the cycle 11 gate failure (priority 0)

Change: cherry-pick `3cbb951`, `8b5bc41`, `faea4f3`, `d32fb21` from
`origin/attempts/luna-ux-01/cycle-11`; add the missing `luna-ux-01/11` line to
`autonomy/JOURNAL.md`; make the cycle 11 report's board lines match `^Board:`; correct the false
cycle 10 sentence about cycle 08/09 code.

Proof: `node tests/docs-smoke.ts` exits 0; the cherry-picked code is re-checked by item 2's
targeted runs and the final verify pass.

## Item 2 — Human console serialises its own cards (V-02)

Justification: `human-console/index.ts:438` checks `inputHeld()` but never takes a hold, and
`processPending:465-479` starts every pending file at once. Two child requests in one scan open
two `ui.select` dialogs; the second steals focus from the first. Open proposal
`luna-ux-01-01-human-console-multi-card-focus-theft.md`; no existing test queues two.

Change:

- `processOne`: after the existing hold check, run the card inside
  `withInputHold("human-console", ...)` so the hold is taken synchronously before the first
  `await`; a sibling in the same scan then sees `inputHeld()` and is left for the next 1 Hz poll.
- `processRunApproval`: the same hold around `answerApproval`, released before `askToResume` (its
  `showWhenFree` must not wait on our own hold).
- `askToResume`: take the hold inside the `showWhenFree` callback, after a final `inputHeld()`
  check, so two pause prompts cannot stack either.
- `session_shutdown`: call `releaseInputHolds()` so a reload drops the card's hold.
- Test in `tests/firewall-overlay-queue-smoke.ts`: write two pending approvals in one scan with a
  manually-held select; assert only one card opens across two polls, `inputHeld()` is
  `"human-console"` while it is open, and the second opens after the first is answered.
- Docs: `docs/security.md` item 6 states the console holds input while a card is open and queues
  sibling child requests for the next poll; `docs/autonomy-gate.md` console paragraph says the
  same in one sentence.

Proof: `npm run smoke:firewall-overlay-queue` (or the script name check-all lists),
`npm run test:typecheck`, `npm run test:lint`, `npm run smoke:docs`; the new case must fail with
the source change reverted.

## Not taken

The other open proposals (idle-cat blink, hub `ctx.mode` fallback, undocumented hub rows,
short-terminal clipping) are unchanged; they are not V-02 and the budget stays on the red gate
and the board item.
