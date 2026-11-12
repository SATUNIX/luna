# Cycle 24 — Verify (run `luna-ux-01`, stream `ux`)

Base `5e6b7a7b0f7f`, head `d83a940`. Items: (1) `/workflows` hard clamp; (2) stale proposal 18.

## Targeted checks (final head `d83a940`)

| Command | Result | Proving line |
| --- | --- | --- |
| `npm run smoke:workflow-panel` | PASS (19 checks) | `workflow-panel-smoke: 19 checks passed` — includes `OK: height budget: a 14-run list clamps to maxLines with its bottom rule at 4-7 rows` and `OK: height budget: a save confirm clamps to maxLines with its bottom rule at 4-7 rows` |
| `npm run smoke:control-center` | PASS (45 checks) | `[control-center-smoke] all 45 checks passed` — includes `OK: a very short overlay keeps the focused row when the cursor is not in the head` |
| `npm run smoke:docs` | PASS | `[docs-smoke] OK: 14 documented commands validated, 62 relative links resolved; ...` |
| `npm run test:typecheck` | PASS | all eight `tsc -p ...` projects exit 0 (no diagnostics) |
| `npm run test:lint` | PASS | `eslint --flag unstable_native_nodejs_ts_config --max-warnings 0 .` exits 0 |

Never ran `npm test` or `npm run check:all` (host gate owns the full suite).

## Pre-fix failure evidence for the new tests

Measured with the real modules before the clamp (throwaway `/tmp/wf-edge-check.ts`):

```
list view, 14 runs: rows=4 cap=3 body=4 (+3) | rows=5 cap=4 body=4 (+2) | rows=6 cap=5 body=4 (+1) | rows=7 cap=6 body=4 (0)
save confirm, pruned run: rows=4..7 body=5 (+4/+3/+2/+1) versus caps 3..6
```

So the new 4/5/6-row list assertions and all four save-confirm assertions fail on the base code;
the clamp is what makes them pass. At 8–20 rows the clamp is a no-op (existing cycle-23 cases
unchanged and green).

## Independent review

- Item 1 (`74fa83e`, `b235a6b`): an independent `reviewer` subagent read the diff against the
  charter and plan and ended `VERDICT: PASS`. It flagged one doc wording overstatement at a
  one-line budget (choices/footer cannot always survive); `b235a6b` fixes that wording. No other
  findings.
- Whole-cycle review (item 2 plus the full diff): **not obtained**. The E3 child budget (3 of 3)
  and the planned-agent allowance were used by the earlier stalled runs; the reviewer launch was
  refused before it started. Item 2 changes only the proposal status line and the cycle records;
  it was checked against the code directly: `hub.ts:404-410` keeps the focused row and
  `tests/control-center-smoke.ts` pins it (`smoke:control-center` 45/45). The host gate and the
  merge review remain the independent check for the full diff.

## Review size

`git diff --no-renames 5e6b7a7b0f7f..HEAD` excluding lockfiles and the cycle/run records:
8411 characters (limit 60000; stop-new-work threshold 30000).

## Failures fixed during verification

- Doc wording at `docs/workflows.md` (reviewer warning): now says the bottom rule is always kept
  and neighbouring lines survive where the budget allows.
