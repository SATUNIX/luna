# Cycle 19 — Plan (run `luna-ux-01`, stream `ux`)

Mode: **fix**. Base `a014133e398a`. No board items. Three items, precedence order, each one
logical commit (item 1 is the cherry-pick set plus its repair commit) and each pushed.

## Item 1 — Re-land cycle 18 and repair the red `smoke:menu-settings` gate

Justification: priority 0. The host gate rejected cycle 18 on `smoke:menu-settings`; the work is
otherwise verified. Leaving it unmerged loses a documented behaviour fix and keeps the gate red.

Change:
- Cherry-pick `origin/attempts/luna-ux-01/cycle-18` commits `18ab6f3..6a08e0e` (review/plan,
  typed command in TUI/RPC, cat `alert` docs, report/verify, journal).
- Update the stale assertion in `tests/menu-settings-smoke.ts`: accept the documented
  `pi settings  [/settings]` label (the `settings.pi` row prefills `/settings `), keeping the other
  labels exact. Pin the suffix explicitly so the test proves the rendered command, not just a
  substring match.
- Adjust `docs/control-center.md` only if the cycle-18 docs do not already state the Settings
  action row's suffix; cycle 18 already documents "every row shows its typed equivalent".

Checks: `npm run smoke:menu-settings`, `smoke:control-center`, `smoke:command-menu`,
`smoke:cat-status`, `smoke:docs`, `test:typecheck`, `test:lint`, `npm run verify`. The
`menu-settings` case must fail on the cycle-18 head and pass after the edit.

## Item 2 — Keep the focused row visible in a very short control-centre overlay

Justification: priority 3 carry-over (`luna-ux-01-18-short-overlay-drops-focus`), corrected by the
review's measurement: at `rows <= 4` `hub.ts:381-390` slices the head and drops the cursor row;
5-7 rows already work. An overlay that hides its cursor makes arrow keys look dead.

Change:
- In `packages/extensions/src/control-center/hub.ts` replace the final blind `slice(0, budget)`
  with a focus-aware trim: if the rendered focused line is outside the head, keep it (with the
  search line while it fits, otherwise the focused row alone) instead of the blank tail. Use the
  list theme's cursor string, not a hard-coded glyph; fall back to the current head when no cursor
  line exists.
- Extend `tests/control-center-smoke.ts` short-terminal case: a 3/4-row terminal with focus moved
  to the last row (`\x1b[A`) must render `→ /cmd19`, stay within the row budget, and keep the frame
  borders. Add a pre-fix assertion the old code fails.
- `docs/control-center.md`: state that below five rows the search line gives way to the focused
  row.

Checks: `smoke:control-center`, `smoke:command-menu`, `smoke:docs`, `test:typecheck`,
`test:lint`, `npm run verify`.

## Item 3 — Re-register the curated `/` menu and launch header each session

Justification: priority 4 defect found in review. `index.ts:68-88` runs the `session_start` setup
once per process, but pi clears the autocomplete providers and extension header on `/new`,
`/resume` and `/fork`; after those, the curated menu and launch screen silently stop.

Change:
- Drop the one-shot `curated` guard (or scope it correctly) so the autocomplete provider and launch
  header are installed on every `session_start`, which pi emits after clearing the old ones.
- Add a regression case in `tests/command-menu-smoke.ts`: fire the registered `session_start`
  handler twice and assert two providers and two headers are registered (fails before: 1 and 1).
  Mirror the header count in `tests/launch-screen-smoke.ts` only if it is cheap.
- `docs/control-center.md`: one sentence that the hub/setup is re-applied for each session.

Checks: `smoke:command-menu`, `smoke:launch-screen`, `smoke:control-center`, `smoke:docs`,
`test:typecheck`, `test:lint`, `npm run verify`.

## Proposals (not this cycle)

- `/workflows` panel exceeds the terminal and the host clips the confirmation/footer
  (`wf-panel.ts:676-700,770`) — file as `luna-ux-01-19-workflow-panel-height.md`.
- `hubKey` is injected raw into the launch screen, `/menu` description and shortcut
  (`index.ts:31-35`) — file as `luna-ux-01-19-hub-key-validation.md`.

## Budget and diff

Diff stop-new-items line: 30,000 characters. Expected total after three items: about 18,000, well
under the 60,000 review budget. Target spend about $3-4 of the $5 plan; stop at the firm $10.
