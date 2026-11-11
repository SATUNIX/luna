# Report — cycle 06, run `luna-core-01`, stream `core`

Outcome: **successful**
Mode: **improve** (PG-27) + **consolidate** (cycle 05's `trunk` channel)

Base `ce87a25c92de`; commits `70bd6d1` (records), `9139ad6`, `5fe9e95`. Reviewable diff 37,823 chars
(records and lockfile excluded), under the 60,000 read budget and past the 30,000 stop-new-items
mark, so this cycle stopped after two items.

Workflow: refused effort child-budget — the gated `workflow_run` plan for Item 2 was refused
("up to 2 more would fit this request"); the `subagent` implementer ran, the follow-up `subagent`
reviewer was then denied ("child invocations for this request are used up (3/3)"), so Item 2 is
covered by the coordinator's own charter inspection plus every targeted check (see `verify.md`).

## Board

Board: PG-10 done - no work needed; the opt-in `trunk` git channel and its `smoke:kit-update-channel`
were already merged into the base by cycle 05.
Board: PG-27 done - added `packages/core/eval/baseline.ts` (`--write` a dated
`baselines/YYYY-MM-DD.json` with success rate, per-category stats and an offline chars/4 `tokens`
estimate; `--check` fails closed on none/malformed/older-than-7-days), committed the first baseline
`2026-11-11.json`, and pinned it with `tests/eval-baseline-smoke.ts` + `smoke:eval-baseline`.

## Items

Item: PG-27 dated offline eval baseline and 7-day freshness check - `9139ad6` -
`node tests/eval-baseline-smoke.ts` (4 checks: --write shape/date/17-17/per-category/tokens, empty
and stale --check, the exact-7-day boundary plus newest-selection and malformed fail-closed, and the
pure summariser/token estimator); independent `reviewer` subagent returned `VERDICT: PASS`.
Item: Consolidate cycle 05's `trunk` channel: document it in the four prose enumerations and refuse
the git-only channel on npm delivery - `5fe9e95` - `npm run smoke:kit-update-channel` (7 checks,
including the new npm + `trunk` refusal and the npm pinned note no longer advertising `trunk`);
`npm run smoke:kit-update` (40), `npm run smoke:distribution` (14), `node tests/docs-smoke.ts`.

## Test justification

No existing test was weakened. `tests/eval-baseline-smoke.ts` is new and
`"smoke:eval-baseline": "node tests/eval-baseline-smoke.ts"` is the only `package.json` change (the
one allowed script addition; the wiring check requires it). `tests/kit-update-channel-smoke.ts`
gained one case; its six earlier checks are untouched. `packages/core/install.ts`'s npm/`trunk`
guard is only reachable once `npm.enabled` ships, so it is covered by inspection; the reachable
`kit-update` npm-switch refusal is tested.

## Left for next cycle

1. The `install.ts` npm/`trunk` guard is untested because the shipped `distribution.json` has no
   `npm.enabled`; when npm delivery is enabled, add a test that the guard fires. The rest of
   `autonomy/proposals/luna-core-01-05-npm-trunk-channel.md` is now implemented (docs enumerations,
   npm pinned notes, npm switch refusal) and can be closed.
2. Cycle 03's env-ownership work still lives only on `origin/attempts/luna-core-01/cycle-03`.
3. Proposal `luna-core-01-03-codeowners-dead-path.md` (`.github/CODEOWNERS` names a path with 0
   tracked files) remains an operator decision; `.github/` is a control path.
4. Defect IDs V-07/V-08/V-10 still have no in-tree finding list; the operator's list is needed.
5. The `coverage` CI job red owner-side is untouched per the steward.
