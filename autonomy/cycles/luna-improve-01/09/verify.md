# Cycle 09 — Verify

- Run: `luna-improve-01`, cycle 09
- Branch: `pi/luna-improve-01`
- Cycle base: `b05a67174f759bf8e7520fdb0b7adca38585e6ed`
- Verified head: `2b12800` (pushed)
- Diff (lockfiles excluded): 6 files, +215 / -5. No `autonomy/CHARTER.md`, no `package.json`
  `scripts`, no operator control path.

## Commits

- `1661af0` docs(autonomy): cycle 09 review and plan — uninstall argument guard, dead code
- `6d7e0c0` fix(uninstall): reject invalid and unknown arguments
- `c5cd90e` refactor(sources): drop dead getExternalByProfile export
- `2b12800` docs(install): note that uninstall.ts validates its own arguments

## Acceptance checks (run at the verified head)

`/opt/autonomy/gate.sh` cannot run inside this container: it writes `/gate/gate.log` and
`/gate/result.json` and expects a clean clone mounted at `/gate` with `HOME=/gate/home`
(cycle 08 recorded the same limitation). Each gate step was therefore run directly in `/work`
after installing dependencies exactly as the gate does:

| Gate step | Command | Result |
|---|---|---|
| install | `npm ci --offline --ignore-scripts` | exit 0 (368 packages) |
| check-all | `npm run check:all` | exit 0 — `all 203 check run(s) passed in 459.4s` |
| security | `npm run test:security` | exit 0 (`kit-root-trust-smoke: 10/10 passed`) |
| docs | `python3 -m mkdocs build --strict -d /tmp/site` | exit 0 |
| secrets | `gitleaks git --redact --exit-code 1 .` | exit 0, `no leaks found` |

`npm ci` had to be run first: `node_modules/` was empty in this clone (no `typescript`/`jsdom`),
so an early `check:all` run failed with `ERR_MODULE_NOT_FOUND` / `test:lint exit 127`. That was an
environment artefact, not a repository state; after the offline install every step passes.

## Per-item verification

### Item 1 (F-1) — `uninstall.ts` argument guard

- **Test:** `testUninstallRejectsBadArguments` in `tests/install-marker-smoke.ts` (added at line
  688, called at line 1025). It runs `uninstall.ts` with `--scope bogus`, a trailing `--scope`,
  `--dryrun` and `stray`, asserts exit 1, the stderr message, the `usage: uninstall.ts` line, and
  that the fake `pi` log stays empty.
- **Genuineness:** on the base code `--scope bogus` falls through to auto-detect and calls the fake
  `pi` (writing `PI_FAKE_LOG`), so the `!fs.existsSync(logPath)` assertion and the stderr regex both
  fail — the test is not vacuous (confirmed by the cycle reviewer, who inspected the base branch).
- **Behaviour preserved for valid input:** the branch structure (`project` / `global` / auto-detect)
  is unchanged; only the local binding is renamed `explicitScope = scopeArg`.
- **Result:** `npm run smoke:install-marker` exit 0; independent reviewer PASS.

### Item 2 (F-2) — delete dead `getExternalByProfile()`

- `packages/core/lib/sources.ts` no longer defines or exports the function (4 lines removed).
- `grep -rn getExternalByProfile . --include='*.ts'` (excluding `node_modules` and autonomy cycle
  notes) returns no code reference.
- `npm run test:typecheck` exit 0, `npm run test:lint` exit 0, `npm run smoke:sources` exit 0.

### Documentation (charter point 3)

- `docs/architecture/profiles-and-install.md` now states that `uninstall.ts` validates its own
  arguments (`--scope` must be `global` or `project`; unknown argument or missing value exits 1),
  citing `tests/install-marker-smoke.ts`.

## Scope / merge guard

- Does not edit `autonomy/CHARTER.md` — no.
- Does not edit operator control paths (`install.ts` scope semantics unchanged; only `uninstall.ts`
  gains input validation) — no.
- Does not change any `package.json` `scripts` — no.
- Diff length is far under the reviewer read budget — yes.

## Verdicts

- Item 1: PASS (independent reviewer).
- Item 2: FAIL at first review (not implemented), must-fix applied by the coordinator (4-line
  deletion the reviewer named), checks green; re-reviewed in the final cycle review.
- Cycle diff: see final review below.
