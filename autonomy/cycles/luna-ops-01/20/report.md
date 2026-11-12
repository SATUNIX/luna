Outcome: successful
Mode: fix
Board: PG-52 done - `--for-changed` now plans both sides of the subagent/fence byte-copy pair, a changed test file's own check, and drops the contradictory plan-mode skip line; the promotable re-land line is clean across `a7cb461f..b859d1e`
Item: PG-52 plan copy-pair sources and changed test files in --for-changed - ad74513 (run branch) / b859d1e (re-land) - `smoke:autonomy-selfimprove` 41/41 + the four manual `--for-changed` fixtures in verify.md
Item: PG-52 clean re-land of cycles 19-20 onto origin/stream/ops - 03c5305, b859d1e - `node packages/core/prepush-scan.ts range --base a7cb461 a7cb461..b859d1e` -> 6 commits checked, clean

# Cycle 20 — consolidate the cycle-19 verify map and rebuild a clean re-land

## What changed

Cycle 19's PG-52 landed the glob→checks map, but three of its own gaps stayed red until the gate.
This cycle (fix mode, consolidation) is entirely in the new code:

- `packages/core/lib/check-map.ts` — added the missing rows: both sources of the
  `subagent/fence.ts` byte-copy pair (`packages/extensions/src/secret-guard/**` →
  `smoke:secret-guard` + `smoke:workflow-notify`, `packages/autonomy/lib/templates/common.ts` →
  `smoke:workflow-notify`) and a changed test file (`tests/**-smoke.ts` → its `smoke:*` check). The
  table is unioned with `scriptTargets` from `packages/core/lib/wiring.ts`, so a check the wiring
  already pins is never skipped.
- `packages/core/check-all.ts` — `checksForChangedPaths`/`verifyPlan` take an optional `scripts`
  parameter; `checkNames(root, announce)` announces the `skipping test:security` line once and only
  on a real `runAll`, so plan mode (`--for-changed`) prints no contradictory line.
- `tests/autonomy-selfimprove-smoke.ts`, `tests/check-all-npm-smoke.ts` — pin the new cases.
- `docs/ARCHITECTURE.md`, `docs/ci-security.md`, `prompts/cycle.md`,
  `lib/templates/self-improve.ts` — describe the derived plan.

## Operator instruction 2026-11-12T03:15Z — publish was blocked

The publish kept failing on the same commit because `3c7c8ae` (a subject with the retired
single-letter board id) is only
in the local branch, not on `origin/stream/ops` (`a7cb461f`), so the scan range kept including it.
Constraint: no force-push, no ref deletion, no `denyNonFastForwards` lift, no `--no-verify`. Rebuild
was done exactly as cycles 12/18 did:

- `pi/luna-ops-01-reland` (`15e5068`, tree = cycle-18 head) advanced with cycle-19 (`03c5305`) and
  cycle-20 (`b859d1e`) snapshot commits whose messages cite only `PG-52`/`PG-60`; no old-shape id in
  any subject or body. This is a fast-forward of the re-land ref; the run branch is untouched.
- `prepush-scan range --base a7cb461 a7cb461..b859d1e` → **6 commits checked, no blocked
  identifiers or private paths** (exit 0). `3c7c8ae` is not in the range.
- The run branch `pi/luna-ops-01` stays non-promotable; the integrator fast-forwards `stream/ops`
  from `pi/luna-ops-01-reland`. The 17:02Z `could not complete` failure did not recur; it is logged
  in `verify.md` as a distinct defect.
- The operator removed an empty hold file; no reason is recorded in the repository, so this report
  treats the removal as deliberate and does not restore it.

## Verification

Targeted checks only (never `npm test` / `npm run check:all`): `smoke:autonomy-selfimprove` 41/41,
`smoke:check-all-npm`, `smoke:docs`, `smoke:autonomy` 32/32, `smoke:autonomy-run` 15/15, `docs:check`,
`test:typecheck`, `test:lint`, `verify` — all PASS. Manual fixtures prove the three gaps are closed
(see `verify.md`). An independent reviewer returned PASS. Cycle diff 18154 chars; re-land diff 46585
chars, both under budget.

## Left / next cycle should know

- No control-path change, no `package.json` script change, no charter change; `--for-changed`
  remains opt-in.
- The re-land is the promotion vehicle: fast-forward `stream/ops` from `origin/pi/luna-ops-01-reland`
  (`b859d1e`), never from `origin/pi/luna-ops-01`.
- No new proposal this cycle.
