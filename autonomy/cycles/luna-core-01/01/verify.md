# Cycle verify — luna-core-01 / 01

Base `dc71c739409e`; final `HEAD` after the record commit. Two code items, each with a targeted
check. No `npm test` / `npm run check:all` was run.

## Item 1 — eval `--category` gate

Commit: `d30b7f0`.

| Command | Result |
|---|---|
| `node packages/core/eval/run.ts --category __no_such_category__; echo $?` | prints `unknown category "__no_such_category__"` + usage, **exit 2** (pre-change: exit 1 with a generic message) |
| `node packages/core/eval/run.ts --category; echo $?` | usage, **exit 2** (pre-change: ran all 17 fixtures, **exit 0** — the false green) |
| `node tests/eval-footprint-smoke.ts` | **PASS** — `all 11 checks passed`, including `the eval --category gate refuses an unknown or missing value` |

Proving line: the new assertion `run(["--category"])` asserts a non-zero exit and fails against the
pre-change `run.ts`, which exited 0. The reviewer independently reproduced this with a scratch copy
of the old file.

## Item 2 — context-sieve message-budget env var

Commit: `8b3013f`.

| Command | Result |
|---|---|
| `node tests/extension-manifest-hooks-smoke.ts` | **PASS** — `3 pinned extensions declare the exact env vars their code reads` |
| `node packages/core/reference.ts --check` | **PASS** — `docs/reference.md is up to date` |
| `npm run smoke:docs` | **PASS** — `14 documented commands validated, 62 relative links resolved` |
| `npm run smoke:context-budget` | **PASS** — `all 12 checks passed` |

Proving line: `docs/reference.md:470` now lists `PI_KIT_CTX_MESSAGE_BUDGET_TOKENS` for
`context-sieve`; the `ENV_ALLOWLIST` `deepEqual` in `tests/extension-manifest-hooks-smoke.ts`
fails if the manifest omits it. The reviewer confirmed the context-sieve code reads exactly those two
`PI_KIT_*` vars and the manifest now declares exactly them.

## Independent review

`reviewer` subagent, over `git diff dc71c739409e..HEAD` (records excluded), against `autonomy/CHARTER.md`:
**VERDICT: PASS** for both items. Merge-guard criteria satisfied: no `autonomy/CHARTER.md`, no
`.github/`, no `package.json` `scripts`, no operator control path, no `any`/casts/`eslint-disable`.

Two warnings (non-blocking, recorded as leftovers):
- the cycle `review.md` initially overstated the unknown-category case as a false green (it exited 1);
  corrected in the record commit;
- `run.ts` header usage example still lists only `security|verification|orchestration`, and the test
  asserts `status !== 0` rather than `status === 2`.

## Diff budget

`git diff --no-renames dc71c739409e..HEAD` excluding lockfile and run records: **7,371 chars**
(limit 30,000).
