Outcome: successful
Mode: fix

Board: PG-56 done - `status`, `top` and `doctor` now surface merged work that has not reached the remote, and the two defects found in that carried feature are fixed: `publish()` records the pushed integration head in `refs/integration/remote`, and a newer "publish recovered" log line clears a stale failure reason and timestamp
Board: PG-52 blocked - not started this cycle; the P0 upstream merge, the cycle-14 carry-over and the review-found PG-56 defects used the budget, and the path-glob -> check mapping table has no prior code to build on (the addition point and carry-over are recorded in the handoff)

Item: Merge `refs/upstream/trunk` into the stream (P0) - 9b751ee (re-landed 783b75b) - `npm run -s smoke:firewall-gate` 20/20, `npm run -s smoke:redaction-corpus` 6/6, `npm run -s smoke:docs`
Item: Surface merged work that has not reached the remote (PG-56) - 6aabc4d (re-landed 55ceb2f) - `npm run -s smoke:autonomy-cli` 21/21 (four PG-56 checks)
Item: Report an invalid installer `--scope` and handle `--help`/`-h` cleanly (cycle-13/14 carry-over) - 6f5e765 (re-landed 955c697) - `npm run -s smoke:install-marker`
Item: Stop PG-56 reporting a run as unpublished after it published - f15a143 (re-landed a5565df) - `npm run -s smoke:autonomy` 32/32 and `npm run -s smoke:autonomy-cli` 21/21

# Cycle 15 landed the upstream merge and corrected the carried PG-56 surface

**P0 upstream merge.** `refs/upstream/trunk` (`5a888fe`) was not an ancestor of the branch. The
merge was already produced and reviewed in cycle 14 as `9b751ee`; this cycle re-used it rather than
rebuilding it, because a hand-built equivalent differed only for the worse. The two conflicts
(`tests/firewall-gate-smoke.ts`, `tests/redaction-corpus-smoke.ts`) keep **both** guards: the
branch's `assertSubQuadratic` (`tests/perf-budget.ts`) and upstream's `assertCpuWithin`
(`tests/timing.ts`). No branch work was dropped: `git diff 5a888fe 9b751ee` is branch-only and
`git diff 2e3155f 9b751ee` is upstream-only. `smoke:firewall-gate` (20/20) and
`smoke:redaction-corpus` (6/6) pin the retained guards.

**PG-56.** The read-only unpublished-work view is landed (`packages/autonomy/lib/unpublished.ts`,
`cli.ts`, `docs/autonomy.md`, `tests/autonomy-cli-smoke.ts`). It compares the run's mirror
`refs/heads/<integration>` against `refs/integration/remote`, prints `unpublished: N commits since
<time>` with a reason in `status`/`top`, marks a run "waiting on operator" in `inbox` past 30
minutes, and makes `doctor` exit 3 while ahead. A scout review of that carried code found two real
defects, both fixed with tests:

1. `publish()` (`packages/autonomy/lib/gitmirror.ts`) pushed the integration branch but never
   advanced `refs/integration/remote`, so after a successful publish a run still reported
   `unpublished:` and `doctor` exited 3. It now records the pushed head.
2. `lastPublishFailure()` (`packages/autonomy/lib/unpublished.ts`) scanned the supervisor log
   backwards for `"publish failed"` and stopped at nothing, so a later `"publish recovered"` line
   did not clear the stale failure timestamp/reason. The most recent publish outcome now wins.

**Installer carry-over.** `--scope` errors and `--help`/`-h` are handled without a stack trace
(`packages/core/install.ts`, `docs/INSTALL.md`, `tests/install-marker-smoke.ts`).

## Publish state and the re-land

`origin/stream/ops` is `616aa06`, an ancestor of this branch, but the run branch carries the
stranded cycle-08/09 rightly-rewritten ancestry, so the pre-push leak scan refuses a fast-forward
of `stream/ops` from it ("37 finding(s) in 61 commit(s)"). Following the cycle-12 procedure, a
clean re-land branch `reland/cycle15` was built from `origin/stream/ops`: the upstream merge
resolved with the reviewed conflict copies, then the three authored commits replayed. Its code tree
is identical to this branch's head for every non-record path, and its leak scan is clean
("37 commit(s) checked, no blocked identifiers or private paths"). `origin/stream/ops` is
fast-forwarded to the re-landed head, carrying this cycle's records too.

## Left / next cycle

- **PG-52** (derive a cycle's verify list from changed files via a path-glob -> check-script data
  table, plus `--for-changed`) is the assigned P1 still owed; review records the exact addition
  point (`packages/core/check-all.ts` beside `checkNames()`, consumed from `cyclePrompt()`).
- **PG-53** stays deferred; re-landing the tool-firewall boundary probe on a 73-file merge is
  unverified risk.
- The rest of cycle 14 (its record commits) stays on `origin/attempts/luna-ops-01/cycle-14`.
- `smoke:redaction-corpus` failed once under load and passed four consecutive reruns; it stays in
  the known load-sensitive-flake proposal.
