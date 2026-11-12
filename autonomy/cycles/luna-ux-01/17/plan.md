# Cycle 17 — Plan (run `luna-ux-01`, stream `ux`)

Mode: **fix**. No assigned board items. Work order comes from handoff carry-overs, then defects.

## Item 1 — Re-land the four cycle-16 ux fixes, corrected

**Justification.** Charter priority 3 (unfinished handoff work): cycle 16's four commits are not on
`stream/ux` because the cycle was rejected for an unrelated missing board item. The defects they
fix are still present at HEAD (review findings 1), with documented contracts contradicted. The
rejection also named a docs gap on item 4 (finding 4), and two scouts found two regressions in the
unmerged code (findings 2 and 3) that must be corrected before merge.

**Change.** Cherry-pick `df03563`, `d449086`, `a9c0ce7`, `205939a` from
`origin/attempts/luna-ux-01/cycle-16` onto the cycle base. Then, in the same item:

- `hub.ts`: account for the title rows in `handleMouse` so the pointer selects the row under it
  when the title is shown (>= 14 terminal rows). Add a pointer smoke that clicks the first data row
  on a 24-row terminal and asserts the focused row is the first.
- `custom-footer/index.ts`: re-arm the cat timer when a higher-priority held result suppresses an
  incoming one. Extend `deniedHoldsAgainstLaterResults` (or a sibling) to assert
  `catTimerActive() === true` after the suppressed `agent_end`.
- `docs/control-center.md`: state that informational rows (Doctor, Security, Help) include the
  command they name in the print/json text page and in the RPC select options.

**Checks.** `smoke:control-center`, `smoke:cat-status`, `smoke:docs`, `smoke:launch-screen`,
`test:typecheck`, `test:lint`, `verify`. Each new assertion must fail against the pre-fix source.

## Item 2 — `/boost` autocomplete points at the wrong hub location

**Justification.** Charter priority 4 (evidenced defect): `command-menu.ts:197-210` picks the first
row whose legacy command name matches. `model.ts:147` `/boost status` precedes `model.ts:169`
`/boost`, so the hidden-suggestion text for `/boost` names Autonomy ▸ Auto-boost although bare
`/boost` runs Recovery ▸ Reassess now. Contradicts `docs/control-center.md:126-128`.

**Change.** In `hubLocationFor` and `locationFor`, prefer an exact `/name` legacy match and fall
back to the existing command-name match. Add a `tests/command-menu-smoke.ts` case for `boost` (and
a non-colliding control). Update `docs/control-center.md` only if the wording implies the bug.

**Checks.** `smoke:command-menu`, `test:typecheck`, `test:lint`, `verify`.

## Out of this cycle

- TUI/RPC not showing typed commands (needs a width design) -> proposal.
- Idle-cat blink, inert Settings values, lab group page, stale `luna-ux-01-10` -> unchanged
  proposals/handoff.
- No `npm test` / `npm run check:all` in this cycle; the host gate owns the full suite.
- Keep the review diff under 30,000 characters excluding records/lockfile; stop taking new items
  once it passes that line.
