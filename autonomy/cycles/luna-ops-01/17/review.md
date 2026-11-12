# Cycle 17 review (run `luna-ops-01`, ops stream)

Mode: fix. Precedence at start: (0) branch/gate, (1) upstream merge, then board items PG-60, PG-63.

## Branch and gate at cycle start

- `HEAD` = `2e3155fb135c` (cycle-12 head). Clean tree.
- `smoke:web-ui-bind-policy` — the check cycle 16 reported red — passes on this tree (23/23). No red gate
  to repair before the merge.

## P0 upstream merge

`refs/upstream/trunk` = `5a888fe5dcf2` (`integrate: stream/core into integration/luna`), not an ancestor
of `2e3155f` (merge-base `bf6d2bb`). `git merge refs/upstream/trunk` conflicted in two files:

- `tests/firewall-gate-smoke.ts` — our side had `assertSubQuadratic`; upstream rewrote the redaction
  growth check as an absolute `assertCpuWithin` CPU budget with a catastrophe self-test.
- `tests/redaction-corpus-smoke.ts` — same shape, our advisory's sub-quadratic guard vs upstream's
  CPU budgets.

Resolved keeping both intents (the cycle-16 sound resolution, reproduced 1:1 because that merge's parent
is exactly `2e3155f`): both the host-speed-independent growth guard and the load-tolerant CPU budget run.
Merged as `bfb0b18`. Verified: `smoke:firewall-gate` 20/20, `smoke:redaction-corpus` 6/6, `test:typecheck`,
`smoke:web-ui-bind-policy` 23/23.

## PG-60 — ops publication

Current receipts (`git ls-remote /git/remote.git`):

- `origin/stream/ops` = `a7cb461f` — the relaunch re-land (clean lineage off `616aa06`), carrying the
  re-landed cycles 08-15 content (`55ceb2f`, `955c697`, `a5565df`, ...). The stranded `e3c7fc9`/`22fdf7f`
  ancestry is **not** in it.
- `origin/pi/luna-ops-01` was `2e3155fb`; our merge pushed cleanly (`2e3155f..bfb0b18`, "29 commit(s)
  checked, no blocked identifiers"). The run-branch push range is clean.
- The *promotion* range is not: `node packages/core/prepush-scan.ts range origin/stream/ops..HEAD` →
  `37 finding(s) in 25 commit(s); push refused`, first at
  `22fdf7f26dc4 autonomy/cycles/luna-ops-01/08/review.md:70: blocked identifier`. The run branch still
  carries the cycle-12 bridge (`b2a409a`, `git merge -s ours`) that pulled the pre-rename commits in.

So the cycles 08-10 publication defect the board item names is **already repaired** by the relaunch:
`origin/stream/ops` is clean and holds the re-landed content. What remains for this cycle is that its own
commits sit on a base (`2e3155f`) that is not an ancestor of `a7cb461`, so a `stream/ops` fast-forward
from the run branch is refused by the leak scan; the re-land path (rebuild the cycle's commits on the
current `origin/stream/ops`) is the integrator action recorded in
`autonomy/proposals/luna-ops-01-16-ops-publication-reland.md`.

## PG-63 — merge review budget after an upstream sync

Board item claims a post-sync cycle's review counts the whole upstream merge side. Code at this head:

- `packages/autonomy/lib/review.ts:83-107` `readReviewDiff` — with `restrict` it diffs only the given
  paths.
- `packages/autonomy/lib/review.ts:119-127` `upstreamMergeScope` — `own = startToHead ∩ upstreamToHead`.
- `packages/autonomy/lib/templates/self-improve.ts:544-568` — `resolves` is set **only** when
  `upstream.outcome === "conflict"` (line 544); only then `upstreamMergeScope` runs and the read uses
  `{ files: scope.own, restrict: true }`. When the host itself merged cleanly (`outcome: "merged"`) the
  integration head is the merge commit and `start` (line 455) already includes upstream.
- `tests/autonomy-review-inputs-smoke.ts` has 21 checks; none drives the self-improve template through a
  large-upstream-merge cycle end to end. Cycle 16's unit-level pin is on the unmerged attempt only, not
  on this base.

An honest reproduction is owed before any fix: the acceptance fixture must run the real `mergeDecision`
(`lib/templates/self-improve.ts`) over a host upstream sync, not call `upstreamMergeScope` by hand.

## PG-63 — reproduction result (end to end)

The fixture was built and run through the real template. It does **not** reproduce on this head: the merge
review already judges the cycle's own paths only. No production change was needed.

Two end-to-end shapes were added to `tests/autonomy-review-inputs-smoke.ts` (a `prepare` hook on the cycle
helper creates the upstream branch before `runOnce`):

- **Host-synced trunk (`outcome: "merged"`)** — `integration/trunk` carries a ~108 KB unrelated file, the
  host merges it into the integration branch before the cycle, and the cycle adds one small own file. The
  judged diff is **257 chars** against the **60000** budget; `upstream-bulk` is absent. The negative
  control in the same check gives the cycle a `60001`-char own code diff and it is still rejected with
  `exceeds the merge review's budget of 60000 characters` before the model is asked.
- **Conflict-resolving cycle (`outcome: "conflict"`)** — the trunk conflicts on a one-line `README.md`
  while also bringing a ~108 KB unrelated file; the worker resolves the conflict and adds one small own
  file. `upstreamMergeScope` yields the multi-parent own set and the judged diff is **402 chars** against
  the **60000** budget; the resolution line is judged, `upstream-bulk` is not.

Both shapes pass; the two board counts (ux 114034 / ops 60598) predate the scoring this head uses and are
not reachable here. The code path was already correct (`upstreamMergeScope` + `readReviewDiff {restrict}`),
so the deliverable is the acceptance coverage that pins it, not a fix.
