# Cycle 08 mapped the CI-policy checks and rejected empty installer values

Outcome: successful
Mode: fix

Board: DE-105 done - re-verified the merged fake-clock guard (`tests/perf-budget.ts` accepts `opts.clock`; `smoke:redaction-corpus` check 5 is deterministic, 6/6); no code change was needed.
Board: DE-106 done - re-verified the merged sharded `coverage`/`pi-compat` matrices and measure-only `coverage-merge` via `smoke:workflow-policy` (5 checks, 48 mutations); the 12-minute PR median remains a host-run measurement.

Item: plan the checks that pin CI policy and core entry scripts - b215c53d cf508ffa - `npm run -s smoke:autonomy-selfimprove` (57 checks) and `smoke:workflow-policy` (5/48), `smoke:suppression-inventory` (2/9), `smoke:scan-coverage` (2/8), `smoke:clean-install` (12).
Item: reject an empty value for an installer value flag - bde95eeb - `npm run -s smoke:install-marker` and `smoke:install-filter` (18), plus direct dry runs: `--channel ""` and `--git-ref ""` exit 1 with the usage line.

## What changed

1. **Changed-path check mapping.** The cycle review found `check-all --for-changed` printed
   `SKIPPED` for every check that pins `.github/**`, `packages/core/install.ts` and
   `packages/core/coverage.ts`, so a cycle changing those files could verify a narrower list than
   the host gate runs. `packages/core/lib/check-map.ts` now maps the workflow definitions,
   expected settings, `CODEOWNERS`, zizmor and CodeQL configuration and Dependabot configuration
   to the smokes that read them, and adds `smoke:clean-install` to the installer row.
   `tests/autonomy-selfimprove-smoke.ts` asserts every row and that unrelated checks stay
   unplanned; `docs/ci-security.md` and `docs/ARCHITECTURE.md` name exactly the covered files.
   An independent review of the first version returned FAIL because the docs overclaimed general
   `.github/` coverage; `cf508ffa` adds the missing rows and narrows both sentences.

2. **Installer value validation.** `install.ts` rejected an undefined or `--`-prefixed value but
   accepted `""`, so `--channel ""` built the malformed source `git:github.com/SATUNIX/luna@v`
   and `--git-ref ""` fell back to local mode. The argument loop now treats an empty next
   argument as a missing value (exit 1, usage, no install work). `--help` precedence and every
   non-empty value are unchanged; `tests/install-marker-smoke.ts` adds both cases.

## Verification

All listed checks pass at the verified head `bde95eeb`: `test:typecheck`, `test:lint`,
`smoke:autonomy-selfimprove` 57/57, `smoke:check-all-npm`, `smoke:workflow-policy` 5/48,
`smoke:suppression-inventory` 2/9, `smoke:scan-coverage` 2/8, `smoke:clean-install` 12/12,
`smoke:install-marker`, `smoke:install-filter` 18/18, `smoke:profile-transaction` 32/32,
`smoke:docs`, `docs:check`, and `verify`. `npm test` and `npm run check:all` were deliberately
not run (the host gate does). The independent whole-diff reviewer returned PASS with one
non-blocking warning (`smoke:install-filter` pins the delegated helpers rather than the entry
script). See `verify.md` for the command-by-command evidence.

## Follow-ups

- None new. DE-105 and DE-106 are complete on the base; the many-CI-minute PR target and the
  coverage-threshold policy question stay with the host and
  `autonomy/proposals/luna-ops-01-06-coverage-threshold-policy.md`.
