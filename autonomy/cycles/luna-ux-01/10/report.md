# Cycle 10 — Report (run `luna-ux-01`, stream `ux`)

Outcome: successful
Mode: fix

Board: PG-59 done - already green at the base (cycle 07's `sessionStartNotice`); re-verified, `smoke:update-notice` 8/8 including the pi-0.99.2 case.
Board: V-05 done - already green at the base (cycles 01-02); re-verified, `smoke:launch-screen` 11/11.

Item: All commands lists each command once - 29a410b - `smoke:control-center` 34/34; case fails at the base.
Item: A cancelled RPC value dialog closes the hub - 1ef8e7d - `smoke:control-center` 34/34; case fails at the base.
Item: Pin built-ins and no dispatch in the two new cases - 8b024ec - `smoke:control-center` 34/34.
Item: Fit the hub overlay to a short terminal - 9e4e345 - `smoke:control-center` 34/34, `smoke:command-menu` 11/11.
Item: PG-59 update-notice pi-compat re-verify - no new commit - `smoke:update-notice` 8/8.
Item: V-05 launch screen re-verify - no new commit - `smoke:launch-screen` 11/11.

## What changed

The cycle base already contained the two assigned items, so the work is the three
control-center defects the rejected cycle-09 attempt had fixed but never had merged, plus one
defect found while reviewing them:

- `allCommands()` emitted every built-in and then every `pi.getCommands()` entry, so `/mcp` and
  `/llama` appeared twice on the All commands page. Built-ins now win and a duplicate name is
  skipped; `docs/control-center.md`'s row says so.
- Cancelling the second (value) RPC dialog returned `"back"`, so the hub reopened the parent
  page instead of closing, contradicting `docs/control-center.md`'s cancel contract. It now
  returns `undefined`, and the same for a timeout.
- `SettingsList` was always built with 15 rows, so on a 24-row terminal the frame plus search
  and hint lines pushed the top border, page title and search off-screen. `maxVisible` is now
  derived from `tui.terminal.rows` at render time (15 when unknown, minimum one).

Test hardening pins that a built-in `/settings` row is still listed once and that a cancelled
dialog dispatches nothing. The new cases were checked against a throwaway clone with the source
reverted to the base: all three fail there and pass at HEAD (see `verify.md`).

## Verification

`smoke:control-center` 34/34, `smoke:command-menu` 11/11, `smoke:update-notice` 8/8,
`smoke:launch-screen` 11/11, `smoke:docs` OK, `test:typecheck` and `test:lint` exit 0. Cycle diff
excluding lockfile and autonomy records is 12854 characters, under the 30000 stop line.

An independent whole-diff reviewer was started twice and both runs were cut off by context
compaction before returning a verdict; the per-item gated reviewers passed and the negative run
is the evidence for the tests. That gap is recorded in `verify.md`, not papered over.

## Left and next

- `overlay-frame.ts` forwards no `handleMouse` and lays inner content out four cells wider than
  the framed area; proposal `autonomy/proposals/luna-ux-01-10-hub-overlay-mouse-and-width.md`.
- `TRUNK_CHANNEL = "next"` naming proposal (`...-07-trunk-channel-alias.md`) is still open; do
  not change the notice wording without it.
- Cycle 08 and 09 records exist in the history/JOURNAL but their code is not on `stream/ux`;
  the two control-center fixes were re-landed here under new commits. Do not assume cycle-08
  fixes are present from the old HANDOFF text.
