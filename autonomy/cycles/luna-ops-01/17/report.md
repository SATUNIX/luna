Outcome: successful
Mode: fix

Board: PG-60 done - `origin/stream/ops` (`a7cb461f`) now carries the re-landed cycles 08, 09, 10, 12 and 15, so the item's missing-08-10 defect is repaired; the run branch's own promotion range still refuses (37 findings / 25 commits, first `22fdf7f .../08/review.md:70`) so re-landing cycle 17 onto `a7cb461` remains the integrator action recorded in the cycle-16 proposal
Board: PG-63 done - end-to-end fixtures drive the real self-improve template through both merge shapes; the post-sync review is judged on the cycle's own paths (257 chars and 402 chars against the 60000 budget), and a 60001-char own diff is still refused; no production change was needed

Item: Merge `refs/upstream/trunk` into the stream (P0) - bfb0b18 - `npm run -s smoke:firewall-gate` 20/20, `npm run -s smoke:redaction-corpus` 6/6, `npm run -s test:typecheck`
Item: Pin that a post-sync merge is judged on the cycle's own paths (PG-63) - 0854e8c - `npm run -s smoke:autonomy-review-inputs` 23/23 (two new checks), `npm run -s smoke:autonomy-selfimprove` 40/40
Item: Record the ops publication state and the stranded promotion range (PG-60) - bfb0b18 - `git ls-remote origin refs/heads/stream/ops` = `a7cb461f`; `node packages/core/prepush-scan.ts range origin/stream/ops..HEAD` refuses (37 findings)

# Cycle 17 merged the upstream trunk and settled the post-sync review-budget item

**P0 upstream merge.** `refs/upstream/trunk` (`5a888fe`) was not an ancestor of the cycle-12 head
`2e3155f` (merge-base `bf6d2bb`). The merge conflicted in `tests/firewall-gate-smoke.ts` and
`tests/redaction-corpus-smoke.ts`, where our side carries the sub-quadratic growth guard and
upstream carries an absolute CPU-time budget. Both intents were kept — the cycle-16 resolution,
reproduced 1:1 because that merge's parent is exactly `2e3155f` — and merged as `bfb0b18`.
`smoke:firewall-gate` (20/20) and `smoke:redaction-corpus` (6/6) pin both guards.

**PG-63.** The board item reported that a post-sync cycle's merge review counts the whole upstream
merge side and is therefore rejected as too large (ux cycle 05: 114034 vs own 32996; ops cycle 14:
60598 vs 60000). The code at this head already scopes the diff correctly: `upstreamMergeScope`
(`lib/review.ts:119`) computes `own = startToHead ∩ upstreamToHead`, and the template passes
`{ files: scope.own, restrict: true }` to `readReviewDiff` on the `outcome: "conflict"` path
(`lib/templates/self-improve.ts:544`); on the host-synced `outcome: "merged"` path `start` already
includes the upstream head. The suite had no end-to-end fixture proving it, so the claim was
unresolved. Two fixtures were added to `tests/autonomy-review-inputs-smoke.ts`: a host-synced trunk
with a ~108 KB unrelated file plus a small own change (judged diff **257 chars**), and a
conflict-resolving cycle over the same trunk (judged diff **402 chars**); both are under the
**60000** budget with the trunk bulk absent, and the negative control still refuses a 60001-char own
diff with `exceeds the merge review's budget of 60000 characters`. The earlier counts predate the
current scoring; no production change was needed, so the deliverable is the coverage that pins it.
`REVIEW_RECORD_STAT_BUDGET` and every existing guard are unchanged.

**PG-60.** The publication defect the item names is repaired by the relaunch: `origin/stream/ops`
is `a7cb461f` and carries the re-landed cycles 08–15. The run branch was pushed to
`origin/pi/luna-ops-01` (`bfb0b18`, "29 commit(s) checked, no blocked identifiers"). The promotion
range is still refused — `origin/stream/ops..HEAD` gives 37 findings in 25 commits, first at
`22fdf7f .../08/review.md:70` — because the run branch carries the cycle-12 `-s ours` bridge
(`b2a409a`) over the stranded `e3c7fc9`/`22fdf7f` ancestry. A `stream/ops` fast-forward from the run
branch is therefore impossible; the re-land onto `a7cb461` is the integrator action recorded in
`autonomy/proposals/luna-ops-01-16-ops-publication-reland.md`. `stream/ops` was not pushed here.

## Checks
`test:typecheck` clean; `smoke:autonomy-review-inputs` 23/23; `smoke:autonomy-selfimprove` 40/40;
`smoke:firewall-gate` 20/20; `smoke:redaction-corpus` 6/6; `smoke:web-ui-bind-policy` 23/23. Host
gate (`/opt/autonomy/gate.sh`) runs on the pushed head and is not run here.
