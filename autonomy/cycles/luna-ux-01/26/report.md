# Cycle 26 — Report (run `luna-ux-01`, stream `ux`)

Outcome: successful
Mode: fix

Item: Hub Security page shows the raw effective level - 1c9d199 - `npm run smoke:control-center` 45/45 (new page assertions fail on base with `guarded (requested balanced)` vs `guarded`)
Item: `/workflows` list cursor follows the selected run, not its row - 879b956, c9e586e - `npm run smoke:workflow-panel` 20/20 (insertion/Enter/Esc case fails on base with index 1 vs 2; prune fallback pinned)
Item: deterministic stopped-queue case in `smoke:workflow-resume` - 1cd4579 - under load (`taskset -c 0` + three CPU hogs) `workflow-resume-smoke: 41 checks passed`; idle 41/41 (before: `MISS: a stopped run's writer leaves the checkout queue`, actual `undefined` vs `[[cancelled, stopped]]`)

## What changed

**P0 red gate, reproduced.** The previous cycle's acceptance named
`check-all:smoke:workflow-resume` (exit 1) but the check passed idle. It fails under CPU
contention at the finding "a stopped run's writer leaves the checkout queue": the holder child
was bounded by a 1500 ms timer and the test then did a fixed `sleep(300)` before stopping the
queued run. `fakeSpawner` schedules the holder timer first, so under load the holder released the
writer lock, the queued run launched and finished, and the late `stop` landed in the post-child
fingerprint, leaving `omissions` undefined. The case now holds the checkout with a one-shot
file gate in a `git` wrapper (the pattern already used by the neighbouring stop-after-writer
case), waits for the gate marker, launches the queued writer, waits for its registered agent,
stops it in the same turn and asserts the unchanged `cancelled`/`stopped` omissions. The first
gated review found the naive gate deadlocked the queued run's initial fingerprint; the one-shot
gate is the fix. No assertion was loosened; the holder's `passed` status is now also asserted.

**Cycle-25 carry-over.** Cycle 25 was sound but unmerged because of the red gate alone. Its two
fixes are cherry-picked here (`1c9d199`, `879b956`, `c9e586e`), docs and tests included, and
re-verified with their smokes. Its record commit was not carried over (this cycle has its own).

## Test justification

Only `tests/workflow-resume-smoke.ts` changed beyond the cherry-picks. The rewrite replaces
wall-clock ordering with observable state; the asserted outcome (`cancelled`/`stopped` omission)
is identical and the case now additionally asserts the holder finished `passed`. No test was
skipped, weakened or deleted.

## Left for later

- Proposal `autonomy/proposals/luna-ux-01-26-workflow-hooks-timer-races.md`: two lower-margin
  fixed-timer patterns in `tests/workflow-hooks-smoke.ts` r14 (5 s and 1.5 s child timers versus
  a ~200 ms run end). Not observed failing; reproduce before changing.
- Non-blocking review warnings: the test header says "no wall-clock dependency" while the queued
  run still takes `drainMs: 200` (a drain window, not ordering); the no-firewall Security page
  wording `Effective: unknown` / `Requested: same as effective` is pre-existing and pinned.
- Open proposals unchanged: idle-cat frames (needs an intent decision), hub 1-4-row frame/mouse
  edges, inert Settings value rows, `TRUNK_CHANNEL` alias, inbox edges.

## For the next cycle

- Never run `npm test` / `npm run check:all`; the host gate owns the full suite.
- Add the `autonomy/JOURNAL.md` line in the same push as a new `report.md` or `smoke:docs` fails.
- Gated `workflow_run` plans did **not** auto-retry after this cycle's `VERDICT: FAIL`: both
  steps reported passed and only 2 agents ran, so the retry had to be a second plan. Read the
  reviewer's verdict in the step output rather than trusting the run's "passed" status.
- A `reviewer` step may also emit only its first message (seen in a scout in this cycle); always
  inspect `git status`/`git diff` and the full step file.
- Non-record diff is 18,442 characters, well under the 30,000 stop threshold; the interrupt
  case is closed, so the next cycle can pick a stream improvement from the open proposals.
