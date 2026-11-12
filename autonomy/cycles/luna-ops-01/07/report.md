# Cycle 07 — Report (run luna-ops-01, stream `ops`)

Outcome: successful
Mode: fix

Board: DE-105 done - re-verified the merged fake-clock guard: `smoke:redaction-corpus` 6/6 passes, including check 5's deterministic linear/10x/quadratic probes; no code change was needed.
Board: DE-106 done - re-verified the merged coverage sharding and raw-report merge policy with `smoke:workflow-policy` (5 checks, 48 mutations); the 12-minute PR median remains a host-run measurement, not claimed offline.

Item: project-scope install no longer writes the global `.env` - 5853db1a - `npm run -s smoke:install-marker` (project real and dry runs create no global `.env`; global `.env` scaffolding still passes).
Item: `--help` precedence and plan-mode `--skip` validation - 69e6e586 - `npm run -s smoke:install-marker` (`--help --profile` and `--help --bogus` exit 0 with usage and no install work) and `npm run -s smoke:check-all-npm` (a misspelt skip exits 2 in `--for-changed` plan mode).

## What changed

1. **Project scope and the global `.env`.** `packages/core/install.ts` scaffolded
   `<global agent dir>/.env` for every scope, contradicting `docs/INSTALL.md`'s promise that a
   project install writes only the project's `.pi/settings.json` and `.pi/.pi-kit.json`. The
   scaffold and its dry-run message are now gated on `scope === "global"`; global behaviour is
   byte-identical. `tests/install-marker-smoke.ts` asserts a project real run and a project dry run
   create no global `.env`, print no scaffold line, and still write the project settings and marker.
   `docs/INSTALL.md` states the global-only `.env` rule.

2. **CLI argument validation.** `install.ts` now handles `--help`/`-h` before argument validation,
   so `--help --profile` prints usage and exits 0 without install work. `check-all.ts` now validates
   unknown `--skip` names before its `--for-changed` plan branch, so a typo exits 2 in plan mode as
   in list mode; valid plan output is unchanged. Tests cover both.

## Verification

The derived plan for the changed paths (`docs:check`, `smoke:check-all-npm`, `smoke:docs`,
`smoke:install-marker`, `test:lint`, `test:typecheck`, `verify`) ran and passed. The board re-runs
`smoke:redaction-corpus` and `smoke:workflow-policy` also passed. An independent reviewer that did
not write the change reviewed the full diff against the charter and returned `VERDICT: PASS`; its
only warnings were record-file bookkeeping and one combined commit for two closely related CLI
fixes. Details are in `verify.md`.

## Left and next-cycle notes

- The board's DE-106 12-minute PR wall-time target was not measured in this offline checkout; the
  sharded matrices and merged raw reports are merged and policy-pinned, so GitHub-hosted PR runs
  remain the measurement. The coverage-threshold policy question remains in
  `autonomy/proposals/luna-ops-01-06-coverage-threshold-policy.md`; no policy change was made.
- No new proposal was needed. Diff excluding lockfiles and cycle/run records is 13981 characters,
  under the 30000 new-item budget. No control path or `package.json` script was changed.
