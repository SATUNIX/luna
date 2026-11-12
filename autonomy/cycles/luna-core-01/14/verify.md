# Cycle 14 verify — `luna-core-01`, stream `core`

- `npm run smoke:compress` — PASS — `compress-smoke: 10/10 passed` (new `testEmptyTurnsStillSummarises`).
- `npm run smoke:eval-footprint` — PASS — `[eval-footprint-smoke] all 13 checks passed` (new malformed-baseline checks).
- `npm run test:typecheck` — PASS — every tsconfig project compiled, no diagnostics.
- `npm run docs:check` — PASS — `OK: nav entries exist and internal links resolve.`
- `npm run smoke:docs` — PASS — `[docs-smoke] OK: ...`.
- Independent reviewer on `68d70c78940c..HEAD` — PASS — both defects reproduce on the base, the new
  tests fail without the fixes, and no control path, dependency, `any` or unrelated file changed.
- `git diff 68d70c78940c..HEAD` (records excluded) = 5884 chars, well under the 60000 review budget.
