# Cycle 24 verification

Base `ae24f89ae230`, branch `pi/luna-core-01`. Two code commits: `24e704d` (Item 1,
memory-vault stemming) and `60cd2c6` (Item 2, orchestrate smoke hermeticity); `5f4426b`
scopes the docs claim. Neither change weakens a test.

## Proving the findings on the base

- `node -e` repro of base `stem()`: `files->fil, notes->not, values->valu,
  processes->proces, classes->clas, addresses->addres`, while the singulars stem
  unchanged — so a plural note is unreachable by a singular query (Finding A).
- `PI_KIT_INTERNAL_CHILD=1 node <base tests/orchestrate-commands-smoke.ts>` — `3/7 FAILED`
  (Finding B). Same file from `ae24f89ae230` run against the unchanged source.

## Test runs (targeted only; never `npm test` / `npm run check:all`)

- `npm run smoke:memory-vault` — all 15 checks passed; new check fails on the base with
  `'fil' !== 'file'`, passes with the change.
- `npm run smoke:memory-recall` — all 7 checks passed.
- `npm run smoke:orchestrate-commands` — all 7 checks passed.
- `PI_KIT_INTERNAL_CHILD=1 npm run smoke:orchestrate-commands` — all 7 checks passed
  (was 3/7 on the base).
- `npm run smoke:docs` — 14 documented commands and 62 relative links validated; journal
  and records resolved.
- `npx tsc -p tests/tsconfig.json` — exit 0.
- `npx eslint packages/extensions/src/memory-vault/search.ts
  tests/memory-vault-smoke.ts tests/orchestrate-commands-smoke.ts` — exit 0.

## Review

- Item 1: independent reviewer subagent (read-only, did not write the change) returned
  **PASS**, confirming the finding is real, the required forms still meet
  (`response/responses->respons`, `commits->commit`, `prefers/preferred->prefer`,
  `crashing->crash`, `configure->configur`), check 16 discriminates base from fix, and the
  commit is scoped. One non-blocking warning: an s-ending singular (`bus->buses`,
  `lens->lenses`, `gas->gases`) gets the short-singular `e` restored, a heuristic limit;
  `5f4426b` scopes the docs claim accordingly.
- Item 2: no reviewer child was available — E3 allows 3 children per request and all 3 were
  spent (3 recon scouts). `workflow_run` and `subagent` both refused for the same reason.
  Reviewed directly instead: `git diff 24e704d..60cd2c6` replaces all six
  `setEnv("PI_KIT_ORCH_DISABLE", undefined)` sites with `isolateKitEnv()`, drops the unused
  `setEnv` import, changes no assertion, and the smoke passes plain and under
  `PI_KIT_INTERNAL_CHILD=1`. The commit carries finding/root cause/fix/verification.
- Whole-diff review (direct): `git diff --no-renames ae24f89ae230..HEAD` is 9,973 chars over
  4 non-record files (`docs/memory.md`, `memory-vault/search.ts`,
  `memory-vault-smoke.ts`, `orchestrate-commands-smoke.ts`). No `package.json` `scripts`,
  `.github/`, CHANGELOG-derived identity, or `autonomy/CHARTER.md` change; no dependency,
  security or test-weakening change.

## Residual limits

- The stemmer stays a heuristic: an s-ending singular and its `-es` plural can still miss
  (documented). Fixing it needs a lexicon, which is out of this cycle's scope.
- Proposals untouched: skill-router session lifetime, firewall timing noise, CodeQL name.
