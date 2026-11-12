# Cycle 18 — Report (run `luna-ux-01`, stream `ux`)

Outcome: successful
Mode: fix

Board: none assigned. The cycle took the typed-command gap left by cycle 17 and a documentation
defect found in the same area, rather than re-opening the re-landed work.

Item: Show the typed command in the TUI and RPC renderers - e23b6f3 - smoke:control-center 39/39 (fails before), smoke:command-menu 13/13, smoke:docs, test:typecheck, test:lint, verify
Item: Remove the unreachable cat `alert` state from the status-bar docs - 4d5686a - smoke:cat-status 12/12, smoke:docs

## Why this work

`docs/control-center.md` and the Help page promise that every hub row shows its typed equivalent,
but only the print/json text page did. The RPC `rowLabel` rendered `row.command` (empty for the
Autonomy and Session rows) and the TUI `SettingItem` rendered only `row.label`. Cycle 17 filed this
as `autonomy/proposals/luna-ux-01-17-hub-typed-command-in-tui-rpc.md` because it needed a
width/truncation decision; this cycle implemented that decision.

The same area's docs also claimed the cat can show `alert` when a request ends. `setResult` has
three callers and none passes `alert`, so the documentation described behaviour the code does not
have.

## What changed

- `hub.ts` now has one `typedCommand()` resolver (`row.legacy ?? trimmed prefill ?? row.command`)
  and one `typedSuffix()`. All three renderers use them: the text page, the RPC option and the TUI
  label. The suffix is `  [command]`, is omitted when the label already is the command (All
  commands), and follows the row name so a narrow terminal truncates the suffix first. Terminal
  sequences and control characters are stripped.
- `tests/control-center-smoke.ts` pins the RPC Autonomy `/auto`, RPC Session `/compact`, TUI
  Autonomy, TUI Doctor, All commands no-duplication and narrow-width cases. The first case fails
  on the pre-fix source; the second case's wide assertion also fails pre-fix.
- `docs/control-center.md` documents the command on all three renderers, the All commands
  exception and the narrow-terminal order.
- `docs/status-bar-and-costs.md` moves `alert` from the reachable-result row to the "Not covered"
  sentence, beside `retrying` and `sleeping`; the animation table and priority list are unchanged.

## Verification

`smoke:control-center` 39/39, `smoke:command-menu` 13/13, `smoke:cat-status` 12/12, `smoke:docs`,
`test:typecheck`, `test:lint` and `verify` all pass after `4d5686a`. Adding the report reddened
`smoke:docs` because `autonomy/JOURNAL.md` had no cycle-18 entry; `139eea6` adds it and the final
`smoke:docs` passes. An independent reviewer read the full diff against the charter and returned
**PASS**; its three non-blocking notes are in `verify.md`. Full evidence is in `verify.md`.

## Left for later

- New proposal: `autonomy/proposals/luna-ux-01-18-short-overlay-drops-focus.md`. A terminal below
  about five rows can still slice the focused row out of the overlay head. It needs a focus-aware
  trim and its own short-terminal test; it was not widened into this cycle.
- Existing proposals unchanged: idle-cat blink, inert Settings value rows, the lab group on the
  Work page, stale `luna-ux-01-10`, hub `ctx.mode` fallback, `TRUNK_CHANNEL`, and the cycle-17
  typed-command proposal now implemented here.
- Diff excluding cycles/runs records and the lockfile is 15,041 characters, under the 30,000
  stop-new-items line and the 60,000 review budget.
