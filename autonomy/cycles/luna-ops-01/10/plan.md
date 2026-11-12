# Cycle 10 plan — luna-ops-01

Mode: fix. Goal: finish PG-50 against its own acceptance text, then carry PG-46 so a red cycle's
review findings reach the next cycle. Keep the reviewed diff well under 30,000 characters.

## Item 1 — PG-50 completion: prove and harden the gate slot bound

Charter fit: the assigned P0/rank-1 item; its acceptance criterion is not yet pinned end to end,
and three review warnings are real defects in the shipped path (`engine.ts:375-393`,
`gate-slots.ts:37-88`, missing env registration). Tested, documented, host-side only; the gate
container and its checks are untouched.

Change:

1. `packages/autonomy/lib/engine.ts` `withGateSlot`: accrue the interval since the previous tick
   before pausing; put the phase change and the first `gate-wait` tick inside the `try/finally`
   so a throw cannot leave `clockPaused` true or the phase stuck.
2. `packages/autonomy/lib/gate-slots.ts`: treat a `flock` exit as contention only when its stderr
   is the lock-conflict message; any other failure rejects loudly instead of polling forever.
3. `packages/extensions/src/autonomy-run/extension.json`: declare `PI_AUTONOMY_GATE_SLOTS`, and
   regenerate `docs/reference.md` so the generated env table lists it.
4. Tests:
   - `tests/autonomy-selfimprove-smoke.ts`: three Engines sharing one `gateSlotsHome`, limit 2,
     real slots — at most two gates overlap, the third heartbeats `gate-wait`, then runs after a
     slot is freed; a gate function that throws still resets `clockPaused` and the phase; active
     minutes before the wait are charged, wait minutes are not. Update the existing gate-wait test
     for the corrected accrual.
   - `tests/autonomy-lifecycle-smoke.ts`: a failing `flock` that is not a lock conflict (a stub
     `flock` on `PATH`) rejects instead of waiting.
   - `tests/docs-smoke.ts` or the reference check: `docs/reference.md` lists the variable (the
     existing generated-page check proves it; `smoke:docs`/`verify` will see the regenerated page).

Proof: `npm run -s smoke:autonomy-selfimprove`, `smoke:autonomy-lifecycle`,
`smoke:autonomy-run`, `smoke:docs`, `node packages/core/reference.ts --check`,
`test:typecheck`, `test:lint`.

## Item 2 — PG-46 carry-over: review a red-gate cycle

Charter fit: carried HANDOFF item (precedence 3), with cycle-05's cost as evidence. The cycle is
still not merged; only the review now runs, and its verdict and concerns go into `mergeReason`
so the next prompt carries them.

Change:

1. `packages/autonomy/lib/review.ts`: `CycleReviewBundle` gains `gateGreen` (default true) and
   `gateFailing`; `buildReviewBundle` prints "Gate red (failing: ...)" and the system prompt no
   longer claims the checks already passed unconditionally.
2. `packages/autonomy/lib/templates/self-improve.ts` `mergeDecision`: stop returning before
   `reviewCycle` on a red gate; keep `merge: false` when the gate is red even if the reviewer says
   MERGE; reason becomes `acceptance checks failed; review <verdict>: <reason>. Concerns: ...`.
3. Tests in `tests/autonomy-selfimprove-smoke.ts`: the red cycle is reviewed (reviewer call
   recorded), is not merged on a MERGE verdict, and its verdict/concerns appear in the next
   cycle's prompt; the red-partial case is reviewed too. Update the existing exact-string
   assertions that pinned the old short reason.

Proof: `npm run -s smoke:autonomy-selfimprove`, `smoke:autonomy-review-inputs`, `smoke:autonomy`,
`test:typecheck`, `test:lint`.

## Order and budget

1. Item 1 through one `workflow_run` plan (implementer + gated reviewer).
2. Measure the diff; take Item 2 if still under 30,000 characters.
3. Verify with targeted smokes and a fresh whole-diff reviewer; then report, journal, handoff.
