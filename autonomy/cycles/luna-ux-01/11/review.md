# Cycle 11 — Review (run `luna-ux-01`, stream `ux`)

## State at the cycle base

`7647d1b` is the head of `stream/ux`. Both board items are already green at the base and were
re-verified by cycle 10:

- PG-59: `npm run smoke:update-notice` → all 8 checks passed, including "an update-available pi
  still yields only the trunk notice at session start".
- V-05: `npm run smoke:launch-screen` → all 11 checks passed; `launch-screen.ts` and its header
  wiring are present in `index.ts`'s single `session_start` handler.

So the assigned board has no open work. Per the work precedence the cycle moves to defects
(priority 4) and carried-over proposals (priority 3). Mode: **fix**.

## Findings

### F1 (P1, confirmed) — framed overlays lay out four cells too wide and ignore the mouse

Evidence:

- `packages/extensions/src/control-center/overlay-frame.ts:136` renders the inner component at the
  full overlay `width`, then `frameLines` (`:73-77`) reserves two border and two padding cells.
  A width-sensitive component (the hub's `SettingsList`, the `/workflows` panel) wraps/clips
  against a width four cells too wide, so its right-hand content is truncated instead of wrapped.
- The wrapper returned at `overlay-frame.ts:135-148` forwards `invalidate`, `handleInput` and
  `dispose` but not `handleMouse`. pi-tui dispatches pointer events through
  `Component.handleMouse` (`node_modules/@earendil-works/pi-tui/dist/tui.d.ts:78`) and delivers
  overlay-local coordinates (`tui.js` overlay dispatch: `x: screenX - layout.col`, `y: screenY -
  layout.row`). `SettingsList` has `handleMouse`
  (`dist/components/settings-list.js:116-158`) and interprets `y` as a list-local row, `x` only via
  the search `Input`. Neither first-party overlay exposes it, so the hub rows and panel controls
  are keyboard-only.
- The vendor copy `packages/extensions/third_party/subagent/overlay-frame.ts` is byte-identical
  and the control-center smoke asserts that (`tests/control-center-smoke.ts:775-777`).
- Open proposal `autonomy/proposals/luna-ux-01-10-hub-overlay-mouse-and-width.md` records the same
  defect; cycle 10 deferred it because it needed a `MouseEvent` shape check and pointer tests.

Fix shape (checked against pi-tui 1.4):

- framed width `>= 10`: render inner at `width - 4`, forward `x - 2`, `y - 1`, `width - 4`,
  `height - 2`, and only when the point is inside the content area;
- width `< 10`: `frameLines` returns the raw lines, so render and forward untranslated;
- expose `handleMouse` on the hub's anonymous component (delegating to its `Container`) so the
  forwarded event reaches the `SettingsList`; the workflows panel has no mouse handler and is out
  of scope for pointer support (its anonymous wrapper may still forward).

### F2 (P2, confirmed) — a hidden three-letter command never reappears in `/` autocomplete

`command-menu.ts:223-235` reveals a hidden command only when `typed.length >= 4`
(`HIDDEN_VISIBLE_PREFIX_LENGTH = 4`). `/kit` is hidden (not in `PINNED_KIT_COMMANDS`,
`command-menu.ts:29-39`) and its name is only three characters, so it can never satisfy the rule.
`docs/control-center.md:118-120` promises a hidden command "appears again once at least four
characters of its name have been typed", and `:207-209` documents `/kit` as a working alias. The
alias runs when typed in full, but never appears in the suggestion list.

Fix: reveal when `typed.length >= Math.min(HIDDEN_VISIBLE_PREFIX_LENGTH, name.length)`, so a short
name reveals at its full length; add a smoke case and one docs sentence.

## Candidates considered and deferred

- Hub uses `ctx.mode === "tui"` (`hub.ts:385,433`) where the launch screen treats
  `mode === undefined ? hasUI : mode === "tui"`. On an old host without `ctx.mode` the hub drops to
  RPC dialogs. Not taken: the docs' "on older pi it opens without an overlay" claim needs a
  version/host check first; proposal material.
- `docs/control-center.md:79-86` lists Protections/delegation/Unattended rows whose `valueKey`s no
  `RowDef` uses (`values.ts:263-265` vs `model.ts`). Docs drift; note for next cycle.
- Short terminals below ~12 rows still clip the frame (`hub.ts:352-360` floor 1). Deferred.
- Open proposals `human-console-multi-card-focus-theft` and `idle-cat-blink` remain open; neither
  is in this stream's launch/menu/overlay core and both need product decisions.
