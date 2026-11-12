# PG-66 (remaining): host-side pre-report refusal and one-item re-landing

Cycle 26 (`12957da`) fixed the root cause of PG-66: the self-improve loop now measures the
would-be review diff while the worker is alive and steers it with the exact number and budget
(`cycle.ts` `budgetStale`, `self-improve.ts` `diffBudget`, `review.ts` `characters`). The reset and
preserve halves already held, and `mergeDecision` remains the fail-closed backstop.

What is deliberately left for a later cycle (each is a separate, reviewable change; do not bundle
them over the 60,000-char review budget):

1. **Hard refusal before submitting, not only a steer.** Today an over-budget cycle is still
   allowed to close; `mergeDecision` then refuses it. A stronger reading of the board item is that
   the cycle's own pre-report check must *refuse* the submission with the measured number (for
   example the host records the cycle as `partial`/`refused_budget` and does not enter the merge
   review at all). The cost is one wasted cycle's model spend versus the current steer's chance to
   split in-cycle, so this needs a measurement before it is worth doing: cycles rejected for review
   budget, and usd per merge, before and after.

2. **Host-driven one-item-at-a-time re-landing.** The prompt still leaves it to the worker to
   decide what to carry from `attempts/<run>/cycle-NN`. A host capability that offers exactly one
   rejected item per cycle (for example a `--carry <n>` input the host fills from the previous
   refusal, checked against `mergeDecision`'s budget before the session starts) would remove the
   worker's discretion and make the growth monotonic only in the intended direction.

3. **Metric.** Record cycles rejected for review budget and usd per merge in the run record so the
   two changes above can be judged rather than assumed.

Non-blocking notes from the cycle-26 reviewer, safe to fold into any of the above:

- `budgetStale` reads `headSha()` then `diffBudget()` re-reads `repo.head()`, so a commit between
  the two can warn a stale head; key the warned set on the measured head.
- The probe can advise a cycle that `mergeDecision` would not review anyway (red gate, a
  non-completed outcome, a dropped upstream scope); harmless because the probe only warns.
- It is a *pre-merge-review* probe invoked after `report.md` exists; if hard refusal (item 1) is
  implemented, move it earlier so the report is not written for a cycle that will be refused.

Evidence for the fix: `tests/autonomy-selfimprove-smoke.ts`, check "an over-budget cycle is caught
pre-report: the live worker is steered with the measured number, then splits and the next cycle
merges"; removing the probe fails it.
