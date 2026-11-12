# Cycle 17 — Review (run `luna-ux-01`, stream `ux`)

Base `369c5ac78db4` (head of `stream/ux` after cycle 15). Mode chosen: **fix**.

## Inputs read

`autonomy/CHARTER.md`; `autonomy/runs/luna-ux-01/HANDOFF.md`; this run's proposals under
`autonomy/proposals/luna-ux-01-*.md`; the cycle 16 attempt branch
`origin/attempts/luna-ux-01/cycle-16` (`review.md`, `plan.md`, `report.md`, `verify.md` and its
commits `df03563`, `d449086`, `a9c0ce7`, `205939a`); `git log --oneline 369c5ac78db4..HEAD`
(empty at cycle start). Two scouts audited the stream's code and the unmerged attempt branch.

## Board

The steward board lists no assigned items for this cycle. Cycle 16 was rejected because it did not
advance PG-09; that constraint does not apply here (no item assigned, and the handoff's PG-09
claim is not relied on). With no board work, precedence moves to handoff carry-overs (3) and
defects (4).

## Scheduling carry-over

Cycle 16's four commits are not ancestors of HEAD (`git merge-base --is-ancestor <sha> HEAD` exits
1 for all four; the source is still pre-fix at HEAD). The handoff says the work is sound apart from
the missing PG-09, and the rejection named only PG-09 and a docs gap on item 4. Re-landing them is
the correct carry-over. Two scouts independently checked the attempt branch and found defects in
that unmerged work, which must be fixed as part of the re-land:

1. **Hub escaping / short-terminal / cat priority / informational commands are still absent at
   HEAD.** Evidence: `hub.ts:218-232` interpolates raw header values (`headerLine({profile:
   "x\u001b[2Jowned"})` returns ESC); `hub.ts:350-356` returns `container.render(width)` even when
   the terminal has fewer rows; `custom-footer/index.ts:343-347` overwrites the single result slot,
   so a denial followed by `agent_end` success renders `success`; `hub.ts:160-169` stores the
   informational command only in `description`, and `textPage` (`hub.ts:243-245`) / `rowLabel`
   (`hub.ts:293-297`) never render it. Contracts: `docs/control-center.md:100-107`,
   `docs/status-bar-and-costs.md:93-95`.

2. **Attempt-branch regression: short-terminal fix moves the pointer hit-test.** On the attempt
   branch the title is rendered outside the `Container` (`hub.ts:374`) while `handleMouse`
   forwards the event unchanged (`hub.ts:391`). `Container.handleMouse` measures child heights from
   its own y=0, so with a title shown (>= 14 rows) a click on the first data row selects the third.
   Violates the pointer behaviour documented at `docs/control-center.md:98-104`.

3. **Attempt-branch regression: a suppressed cat result never re-arms its timer.**
   `custom-footer/index.ts:343-355` returns from `setResult` without `syncCat()` when a held result
   outranks the new one. `agent_end` calls `stopCat` then `setResult(success)`; the denial is kept
   but no timer is armed, so the held face is never cleared. Violates
   `docs/status-bar-and-costs.md:108-110` ("a result plays once … then goes back to the resting
   face").

4. **Item 4 docs gap named by the rejection.** `docs/control-center.md:107` says print/json writes
   "its typed command", but nothing says informational rows (Doctor/Security/Help) now contribute
   the command they name; the RPC dialogs are not described either. Needs one explicit sentence.

## New defect taken (precedence 4)

5. **`/boost` autocomplete reports the wrong hub location.** `command-menu.ts:197-210` resolves a
   command by `legacyCommandName` only and keeps the first row. `model.ts:147` (`Auto-boost`,
   Autonomy, `legacy: "/boost status"`) precedes `model.ts:169` (`Reassess now`, Recovery,
   `legacy: "/boost"`), so bare `/boost` is reported as `moved → /menu ▸ Autonomy ▸ Auto-boost`
   while `/boost` actually runs the Recovery row. Contract: `docs/control-center.md:126-128`
   ("where the command lives"). Small fix: prefer an exact `/name` legacy match, then fall back to
   the name match, in both `hubLocationFor` and `locationFor`.

## Findings left as proposals

- The TUI and RPC renderers never show a row's typed command, although the Help page
  (`hub.ts:186`) and `docs/control-center.md:3-5,45` say every row shows its typed equivalent.
  This needs a width/truncation design decision and touches every row, so it becomes a proposal
  rather than this cycle's work.
- Idle-cat blinking, inert Settings value rows, the lab group routed to the Work page and the
  stale `luna-ux-01-10` proposal remain as the handoff records them.
- The earlier cycle-16 note about integration-candidate shard 3 still cannot be reproduced from
  this clone; no new evidence either way.

## Scope

Re-land the four cycle-16 commits with the two regressions corrected and the docs gap closed; then
the `/boost` location fix. Targeted checks: `smoke:control-center`, `smoke:cat-status`,
`smoke:command-menu`, `smoke:docs`, `smoke:launch-screen`, `test:typecheck`, `test:lint`, `verify`.
Never `npm test` / `npm run check:all`.
