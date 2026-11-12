# Cycle 23 — Verify (run `luna-ux-01`, stream `ux`)

## Targeted checks

- `npm run smoke:workflow-panel` — PASS: `workflow-panel-smoke: 17 checks passed`; the two new
  cases print `OK: height budget: a 14-run list trims to a window with its rules, footer and
  selected run` and `OK: height budget: a stop confirm keeps its question, choices and bottom rule
  at 12 and 8 rows`.
- `npm run smoke:update-notice` — PASS: `[update-notice-smoke] all 8 checks passed`.
- `npm run test:typecheck` — PASS: `tsc -p ...` for all eight projects exited 0 (no diagnostics).
- `npm run test:lint` — PASS: `eslint --flag unstable_native_nodejs_ts_config --max-warnings 0 .`
  exited 0 with no output.
- `npm run smoke:docs` — PASS: `[docs-smoke] OK: 14 documented commands validated, 62 relative
  links resolved; balanced profile resolved; 23 external lines skipped; skills catalogue visible
  4/38; 97 shipped pages name no removed delegation surface.`

## Measured before/after (real modules through `packages/core/eval/harness.ts`)

14-run list view (`body` / `frameLines`, host cap `floor(rows*0.9)`):

- rows=20: base 18/20 vs cap 18 → after 16/18 vs cap 18, footer present.
- rows=12: base 18/20 vs cap 10 → after 8/10 vs cap 10, footer present.

Run view with a stop confirm:

- rows=12: base 10/12 vs cap 10 → after 8/10 vs cap 10.
- rows=10: base 10/12 vs cap 9 → after 7/9 vs cap 9.
- rows=8: after 5/7 vs cap 7 (hint/spacer give way, question/choices/rules stay).

## Independent review

- Reviewer subagent read `git diff cf7d7865ea81..HEAD` against `autonomy/CHARTER.md` and the plan,
  reran the five permitted checks, and ended `VERDICT: PASS`. Warnings: at ≤7 terminal rows the
  fixed rules/spacer/footer still exceed the body budget (pre-existing, below the evidenced
  10–20-row range), and a save confirm surviving registry pruning would take the list branch's
  fixed count (pre-existing, unreachable in practice). Neither blocks this cycle.

## Diff

Non-record diff measured after the commits (see `report.md`); no control path, `package.json`
script or `autonomy/CHARTER.md` change.
