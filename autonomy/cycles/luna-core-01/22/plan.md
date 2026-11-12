# Cycle 22 plan — `luna-core-01`, stream `core`

Mode: improve. One item: finish V-10 by landing its reviewed sub-item 3b and fixing the journal
gate that rejected cycle 21.

## Item 1 — V-10 sub-item 3b: whole-repository brand smoke (cherry-pick `f7554ce` + `bed0c65`)
- **Justification:** V-10 [P1] board item; charter priority 2. Cycle 21 implemented the change and
  was rejected only because its own records broke `smoke:docs` (review finding 2), so the work is
  sound and unmerged.
- **Change:** cherry-pick the two code/docs commits unchanged; no edit to `tests/brand-smoke.ts`,
  `docs/branding.md` or `CHANGELOG.md` beyond them.
- **Acceptance evidence:** `npm run smoke:brand` (18/18, whole-repo walk), `npm run smoke:docs`
  (journal gate green), `npm run test:typecheck`, `npx eslint tests/brand-smoke.ts`.
- **Journal fix:** add `- luna-core-01/22 | Board: V-10 | ...` in the same commit that writes
  `report.md`, then re-run `smoke:docs`, so the gate is green on a clean checkout and the rejection
  cause cannot recur.

## Checks
Run only the targeted smokes above. Never run `npm test` or `npm run check:all` (the host gate does).
`node packages/core/paperwork-budget.ts autonomy/cycles/luna-core-01/22 --journal=autonomy/JOURNAL.md
--run=luna-core-01 --cycle=22` to keep the records within 60 lines and one journal line.
