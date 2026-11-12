# Cycle 07 — Report (run luna-ux-01, stream `ux`)

Outcome: successful
Mode: fix

Test-change justification: PG-59 requires `smoke:update-notice` to pass on a pi older than the
pin. The old case deep-equalled the whole notification list to one trunk line. The replacement
still requires the trunk line exactly once and fails on any second kit notice; it only tolerates
a pi built-in notice, filtered by object identity so a kit summary with the same wording still
fails. A new case pins pi 0.99.2 against registry 1.4.0. No assertion was weakened otherwise.

Board: PG-59 done - trunk-gap notice now owns the session-start kit notice (`sessionStartNotice`), with a pi-0.99.2 case and a built-in-notice-tolerant integration test.
Board: V-05 done - already shipped by cycles 01-02; every acceptance point re-verified, no code change needed this cycle.

Item: P0 upstream merge conflict - 03bc064 - `grep` shows no conflict markers; both sides kept in `package.json` and `kit-update/index.ts`; `smoke:update-notice` 8/8 and `smoke:kit-update-channel` 7/7.
Item: PG-59 smoke:update-notice pi-compat - ec30653, 3b913d5 - `npm run smoke:update-notice` 8/8, including the update-available pi case.
Item: V-05 launch screen - no new commit (shipped earlier; re-verified) - `npm run smoke:launch-screen` 11/11.

## Left and next

- HANDOFF carry-overs remain open and confirmed: duplicate `/mcp`/`/llama` rows in
  `allCommands()` (`control-center/index.ts:106-111`) and the cancelled RPC value dialog returning
  `"back"` (`hub.ts:283`). Not taken: the mandatory merge alone puts the review diff far past the
  30000-character stop line. Evidence and test sketches stay in `autonomy/runs/luna-ux-01/HANDOFF.md`.
- The merge diff is dominated by upstream files; cycle-owned code/docs/tests are ~7.7k characters.
- `TRUNK_CHANNEL = "next"` (gap is `HEAD..main`) overlaps upstream's `trunk` channel
  (`integration/luna`); existing proposal `autonomy/proposals/luna-ux-01-07-trunk-channel-alias.md`
  covers the naming, not changed here.
