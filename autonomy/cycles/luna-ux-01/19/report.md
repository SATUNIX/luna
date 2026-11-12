# Cycle 19 — Report (run `luna-ux-01`, stream `ux`)

Outcome: successful
Mode: fix

Board: none assigned. The cycle opened with a red host gate from cycle 18, so the red gate came
first, then the carry-over overlay defect, then a defect the review found in the same file.

Item: Re-land the cycle-18 typed-command TUI and RPC renderers - 438329b - smoke:control-center 40/40 (fails before), smoke:command-menu 14/14
Item: Re-land the cycle-18 cat `alert` docs correction - 7ff7e6a - smoke:cat-status 12/12, smoke:docs
Item: Wrap the cycle-18 review and plan plus the cycle-18 journal and report into this cycle - 1bc4630, 5b72b21, b42ede0, 981b056 - smoke:docs
Item: Repair the stale `smoke:menu-settings` assertion that reddened the gate - ec3bd1a - smoke:menu-settings 4/4 (red before)
Item: Note the cycle 19 workflow allowance fallback in the review record - b1af1a5 - smoke:docs
Item: Keep the focused row visible in a very short control-centre overlay - f8a85ce - smoke:control-center 40/40 (fails before), smoke:command-menu, smoke:docs, test:typecheck, test:lint, verify
Item: Re-register the curated `/` menu and launch header each session - e4536f8 - smoke:command-menu 14/14 (fails before), smoke:launch-screen 11/11, smoke:control-center, smoke:docs, test:typecheck, test:lint, verify
Item: Record cycle 19 (report, verify, journal, proposals) - 8f79470, 64183bd, d68892a - smoke:docs

## Why this work

The host gate rejected cycle 18 on `smoke:menu-settings`: the assertion still expected
`pi settings`, while cycle 18's `typedSuffix()` renders `pi settings  [/settings]` because the
Settings action row prefills `/settings `. The test was stale; the code matches
`docs/control-center.md`. Re-landing the work required repairing the test, not the renderer.

The carry-over proposal from cycle 18 guessed the short-overlay bug bit at five to seven rows. The
review measured it: at four rows and fewer, the rendered lines are `border`, `>`, blank, `border`,
so the cursor row is sliced out. At five rows the focused row already survives.

The review also found that `index.ts:68-88` guarded its `session_start` setup with a one-shot
`let curated = false`. pi clears autocomplete wrappers and the extension header on `/new`,
`/resume` and `/fork`, so after any of those the curated `/` menu and launch screen silently
stopped until restart.

## What changed

- `tests/menu-settings-smoke.ts` pins `"pi settings  [/settings]"` exactly, with a comment saying
  why; the other three labels are unchanged.
- `hub.ts` trims a too-short overlay around the focused row: it finds the line carrying the list
  theme's cursor string, keeps the search line plus the focused row when the budget is at least
  two, the focused row alone at one, and falls back to the old head when no cursor line exists.
  Output at five or more rows is byte-identical to before.
- `tests/control-center-smoke.ts` adds the 4-row and 3-row cases that fail on the old trim.
- `index.ts` drops the one-shot guard; the provider and launch header are installed on every
  `session_start`, which pi emits after clearing the previous session's registrations.
- `tests/command-menu-smoke.ts` gains `headers` tracking plus the replacement-session case
  (two `session_start` dispatches, two providers, two headers).
- `docs/control-center.md` states the three-to-four-row search-line trade and that the curated menu
  and launch screen are installed per session.

## Verification

`smoke:command-menu` 14/14, `smoke:launch-screen` 11/11, `smoke:control-center` 40/40,
`smoke:menu-settings` 4/4, `smoke:cat-status` 12/12, `smoke:docs`, `test:typecheck`,
`test:lint` and `verify` all pass after `e4536f8`. Each item has a negative run recorded in
`verify.md`. The whole-diff reviewer subagent stalled four times without returning a verdict; the
per-item negative runs are the substitute proof and `verify.md` says so.

## Left for later

- New proposal `autonomy/proposals/luna-ux-01-19-workflow-panel-height.md`: the `/workflows` panel
  can exceed a 24-row terminal and the host clips its confirmation block and footer.
- New proposal `autonomy/proposals/luna-ux-01-19-hub-key-validation.md`: `readHubKey()` injects the
  raw `hubKey` into the launch screen, the `/menu` description and the shortcut registration.
- Existing proposals unchanged (idle-cat blink, inert Settings value rows, the lab group, stale
  `luna-ux-01-10`, hub `ctx.mode` fallback, `TRUNK_CHANNEL`).
- Diff excluding records and the lockfile is 24,970 characters at `e4536f8`; the final record
  commit brings the total to 30,553 characters, still under the 60,000 review budget.
