# Cycle 08 — Plan (run luna-ops-01, stream `ops`)

Mode: **fix**. Base `e120c3fdb8b0`.

## Board status first

- **DE-105**: done and merged before this cycle; re-verified (`smoke:redaction-corpus` 6/6). No
  change.
- **DE-106**: merged as sharded `coverage` and `pi-compat` matrices plus a measure-only
  `coverage-merge`; policy pinned by `smoke:workflow-policy`. No threshold exists to enforce, and
  adding one is an operator decision already recorded in
  `autonomy/proposals/luna-ops-01-06-coverage-threshold-policy.md`; the 12-minute median is a
  host PR measurement. No change this cycle.

## Item 1 — plan the checks that pin CI policy and core entry scripts

**Justification:** charter priority 4 (defect). `check-all --for-changed` exists so a cycle's
verify list matches the host gate; the table has no rule for `.github/**`,
`packages/core/install.ts` or `packages/core/coverage.ts`, so the checks that pin those files are
printed as SKIPPED (evidence in `review.md`).

**Change:**
- `packages/core/lib/check-map.ts`: add rows
  - `.github/workflows/**` → `smoke:workflow-policy`, `smoke:release-workflow`
  - `.github/expected-settings.json` → `smoke:workflow-policy`, `smoke:github-settings-check`
  - `.github/CODEOWNERS` → `smoke:codeowners-coverage`
  - `packages/core/install.ts` → `smoke:install-marker`, `smoke:install-filter`,
    `smoke:profile-transaction`
  - `packages/core/coverage.ts` → `smoke:check-all-npm`
- `tests/autonomy-selfimprove-smoke.ts`: assert each changed path plans the named checks (and
  still not unrelated ones).
- `docs/ci-security.md` / `docs/ARCHITECTURE.md`: one sentence naming CI policy and core entry
  scripts as covered.

**Checks:** `npm run -s smoke:autonomy-selfimprove`, `npm run -s smoke:check-all-npm`,
`npm run -s smoke:docs`, `docs:check`, `test:typecheck`, `test:lint`, `verify`, plus the plan
printed by `--for-changed` for the changed paths.

## Item 2 — reject empty values in `install.ts`

**Justification:** charter priority 4 (defect). `--channel ""` produces the malformed source
`git:github.com/SATUNIX/luna@v` and `--git-ref ""` is silently ignored; both are user-error
presentation/validation gaps in the installer, like the fixed bad `--profile` path.

**Change:** in `packages/core/install.ts`, treat `args[i + 1] === ""` as a missing value so the
existing `<flag> needs a value` path runs (exit 1, usage, no install work). Extend
`testUnknownFlagsRejected` in `tests/install-marker-smoke.ts` with `--channel ""` and
`--git-ref ""` cases asserting exit 1, the message, the usage line, and no source/default install.
No docs change: `docs/INSTALL.md` already describes these flags as taking a value.

**Checks:** `npm run -s smoke:install-marker`, `test:typecheck`, `test:lint`, `verify`.

## Out of scope

- Any change to `ci.yml`, coverage policy or `package.json` scripts.
- The stale `workflow-resume` proposal (already fixed) and the `/workflows` docs sweep.
- `coverage.ts --report` missing-directory error handling (recorded in `review.md`; a later cycle).

## Budget

Two small items; expected diff well under the 30000-character new-item stop line. Each item is
implemented and then reviewed by an agent that did not write it.
