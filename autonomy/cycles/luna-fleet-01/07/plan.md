# Cycle 07 plan — luna-fleet-01

Mode: **improve**. Item: **A-92**, split into two commits. O-01 remains open/blocked on its
PG-06–PG-09 surfaces and walkthrough (see `review.md`).

## Charter justification

A-92 is an assigned P0 board item for this stream and its acceptance is unmet. The change
strengthens the control plane rather than weakening a check: the board lock makes ownership
atomic instead of racy, and a dispatch run can only work an item it actually claimed. No test is
removed or relaxed and no control path outside the fleet stream is touched.

## Change 1 — atomic board claim (A-92b)

Files:

- `packages/autonomy/lib/board.ts`: export `ITEM_KEYS`; extend `BoardItem` with `assignee`,
  `claimedAt`, `submittedAt`, `sha`, `rounds`, `verdict`, `verdictBy`, `findings`; validate them
  strictly without materialising defaults; add a pure `claimBoardItem()` and a
  `claimNextItem()` selector that skips blocked and already-owned items.
- `packages/autonomy/cli.ts`: add `board claim <id> --run <id> --by <agent>` under a board lock
  (`control/board.lock`) using `createRunLock`; refusal carries the current owner. Put the
  existing `board --file` write under the same lock. Allow the command for `self-improve` and
  `dispatch`.
- `packages/autonomy/lib/runlock.ts` only if a small board-lock wrapper is needed; no change to
  supervisor semantics.
- `tests/autonomy-dispatch-smoke.ts` (new): two real child processes claim the same item under
  the real lock; exactly one wins, the loser reports the winner as owner; the item has
  `assignee`/`claimedAt` and `status: in_progress` in one write; no lock/temp files remain.
  Also cover idempotent re-claim, blocked item, missing item and extended-key validation.
- `docs/autonomy.md`: document the claim command, the new fields, lock/refusal semantics and the
  test that pins them.
- No `package.json` `scripts` change (a cycle touching them is refused at merge); the new test
  runs as `node tests/autonomy-dispatch-smoke.ts`.

Proving checks: `node tests/autonomy-dispatch-smoke.ts`, `npm run smoke:autonomy-cli`,
`npm run smoke:autonomy-contract`, `npm run test:typecheck`, `npm run test:lint`.

## Change 2 — dispatch template (A-92a)

Files:

- `packages/autonomy/lib/templates/dispatch.ts` (new): a thin variant of the self-improve cycle
  machinery. Per new cycle it reads the contract's board file, claims the top ready item for one
  of the contract's streams under the board lock, snapshots only that item into
  `state.selfImprove.current.board`, and finalises as exhausted when nothing is ready. A resumed
  cycle keeps its snapshot and does not re-claim.
- `packages/autonomy/lib/templates/self-improve.ts`: add a small variant seam (prepare hook and
  board section) so dispatch reuses seeding, cycles, recovery, review, acceptance and promotion;
  default self-improve behaviour is unchanged.
- `packages/autonomy/lib/templates/index.ts`: register `dispatch`.
- `packages/autonomy/lib/contract.ts`: optional `inputs.board` (path resolved against the
  contract's directory) and `inputs.streams` (bounded unique non-empty names); require
  `inputs.board` for dispatch; filesystem existence check.
- `packages/autonomy/schema/run-contract.schema.json`: template enum, `inputs.board`,
  `inputs.streams`.
- `packages/autonomy/lib/lifecycle.ts`: optional dispatch claim snapshot in
  `SelfImproveState.current`.
- `tests/autonomy-dispatch-smoke.ts`: extend with a fake-runtime run whose written contract names
  the stream and engineers, whose first cycle prompt carries the claimed item's title, detail and
  acceptance (and not the second item), whose second cycle claims the next item, and whose manager
  review sees only the claim. Add plan/start acceptance and the missing-board failure.
- CLI/contract smoke expectations for the new template id.
- `docs/autonomy.md`: template row and dispatch semantics with the pinning test.

Proving checks: `node tests/autonomy-dispatch-smoke.ts`, `npm run smoke:autonomy-selfimprove`,
`npm run smoke:autonomy-cli`, `npm run smoke:autonomy-command`,
`npm run smoke:autonomy-contract`, `npm run test:typecheck`, `npm run test:lint`.

## Budget and stop rules

- Work items in the order above. Do not start change 2 until change 1 is committed and green.
- Commit and push each logical change. Measure `git diff --stat c8b2179bb698..HEAD` after each
  commit; stop taking new items once the reviewable diff passes 30,000 characters, and never let
  it pass 60,000.
- No `npm test`, no `npm run check:all`; targeted smokes only.
- Verify with `verify_completion` after both changes or after change 1 if change 2 is dropped.
