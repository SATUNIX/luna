# Cycle verify — luna-core-01 / 01 (continuation)

Base `d932d6f02e41`; items committed `486d3d2` and `a9b6f21`. Targeted checks only — no
`npm test` / `npm run check:all` was run.

## Item 1 — guidelines env var name

Commit: `486d3d2`.

| Command | Result |
|---|---|
| `npm run smoke:docs` | **PASS** — `14 documented commands validated, 62 relative links resolved` |
| `node packages/core/reference.ts --check` | **PASS** — `docs/reference.md is up to date` |
| pre-change reproduction (scratch worktree, row reverted to `PI_KIT_GUIDELINES_FILE`) | **FAIL as intended** — `node tests/docs-smoke.ts` exits 1: `docs/INSTALL.md lists PI_KIT_GUIDELINES_FILE for "guidelines", but its manifest env[] does not declare it` |

Proving line: the new assertion in `tests/docs-smoke.ts` fails on the old INSTALL row and passes on
the new one; the generated `docs/reference.md` row for `PI_KIT_GUIDELINES_PATH` gains its Purpose
and INSTALL link.

## Item 2 — declared settings missing from the reference

Commit: `a9b6f21`.

| Command | Result |
|---|---|
| `npm run smoke:docs` | **PASS** — the same checker now resolves every INSTALL row against its manifest `env[]` |
| `node packages/core/reference.ts --check` | **PASS** — `docs/reference.md is up to date` |
| `node tests/extension-manifest-hooks-smoke.ts` | **PASS** — `3 pinned extensions declare the exact env vars their code reads` |

Proving line: `docs/reference.md` now lists `PI_KIT_LEAN_CTX` under `session-helpers` and
`PI_KIT_VERIFY_PENDING_TTL_MS` under `verify-gate` with a purpose and INSTALL link; removing either
manifest `env[]` entry makes the `docs-smoke` INSTALL/manifest assertion fail.

## Independent review

`reviewer` subagent over `git diff --no-renames d932d6f02e41..HEAD` (lockfile and cycle/run records
excluded), against `autonomy/CHARTER.md`: **VERDICT: PASS**. The only non-record files are
`docs/INSTALL.md`, `docs/reference.md`, `tests/docs-smoke.ts`,
`packages/extensions/src/session-helpers/extension.json` and
`packages/extensions/src/verify-gate/extension.json`; no `.github/`, `package.json` script,
`autonomy/CHARTER.md` or operator control path; no test deleted or weakened.

## Diff budget

`git diff --no-renames d932d6f02e41..HEAD` excluding lockfile and cycle/run records: **8,856 chars**
(limit 30,000).
