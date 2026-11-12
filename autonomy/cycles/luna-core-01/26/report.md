# Cycle 26 report — luna-core-01

Outcome: successful
Mode: fix

- Run: `luna-core-01`, cycle 26, stream `core`
- Branch: `pi/luna-core-01`, base `29eeab10123a`
- Cycle status: completed

Board: PG-66 progress - implemented and tested the in-cycle pre-report diff probe that steers a
live worker with the exact measured number before the cycle closes (the reset/preserve half already
held); the stronger host-side "refuse before submitting and re-land one item at a time" variant is
left to `autonomy/proposals/luna-core-01-26-pg66-pre-report-refusal.md`.
Board: V-102 done - the V-10b UI/installer/helper strings and whole-repo brand-smoke scope already
hold on the base (cycle 22 `85e93fa`, `e19f880`/`f7554ce`); re-verified with the named smokes, no
code change.

Item: PG-66 in-cycle review-diff probe - `12957da` - `npm run smoke:autonomy-selfimprove` all 44
checks pass, including the new `an over-budget cycle is caught pre-report ...` check, which fails
with `cycle 1 got a pre-report budget steer` when the probe is removed; independent reviewer
VERDICT PASS.
Item: V-102 already-held re-verification - no code commit - `npm run smoke:brand` 18/18,
`smoke:kit-update` 40/40, `smoke:install-marker` all pass, `npm run verify` all checks pass,
`npm run test:security` pass, `npm run gen:shared` leaves no diff.

## What was done

### PG-66 — the worker now learns in-cycle that its diff is over budget

Finding (evidenced by the steward): `luna-ops-01` has not merged since cycle 20; its reviewed diff
grew monotonically (cycle 14 60,598 → 25 63,986 → 26 92,761 chars), every cycle gate-green, every
one rejected "the diff ... exceeds the merge review's budget of 60000 ... Split the work across
cycles". A run in that state cannot recover, because the host measures the diff only inside
`mergeDecision`, after the worker session has ended, so the next worker re-lands the prior rejected
work and the cycle is rejected again one cycle later.

Root cause: no in-cycle, pre-report probe. The reset/preserve half of PG-66 already held
(`gitmirror.ts:285-289` via `self-improve.ts:514`, tags/attempts at `self-improve.ts:515-517,580`);
what was missing was any measurement while the worker could still act.

Fix (`12957da`, four files): `ReviewDiffRead` gains the measured `characters` on an over-budget
result (`review.ts`); the self-improve cycle runtime gains `diffBudget()`, measuring exactly the
`start..head` diff `mergeDecision` will judge with the same exclusions and upstream-conflict scope
and failing closed without throwing (`self-improve.ts`); the cycle loop gains `budgetStale()`,
which once per head steers the live worker with the exact measured characters and budget and tells
it to land only the current item's work, carry-over items staying on `attempts/<run>/cycle-NN`
(`cycle.ts`). The merge decision remains the fail-closed backstop and no outcome changed.

Test: `tests/autonomy-selfimprove-smoke.ts` gains a 3-cycle fixture (cycle 1 70k refused; cycle 2
re-lands 70k+10k refused, accumulated; cycle 3 10k merges) asserting the reset to the seed head,
the attempts tags and worker-remote branches, exactly one merge-review model call, and the live
steer naming the measured number. Removing the probe makes the new check fail.

### V-102 — verified, no change needed

Reconnaissance found every named string already says Luna (`kit-update/index.ts:782` prints
`Luna update status`; `install.ts:595`, `uninstall.ts:94`, `gen-notices.ts:94`, the helper
scripts, both `package.json` descriptions and `gate.sh` all say Luna), the test assertions already
expect Luna, and `brand-smoke` already walks the whole workspace. The only `pi-system` left is the
documented identity tokens in `docs/branding.md`. The cycle ran the named smokes instead of
manufacturing churn, record it `done` as in cycle 23's V-10 re-verification.

## Checks

See `verify.md`. Diff 13,909 characters (under the 30,000 stop). No security control, test
assertion, CHARTER or `package.json` script was touched. Independent reviewer on `12957da`:
VERDICT PASS, no must-fix.

## For the next cycle

- `bus`/`buses` `-es` stemmer regression still needs a lexicon or an operator trade-off.
- PG-66's remaining orchestration is in `autonomy/proposals/luna-core-01-26-pg66-pre-report-refusal.md`
  (host-side hard refusal before submitting, host-driven one-item-at-a-time re-landing, and the
  usd-per-merge metric).
- Non-blocking probe notes: key the warned set on the measured head, and remember the probe can
  advise a cycle that `mergeDecision` would not review anyway (red gate); both are safe because the
  probe only warns.
