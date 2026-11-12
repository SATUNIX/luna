# Cycle 10 verification

Base `4d795fe3ec5c`, head after Item 2 `1971758` (records commit follows). All commands run in
`/work`; `npm test` and `npm run check:all` were never run. Each line names the command, the result
and the assertion that proves the change.

## Item 1 — PG-50 gate-slot completion (commit 68b6f57)

- `npm run test:typecheck` — PASS — `tsc` over the root, core, autonomy and tests projects; no errors.
- `npm run test:lint` — PASS — `eslint --max-warnings 0 .`; no errors.
- `npm run -s smoke:autonomy-selfimprove` — PASS, 40 checks — new check "three supervisors with N=2
  never overlap more than two gates; the third waits in gate-wait then runs" proves `live === 2`,
  `maxOverlap === 2`, the third engine's `state.phase === "gate-wait"` and its `heartbeat.json`
  phase, then that releasing one slot starts the third while `maxOverlap` stays 2; new check "a
  throwing gate restores the previous phase and clears clockPaused; a lost lock throws without
  pausing" proves `clockPaused === false` and `state.phase === "work"` after a throw and after
  `LockLost`; corrected check "a waiting engine heartbeats gate-wait, freezes wall-clock minutes
  and resumes into acceptance" now asserts the active 30 s before the wait is charged
  (`minutesBefore + 0.5`) while the 60 s wait is not.
- `npm run -s smoke:autonomy-lifecycle` — PASS, 23 checks — new check "a non-contention flock
  failure rejects loudly instead of polling forever" stubs a `flock` that prints `Permission denied`
  and exits 1, and asserts the acquisition rejects with that text within 2 s instead of timing out;
  the existing parse, two-at-once, `0`-unbounded, killed-holder and missing-binary checks still pass.
- `npm run -s smoke:autonomy-run` — PASS, 15 checks — the autonomy-run extension still loads and
  runs with `PI_AUTONOMY_GATE_SLOTS` declared in its manifest `env`.
- `node packages/core/reference.ts --check` — PASS — `OK: up to date`; `docs/reference.md` lists
  `PI_AUTONOMY_GATE_SLOTS` (regenerated once from the manifest).
- `npm run -s smoke:docs` — PASS — 14 documented commands, 62 links, and the journal/reference
  checks over the tree.

## Item 2 — PG-46 red-gate review carry-over (commit 1971758)

- `npm run test:typecheck` — PASS — as above, after the `review.ts`/`self-improve.ts` changes.
- `npm run test:lint` — PASS — as above.
- `npm run -s smoke:autonomy-selfimprove` — PASS, 40 checks — the "a red cycle is not merged" check
  now asserts `c1.merged === false` with `c1.review === "MERGE"` (a MERGE verdict cannot waive the
  gate), that `c1.mergeReason` is `acceptance checks failed (gate); review MERGE: ...`, that the
  reviewer's system prompt says `acceptance checks FAILED: gate` and its bundle says `Gate RED
  (gate)`, and that cycle 2's prompt carries the merged reason and the attempt branch; the "partial
  green committed work" check still proves a host-closed red partial cycle gets no reviewer call.
- `npm run -s smoke:autonomy-review-inputs` — PASS, 21 checks — the host-side review inputs and
  budget checks are unchanged.
- `npm run -s smoke:autonomy` — PASS, 32 checks — the task review path is untouched.
- `npm run -s smoke:autonomy-run` — PASS, 15 checks — as above.
- `npm run -s smoke:docs` — PASS — the reworded `docs/autonomy.md` merge-review paragraph resolves
  and names the tests.

## Independent review

A reviewer subagent that did not write the change read `git diff 4d795fe3ec5c..HEAD` (lockfiles and
the cycle/run record directories excluded) and returned `VERDICT: PASS` for both items, with no
critical defect. It confirmed: the three-supervisor test really exercises three real Engines and is
not vacuous; a throwing gate cannot leave `clockPaused`/phase stuck; a non-contention `flock`
failure fails loudly; `merge = gateGreen && verdict === "MERGE"`; host-closed never-green partial
cycles stay unreviewed; the gate note and concerns reach the next prompt; no fail-closed control is
weakened. Warnings it raised were fixed in this cycle (the malformed doc bullet was moved into the
merge-review bullet; the phase-restore assertion now uses a non-`acceptance` precondition). One
warning was noted, not fixed, to keep the reviewed diff bounded: a completed red cycle with
`integration.review: false` has no dedicated test (the partial-red path is covered); the branch is
`merge: false` by inspection at `self-improve.ts` review-disabled path.
