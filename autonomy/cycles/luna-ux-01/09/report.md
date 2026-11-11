# Cycle 09 — Report (run luna-ux-01, stream `ux`)

Outcome: successful
Mode: fix

Board: V-73 done - the one-wording-for-aliases item was already merged in cycle 08 (`be6c1bb`) and is re-verified green; no new alias work was needed.

Item: Back navigation follows the visited-page stack, not the static parent (HANDOFF carry-over) - `dbf1c35` - `npm run -s smoke:control-center` is 31/31 with the fix and 1/31 (exit 1) with `hub.ts` reverted to base and the new case kept.

## The steward P0 (not a board item)

The steering said the integration candidate's `verify` and both `pi-compat` lanes fail only on
`smoke:docs` because `autonomy/JOURNAL.md` has no `luna-ux-01/03` line. **That line is already on
this branch**, added by cycle 06 (`629d998`): `autonomy/JOURNAL.md:18` is
`- luna-ux-01/03 | Board: V-01, V-03 | partial | ...`. `node tests/docs-smoke.ts` and
`npm run -s smoke:docs` both pass at base `25cc6eab64b5`. Appending a second line would regress it:
`packages/core/lib/journal.ts:100` reports `duplicate journal entry: luna-ux-01/03`. The candidate
PR #63 predates cycle 06; a candidate rebuilt from this head carries the line. No code change was
made, and none is correct. The `coverage` job is owner-side and was not touched.

## Board item V-73

Assigned but already shipped by cycle 08. Re-verified at HEAD: `git grep -n 'Alias for'
packages/extensions/src` is empty; `smoke:command-contract` is 12 including the alias-target-missing
fixtures; `npm run catalog` leaves `git status` clean. Recorded done rather than re-implemented.

## Item: back navigation

**Finding (HANDOFF carry-over 1).** Settings → Display → Back landed on **System**, contradicting
`docs/control-center.md:95` ("Back returns the cursor to the row that opened the page").

**Root cause.** `openHub` (`packages/extensions/src/control-center/hub.ts:376-380`) resolved Back
with the single static parent in `PAGES`; `display.parent` is `system` while the Display row lives
on the Settings page (`model.ts:88,93`). `tests/control-center-smoke.ts:596` only exercised a page
opened directly, where the static parent and the navigation history agree.

**Fix (`dbf1c35`).** `openHub` keeps a `stack` of pages reached by page-row navigation, pushes the
current page when a `kind:"page"` row changes the page, and on Back pops the stack, falling back to
`parentPage` only when the page was opened directly. The effective target is passed as
`PageInput.parent`, so the renderer still offers `‹ Back`/Esc, and the existing focus-row lookup is
kept. Page ids, `PAGES`, row ids, commands, handlers, `HARNESS_COMMANDS`, `package.json` scripts and
`overlay-frame.ts` are unchanged.

**Tests.** New `tests/control-center-smoke.ts` case "Back follows the path the operator took, not
the page's static parent"; it fails on the pre-fix hub and passes after, while the existing
direct-open case stays green.

**Docs.** `docs/control-center.md:95` now states Back follows the path taken and only a
directly-opened page falls back to its declared parent.

## Left and notes for the next cycle

- P0: re-verify on the rebuilt candidate; if it is still red on `luna-ux-01/03`, the candidate is
  stale, not the branch.
- Carried over and not taken: overlay mouse forwarding (no small fix), idle-cat blink (needs an
  operator decision), `smoke:web-console` shared runtime (outside `ux`), alias wording after the
  target (accepted in cycle 08), `trunk` channel alias (core/ops).
- Process: the `workflow_run` implementer committed `dbf1c35` but did not push (same as cycles 06
  and 08); checked `git status`/remote and pushed directly. The cycle's own reviewer step returned
  no visible text, so an independent reviewer was run separately and passed.
- Diff excluding lockfile and records: 4538 characters. No control path touched.
