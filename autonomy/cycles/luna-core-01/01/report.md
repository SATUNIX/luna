Outcome: successful
Mode: fix

Cycle 1 of run `luna-core-01` (stream `core`), base `5a511f35e7d5`. One P0 board item fixed, the
other re-verified on the base with no change. Diff 26,562 chars for code, tests and docs (limit
30,000); no operator control path, `.github/`, `package.json` script or charter changed.

Board: PG-67 done - When the destination moved under a run, the cycle start now rebases the local cycle commits onto it, records the reconciliation, rewrites recorded heads through a first-parent mapping, never moves tags, and continues with the same cycle counter; a conflicting rebase parks the run blocked instead of failing.
Board: PG-55 done - Re-verified on the base with no code change: status carries the publish blocker and unpublished count, the next prompt names the commit and location, two blocked cycles park on a question, and a clean publish clears all three.

Item: reconcile a diverged integration branch instead of killing the run - ce412c3 - `npm run smoke:autonomy-selfimprove` (57 checks; the new non-conflicting PG-67 check ends `failed`/`integration_diverged` on base `5a511f3` and `succeeded` with `[1,2,3]` at HEAD) and `npm run smoke:autonomy` (34 checks: rebase, first-parent mapping, unmoved tag, fast-forward publish, conflict abort)
Item: re-verify PG-55 publish-blocked visibility, next-prompt location and two-cycle parking - no code change (verified on base `5a511f3`) - `npm run smoke:autonomy-selfimprove` PG-55 checks, all PASS

## What and why

`syncIntegration` already reported `diverged`, but the cycle start turned it into a terminal
`engine.go("failed")` with reason `integration_diverged`, and the run contract had no reconciliation
step. `luna-ux-01` (after its green cycle 10) and `luna-guard-01` were both killed this way; their
merged work was stranded and their cycle counters restarted.

`gitmirror.reconcileIntegration` now rebases `mergeBase..local` with `git rebase --rebase-merges
--onto <fetched-destination> <merge-base> <local>` in a temporary host worktree (hooks and signing
off, run identity), moves only the integration ref, and returns a first-parent old→new mapping. The
template records `from`/`remote`/`head`/`commits` in `selfImprove.reconciliations`, rewrites
`history[].head`/`start`, `lastGoodSha` and `current.startSha`, then continues the same cycle; the
next publish fast-forwards the destination. Tags are deliberately never moved: publication is
fast-forward only, so a rewritten tag would be refused by the destination; each run tag keeps naming
the commit that was originally published. A conflicting rebase aborts cleanly and parks the run
`blocked` on an `integration-diverged` question naming the branch and both short shas. No new
network call is made beyond the sync's fetch; the leak scan, its patterns and its exceptions are
untouched.

## Leftovers / next cycle

- PG-67's non-conflicting end-to-end check moves the destination from an `onSleep` hook, so the
  exact cycle on which the divergence is observed depends on the tick boundary; it always asserts
  that a reconciliation happened, publication succeeded and the counter was kept.
- PG-67 blocks on a conflict but does not retry automatically after the operator's hand
  reconciliation; the answer resumes the same cycle, which re-syncs.
- Carried in the handoff, not worked: `.github/CODEOWNERS` dead path (proposal territory), broad
  env-manifest ownership, and the V-07/V-08/V-10/V-11 defect IDs that need the operator's list.
