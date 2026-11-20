# Proposal — scope cycle record directories to the run incarnation (DE-121)

Raised in cycle 2 of `luna-fleet-01` because the fix cannot merge unattended. Cycle 1 of this run
(`origin/attempts/luna-fleet-01/cycle-01`, `cd514f55` + `2c38c150`) implemented exactly this and
was refused before review: the diff changed
`packages/autonomy/lib/templates/self-improve.ts`, which `packages/autonomy/lib/risk.ts` classifies
R3. The steward board item says to keep the work out of that file. The same is true of the other
two files the fix must touch (`review.ts`, `hostrepo.ts`, both R3), so no part of the behavioural
change can land through an unattended cycle. The owner/steward route applies.

## Finding

A run name is not an identity. A run deleted and recreated keeps the same `<run>` directory under
the state home, so its cycle numbers restart at 01, while the integration branch still holds the
earlier incarnation's `autonomy/cycles/<run>/<NN>/` records.

Evidence: `autonomy/proposals/luna-ux-01-20-stale-cycle-record-dirs.md` (cycle 19 of `luna-ux-01`
was rejected because the attached `autonomy/cycles/luna-ux-01/19/verify.md` came from an earlier
lineage and named commits the host ledger did not contain). The host attaches records it reads from
the cycle directory: `packages/autonomy/lib/templates/self-improve.ts:1174` (`verify: at(\`${dir}/verify.md\`)`),
`1118` (`workerReport`) and `924` (`report`) — all built from
`cycleDir = autonomy/cycles/${cfg.run}/${pad(n)}` (`self-improve.ts:391`). Merge review excludes
records by the run-wide prefix `autonomy/cycles/<run>/` (`review.ts:50`), so it covers every
incarnation.

## Fix (the design cycle 1 validated)

1. `RunState` gains `incarnation?: string`; `newState()` fills it with
   `randomBytes(8).toString("hex")` (`packages/autonomy/lib/lifecycle.ts`, R2).
2. New `packages/autonomy/lib/cyclerecord.ts` (R2) exposes
   `recordIncarnation(state)` (returns the id only when it matches `/^[0-9a-f]{8,64}$/`, else
   `null`) and `cycleRecordDir(state, run, n)` → `autonomy/cycles/<run>/<id>/<NN>`, falling back to
   the historical `autonomy/cycles/<run>/<NN>` for a legacy state.
3. `cycleDir` in `templates/self-improve.ts` takes the state and delegates to `cycleRecordDir`;
   the three read sites above and the `dir` passed to `runCycle` use it.
4. `reviewRecordDirectories` (`review.ts:49`) scopes the prefix by the incarnation when the scope
   carries one, and `hostrepo`'s `fileAt` callers pass it, so the merge review does not attach an
   earlier incarnation's records.

Cycle 1 additionally made a hand-edited, invalid `incarnation` id fall back to the legacy path
instead of failing closed; the accepted review listed that as a non-blocking warning. Failing
closed (refuse to start/resume a state whose id is present but invalid) is the safer variant.

## Suggested acceptance

Port `cd514f55` and `2c38c150` from `origin/attempts/luna-fleet-01/cycle-01`, then add one smoke
that creates a run, records a cycle directory for cycle 01, deletes and recreates the run at the
same cycle number, and asserts the new incarnation's record path differs and the merge review
does not attach the old `report.md`/`verify.md`. That smoke must fail on the current unscoped path.
Run `node tests/autonomy-selfimprove-smoke.ts`, `node tests/autonomy-review-inputs-smoke.ts`,
`node tests/docs-smoke.ts`, `npm run test:typecheck` and `npm run test:lint`.

## Why not delete the stale directories instead

Deleting another lineage's committed records from the integration branch is a bookkeeping decision
for the operator (option 2 in the `luna-ux-01` proposal), not something an unattended cycle should
do to history it did not write. Scoping the path keeps the old records addressable.
