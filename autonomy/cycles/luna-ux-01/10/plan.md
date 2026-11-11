# Cycle 10 — Plan (run luna-ux-01, stream `ux`)

Mode: **fix**. The previous merged cycle was cycle 07 (fix/merge). The assigned P0 (PG-59) and
P2 (V-05) are already green at the base; this cycle re-verifies them and lands the reviewed
control-center fixes the rejected cycle 09 left unmerged.

## Items, in work precedence order

### 1. All commands lists each command once (carry-over 1)

Change `allCommands()` in `packages/extensions/src/control-center/index.ts` to keep built-ins
first and skip a `pi.getCommands()` name already listed. Bring `docs/control-center.md`'s row
with it. Tests: the RPC `/menu all-commands` case in `tests/control-center-smoke.ts` asserting
`mcp`, `llama` and `auto` appear exactly once, plus the built-ins/no-dispatch hardening.
Checks: `smoke:control-center`, `smoke:command-menu`, `smoke:docs`, `test:typecheck`,
`test:lint`.

### 2. A cancelled RPC value dialog closes the hub (carry-over 2)

Change `hub.ts`'s second/value `select` cancellation from `"back"` to `undefined` so a
cancelled or timed-out dialog closes the hub, as `docs/control-center.md:101-102` promises.
Test: a scripted two-dialog RPC case that answers the page row and cancels the value row;
exactly two dialogs and no dispatch on the old code, hub closed on the new code.
Checks: `smoke:control-center`, `smoke:command-menu`, `smoke:docs`, `test:typecheck`,
`test:lint`.

### 3. The hub overlay fits a short terminal (carry-over defect)

Derive `SettingsList`'s `maxVisible` from `tui.terminal.rows` at render time (15 when the host
exposes no rows, minimum one item), so the framed overlay never exceeds the terminal and its
top border, title and search stay visible. Add one sentence to `docs/control-center.md`.
Test: fake `tui` with `terminal.rows = 24` on a page with many rows; assert framed output
`<= 24` lines, starts with the top border and ends with the bottom border, and the focus row is
reachable; a tall terminal keeps up to 15 items.
Checks: `smoke:control-center`, `smoke:command-menu`, `smoke:docs`, `test:typecheck`,
`test:lint`.

### 4. Re-verify assigned items (no code)

PG-59: `npm run -s smoke:update-notice` (8/8, pi-0.99.2 case). V-05:
`npm run -s smoke:launch-screen` (11/11).

## Acceptance

- New control-center cases fail when `hub.ts`/`index.ts` are reverted to the base and pass with
  the fixes.
- `smoke:control-center`, `smoke:command-menu`, `smoke:launch-screen`,
  `smoke:update-notice`, `smoke:docs`, `test:typecheck` and `test:lint` green.
- `autonomy/JOURNAL.md` gains a `luna-ux-01/10` line whose Board set matches `report.md`.
- Diff under the 30000-character stop line after each commit; no `scripts`, control path or
  `autonomy/CHARTER.md` change.
