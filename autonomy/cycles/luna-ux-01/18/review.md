# Cycle 18 — Review (run `luna-ux-01`, stream `ux`)

Base `a014133e398a` (head of `stream/ux` after cycle 17). Mode chosen: **fix**.

## Inputs read

`autonomy/CHARTER.md`; `autonomy/runs/luna-ux-01/HANDOFF.md`; the open proposals under
`autonomy/proposals/luna-ux-01-*.md`; cycle 17's `report.md`, `plan.md` and `verify.md`;
`git log --oneline a014133e398a..HEAD` (empty at cycle start). Two scouts audited the stream's code:
one on the typed-command proposal and the renderer/`SettingsList` mechanics, one on new defects in
the code cycle 17 changed.

## Board

The steward board lists no assigned items for this cycle. With no board work, precedence moves to
handoff carry-overs (3) and defects (4).

## Findings

1. **The typed-command proposal is real and still present at HEAD.** `docs/control-center.md:3-5`
   and `:45` promise every row shows the typed command that does the same work, and the Help row at
   `hub.ts:186` repeats it. Only the print/json renderer keeps that promise: `textPage`
   (`hub.ts:258`) uses `legacy ?? prefill ?? command`, while the RPC `rowLabel` (`hub.ts:308-313`)
   renders only `row.command`, and the TUI `SettingItem` (`hub.ts:329-340`) renders neither. An
   operator in the TUI or RPC therefore cannot see `/auto`, `/effort`, `/compact` and similar on
   their rows. The proposal records the same finding with the renderer line numbers. Worth this
   cycle: it is a documented contract the two interactive renderers do not meet, and the fix is
   small once the format is decided.

2. **Design decision for item 1.** A scout checked `SettingsList`
   (`node_modules/@earendil-works/pi-tui/dist/components/settings-list.js:79-96,213-224`):
   `description` is rendered only for the focused row and `currentValue` drives value cycling, so
   the suffix belongs in `label`. The label is rendered before the value column and is truncated
   last, which keeps the row name when the terminal is narrow. Suppress the suffix when the label
   already is the command (the All commands page sets `label: "/name"` and `prefill: "/name "`).
   Sanitise the command with `stripTerminalSequences` and drop the remaining control characters, so
   a registered control cannot inject a newline or escape into the interactive list. Keep the
   existing two-space `[command]` form so the print/RPC assertions and `docs/control-center.md:113`
   stay true.

3. **`alert` is documented as a reachable cat result but no code drives it.** The priority list and
   animation table include it (`cat.ts:52,59,64`), and
   `docs/status-bar-and-costs.md:106` says it is shown when the session "needs attention". The only
   `setResult` callers (`custom-footer/index.ts:507,524,534`) pass `denied`, `warning`, `success`,
   `error` or `cancelled`; nothing passes `alert`. The same docs page already lists `retrying` and
   `sleeping` as faces nothing reports, so `alert` is the one stale entry. Docs-only correction:
   remove `alert` from the result table row and name it with the other unreported faces. Evidence
   is a grep of every `setResult(` call site.

4. **Overlay below five rows drops the focused row.** `hub.ts:381-390` slices the rendered lines to
   `rows - 2`; at four terminal rows the search line and its blank line fill that budget and the
   selected row disappears, contradicting the comment at `hub.ts:387-389` and
   `docs/control-center.md:104-106`. This is a pathological height and needs a layout decision
   (hide search before the selection, or document a minimum). Left as a proposal; it does not block
   the typed-command contract.

5. **`/kit` and `/helpers` hints point at All commands.** `command-menu.ts` has no rows for the
   aliases, so the documented no-row fallback (`docs/control-center.md:126-128`) applies. The docs
   describe that fallback as intended, so this is a product decision, not a regression. Left for
   the next cycle.

## Scope

- Item 1: show each row's typed command in the TUI and RPC, using the shared helper and format
  above; tests for TUI, RPC, All commands (no duplicate), informational rows and a narrow width;
  update `docs/control-center.md`.
- Item 2: correct the stale `alert` claim in `docs/status-bar-and-costs.md` (docs only).
- Targeted checks: `smoke:control-center`, `smoke:command-menu`, `smoke:cat-status`, `smoke:docs`,
  `test:typecheck`, `test:lint`, `verify`. Never `npm test` / `npm run check:all`; the host gate owns
  the full suite.
- Keep the diff under 30,000 characters excluding records and lockfile.
