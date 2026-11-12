# Cycle 28 verify — luna-core-01

Base `ee45b3cc3636`. Everything below was run on the branch head. The host gate runs the full
suite on a clean checkout; these are the targeted checks only.

- `npm run smoke:autonomy-selfimprove` — **PASS** — `[autonomy-selfimprove-smoke] all 45 checks passed`
  (was 44 on the base). New check: `OK: a session that records an over-budget report and then dies
  is refused by its own pre-report check, never merged`; asserts `outcome === "partial"`,
  `reason` = `refused_budget: the diff this cycle would submit is <n> characters, over the merge
  review's budget of 60000 characters`, `merged === false`, and zero merge-review model calls.
  Falsification: removing the two `budgetRefusal()` calls makes `close("completed","report
  recorded")` run, so `outcome` is `completed` and the assertion fails.
- `npm run smoke:memory-vault` — **PASS** — `[memory-vault-smoke] all 16 checks passed` (unchanged;
  Item B was not landed, see report.md left-overs).
- `npm run test:typecheck` — **PASS** — exit 0, all eight tsconfig projects.
- `npx eslint packages/autonomy/lib/cycle.ts tests/autonomy-selfimprove-smoke.ts` — **PASS** — exit 0.
- `npm run smoke:docs` — **PASS** — `14 documented commands validated, 62 relative links resolved;
  balanced profile resolved; 23 external lines skipped; skills catalogue visible 4/38`.

Diff budget: `git diff --no-renames ee45b3cc3636..HEAD -- . ":(exclude)package-lock.json"
":(exclude)autonomy/cycles/luna-core-01/" ":(exclude)autonomy/runs/luna-core-01/" | wc -c`
measured 7,208 chars before the cycle-28 records/proposals; well under the 60,000 review budget.
