# Cycle 18 plan — `luna-core-01`, stream `core`
Mode: improve. Item V-10, two ordered green sub-items. Never change npm/bin names, env vars, install
paths, compose/container names, symbol/urn ids, identity regexes, `distribution.json` or CHANGELOG
history.
## Item 1 — smoke to the board spec over docs (`V-10`)
Rewrite `tests/brand-smoke.ts` to import `WORKSPACE_ROOT`, walk root docs + `docs/**/*.md`, skip
`node_modules/.git/dist/site/.pi/autonomy/package-lock.json`, match `/pi[- ]system/i` per line,
strip `ALLOWED` and assert no leftover, printing `file:line`. Replace `modular pi system` in
`AGENTS.md`; rewrite `docs/branding.md` with every identity category plus the rename proposal, keep
it in the nav, add one `[Unreleased]` CHANGELOG bullet. Checks: `smoke:brand`, `smoke:docs`,
`docs:check`, `test:typecheck`, targeted eslint.
## Item 2 — system surfaces and display strings (`V-10`)
Widen the smoke to `packages/**/*.md`, `packages/container/**`, `website/index.html`, root and
workspace manifests; allow bin names, the `/pi-system` path segment and YAML `id:`/`name:`; rename
the old display strings in the container and the two package descriptions. Checks: `smoke:brand`,
`smoke:container-static`, `smoke:scan-coverage`, `smoke:compose-policy`, `smoke:docs`,
`test:typecheck`, eslint.
## Not taken
Sub-item 3 (whole-repo prose) — `autonomy/proposals/luna-core-01-18-rebrand-subitem-3.md`.
