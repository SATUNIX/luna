# Cycle 07 report — luna-fleet-01

Outcome: partial
Mode: improve

Board: O-01 blocked - owner visibility still lacks PG-06 host event log, PG-07 live /autonomy widget, PG-08 console panel, PG-09 owner inbox and the recorded non-Claude walkthrough, which do not exist in the tree; four surfaces plus an end-to-end recording exceed this cycle's budget.
Board: A-92 progress - the atomic `board claim` half (A-92b) landed with strict claim/review metadata, a real board lock shared with `board --file`, and a real-child-process race test; A-92a (dispatch template and claimed-item cycle prompt) was not started because the diff passed the 30,000-character new-item stop.

Item: Atomic steward board claim (A-92b) — `5bd9289`, `6e30118` — `node tests/autonomy-dispatch-smoke.ts` (5 checks, two real child processes racing `board claim` under `control/board.lock`) and `npm run smoke:autonomy-cli` (16 checks, which spawns that suite).

## What changed

A-92b is the ownership primitive the fleet control plane needs before dispatch can hand out
work. `packages/autonomy/lib/board.ts` now exports `ITEM_KEYS` and accepts `assignee`, `claimedAt`,
`submittedAt`, `sha`, `rounds`, `verdict`, `verdictBy` and `findings`, validating each strictly
without materialising defaults. `claimBoardItem()` is a pure one-winner claim; `claimNextItem()`
selects the first ready, unowned, non-approved item in priority order and is ready for dispatch.

`packages/autonomy/cli.ts` adds `board claim <id> --run <id> --by <agent>`. A claim and a
`board --file` replacement both serialise on `<run>/control/board.lock` through `createRunLock`, so
two agents produce one winner; the loser exits 3 with `code: "refused"` and the winner's
`assignee`/`claimedAt`. Same-agent re-claim is idempotent, and a blocked, missing or ownerless
in-progress item is refused.

A first review failed the cycle because the new test was unwired. With `package.json` scripts off
limits, `tests/autonomy-cli-smoke.ts` now spawns `tests/autonomy-dispatch-smoke.ts` and fails on a
non-zero exit; `MANUAL_ONLY` records the indirect wire and its reason, and `wiring-smoke` passes.
The final independent reviewer verdict was PASS.

## Verification

`node tests/autonomy-dispatch-smoke.ts` (5 checks), `smoke:autonomy-cli` (16, including the spawned
suite), `smoke:autonomy-contract` (16), `smoke:autonomy-selfimprove` (42), `smoke:autonomy-command`
(11), `wiring-smoke` (8), `docs-smoke`, TypeScript for `packages/autonomy`, `packages/core` and
`tests`, and eslint on the changed TS files all pass. Full detail is in `verify.md`.

Reviewable diff `c8b2179bb698..HEAD` excluding the lockfile and cycle/run records is 40,478
characters: under the 60,000 review limit, above the 30,000 new-item stop. No `package.json`,
`autonomy/CHARTER.md`, operator control path or `autonomy/BACKLOG.md` change.

## What remains

- **A-92a**: register a `dispatch` template that reads the contract's board file, claims the top
  ready item for its stream, snapshots only that claim into the cycle prompt (title, detail,
  acceptance), does not re-claim on resume, and has plan/start plus prompt assertions in
  `tests/autonomy-dispatch-smoke.ts`. The claim primitive is now in place.
- **A-92 warning**: replace the fixed 300 ms lock-contention window in the race test with a
  child-ready signal, so a slow host cannot pass the wait assertion by accident.
- **O-01**: PG-06 host event log, PG-07 live `/autonomy` widget, PG-08 web console panel, PG-09 owner
  inbox, then the recorded non-Claude walkthrough. Cycle 08 should take these before new work.
- Carried proposal: `/workflows` control completions still offer autonomy ids that
  `workflow_control` cannot act on (`autonomy/proposals/luna-fleet-01-04-autonomy-control-ids.md`).
