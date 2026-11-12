# Cycle 22 verify — `luna-core-01`, stream `core`

Base `59b2a82a7b9a`. Diff under review: `e19f880` + `1acb83c` (V-10 sub-item 3b, cherry-picked from
cycle 21) + `0dec2ed` (review/plan records). Git diff excluding lockfile and records: well under
the 30,000/60,000 caps (measured ~13,094 chars before the records).

## Test runs
- `npm run smoke:brand` — **PASS** — `[brand-smoke] all 18 checks passed`; walks `WORKSPACE_ROOT`,
  `scanned.length > 100`, includes `packages/core/install.ts`.
- `npm run smoke:docs` — **PASS** — `[docs-smoke] OK: 14 documented commands validated, 62 relative
  links resolved; ... 97 shipped pages name no removed delegation surface.` (green before and after
  the cycle-22 records; the journal line is added in the report commit).
- `npm run test:typecheck` — **PASS** — exit 0 across all eight tsconfigs.
- `npx eslint tests/brand-smoke.ts` — **PASS** — exit 0.
- Regression probe (reviewer) — **FAIL as required** — `packages/core/__brand_probe.ts`
  (`Pi System is here.`) made `smoke:brand` exit 1 printing
  `packages/core/__brand_probe.ts:1:`; probe deleted, tree clean.

## Independent review
Reviewer subagent that did not write the change: **VERDICT: PASS** — "all six review actions
verified, both smokes green, and the wider walker fails on an independent `pi-system` probe while
the tree stays clean." No critical or blocking warnings (two cosmetic wording notes only).

## Acceptance against V-10
- `smoke:brand` passes over the whole repo: yes.
- `docs/branding.md` exists, is in `mkdocs.yml` nav, lists every category (npm name, bin names, env
  vars, install paths, symbol/urn ids, previous/legacy sources, CHANGELOG, legacy-source tests) plus
  the rename proposal: yes.
- `mkdocs.yml` `site_name: Luna`, README `# Luna` + Luna hero alt, AGENTS.md and CLAUDE.md say Luna,
  root `package.json` name still `@satunix/pi-system`: yes, pinned by `smoke:brand`.
- No `package.json` scripts, `package-lock.json`, `.github/` or `autonomy/CHARTER.md` touched.
- `node packages/core/check-all.ts` is left to the host gate per this cycle's rules.
