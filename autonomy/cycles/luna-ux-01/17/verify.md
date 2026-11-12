# Cycle 17 — Verify (run `luna-ux-01`, stream `ux`)

Cycle base `369c5ac78db4`. Targeted checks only; the host gate owns the full suite. All checks
below ran after `bdeb5d6`, the last non-record commit.

| Check | Result |
| --- | --- |
| `npm run smoke:control-center` | PASS: `[control-center-smoke] all 37 checks passed` |
| `npm run smoke:cat-status` | PASS: `cat-status-smoke: 12/12 passed` |
| `npm run smoke:command-menu` | PASS: `[command-menu-smoke] all 13 checks passed` |
| `npm run smoke:docs` | PASS: `[docs-smoke] OK: 14 documented commands validated, 62 relative links resolved` |
| `npm run smoke:launch-screen` | PASS: `[launch-screen-smoke] all 11 checks passed` |
| `npm run test:typecheck` | PASS: exit 0 |
| `npm run test:lint` | PASS: exit 0 |
| `npm run verify` | PASS: `[verify] All checks passed.` |

## Red gate found and repaired

`npm run smoke:docs` failed at base with `duplicate journal entry: luna-core-01/09`,
`/10`, `/11` (the cycle-15 merge kept both copies). `40fdab7` removes the later block; the check
then passed. This is why `a8e8553`'s message claims `smoke:docs` although the gate was red until
`40fdab7`; the doc change itself is correct and the following commit carries the real verification.

## Before/after evidence

**Hub escaping, short terminals, cat priority, informational commands (re-land).** Each
cherry-picked commit carries its own test; the re-landed cases are in
`tests/control-center-smoke.ts` (exact header without ESC, 10/8/24/60-row overlays, RPC `[command]`
suffix) and `tests/cat-status-smoke.ts` (`deniedHoldsAgainstLaterResults`). All pass after the
re-land and the pre-fix source was still present at the base.

**Mouse hit-test (regression).** New case clicks the first data row on a 24-row terminal after
moving the selection to the third row. With `1381aaa` reverted it fails with
`AssertionError: the press focused the row under the pointer, not a lower one`; with the fix
`smoke:control-center` is 37/37.

**Cat timer (regression).** `deniedHoldsAgainstLaterResults` now asserts
`catTimerActive() === true` after a suppressed `agent_end`. With `6cc6746`'s source change
reverted it fails on `the held denial still has a footer timer to clear it`; with the fix
`smoke:cat-status` is 12/12.

**`/boost` location.** New command-menu case asserts `hubLocationFor("boost")` and
`locationFor(model)("boost")` both name `Work ▸ Recovery ▸ Reassess now`, and that a non-colliding
command is unchanged. With the source change reverted it fails
(`an exact legacy command wins over another row whose command name collides`); with the fix
`smoke:command-menu` is 13/13.

**Review follow-ups (`bdeb5d6`).** Docs now name only rows that carry a command; one
`titleShown()` predicate drives both render and `handleMouse`; the project-marker Doctor assertion
requires the exact `[/update status]` suffix. `smoke:control-center` 37/37, `smoke:docs` OK.

## Independent review

A reviewer subagent that did not write the change read `git diff 369c5ac78db4..HEAD` against
`autonomy/CHARTER.md` and the plan, re-ran every targeted check, and returned **PASS** with three
non-blocking warnings (docs over-generality, optional Doctor suffix, duplicated title predicate).
All three were fixed in `bdeb5d6` and the checks re-run green. Its one noted limitation: the four
cherry-picked commits keep their original subject-only messages; the finding/cause/fix/verification
detail is in this cycle's `review.md` and `plan.md`, and amending pushed history is out of bounds.

## Diff and scope

`git diff 369c5ac78db4..HEAD` excluding `package-lock.json` and the cycle/run record directories is
35,181 characters, under the 60,000 review budget (the 30,000 stop-new-items line was crossed only
after the last item was complete). No change to `autonomy/CHARTER.md`, operator control paths or any
`package.json` scripts. `autonomy/runs/luna-ux-01/HANDOFF.md` is gitignored, so it is updated
locally and not part of the commit.
