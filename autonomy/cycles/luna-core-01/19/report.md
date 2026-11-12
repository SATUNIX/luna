# Cycle 19 report — `luna-core-01`, stream `core`

Outcome: successful (V-10 progress)
Mode: fix (red gate) then improve (assigned V-10)

Board: V-10 progress - sub-items 1-2 are landed and enforced by `npm run smoke:brand`; sub-item 3 is
implemented and preserved on `origin/attempts/luna-core-01/cycle-19-subitem3` because its own diff
exceeds the review budget for this cycle.
Board: (no other board items were in scope; V-07/V-08 still need the operator's finding list).

Item: V-10 carry sub-items 1-2 (brand smoke over docs+system surfaces, Luna display strings) - `4d67d2d`, `a78495a`, `e62c24c` - `npm run smoke:brand` (17/17), `smoke:container-static`, `smoke:docs`
Item: V-10 repair the carried red gate (generated `docs/reference.md` drift) - `e54833e` - `npm run verify` (exit 0), `node packages/core/reference.ts --check`
Item: V-10 sub-item 3 (whole-repository rebrand) - `07a89e0` implemented, `6c46845` reverted - not verified on this branch; diff 83,814 chars exceeded the cap; preserved on the attempt branch

## Item 1 — the carried red gate

Finding: on the carried cycle-18 tree `npm run verify` failed `docs/reference.md is stale`, so the
branch could not be merged. Root cause: `docs/branding.md` names `PI_SYSTEM_GIT_SOURCE`, and
`reference.ts`'s `whereEnv()` links an env var to the first docs page alphabetically that mentions
it, so the row drifted from `migration.md` to `branding.md`; `catalog` was never rerun. Fix: add
`branding.md` to `GENERATED` in `packages/core/reference.ts` (it lists names, it does not document
behaviour) and regenerate. `docs/reference.md` is byte-identical to the pre-cycle-18 content.

## Item 2 — V-10 sub-item 3 (deferred)

Finding: the board contract wants `smoke:brand` over `WORKSPACE_ROOT`, but the smoke walked a
hand-written scope and ~100 `/pi[- ]system/i` hits remained in 29 files (kit-update `/update`
labels, `session-helpers` `pi-system:` prefixes, installer banners, helper scripts, comments).
The implementation (`07a89e0`) rewrote the smoke to walk the whole tree, renamed the strings, kept
every external identity, and added two narrow allowances plus two `.github`/`.env` text kinds. It
took the cycle diff from 30,280 to 83,814 chars; a merge would be refused before review, so it was
reverted (`6c46845`) and pushed whole to the attempt branch. Next cycle can cherry-pick it as its
single item (~53k). `docs/branding.md` and the CHANGELOG did not change on this branch, so the
sub-item 3 proposal still stands.

## Verification

`verify.md`: reviewer on `75e072404559..HEAD` (`6c46845`) **VERDICT: PASS**; diff 30,280 chars over
16 files, +240/−81; no `.github/`, `package-lock.json`, `package.json` `scripts`, protected identity
or `CHARTER.md` change; revert confirmed clean by an empty `git diff 0088e22 HEAD`; `npm test` and
`npm run check:all` never run.

## Left

- Sub-item 3 on `attempts/luna-core-01/cycle-19-subitem3` (next cycle's item).
- `.github/codeql/codeql-config.yml` rename — operator decision
  (`autonomy/proposals/luna-core-01-19-codeql-config-name.md`).
- HANDOFF #10 (context-sieve framing), #11 (two one-line doc drifts) remain proposals; #1 out of
  stream; #4 test robustness only.
