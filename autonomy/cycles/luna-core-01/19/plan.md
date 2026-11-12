# Cycle 19 plan — `luna-core-01`, stream `core`
Mode: fix (red gate) then improve (assigned V-10). Base `75e072404559`.

## Item 1 — repair the carried cycle-18 red gate (`V-10`)
Bring the sound sub-items 1–2 over by cherry-pick, then fix `verify`. Finding: `docs/branding.md`
names `PI_SYSTEM_GIT_SOURCE`, and `reference.ts`'s `whereEnv()` is a first-page-alphabetical search,
so the generated `docs/reference.md` row drifted to `branding.md` and `verify` failed stale.
Change: add `branding.md` to the `GENERATED` inventory set in `packages/core/reference.ts` (it lists
names, it does not document behaviour) and regenerate. Checks: `npm run verify`, `smoke:brand`.
Status: done (`e54833e`).

## Item 2 — V-10 sub-item 3: whole-repository rebrand (`V-10`) — DEFERRED

Status: implemented (`07a89e0`) but **not landed**. The commit took the review diff from 30,280 to
83,814 chars, over the 60,000 hard read budget, so a merge would be refused before review. It was
reverted (`6c46845`) and preserved whole on `origin/attempts/luna-core-01/cycle-19-subitem3`; the
next cycle can cherry-pick it as its single item (that diff alone is ~53k, under the cap).

Intended change (as implemented on the branch):
- Widen `tests/brand-smoke.ts` to walk `WORKSPACE_ROOT` (same text-file predicate), skipping
  `node_modules`, `.git`, `dist`, `site`, `.pi`, the top-level `autonomy/` records (but not
  `packages/autonomy/`), `package-lock.json`, `CHANGELOG.md`, `docs/branding.md` and itself; keep the
  per-line `/pi[- ]system/i` match, the `ALLOWED` identity strip and the `file:line` failure. Read
  `.ps1` and `.env.example` too.
- Rename the remaining display strings and comments to Luna, including the tests that pin them, and
  update `docs/branding.md` + the CHANGELOG. Keep every external identity and identity regex.

## Not taken

`luna-core-01-18-rebrand-subitem-3.md` is superseded by the deferred commit above. HANDOFF #10/#11
remain proposals; HANDOFF #13 (this sub-item) is now implemented on the attempt branch. A
`.github/codeql/codeql-config.yml` rename proposal was added because that operator control path is
out of scope.
