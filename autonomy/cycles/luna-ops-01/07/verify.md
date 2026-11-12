# Cycle 07 — Verify (run luna-ops-01, stream `ops`)

Base `0b8b2c9bceb2`, head before records `69e6e586`. Diff excluding lockfiles and cycle/run records:
13981 characters (under the 30000 new-item budget and 60000 review budget).

Plan derived with:

`node packages/core/check-all.ts --for-changed="$(git diff --name-only 0b8b2c9bceb2..HEAD | tr '\n' ',')"`

Changed non-record paths: `docs/INSTALL.md`, `packages/core/check-all.ts`,
`packages/core/install.ts`, `tests/check-all-npm-smoke.ts`, `tests/install-marker-smoke.ts`.
Derived plan: run `docs:check`, `smoke:check-all-npm`, `smoke:docs`, `smoke:install-marker`,
`test:lint`, `test:typecheck`, `verify`; all other checks skipped. One line per check:

- `npm run -s docs:check` — RAN, PASS (`EXIT:0`).
- `npm run -s smoke:check-all-npm` — RAN, PASS (`EXIT:0`); covers the new plan-mode skip typo.
- `npm run -s smoke:docs` — RAN, PASS (`EXIT:0`).
- `npm run -s smoke:install-marker` — RAN, PASS (`EXIT:0`); the output includes `OK: a project-scope profile install leaves the global firewall.json and security.json byte-identical, writes only the project settings/marker, never scaffolds the global .env, and warns about the gate difference`.
- `npm run -s test:lint` — RAN, PASS (`EXIT:0`).
- `npm run -s test:typecheck` — RAN, PASS (`EXIT:0`).
- `npm run -s verify` — RAN, PASS (`EXIT:0`).

Board re-verification (unchanged by this cycle):

- `npm run -s smoke:redaction-corpus` — RAN, PASS; all 6 checks passed, including check 5 (`OK: 5. the sub-quadratic guard passes linear probes and rejects a quadratic one`) and the real-timing check 4.
- `npm run -s smoke:workflow-policy` — RAN, PASS; 5 checks and 48 mutations, so the merged DE-106 shard/merge policy still holds.

Independent review: a `reviewer` subagent that did not write the change reviewed
`git diff 0b8b2c9bceb2..HEAD` against `autonomy/CHARTER.md` and the cycle plan. It ran the seven
derived checks and returned `VERDICT: PASS`, with no critical findings. Its two warnings were
bookkeeping only (this file was not yet written at review time, and the two small CLI fixes share
one commit); this file closes the first, and the commit message documents both fixes.

No check was skipped that the derived plan marked RAN. `npm test` and `npm run check:all` were not
run, as the cycle ground rules require; the host gate runs them on the clean checkout.
