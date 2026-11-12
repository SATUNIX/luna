# Proposal: stop the ops run branch from re-stranding behind `stream/ops`

Board: PG-60

## Finding (evidenced)

Cycle 18 had to repair the run branch before any board work: `git diff --stat origin/stream/ops..HEAD`
(merge-base `616aa06`) showed the run branch **deleting** `packages/autonomy/lib/unpublished.ts`
(113 lines, the cycle-15 PG-56 surface), the cycle-15 records, and parts of
`packages/autonomy/cli.ts` and `packages/core/install.ts`. Cycles 16 and 17 were built on the
stranded cycle-12 head (`2e3155f`, behind the cycle-12 `-s ours` bridge `b2a409a` over `e3c7fc9`)
instead of syncing the integration branch, so they never received cycles 08-15 in the relaunched
lineage. The run branch is not a descendant of the published integration branch.

The same stranding also makes the run branch non-promotable:
`node packages/core/prepush-scan.ts range origin/stream/ops..HEAD` →
`37 finding(s) in 29 commit(s); push refused`, first `3c7c8ae` message line 1. The findings name the
pre-rename commits the `-s ours` bridge pulled in; they are unreachable from `stream/ops`.

This is the third cycle (12, 15, 18) to spend its budget rebuilding a re-land.

## Proposed fix

Two parts, operator-facing only (no worker change this cycle, because the sync alone is 35900
reviewed chars and the item budget stops at 30000):

1. **Guarantee the per-cycle integration sync.** Before a cycle's branch is cut, assert
   `git merge-base --is-ancestor origin/stream/ops HEAD` for the run branch; if false, merge
   `origin/stream/ops` into the run branch as part of the cycle's P0 sync (precedence item 1) and
   fail the cycle loudly if the merge is non-trivial. `startCycleBranch` already resets the worker
   to the integration head, but the pushed run branch is what the next cycle inherits.
2. **Make the re-land a first-class integrator step.** When the run branch's promotion range is
   refused, build a single commit off the current `stream/ops` tip whose tree equals the run-branch
   tree (the cycle-18 re-land shape), push it as `<run>-reland`, and have the integrator
   fast-forward `stream/ops` from that branch. Record the stranded shas for the operator.

## Acceptance test

Extend the autonomy smoke with a fixture where the run branch's recorded remote tip is behind the
integration head: assert the next cycle's prompt/plan includes the integration sync as a P0
precedence item, and that a run branch whose promotion range is refused yields a re-land branch
whose `prepush-scan range <stream-tip>..<reland>` is clean and whose tree matches the run head.

## Why a proposal, not this cycle

The durable fix touches the cycle-start wiring (`packages/autonomy/lib/wiring.ts` /
`templates/self-improve.ts`) and is a harness control change; the cycle-18 diff already exceeds the
new-item budget, so it is recorded for a later ops cycle.
