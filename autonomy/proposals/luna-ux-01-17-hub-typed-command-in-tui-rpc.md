# Proposal — show each hub row's typed command in the TUI and RPC

Run `luna-ux-01`, stream `ux`, cycle 17. Proposal, not landed work.

## Finding

The hub's promise is that every row shows its current value and the typed command that still does
the same work. `docs/control-center.md:3-5` and `:45` state it, and the Help page itself says
"every row shows its typed command" (`packages/extensions/src/control-center/hub.ts:186`).

Only the print/json renderer keeps that promise. `textPage` (`hub.ts:243-245`) appends
`[legacy]` or `[prefill]`; the TUI renderer (`hub.ts:330-345`) builds `SettingItem`s from label,
description and `currentValue` and never renders `row.legacy`; the RPC renderer's `rowLabel`
(`hub.ts:293-297`) renders label, value and unavailable reason only. Cycle 16 added only an
explicit `command` for informational rows, visible in print/RPC text, not the TUI.

So in the two interactive modes an operator cannot see the typed equivalent of a row, contrary to
the docs. The TUI is also where the user most needs it (the typed command is the fallback when the
overlay is unavailable).

## Why it was not fixed this cycle

Appending the typed command to a TUI label changes every row's width and truncation behaviour, and
the existing smoke fake asserts exact labels in several tests. It needs a design decision: append
to `label` after a separator, put it in `description`, or render it as a dim suffix only when the
row is focused. RPC option labels are matched by index, so appending is safer there, but the
contract should be decided once for both modes.

## Suggested change

- Add a helper that returns `label` plus a dim ` — /typed` suffix, using the row's `legacy` or
  trimmed `prefill`, shared by the TUI and RPC renderers.
- Decide whether the suffix is always shown or only for the focused TUI row, and how a narrow
  terminal truncates it (prefer truncating the suffix, never the label).
- Update `docs/control-center.md` if the chosen behaviour differs from "every row shows".
- Tests: a TUI render on a fake terminal containing a typed-command row asserts the suffix; an RPC
  select option asserts the same; a narrow-width case asserts the label is not lost.
