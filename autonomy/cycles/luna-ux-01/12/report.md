# Cycle 12 — Report (run `luna-ux-01`, stream `ux`)

Outcome: successful
Mode: fix

## Board

Board: V-02 done - the human console now holds input while a card is open, so two pending child requests in one scan serialise instead of opening two focus-stealing cards; an interactive `ask_human` card holds input too, and the notices name the open card. Pinned by `smoke:firewall-overlay-queue` (35/35).

## Items

- Item: Unblock the cycle 11 red gate and re-land its reviewed fixes - `faa6c2b`, `7394173`, `9dbd71c`, `1471cde` - `node tests/docs-smoke.ts` (exit 0) and `smoke:control-center` (34/34) / `smoke:command-menu` (12/12)
- Item: Serialise human-console cards and hold input for `ask_human` (V-02) - `f2767e2`, `7a52139`, `2ee1e3f` - `smoke:firewall-overlay-queue` (35/35; the three new cases fail with the source reverted)
- Item: Correct the cycle 10 report's false "not on `stream/ux`" claim - `205590d` - record-only; `smoke:docs` exit 0

## What changed

1. **Red gate.** Cycle 11 failed the host gate because `autonomy/JOURNAL.md` had no entry for
   `luna-ux-01/11` and its report used `- Board:` bullets the checker does not read. The four
   cycle 11 commits were cherry-picked unchanged, the journal line added and the board bullets
   fixed. `node tests/docs-smoke.ts` exits 0, and the reviewed overlay-frame/mouse and `/kit`
   reveal fixes are now on the branch.
2. **V-02.** The console checked the input-owner registry but never registered a hold;
   `processPending` starts every pending file in one scan, so the second `select` took focus from
   the first. `processOne` and `processRunApproval` now take the hold synchronously before the
   first `await`, `processRunApproval` releases before `askToResume`, and `askToResume` and
   `ask_human` re-check then hold inside their `showWhenFree` callback. `session_shutdown`
   releases holds. Hold labels are actionable noun phrases ("the open console card", "the open
   resume card", "the open question card") in every notice that interpolates them.
3. **Coverage.** `tests/firewall-overlay-queue-smoke.ts` adds three cases: two child approvals in
   one scan, `ask_human` holding against a console card (the reverse direction), and two run
   approvals in one scan. The notice text is asserted too. `docs/security.md`,
   `docs/autonomy-gate.md` and `CHANGELOG.md` describe the contract.

## Checks

Green: `smoke:firewall-overlay-queue` 35/35, `smoke:control-center` 34/34,
`smoke:command-menu` 12/12, `smoke:workflow-panel` 14/14, `smoke:human-console-broker` OK,
`smoke:human-console-auth` 8/8, `smoke:update-notice` 8/8, `smoke:launch-screen` 11/11,
`smoke:docs` OK, `test:typecheck` exit 0, `test:lint` exit 0. The three new console cases fail
when the source is reverted to `205590d`. Whole-diff reviewer: PASS. Diff 40573 characters: over
the 30000 stop line, under the 60000 review budget. No scripts, charter, control-path, credential
or release change. Details in `verify.md`.

## Leftovers

- The diff is 40573 characters, over the 30000 stop-new-items line but under the 60000 merge
  budget; no new item was started after it crossed.
- Open proposals not taken: `luna-ux-01-10-hub-overlay-mouse-and-width.md` (short-terminal
  clipping), the hub `ctx.mode` fallback, undocumented hub rows, `idle-cat-blink`, and
  `luna-ux-01-07-trunk-channel-alias.md` (`TRUNK_CHANNEL = "next"`). Carry to cycle 13.
- The `human-console-multi-card-focus-theft` proposal is now implemented by this cycle; no code
  in it remains open.
- pi-lens still reports four pre-existing findings in `human-console/index.ts` on lines this
  cycle did not change; `test:lint` passes.
