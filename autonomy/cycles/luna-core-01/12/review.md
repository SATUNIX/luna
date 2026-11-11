# Review — cycle 12, run `luna-core-01`, stream `core`

Base `363dba0b9a25` (head of `stream/core`, holds cycles 01–11). This stream: rebrand, memory
recall, discoverability, agent efficacy and token efficiency, defects V-10/V-11/V-07/V-08.

## Assigned items checked against the code

**PG-55 (P0, first).** The cycle-10 fix is present: `packages/autonomy/lib/templates/self-improve.ts:406-407`
consumes a `publish-blocked` `pendingAnswer` before the parking guard at `:402`, and
`tests/autonomy-selfimprove-smoke.ts:670` passes (42/42). So the steward's "re-fires the guard"
description is the pre-`f24a144` state. The acceptance is still unmet: `:670-702` leaves the leak
fixture in every cycle, so publication is always refused. Nothing exercises the intended exit —
citing the operator's answer, removing the identifier, letting `publishNow`
(`self-improve.ts:233-234`) clear `publishBlocker`/`publishBlockedCycles`, and the run continuing
past the block. That positive path is exactly what the steward's acceptance names ("answering the
publish-blocked question attempts the publish and resets the streak, pinned by a smoke that answers
the question and completes a cycle"). It may hide a real defect: no test proves the streak resets
without a later cycle.

**PG-19 (P0).** No paperwork budget exists: `find . -name paperwork-budget.ts` is empty.
`node packages/core/check-all.ts --list` lists only package.json `smoke:`/`test:` scripts
(`packages/core/check-all.ts:186-210`), and a cycle adds one legitimately when it only adds a
`smoke:<name>` running `node tests/<name>-smoke.ts` (`packages/autonomy/lib/review.ts:170-187`,
`onlyAddsSmokeScripts`). Evidence of the need: cycle 11's four docs are 245 lines total
(`plan.md` 47, `report.md` 63, `review.md` 50, `verify.md` 85) against the intended 60-line cap.

**V-81 (P1).** `packages/core/eval/footprint.ts` has no CLI: the only `import.meta.url` use is the
baseline path at `:269`; no `process.argv` and no entry point. So the documented command
`node packages/core/eval/footprint.ts --profile lite --json` exits 0 with no output. The module and
baseline are otherwise complete; `tests/eval-footprint-smoke.ts` (42 checks) pins per-tool text and
the ceiling. `docs/efficiency-and-loops.md` has no Measuring section for the footprint.

## Other findings (not chosen this cycle)

- Record defect: `docs/autonomy.md:580` and `CHANGELOG.md:35` say "two consecutive merged cycles"
  while `tests/autonomy-selfimprove-smoke.ts:705-732` pins that an intervening non-merged cycle does
  not reset the count (steward backlog item 4). Priority 6.
- Cycle-08 records still attempt-only; the journal line is the documented fix (HANDOFF).
- Standing operator proposals `luna-core-01-{01,03,05,07,08}` and `-11` need no code change.

No new defect forces a P0/P1 above the assigned items. Mode: **fix** (PG-55 defect/coverage) plus
**improve** (PG-19, V-81 assigned improvements). PG-19 and V-81 each need evidence, tests and docs.

## Checks available (from `node packages/core/check-all.ts --list`)

`smoke:autonomy-selfimprove` (`tests/autonomy-selfimprove-smoke.ts`), `smoke:eval-footprint`,
`test:typecheck`, `test:lint`, and a new `smoke:paperwork-budget` for PG-19. Never run `npm test` or
`npm run check:all`.
