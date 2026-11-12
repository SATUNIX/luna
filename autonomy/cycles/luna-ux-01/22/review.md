# Cycle 22 — Review (run `luna-ux-01`, stream `ux`)

Base `f19788240eaa` (head of `stream/ux`). Previous attempt `origin/attempts/luna-ux-01/cycle-21`
was rejected: acceptance red, `check-all` and `check-all:smoke:docs` exit 1.

## Gate / rejected attempt

Root cause of the cycle-21 rejection found: its records added
`autonomy/cycles/luna-ux-01/21/report.md` but no matching
`autonomy/JOURNAL.md` line. `tests/docs-smoke.ts:518` asserts
`checkJournal(ROOT) == []` ("autonomy/JOURNAL.md disagrees with the cycle reports"), so
`smoke:docs` failed, and `check-all` fails with it. The attempt's own targeted runs all passed
(`autonomy/cycles/luna-ux-01/21/verify.md` on that branch), which is why it was not seen.

Its three new `eslint-disable` comments had already been replaced by the character-code helper
in `b16f9e8`; base head has 27 inline markers/14 eslint-disable comments, and
`smoke:suppression-inventory` (2/2) and `smoke:typescript-coverage` (5/5) pass.

## Board item

PG-12 (trunk-ahead one line) is already implemented at the cycle base. Evidence:
`packages/extensions/src/kit-update/index.ts:739` `trunkNotice()` returns
`trunk is N commits ahead — /update channel <channel>` or null; `:760` `sessionStartNotice()`
uses it at start-up, `:791` `formatReport()` on `/update status`, `:1311` the bare `/update`
screen; `:1263` runs the check with `void check(cwd).then(...)`, never awaiting it.
`tests/update-notice-smoke.ts` pins the exact line, the in-sync/offline null case, and the
hanging-git timeout case; `npm run smoke:update-notice` is 8/8 at HEAD. `docs/updates.md:22-33`
documents it. The board evidence ("nothing mentions the gap") is stale.

## Re-landed carry-over (cycles 20 and 21)

The attempt's code is sound and its acceptance failure was only the journal-line bookkeeping,
so its code commits are re-landed here (not the records of the rejected cycles):

- `d4d76da`, `589dbfd` — validate `hubKey` from `ui.json` (C0/DEL/C1, whitespace, pi-tui key
  shape; fall back to `alt+m` once, never echo the value), accept single base keys, reject
  repeated modifiers. Tests: `tests/control-center-smoke.ts`, `tests/launch-screen-smoke.ts`,
  `docs/control-center.md`.
- `b16f9e8` — replace the two new `no-control-regex` suppressions in
  `tests/launch-screen-smoke.ts` with a character-code predicate (base has 14 suppressions).
- `d3313e4` — the launch header, `/menu` row, Settings/Help and the registered shortcut all use
  the load-time `hubKey` again; the header no longer re-reads `ui.json` per session.
- `4933eac`, `65c01af` — `/workflows` panel gets the terminal height from the overlay host,
  reserves the two `withOverlayFrame` rows, and trims narration, then phase rows, then agent
  rows so the header, selected agent, confirm block, footer and borders survive a short
  terminal; below the minimum it collapses to one `… n more` line. Tests:
  `tests/workflow-panel-smoke.ts`, `docs/workflows.md`.
- `e104fd7` — scope the short-terminal docs sentence to the run view and file the remaining
  list-view gap as `autonomy/proposals/luna-ux-01-21-workflow-list-height.md`.

Negative evidence (run this cycle, files restored afterwards):
- restore `f19788240eaa:.../control-center/index.ts` → `smoke:control-center` 4/45 FAILED
  (`an invalid hubKey falls back to alt+m with one warning`, the terminal-controls case, the
  duplicate-modifier case, and the session-restart header case); 45/45 with the change.
- restore `f19788240eaa:.../wf-panel.ts` → `smoke:workflow-panel` FAIL,
  `the panel fits 16 rows at 20 rows (got 37)`; 15/15 with the change.

## New problems and scope

No new defect was found in the re-landed code (a scout review stalled after one message; the
whole-diff reviewer in `verify.md` is the independent check). Open pre-existing proposals remain
(idle-cat blink, inert Settings value rows, Work page lab group, hub `ctx.mode`, `TRUNK_CHANNEL`
alias, workflow run-list height); none blocks an assigned item. The diff excluding records is
~42k characters, past the 30000 stop-taking-new-work line, so this cycle takes no new item and
finishes the carry-over.
