# Cycle 08 — Verify (run `luna-ops-01`, stream ops)

- Base `e120c3fdb8b0` (head of `stream/ops`); branch `pi/luna-ops-01`; verified head `bde95eeb`, pushed to `origin/pi/luna-ops-01`.
- Reviewed diff (excluding `package-lock.json`, this cycle's records and the run records): 9,650
  characters — below the 30,000-character stop line and the 60,000-character review budget.
- Files changed: `packages/core/lib/check-map.ts`, `tests/autonomy-selfimprove-smoke.ts`,
  `docs/ci-security.md`, `docs/ARCHITECTURE.md` (check-map rows and docs);
  `packages/core/install.ts`, `tests/install-marker-smoke.ts` (empty value rejected). No
  `autonomy/CHARTER.md`, no `package.json` `scripts`, no operator control path.
- `npm test` and `npm run check:all` were deliberately not run (the host gate runs the full suite);
  only the targeted checks below.

## Checks run at the verified head

| Check | Result | Proving line |
|---|---|---|
| `npm run -s test:typecheck` | exit 0 | all workspaces type-check |
| `npm run -s test:lint` | exit 0 | `--max-warnings 0` |
| `npm run -s smoke:autonomy-selfimprove` | exit 0 | `all 57 checks passed` (includes the new check-map rows) |
| `npm run -s smoke:check-all-npm` | exit 0 | `check-all npm smoke: OK` |
| `npm run -s smoke:workflow-policy` | exit 0 | `5 checks passed`, each of 48 mutations caught |
| `npm run -s smoke:suppression-inventory` | exit 0 | `2 checks passed`, each of 9 mutations caught |
| `npm run -s smoke:scan-coverage` | exit 0 | `2 checks passed`, each of 8 mutations caught |
| `npm run -s smoke:clean-install` | exit 0 | `[clean-install-smoke] OK (12 checks)` |
| `npm run -s smoke:install-marker` | exit 0 | `all checks passed`, including the two empty-value cases |
| `npm run -s smoke:install-filter` | exit 0 | `all 18 checks passed` |
| `npm run -s smoke:profile-transaction` | exit 0 | `32/32 passed` |
| `npm run -s smoke:docs` | exit 0 | `OK: 14 documented commands validated, 62 relative links resolved` |
| `npm run -s docs:check` | exit 0 | `OK: nav entries exist and internal links resolve` |
| `npm run -s verify` | exit 0 | `[verify] All checks passed.` |
| `check-all --for-changed=<cycle diff>` | exit 0 | plans the ten checks above plus `test:lint`, `test:typecheck`, `smoke:docs` |
| `install.ts --dry-run --channel ""` | exit 1 | `[install] --channel needs a value` plus usage, no install work |
| `install.ts --dry-run --git-ref ""` | exit 1 | `[install] --git-ref needs a value` plus usage, no install work |

## Per-item verification

### DE-105 — deterministic sub-quadratic guard (already merged)

Re-verified: `tests/perf-budget.ts` accepts `opts.clock` (default `performance.now`) and
`tests/redaction-corpus-smoke.ts` check 5 drives the guard with a fake clock. No code change
this cycle; `smoke:redaction-corpus` passed 6/6 at review time.

### DE-106 — coverage/pi-compat sharding (already merged)

Re-verified against `.github/workflows/ci.yml`: `coverage` and `pi-compat` are shard matrices
and `coverage-merge` is measure-only (outside `ci-complete.needs`), pinned by
`smoke:workflow-policy`. No threshold exists to enforce; the 12-minute PR median is a host-run
measurement and is not claimed offline. No code change this cycle.

### Item 1 — plan the checks that pin CI policy and core entry scripts

- `CHANGED_PATH_CHECKS` now maps `.github/workflows/**`, `.github/expected-settings.json`,
  `.github/CODEOWNERS`, `.github/zizmor.yml`, `.github/codeql/**` and `.github/dependabot.yml` to
  the smokes that read them, and adds `smoke:clean-install` to the `install.ts` row.
- Each mapped check exists in `package.json` and reads the mapped path (grep in
  `tests/workflow-policy-smoke.ts:286`, `tests/suppression-inventory-smoke.ts:154`,
  `tests/scan-coverage-smoke.ts:85`, `tests/clean-install-smoke.ts:247`).
- `smoke:autonomy-selfimprove` 57/57 asserts each row and that unrelated checks are not planned.
- Docs sentences now name exactly the mapped files; earlier review had returned FAIL for the
  overclaim, and this is the repair.

### Item 2 — reject an empty value for a value flag

- `packages/core/install.ts:111` treats `""` as a missing value; `--help` is still handled first,
  and non-empty values are unchanged.
- `tests/install-marker-smoke.ts` adds `--channel ""` and `--git-ref ""` cases (exit 1, message,
  usage line); direct dry runs confirm both.

## Independent review

A read-only `reviewer` subagent reviewed the whole diff (excluding records and the lockfile) and
returned **PASS**. Its one warning: `smoke:install-filter` is mapped to `install.ts` but pins the
delegated profile/settings helpers rather than the entry script itself; the mapping was kept
because the cycle plan names that check and it is additive, not load-bearing. No fail-closed
control or existing assertion is weakened.

## Residual risk / not verified here

- The host acceptance gate (`/opt/autonomy/gate.sh`) runs on the pushed head; it was not run here.
- The 12-minute PR wall-time target for DE-106 remains a host measurement, not an offline claim.
