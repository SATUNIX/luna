# Cycle 19 — Review (run `luna-ux-01`, stream `ux`)

Stream area: TUI overlays, the `/` menu, launch screen, animation and polish (V-01, V-02, V-03,
V-05, V-09). Cycle base `a014133e398a`. No board items assigned.

## Gate state (priority 0)

Cycle 18 was not merged: the host reported `check-all` red, failing exactly
`check-all:smoke:menu-settings` (exit 1). The cycle-18 branch is
`origin/attempts/luna-ux-01/cycle-18` (head `6a08e0e`). Reproduced in a worktree with the shared
`node_modules`:

```text
$ npm run smoke:menu-settings
FAIL: /menu settings resolves the Settings page and its rows show the joined settings
  AssertionError: the Settings page shows "pi settings":
  pi settings  [/settings] | Command menu: curated | Hub key: alt+k | ...
[menu-settings-smoke] 1/4 FAILED
```

Root cause: cycle 18's `e23b6f3` made every renderer append the typed-command suffix
(`typedSuffix()` in `packages/extensions/src/control-center/hub.ts:318-330`), so the Settings
action row `settings.pi` (label `pi settings`, `prefill: "/settings "`) now renders
`pi settings  [/settings]`. `tests/menu-settings-smoke.ts:114` still asserts the old exact label
`pi settings`. The behaviour is the documented intent ("Every row shows its typed equivalent",
`docs/control-center.md:40`), so the test is stale, not the code.

The rest of cycle 18 is sound and was re-checked on its branch: `smoke:control-center` 39/39,
`smoke:command-menu` 13/13, `smoke:cat-status` 12/12, `smoke:docs` PASS. The two code commits
(`e23b6f3` typed command in TUI/RPC, `4d5686a` cat `alert` docs) are carried over; the only change
needed is the stale assertion.

## Carry-over from the handoff (priority 3)

`autonomy/proposals/luna-ux-01-18-short-overlay-drops-focus.md` (on the cycle-18 branch): a very
short terminal can slice the focused row out of the control-centre overlay. A scout checked it
against the code and corrected the details:

- `hub.ts:381-390` computes `budget = rows - 2` and, when the list still overflows, returns
  `lines.slice(0, budget)` — the head.
- Real `SettingsList` layout at `maxVisible === 1` is search line, blank, focused item
  (`node_modules/@earendil-works/pi-tui/dist/components/settings-list.js:57-112,194-196`).
- Measured with the test fake, 20 rows, focus moved to the last row (`cmd19`):
  - rows=4 -> rendered lines are `border, ">", blank, border`; `cmd19` absent, no cursor line.
  - rows=5..7 -> `→ /cmd19` is present.
- So the failure is at `rows <= 4`, **not** 5-7 as the proposal guessed; a test at 5-7 would pass
  before the fix. The regression test must use rows=4 (and 3).
- The current short-terminal test loops `[10, 8]` only (`tests/control-center-smoke.ts:666`) and
  its focus assertion uses the initial row `cmd0`, so it cannot catch this.

## New defect found (priority 4)

Scout 2, checked against `packages/extensions/src/control-center/index.ts:68-88`:

- `let curated = false;` guards one `session_start` handler that installs the launch header and
  wraps the autocomplete provider, then sets `curated = true`.
- pi clears extension UI on every session replacement: `setExtensionHeader(undefined)` and
  `autocompleteProviderWrappers = []` plus `setupAutocompleteProvider()` in
  `node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js:1909-1915`,
  wired from `agent-session-runtime.js` for `/new` (`:155-166`), `/resume` (`:141,:291`) and
  `/fork` (`:211-246`).
- Reproduced locally by firing the recorded handler twice with the repo harness: `providers 1
  headers 1` — the second session registers nothing.
- Consequence: after `/new`, `/resume` or `/fork` the curated `/` menu silently shows every hidden
  Luna command again and the launch screen is gone, contrary to `docs/control-center.md:30,126-131`.
  No test fires a second `session_start`.

Other scout candidates were deferred to proposals rather than this cycle: the `/workflows` panel
has no height budget and can clip its confirmation at 24-40 rows (`wf-panel.ts:676-700,770`), and
`hubKey` is injected raw into the launch screen/description/shortcut
(`index.ts:31-35`). Both are outside the smallest safe scope here; see proposals filed this cycle.

## Mode and chosen work

**Fix mode.** Items, in precedence order:

1. Re-land cycle 18 and repair the red gate: cherry-pick its commits, update the stale
   `menu-settings` assertion to the documented suffix, re-run the targeted checks.
2. Focus-aware short-overlay trim: always render the focused row at `rows <= 4`.
3. Re-register the command menu provider and launch header on every `session_start`, with a
   two-session regression test.

Each item stays within the stream area, has a test that fails before it, and updates the docs that
describe the behaviour.

Workflow: refused plan-allowance (E3 Standard allows 8 planned agents a request; the cycle used
8 on two plans, so item item 2 fell back to the `subagent` tool for its implementer and reviewer).
