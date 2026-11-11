# Verify — cycle 12, run `luna-core-01`
`npm run smoke:autonomy-selfimprove` — PASS (43/43; new positive-exit, discarded-history, no-published-discarded-tag cases).
`npm run smoke:paperwork-budget` — PASS (5/5; 120-line failure, 40-line pass, CLI exits 1/2, one journal line).
`npm run smoke:eval-footprint` — PASS (13/13; deterministic JSON, bad args exit 2, balanced and lite byte-identical, missing baseline row fails).
`npm run test:typecheck` — PASS (all projects clean).
`npx eslint --max-warnings 0` on the changed TS files — PASS.
`npm run smoke:docs` — PASS (14 commands, 62 links; 12/12 journal/report lines valid).
`node packages/core/paperwork-budget.ts autonomy/cycles/luna-core-01/12 --journal=autonomy/JOURNAL.md --run=luna-core-01 --cycle=12` — PASS.
Reviewer on `363dba0b9a25..be8f294` found one false docs claim and four edge cases; `8a0fbe9` fixed all five and every check above was re-run green.
Never ran `npm test` or `npm run check:all`. Diff 50,945 chars, under the 60,000 read budget.
