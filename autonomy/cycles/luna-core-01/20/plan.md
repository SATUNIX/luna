# Cycle 20 plan — `luna-core-01`, stream `core`

Mode: **improve**; outcome: **partial**.

## Item V-10 sub-item 3a — finish the rebrand prose
Justification: ~100 hits in 29 files still say `pi-system` outside the documented identities, all user-visible or comments; the whole sub-item is 63,268 chars, over the review cap, so split it.
Change: port `07a89e0`'s 27 files — every changed path except `tests/brand-smoke.ts`, `docs/branding.md` and `CHANGELOG.md` — plus one concise `[Unreleased] Changed` bullet. Never touch npm/bin names, `PI_SYSTEM_*`, install paths, compose/container names, symbol/urn ids, `distribution.json` identity values, identity regexes, `.github/` or CHANGELOG history. Diff target ~52k.
Proof: `smoke:brand` (17/17) plus `kit-update`, `kit-update-channel`, `kit-root-trust`, `install-marker`, `install-filter`, `profile`, `profile-transaction`, `docs`, `distribution`, `container-static`; `test:typecheck`; targeted `eslint`; `paperwork-budget.ts`.
Deferred: whole-repo smoke walk, `docs/branding.md` scope text, scope-widening CHANGELOG bullet.
