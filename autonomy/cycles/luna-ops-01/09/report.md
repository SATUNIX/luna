# Cycle 09 bounded concurrent acceptance gates per host and recorded the unattended decision

Outcome: successful

Mode: fix

Board: PG-50 done - a host-wide flock slot bound (default 2, 0 unbounded) now limits how many supervisors on one host run an acceptance gate at once, with a visible gate-wait phase that does not charge wall-clock budget
Board: PG-53 progress - recorded as an operator/security decision with a proposal and two honest fix paths; the fail-closed namespace check is unchanged

Item: Bound concurrent acceptance gates per host - fd6f772 (bound), 3773eca (hardening after review) - `npm run -s smoke:autonomy-lifecycle` (at most two overlap, a third waits then runs; a killed holder frees its slot; limit 0 unbounded), plus `smoke:autonomy-run` and `smoke:autonomy-selfimprove`
Item: Record the tool-firewall unattended-namespace decision - ee5b3fa - no test: a docs-only proposal, no code path changed (the fail-closed check is untouched)

## What changed

Item PG-50 (the P0/rank-1 item): before this cycle the per-run lock (`runlock.ts`) guaranteed one
supervisor per run but nothing bounded how many of those supervisors ran their expensive acceptance
gate at the same time on one host. Several runs therefore competed for CPU and IO, which is the
item's measure: cycles rejected for a gate failure unrelated to the change (baseline 14 of 25 on
2026-11-11). The fix is host-side only and adds `packages/autonomy/lib/gate-slots.ts`: a slot set
under `stateHome()/gate-slots`, taken with `flock` on an open fd (never a pid file), default limit
2, `0` unbounded, read from `PI_AUTONOMY_GATE_SLOTS` (or an explicit `gateSlots` option).
`Engine.withGateSlot` sets phase `gate-wait`, heartbeats it, pauses wall-clock minute accrual, then
runs the gate under phase `acceptance`; the slot frees in `finally`, on the holder's death, or when
another process kills it. The four acceptance call sites are wrapped (`engine.ts evaluateStep`; the
three `self-improve.ts` `runAcceptance` calls). Nothing inside the gate container, no check and no
definition of a pass changed; only when a gate may start is bounded. The second commit hardens the
primitive after review (a throwing post-acquire tick used to leak a slot; a missing `flock` used to
look like contention and hang forever; the wait could charge a poll interval; the comment and README
claim were imprecise).

Item PG-53 (rank 53) was not implemented. Every worker session logs that unattended mode is not
active because the process is not in the initial user namespace, so the run contract and the
tool-firewall disagree and non-routine calls escalate (cycle 08: 10 operator prompts, 2,319 s
waiting, one timeout; two session restarts at roughly 30 calls and 88 min). The check is a
fail-closed control and must not be deleted or loosened. It needs an operator/security decision, so
`autonomy/proposals/luna-ops-01-09-tool-firewall-unattended-namespace.md` records the evidence, the
two honest paths (run the worker in the initial user namespace, or make the proof exact and
two-sided with a security review) and the acceptance test each needs.

## Verification

Independent reviewer subagent read the whole diff against the charter and the assigned items and
returned `VERDICT: PASS` (residual warnings only: the first tick sits outside the `try/finally`; the
clock pause discards the interval since the previous tick; `PI_AUTONOMY_GATE_SLOTS` is not in the
generated env table; the three-supervisor criterion is pinned at the slot primitive rather than
through three Engines; stock macOS lacks `flock`). `verify.md` lists each check with its proof line.

## Left / next cycle

- All three PG-50 commits and the proposal are pushed to `stream/ops` (head `ee5b3fa`). The remote
  branch `pi/luna-ops-01` is stale and diverged (it still points at the pre-rewrite `6f4a7f3`),
  so `git push origin HEAD` is rejected; push `HEAD:stream/ops` instead. This is inherited from the
  pre-push leak-scan history rewrite, not from this cycle.
- Reviewer hardening warnings above: consider wrapping the first `tick()` so `clockPaused`/`phase`
  reset unconditionally, settling `lastTickAt` before the wait, registering
  `PI_AUTONOMY_GATE_SLOTS` in the autonomy-run extension manifest so the generated env table lists
  it, and adding a three-Engine end-to-end overlap test.
- Carried from the handoff: **PG-46** (stop returning before `reviewCycle` on a red gate, keep
  `merge:false`, put the verdict and concerns into `mergeReason`) and **V-04** (workflow/unification
  doc sweep, proposal `autonomy/proposals/V-04-unify-workflows.md`).
- Pre-existing flake recorded in `autonomy/proposals/luna-ops-01-08-flaky-resume-checkout.md`:
  `tests/workflow-resume-smoke.ts` "a stopped run's writer leaves the checkout queue" is
  timing-shaped and fails on the clean base.
