Outcome: successful
Mode: fix

Cycle 1 of run `luna-core-01` (stream `core`), continuation from base `d932d6f02e41`. Two
evidenced docs-vs-code defects fixed, each with a check that fails without it. Diff 8,856 chars
for code and docs (12,082 including this cycle's proposal); limit 30,000. No operator control path, `.github/`, `package.json` script or charter changed.

Item: install page documented `PI_KIT_GUIDELINES_FILE`, which nothing reads; renamed to `PI_KIT_GUIDELINES_PATH` and pinned every INSTALL env row to a manifest `env[]` - 486d3d2 - `npm run smoke:docs` (new assertion fails on the old row: `docs/INSTALL.md lists PI_KIT_GUIDELINES_FILE for "guidelines", but its manifest env[] does not declare it`)
Item: documented settings `PI_KIT_LEAN_CTX` and `PI_KIT_VERIFY_PENDING_TTL_MS` were missing from the generated reference; declared them in their manifests and INSTALL table - a9b6f21 - `npm run smoke:docs` + `node packages/core/reference.ts --check` (both rows now appear with Purpose and link; dropping either manifest entry fails the assertion)

## What and why

- `docs/INSTALL.md` told users to set `PI_KIT_GUIDELINES_FILE`, but
  `packages/extensions/src/guidelines/index.ts` reads `PI_KIT_GUIDELINES_PATH` and the manifest
  declares only that name, so the documented setting was a no-op. Renamed the row and regenerated
  `docs/reference.md`, which also gained the row's Purpose and link. Added a `tests/docs-smoke.ts`
  assertion: every INSTALL.md environment-table row must name an existing manifest whose `env[]`
  declares that variable. That assertion fails against the pre-change INSTALL.md.
- `.env.example` and `docs/architecture/profiles-and-install.md` document `PI_KIT_LEAN_CTX` and
  `PI_KIT_VERIFY_PENDING_TTL_MS`, but no manifest declared either, so the generated
  `docs/reference.md` (built from manifest `env[]`) omitted them. Declared them in
  `session-helpers` and `verify-gate`, added both INSTALL rows, regenerated the reference; the
  Item 1 assertion now guards both rows.

## Verification

Targeted checks only: `npm run smoke:docs` PASS; `node packages/core/reference.ts --check` PASS;
`node tests/extension-manifest-hooks-smoke.ts` PASS. Independent `reviewer` over
`git diff d932d6f02e41..HEAD`: **VERDICT: PASS**. See `verify.md`.

## Leftovers / next cycle

- Broad env-manifest drift: further code-read `PI_KIT_*` vars (for example
  `PI_KIT_HUMAN_CONSOLE_TIMEOUT_MS`, `PI_KIT_VERDICT_MAX_AGE_MS`) are documented only in
  architecture pages and declared by no manifest. A general bidirectional check was judged
  infeasible in `tests/extension-manifest-hooks-smoke.ts`; the sweep needs an ownership rule.
  Proposal written: `autonomy/proposals/luna-core-01-01-env-manifest-ownership.md`.
- `.github/CODEOWNERS:43` names `/packages/core/gitlab-release.ts`, which does not exist;
  `docs/releasing.md` release examples carry older patch versions (cosmetic drift). Both outside
  the stream area / a `.github/` edit; not worked.
- The assigned defect IDs V-07/V-08/V-10/V-11 still have no in-tree finding list (`grep` over
  `docs/` and `autonomy/` finds none), so they remain unactionable without the operator's list.
