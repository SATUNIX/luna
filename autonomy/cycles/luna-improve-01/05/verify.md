# Cycle 05 verify — luna-improve-01

Base: `a385401`. Head under test: `92dbeaf` (code/commits) plus the cycle-05 records in this
directory.

All commands run in this container (`Node v26.12.1`, npm `12.2.1`, rootless, offline) with
`npm_config_cache` pointed at a copy of the shipped cache (`/opt/npm-cache`), the same setup the
acceptance gate uses. This is the cycle's evidence; the supervisor's gate (`/opt/autonomy/gate.sh`)
runs the real checks on the pushed head.

## Commands run

### `npm run check:all` — PASS (203/203, 446.7s)

```
check-all: all 203 check run(s) passed in 446.7s
```

Every listed check passed, including the ones the carried fixes target:

```
--- smoke:autonomy-cli: OK (1.8s)
--- smoke:clean-install: OK (22.7s)
--- smoke:firewall-unattended: OK (1.1s)
--- smoke:package: OK (2.6s)
--- smoke:web-ui-api: OK (0.4s)
--- verify: OK (4.2s)
--- test:lint: OK (29.4s)
--- test:typecheck: OK (13.6s)
```

`smoke:clean-install` reaches its offline runtime-dependency install and its
`packReports reads both npm pack --json shapes` assertion; `smoke:firewall-unattended` passes all 15
checks. Pins items 1–4 and both carried commits.

### `npm run test:security` — PASS (exit 0)

```
kit-root-trust-smoke: 10/10 passed
```

The gate runs this chain separately from `check:all`; it passes.

### `npm run docs:check` — PASS (exit 0)

```
[docs-nav-check] OK: nav entries exist and internal docs links resolve.
```

Pins item 5 (`docs/future-work.md`).

## Independent review

A `reviewer` subagent that did not write the change reviewed `git diff a385401..HEAD` against
`autonomy/CHARTER.md`. Verdict: **PASS**, no must-fix findings. It confirmed: the diff matches the
records; the strict refusal text is still asserted deterministically at
`tests/firewall-unattended-smoke.ts:599`, with only the two real-`/proc` cases (lines 605–606)
adapting; no out-of-bounds path, `package.json` `scripts`, lockfile or dependency is touched; and
each code change has a pinning assertion. Residual note from the reviewer: `installDelegation`
isolation is exercised indirectly by the eight subagent/workflow smokes under the ambient env rather
than a dedicated deterministic assertion — that is exactly the acceptance check it was fixed for.

(An earlier child run ended without a reply after one turn; the run quoted above produced the
verdict. No code changed between the two.)

## Item verdicts

| Item | Commit(s) | Check | Verdict |
|------|-----------|-------|---------|
| 1 npm 12 pack shape | `f86177c` | `smoke:package`, `smoke:clean-install`, `check:all` | pass |
| 2 hermetic `installDelegation` | `fd76bd3`, `fe8a128` | eight subagent/workflow smokes under ambient env | pass |
| 3 namespace-aware firewall smoke | `14d43dd` | `smoke:firewall-unattended` (15/15) | pass |
| 4 offline runtime-dependency install | `794adac` | `smoke:clean-install` offline | pass |
| 5 docs accuracy | `92dbeaf` | `docs:check` | pass |
| carried: web-console version | `f766593` | `smoke:web-ui-api` | pass |
| carried: single-write supervisor log | `3f8ab1b` | `smoke:autonomy-cli` | pass |
| record correction (rejection) | this directory | `git diff --stat a385401..HEAD` matches `report.md` | pass |

## Diff shape

`git diff --stat a385401..HEAD`: 18 files, +364/-45. Fourteen are code/tests/docs
(`packages/core/build-npm.ts`, `packages/core/pack-check.ts`, `packages/core/eval/delegation.ts`,
`packages/extensions/src/tool-firewall/unattended.ts`, `packages/autonomy/lib/engine.ts`,
`packages/autonomy/lib/fsutil.ts`, `packages/web-ui/server/{routes,configinfo}.ts`,
`tests/{autonomy-cli,clean-install,firewall-unattended,web-ui-api}-smoke.ts`, `docs/future-work.md`,
`autonomy/BACKLOG.md`); four are cycle-04's historical records. This matches `report.md`'s commit
list — the mismatch that caused the cycle-04 rejection is corrected here: this cycle's records name
every file and commit in the diff.
