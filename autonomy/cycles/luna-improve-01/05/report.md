# Cycle 05 report — luna-improve-01

Outcome: successful
Mode: fix

- Run: `luna-improve-01`, cycle 5 of 200
- Branch: `pi/luna-improve-01`
- Cycle base: `a385401` (`integration/luna`; `origin/pi/luna-improve-01` also points here)
- Documents: `review.md`, `plan.md`, `verify.md` in this directory
- Cycle status: completed

## What was done

Cycle 04 was rejected: its records claimed a 6-file, two-item diff while its attempt branch actually
changed 17 files and carried the cycle-03 work its report said it had "not re-applied here". This
cycle starts from `a385401` (no such work), re-applies the sound parts on a reviewable diff, puts
the re-application in *this* cycle's records (cycle 04's commit `e6f20e6` records stay as the
historical description of its own two commits), and runs the full acceptance suite.

A prior session of this run had already re-applied the commits and edited cycle 04's records; this
cycle restored those records and re-verified from the base.

### Items completed

- **`f86177c` — npm 12 `npm pack --json` object shape.** Finding: `smoke:package` and
  `smoke:clean-install` fail under npm `12.2.1` with `ValidationError: npm pack --dry-run: expected
  array of object with files, got object`. Root cause: `packages/core/build-npm.ts:34` (and a copy
  in `pack-check.ts`) validated only the npm ≤ 11 array. Fix: exported `packReports()` /
  `PackReportEntry` validate `union(array(entry), record(entry))` and fold to a flat list. Pinned by
  the both-shape fixture assertion in `tests/clean-install-smoke.ts`.
- **`fd76bd3` + `fe8a128` — hermetic `installDelegation()`.** Finding: an ambient
  `PI_KIT_EFFORT_CAP`/`PI_KIT_UNATTENDED` clamped the fake children, failing eight subagent/workflow
  smokes. Root cause: `packages/core/eval/delegation.ts` read the ambient environment before
  `isolateKitEnv()`, and restored only three variables. Fix: isolate first, restore the whole
  environment in `cleanup()`, deleting the two variables the helper added. Pinned by the eight
  smokes under the ambient env.
- **`14d43dd` — namespace-aware firewall smoke.** Finding: `smoke:firewall-unattended` failed in this
  rootless container because it hard-coded the initial-user-namespace refusal. Fix: exported
  `currentNamespaceStanding()`; the two real-`/proc` provenance cases expect the reason matching the
  real standing. Not a loosening: the refusal is still asserted and the strict reason is still
  asserted deterministically at `tests/firewall-unattended-smoke.ts:599`.
- **`794adac` — offline runtime-dependency install.** Finding: `smoke:clean-install` ran
  `npm install` against a registry the offline gate lacks (`ENOTCACHED`). Fix: `runtimeLock()` cuts a
  lockfile for the artefact's runtime dependencies from the repo `package-lock.json`; the smoke runs
  `npm ci --prefer-offline` against the shipped cache.
- **`92dbeaf` — documentation accuracy.** Finding: `docs/future-work.md` still claimed the web
  console's version constants read `0.1.0`, which `f766593` made false. Fix: drop the stale clause.
- **Carried on this branch (cycle 04's own commits, verified here):** `f766593` web console reports
  the real package version (B-001); `3f8ab1b` detached supervisor writes each log line once (B-002).

## Verification

- `npm run check:all` — **all 203 checks passed** (446.7s) with the shipped offline cache.
- `npm run test:security` — exit 0; `npm run docs:check` — exit 0.
- Independent `reviewer` subagent on `git diff a385401..HEAD` against the charter: **PASS**, no
  must-fix findings (it confirmed the strict firewall assertion remains at line 599 and that no
  out-of-bounds path is touched).
- Full evidence in `verify.md`.

## What was left and why

- `.github/workflows/release.yml` still indexes `require("./pack.json")[0]`, which is `undefined`
  under npm 12's object shape. Changing a release pipeline is out of bounds (charter), so it is
  recorded as `B-007` for the operator.
- `runtimeLock()` closes only `dependencies` (root and transitive), not `optionalDependencies` or
  `peerDependencies`. The current runtime dependency has neither; recorded as `B-008` (low).
- The cycle-04 attempt's records on `origin/attempts/luna-improve-01/cycle-04` are left as they are;
  this branch's cycle-04 records (`e6f20e6`) describe only cycle 04's own two commits, which is
  accurate for that commit range.

## For the next cycle

- Read `HANDOFF.md`; it carries the environment notes (npm 12 pack shape, offline cache, gate
  runtime).
- Nothing is carried over as unfinished. Next work is the normal priority order: a consolidation
  pass over the re-applied test-harness code, then the next evidenced fix.
- `B-007` is the only item that needs an operator decision.
