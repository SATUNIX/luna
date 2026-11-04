# Cycle 09 — Report

Outcome: successful
Mode: fix mode

- Run: `luna-improve-01`
- Branch: `pi/luna-improve-01`
- Cycle base: `b05a67174f759bf8e7520fdb0b7adca38585e6ed`
- Pushed head at close: this record commit (code head `2b12800`)
- Artefacts: `autonomy/cycles/luna-improve-01/09/review.md`, `plan.md`, `verify.md`, this `report.md`

## Completed items

1. **B-010 — `uninstall.ts` accepted invalid and unknown arguments silently.**
   - Commit: `6d7e0c0` (fix), `2b12800` (docs).
   - Finding: `packages/core/uninstall.ts` parsed argv with only `has()`/`get()`, so `--scope bogus`,
     a trailing `--scope`, and unknown flags were ignored and the script fell through to
     auto-detected scope. On the destructive path this can remove the wrong installation.
   - Root cause: the flag-validation loop that `install.ts:89-120` gained was never added to
     `uninstall.ts`.
   - Fix: added the same guard — `VALUE_FLAGS = ["--scope"]`, `BOOLEAN_FLAGS = ["--dry-run",
     "--yes"]`, reject an unknown argument, reject a value flag with a missing/`--`-shaped value,
     reject a `--scope` other than `global|project`; each prints `[uninstall] <problem>` and a
     `usage: uninstall.ts` line to stderr and exits 1. The project/global/auto-detect logic for valid
     input is unchanged.
   - Verification: `testUninstallRejectsBadArguments` in `tests/install-marker-smoke.ts` (fails on
     the pre-fix code); `npm run smoke:install-marker` green; documented in
     `docs/architecture/profiles-and-install.md:78`.
2. **F-2 — dead `getExternalByProfile()` removed.**
   - Commit: `c5cd90e`.
   - Finding: `packages/core/lib/sources.ts:43` exported a function with no caller anywhere and not
     part of a public entry (`package.json` has no `exports`, only a `bin` map).
   - Fix: deleted the export. Verification: no code reference remains; `test:typecheck`,
     `test:lint`, `smoke:sources` green.

## What was left and why

- **B-011 (new, open, low):** `packages/core/eval/run.ts:21` silently ignores a `--category` with no
  value instead of erroring. Real but low impact (offline eval harness, no destructive effect), and
  changing it risks altering deliberately lenient harness behaviour. Filed in `BACKLOG.md`, not done.
- **Installer raw `writeFileSync`** (`packages/core/install.ts:738`): already documented as a known
  pending gap in `docs/future-work.md:95`, so it is a documented state, not a mismatch. Out of scope.
- **B-007** stays an operator proposal (release pipeline, out of bounds).

## Verification

- `/opt/autonomy/gate.sh` cannot run inside this container (it writes `/gate/result.json`); each gate
  step was run directly at the verified head:
  - `npm ci --offline --ignore-scripts` — exit 0
  - `npm run check:all` — exit 0, all 203 check runs passed
  - `npm run test:security` — exit 0
  - `python3 -m mkdocs build --strict -d /tmp/site` — exit 0
  - `gitleaks git --redact --exit-code 1 .` — exit 0, no leaks found
- Independent `reviewer` verdict: **PASS** on `git diff b05a671..2b12800` across all five charter
  points. (A first reviewer pass caught that the implementer had left item 2 undone; the coordinator
  applied the reviewer's named must-fix, and the final review passed.)
- Diff (lockfiles excluded): 6 files, +215/-5. No `autonomy/CHARTER.md`, no `package.json` `scripts`,
  no operator control path — merge guard satisfied. Diff is small relative to the review budget.

## Notes for the next cycle

- Cycle base for cycle 10 is this record commit.
- `node_modules/` can be empty in this clone: run `npm ci --offline --ignore-scripts` before checking,
  or `check:all` fails with `ERR_MODULE_NOT_FOUND` / `test:lint exit 127`.
- Next evidenced work in charter order; the only open in-bounds backlog item is the low-priority
  B-011 (eval `--category`).
