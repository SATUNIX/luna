# Cycle 18 review — `luna-core-01`, stream `core`
Base `75e072404559`. Charter read. Mode: improve. Assigned board item **V-10 [P1] rebrand
pi-system -> Luna**. Cycle 02 (`7b5764b`) already set `mkdocs site_name: Luna`, the `# Luna` README
title and hero alt, Luna in `AGENTS.md`/`CLAUDE.md`, and `docs/branding.md` in the nav, so the work
left is the board's stronger contract:
1. `tests/brand-smoke.ts` uses `import.meta.url`, a hand-written markdown list, a backtick rule and
   asserts `modular pi system` must stay, instead of walking `WORKSPACE_ROOT`, matching
   `/pi[- ]system/i` per line, stripping allowed identities and reporting `file:line`.
2. `docs/branding.md` lists only three identities; it is missing env vars, install paths,
   compose/container names, symbol/urn ids, capability id, TLS organisation, identity sets/regexes,
   `previousSources`/`legacySources`, CHANGELOG history, legacy tests and a rename proposal.
3. System surfaces still say the old name: `capability.yaml:3`, `pi-agent-idle:5`,
   `validate-runtime-readiness.py:220,231`, `validate-pentest-env.sh:141`, `governance/index.ts:196`,
   `packages/core/package.json:5`, `packages/autonomy/package.json:7`.
4. The other ~1000 hits are deliberate identities; the 42 kit-update prose lines need their own work.
Decision: two green sub-items (docs scope, then system surfaces); sub-item 3 proposed.
