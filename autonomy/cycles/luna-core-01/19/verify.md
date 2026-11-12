# Cycle 19 verification — `luna-core-01`, stream `core`

Base `75e072404559`, head at record time. Diff (package-lock and the cycle/run records excluded):
**30,280 chars**, 16 files, +240/−81 — under the 30,000 "stop taking items" mark and well under the
60,000 read cap. No `.github/`, `package-lock.json`, `package.json` `scripts`, protected identity or
`autonomy/CHARTER.md` change. `npm test` and `npm run check:all` were never run.

## Item 1 — gate fix (`e54833e`), carried sub-items 1–2 (`4d67d2d`,`a78495a`,`e62c24c`)

- `npm run verify` — **PASS** (exit 0, `[verify] All checks passed.`); proves `docs/reference.md` is
  byte-identical to its generator after `branding.md` joined `GENERATED` in `packages/core/reference.ts`.
- `node packages/core/reference.ts --check` — **PASS**; the `PI_SYSTEM_GIT_SOURCE` row links
  `migration.md` again.
- `npm run smoke:brand` — **PASS** (17 checks); the docs/system-surfaces scope, the mkdocs site name,
  the README title/hero and every documented identity.
- `npm run smoke:docs` — **PASS**; `docs/branding.md` is in the mkdocs nav and has no orphan/broken link.
- `npm run docs:check` — **PASS**.
- `npm run smoke:container-static` — **PASS**; the `capability.yaml`/compose display strings say Luna
  while `id: pi-system` stays.
- `npm run test:typecheck` — **PASS** (all nine tsconfig projects).
- targeted `npx eslint` on `packages/core/reference.ts` and the carried `.ts` files — **PASS**.

## Item 2 — V-10 sub-item 3 — DEFERRED, not landed

- `07a89e0` implemented the whole-repository smoke and rename; its `75e072404559..HEAD` diff was
  **83,814 chars**, over the 60,000 review cap, so the merge would be refused before review.
- `6c46845` reverts it; `git diff 0088e22 HEAD` is empty, so the tree is clean of half-applied work.
- Preserved on `origin/attempts/luna-core-01/cycle-19-subitem3` (`07a89e0`); that commit's own diff is
  ~53k, so it fits as the next cycle's single item.

## Independent review

- `subagent` reviewer on `75e072404559..HEAD` (HEAD `6c46845`): **VERDICT: PASS**. No protected
  identity changed; no operator control path touched; revert confirmed clean; diff 30,280 chars.
  Re-ran `smoke:brand`, `smoke:docs`, `docs:check`, `verify`, `test:typecheck`, `smoke:container-static` — all pass.
- Carry-over: the cycle-18 reviewer also returned **PASS** on the same sub-item 1–2 content.

## Not verified / left

- Whole-repository `smoke:brand` (sub-item 3) is not on this branch; it is on the attempt branch and
  is next cycle's item. The `.github/codeql/codeql-config.yml` rename is an operator decision
  (`autonomy/proposals/luna-core-01-19-codeql-config-name.md`).
