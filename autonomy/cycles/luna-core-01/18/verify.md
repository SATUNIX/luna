# Cycle 18 verify — `luna-core-01`, stream `core`
Base `75e072404559`; head `dd49bcb` (item 2). Mode: improve. Diff (records excluded) 29,220 chars
over 13 files, +201/−79.
- `npm run smoke:brand` — **PASS** 17/17: walks the system-surfaces scope, skips
  `node_modules/.git/dist/site/.pi/autonomy/package-lock.json`, strips `ALLOWED` per line, reports
  `file:line`.
- Regression probe — **FAIL as required**: `docs/__brand_probe.md` with `Pi System is here.` makes
  `smoke:brand` exit 1 printing `docs/__brand_probe.md:1: Pi System is here.`; probe removed.
- `smoke:container-static` **PASS**; `smoke:scan-coverage` **PASS** 2/2; `smoke:compose-policy`
  **PASS**; `smoke:docs` **PASS**; `test:typecheck` **PASS**; targeted eslint on
  `tests/brand-smoke.ts` and `governance/index.ts` **PASS**. Never ran `npm test` or `check:all`.
- Independent reviewer on `75e072404559..HEAD`: **VERDICT: PASS** (five points checked; no
  must-fix). Non-blocking: `capability.yaml` `source.repo` is inert metadata, and the
  `validate-compose.sh` failure text is generic (assertion unchanged).
- Scope: no `.github/`, `package-lock.json`, `autonomy/CHARTER.md`, `package.json` `scripts`,
  dependency, identity regex, `distribution.json` or CHANGELOG-history change; the smoke is
  strictly stronger than the old backtick-only scan. Item 1 `684f54b`, item 2 `dd49bcb`.
