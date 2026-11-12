# Cycle 22 — Report (run `luna-ux-01`, stream `ux`)

Outcome: successful
Mode: fix

Board: PG-12 done - the one-line trunk-ahead notice already exists at the cycle base
(`trunkNotice`/`sessionStartNotice`/`formatReport` in `packages/extensions/src/kit-update/index.ts`)
and `tests/update-notice-smoke.ts` pins the exact line, the in-sync silence and the timeout; the
board evidence was stale.

## Changed tests (justification)

None loosened. `tests/launch-screen-smoke.ts` replaces two new `no-control-regex` suppressions
with a character-code predicate (base has 14 eslint-disable comments, ceiling 15);
`tests/control-center-smoke.ts` gains the hubKey validation and re-read cases;
`tests/workflow-panel-smoke.ts` gains the 20/24-row framed case and tightened its budget by the
two frame rows.

## Items

Item: Re-land the carried hubKey validation (rejected with cycle 20) - 9bf3fcb, 4e2b543 - smoke:control-center 45/45; 4/45 fail on the base
Item: Repair the cycle-20 suppressions so the docs/lint gate passes - df3910c - smoke:suppression-inventory 2/2, smoke:typescript-coverage 5/5 (14 disables)
Item: Keep every hubKey surface on the key that is actually bound - de9841f - smoke:control-center 45/45; the session-restart case fails on the base
Item: Keep the /workflows confirm block and footer visible in a short terminal - d194ea9 - smoke:workflow-panel 15/15; `the panel fits 16 rows at 20 rows (got 37)` fails on the base
Item: Reserve the two overlay-frame rows in the panel budget - 7231162 - smoke:workflow-panel 15/15
Item: Scope the short-terminal docs sentence and file the list-view proposal - f4b4bdc - smoke:docs
Item: Correct the docs' short-terminal agent-window claims after review - f289f48 - smoke:docs, docs:check, docs:mermaid
Item: Re-land the stale-proposal status updates - 84ac154 - smoke:docs

## What was done

The cycle-21 attempt was rejected for acceptance only, not for its code: its cycle-21 report had
no `autonomy/JOURNAL.md` line, which `tests/docs-smoke.ts` `checkJournal` makes a
`smoke:docs`/`check-all` failure. Its code commits are re-landed here with the rejected cycles'
records left off the branch, then the independent reviewer's two documentation warnings were
fixed (`f289f48`). The hubKey from `ui.json` is validated before it reaches the launch screen,
`/menu` and the shortcut, and the header keeps the load-time key; the `/workflows` panel now
budgets the terminal height, reserves the two overlay-frame rows and keeps its header, selected
agent (while room remains), confirm block, footer and borders, collapsing to one `… n more` line
below the minimum.

## Left for later

- `autonomy/proposals/luna-ux-01-21-workflow-list-height.md`: the run-list view and the
  very-small-height fallback are still unbudgeted (pre-existing, needs its own render window).
- Older open proposals unchanged: idle-cat blink, inert Settings value rows, Work page lab group,
  hub `ctx.mode` fallback, `TRUNK_CHANNEL` alias. The hubKey proposal is marked implemented by
  `84ac154`.

## For the next cycle

- The cycle-21 stall on the gated `reviewer` step repeated in this cycle's parallel scout plan
  (one scout answered only "I'll investigate..."); `subagent` reviewers/scouts answered fully.
- `smoke:control-center` is 45 checks, `smoke:workflow-panel` 15; keep report counts honest.
- Non-record diff is 44706 characters, past the 30000 stop-taking-new-work line: finish the
  carried work before adding an item.
