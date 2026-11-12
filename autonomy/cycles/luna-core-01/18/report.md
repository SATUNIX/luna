# Cycle 18 report — `luna-core-01`, stream `core`
Outcome: successful
Mode: improve
Board: V-10 progress - sub-items 1-2 landed and enforced by `npm run smoke:brand`; sub-item 3 is
proposed in `autonomy/proposals/luna-core-01-18-rebrand-subitem-3.md`.
Item: V-10 smoke to the board contract over a docs scope - `684f54b` - `npm run smoke:brand`
Finding: the smoke used `import.meta.url`, a hand-written file list, a backtick rule and pinned the
prose `modular pi system`; the branding page had three identities; `AGENTS.md:11` said `pi system`.
Root cause: cycle 02 created the guard before the board contract and the page was never expanded.
Fix: walk `WORKSPACE_ROOT` with per-line `/pi[- ]system/i` and allowed-identity stripping, report
`file:line`; document every identity plus the rename proposal; fix `AGENTS.md`; add the CHANGELOG
bullet. Verification: `smoke:brand` 16 checks, `smoke:docs`, `docs:check`, `test:typecheck`, eslint.
Item: V-10 system surfaces and display strings - `dd49bcb` - `smoke:brand` 17 checks,
`smoke:container-static`, `smoke:scan-coverage`, `smoke:compose-policy`, `smoke:docs`, `test:typecheck`
Finding: `Pi System` survived in `capability.yaml:3`, `pi-agent-idle:5`,
`validate-runtime-readiness.py:220,231`, `validate-pentest-env.sh:141`, `governance/index.ts:196`,
`compose.dev.yaml:8-9` and the core/autonomy descriptions. Root cause: no check covered the
container, website or manifests. Fix: widen the smoke to system surfaces with narrow new allowances
and rename the strings to Luna.
## Verification
`verify.md`: reviewer on `75e072404559..HEAD` **PASS**; diff (records excluded) 29,220 chars over 13
files, under the 30,000 stop; no `.github/`, `package-lock.json`, `package.json` `scripts`, identity
regex, `distribution.json` or CHANGELOG history change; never ran `npm test` or `npm run check:all`.
## Left
Sub-item 3 proposal; cycle-17 proposals unchanged; HANDOFF #1 out of stream, #4 test-only.
