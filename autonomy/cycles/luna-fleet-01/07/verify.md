# Cycle 07 verification — luna-fleet-01

Mode: **improve**. Item: **A-92**, delivered as A-92b (atomic board claim). A-92a (dispatch
template) was not started: after the claim commit the reviewable diff was 37,570 characters,
already past the 30,000-character new-item stop. A-92 therefore remains `progress`, not `done`.

## Targeted checks (no `npm test`, no `npm run check:all`)

| Command | Result |
|---|---|
| `node tests/autonomy-dispatch-smoke.ts` | PASS, 5/5 checks |
| `npm run smoke:autonomy-cli` | PASS, 16/16 checks (also spawns the dispatch suite) |
| `node tests/wiring-smoke.ts` | PASS, 8/8 checks; 217 test files, 4 indirect/manual with reasons |
| `node tests/docs-smoke.ts` | PASS; 14 commands, 62 links, 97 pages |
| `npm run smoke:autonomy-contract` | PASS, 16/16 checks |
| `npm run smoke:autonomy-selfimprove` | PASS, 42/42 checks |
| `npm run smoke:autonomy-command` | PASS, 11/11 checks |
| `npx tsc -p packages/autonomy/tsconfig.json` | PASS |
| `npx tsc -p packages/core/tsconfig.json` | PASS |
| `npx tsc -p tests/tsconfig.json` | PASS |
| `npx eslint --flag unstable_native_nodejs_ts_config --max-warnings 0` on changed TS | PASS |

The new suite proves two **real child processes** racing `board claim V-01` under
`control/board.lock`: exactly one winner, the loser exits 3 with `refused` and the winner's
`assignee`/`claimedAt`, the item has `assignee`/`claimedAt`/`status: in_progress` in the single
write, same-agent re-claim is idempotent, and no lock/temp file remains. It also holds the real
lock and proves both `board claim` and `board --file` wait; strict extended-metadata validation,
blocked/missing/ownerless-in-progress refusal and the non-board-template refusal are covered.

## Wiring repair

The first review failed because the new suite was not wired. A cycle may not change `package.json`
scripts, so `tests/autonomy-cli-smoke.ts` now unconditionally spawns
`tests/autonomy-dispatch-smoke.ts` and fails on a non-zero exit, and `MANUAL_ONLY` records it as an
indirect wire with that reason. `wiring-smoke` passes; the reviewer confirmed the runner really
executes the suite.

## Independent review

Final reviewer verdict: **PASS**. Files reviewed and command results are recorded in the workflow
run; no critical findings. Remaining warnings are test-robustness (fixed 300 ms contention window)
and record-keeping (A-92a carry-over), not blockers. No test or control was weakened, and the
diff touches no `package.json`, lockfile, `autonomy/CHARTER.md`, operator control path or
`autonomy/BACKLOG.md`.

## Diff and scope

Reviewable diff `c8b2179bb698..HEAD`, excluding the lockfile and cycle/run records: **40,478
characters**, under the 60,000 review limit and above the 30,000 new-item stop. Changed files:
cycle review/plan, `docs/autonomy.md`, `packages/autonomy/lib/board.ts`,
`packages/autonomy/cli.ts`, `packages/core/lib/wiring.ts`, `tests/autonomy-cli-smoke.ts` and the new
`tests/autonomy-dispatch-smoke.ts`.

## Carried forward

- A-92a: `dispatch` template with contract `inputs.board`/`inputs.streams`, one-claimed-item cycle
  prompt and plan/start test. The claim primitive it needs is now in place.
- A-92 warning: replace the fixed 300 ms lock-contention window with a child-ready signal.
- O-01: PG-06 (host event log), PG-07 (live `/autonomy` widget), PG-08 (console panel), PG-09 (owner
  inbox) and the recorded non-Claude walkthrough.
