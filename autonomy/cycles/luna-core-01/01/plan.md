# Cycle plan — luna-core-01 / 01 (continuation)

Mode: **fix**. Two items, each with a proving check. One logical change per commit.

Base: `d932d6f02e41`. The earlier attempt's two fixes are already merged at this base (see
`review.md`); this plan covers only this session's diff.

Goal: make the documented environment variables match the code in the `core` stream
(discoverability), without touching operator control paths, `.github/`, any `package.json` script,
or the charter.

## Item 1 — the guidelines env var in INSTALL.md is a no-op

- Files: `docs/INSTALL.md`, regenerated `docs/reference.md`, `tests/docs-smoke.ts`.
- Change: rename the INSTALL.md environment-table row `PI_KIT_GUIDELINES_FILE` →
  `PI_KIT_GUIDELINES_PATH` (the name `packages/extensions/src/guidelines/index.ts:37` reads and
  its manifest declares), regenerate `docs/reference.md` so the row gains its Purpose and links,
  and add a regression assertion to `tests/docs-smoke.ts`: every row in the INSTALL.md environment
  table must name an existing extension manifest whose `env[]` declares that variable. That
  assertion fails against the pre-change INSTALL.md.
- Proving checks: `npm run smoke:docs` (the new assertion), `node packages/core/reference.ts --check`
  (generated page is fresh).

## Item 2 — documented settings missing from the interface reference

- Files: `packages/extensions/src/session-helpers/extension.json`,
  `packages/extensions/src/verify-gate/extension.json`, `docs/INSTALL.md`, regenerated
  `docs/reference.md`.
- Change: declare `PI_KIT_LEAN_CTX` in session-helpers' `env[]` and
  `PI_KIT_VERIFY_PENDING_TTL_MS` in verify-gate's `env[]` (the extension that defines the TTL);
  add both rows to the INSTALL.md environment table (extension, default, purpose) so
  `docs/reference.md` shows a purpose and a link; regenerate `docs/reference.md`.
- Regression guard: the Item 1 assertion in `tests/docs-smoke.ts` already pins each new INSTALL
  row to its manifest `env[]`, so `tests/extension-manifest-hooks-smoke.ts` is not changed (its
  message claims an exact code-read set that session-helpers and verify-gate do not satisfy, and
  the new checker covers the drift).
- Proving checks: `npm run smoke:docs`, `node packages/core/reference.ts --check`.

## Checks to run (targeted only — never `npm test` / `npm run check:all`)

- `node tests/docs-smoke.ts` (script `smoke:docs`)
- `node packages/core/reference.ts --check`
- `node tests/extension-manifest-hooks-smoke.ts`

## Task graph

1. Item 1 implement + commit + push.
2. Item 2 implement + commit + push.
3. Independent review of `git diff d932d6f02e41..HEAD`; then verify/report/HANDOFF.

## Out of scope (recorded, not worked)

- Broad env-manifest drift needing an ownership rule (proposal).
- `.github/CODEOWNERS` dead path; `docs/releasing.md` version-example drift.
- The `V-*` defect IDs (no in-tree list).
