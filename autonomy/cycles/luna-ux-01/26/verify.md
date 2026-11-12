# Cycle 26 — Verify (run `luna-ux-01`, stream `ux`)

Base `5e0050c7a539`, head after items: `1cd4579` (records commit follows). Items: (1) deterministic
queue case in `smoke:workflow-resume`; (2) carry-over of cycle 25's two fixes.

## Targeted checks (final code head `1cd4579`)

| Command | Result | Proving line |
| --- | --- | --- |
| `taskset -c 0 node tests/workflow-resume-smoke.ts` with three `taskset -c 0 yes` hogs | PASS (41) | `workflow-resume-smoke: 41 checks passed` (before the fix: `MISS: a stopped run's writer leaves the checkout queue`, actual `undefined` vs `[[cancelled, stopped]]`) |
| `node tests/workflow-resume-smoke.ts` (idle) | PASS (41) | `workflow-resume-smoke: 41 checks passed` |
| `npm run smoke:control-center` | PASS (45) | `[control-center-smoke] all 45 checks passed` |
| `npm run smoke:workflow-panel` | PASS (20) | `workflow-panel-smoke: 20 checks passed` |
| `npm run smoke:docs` | PASS | `[docs-smoke] OK: 14 documented commands validated, 62 relative links resolved; ...` |
| `npm run test:typecheck` | PASS | eight `tsc -p ...` projects exit 0 |
| `npm run test:lint` | PASS | `eslint --flag unstable_native_nodejs_ts_config --max-warnings 0 .` exits 0 |

Never ran `npm test` or `npm run check:all`.

## Base-fail evidence

- Item 1: reproduced on the base code under load before any edit (three CPU hogs on one core):
  `MISS: a stopped run's writer leaves the checkout queue: Expected values to be strictly
  deep-equal: + undefined - [ [ 'cancelled', 'stopped' ] ]`, then
  `AssertionError: resume review regressions`. Root cause and fix in `review.md`/`plan.md`.
- Item 2: cycle 25's own verification recorded the base failures — Security page showed
  `guarded (requested balanced)` instead of `guarded`, and the `/workflows` cursor followed the
  row index (expected 2, got 1). Re-run here: `smoke:control-center` 45/45 and
  `smoke:workflow-panel` 20/20.

## Independent reviews

- Item 1, round 1: gated `workflow_run` implementer + reviewer. Reviewer returned
  `VERDICT: FAIL` — the file gate also blocked the queued run's initial fingerprint, so the case
  deadlocked (`MISS: ... timed out`). The host did **not** auto-retry on the FAIL (both steps
  reported passed), so the retry ran as a second plan.
- Item 1, round 2: implementer made the gate one-shot (only the first `add -A` after `hold`
  blocks; the queued initial fingerprint passes). Reviewer traced `wf-engine.ts` order, ran the
  case idle and under contention, and returned `VERDICT: PASS`. Warnings: the `entered` marker
  is left to the suite-wide temp cleanup (inert), and a hypothetical lock regression would hang
  rather than fail fast (pre-existing pattern).
- Whole cycle: independent `reviewer` subagent read the non-record diff and the cycle records
  against the charter, re-ran the four smokes, and returned `VERDICT: PASS`. Warnings: the test
  header's "no wall-clock dependency" wording is broader than needed because the queued run
  still passes `drainMs: 200` (a drain window, not ordering); the no-firewall Security page
  wording (`Effective: unknown` / `Requested: same as effective`) is pre-existing and pinned;
  the report/journal line were still pending at review time (added in the records commit).

## Review size

`git diff --no-renames 5e0050c7a539..HEAD` excluding lockfile and the cycle/run records:
18,442 characters at the code head (limit 60,000; stop-new-work threshold 30,000).
