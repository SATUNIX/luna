# Cycle 08 verify — Luna ux stream

Base `a597e3bf1063`, branch `pi/luna-ux-01`. `npm test` and `npm run check:all` were not run, per
the cycle rules. Checks below were derived with
`node packages/core/check-all.ts --for-changed="$(git diff --name-only a597e3bf1063..HEAD | tr '\n' ',')"`
(plan: docs:check, smoke:command-menu, smoke:docs, smoke:new-extension, test:lint,
test:typecheck, verify — all RAN).

| Check | Status | Proof |
| --- | --- | --- |
| `node tests/command-menu-smoke.ts` | RAN PASS | `[command-menu-smoke] all 15 checks passed` (exit 0). The new case fails on the base source: `PREFIX_EXIT:1`, `FAIL: PI_KIT_ASCII=1 keeps the curated menu's location hints printable ASCII`, `1/15 FAILED`; it also fails on the label-unaware `4ff581a5` at `Plan → implement → review`. |
| `npm run -s smoke:docs` | RAN PASS | `[docs-smoke] OK: 14 documented commands validated, 62 relative links resolved; … 97 shipped pages name no removed delegation surface.` |
| `npm run -s docs:check` | RAN PASS | `[docs-nav-check] OK: nav entries exist and internal links resolve.` |
| `node tests/new-extension-smoke.ts` | RAN PASS | `new-extension smoke: OK` (exit 0). |
| `npm run -s verify` | RAN PASS | `[verify] All checks passed.` (exit 0). |
| `npm run -s test:typecheck` | RAN PASS | exit 0. |
| `npm run -s test:lint` | RAN PASS | exit 0. |
| `npx eslint` on the three touched TS files | RAN PASS | exit 0. |
| Independent reviewer (subagent) | RAN PASS | final verdict `PASS`; it reproduced the pre-fix failure, confirmed default output byte-identical, docs exact and scope clean. |

Not run, by rule: `npm test`, `npm run check:all` (host gate owns the full suite).

V-09 / V-93 re-check (board items already done on the base): the bolded
`Workflow panel height budget (2026-11-12)` entry in the subagent `SOURCE.md` names `wf-panel.ts`
and `23725c2`, and `smoke:docs` exercises the `tests/docs-smoke.ts` provenance scan; the only
hand-written hidden-character filter is `packages/core/shared/visible-text.ts`, with the generated
copies and consumers importing it (confirmed by `smoke:docs`, `verify` and the reviewer).

Diff size: `git diff --no-renames a597e3bf1063..HEAD` excluding records/lockfile = 9338 bytes
before the record commit (< 30000 stop point, < 60000 review cap).
