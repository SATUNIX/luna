# Cycle 05 plan — luna-improve-01

- Mode: **fix**
- Base: `a385401` (`integration/luna` seed, also `origin/pi/luna-improve-01`)
- Goal: land the cycle-05 resubmission of the rejected cycle-04 delivery — re-apply the sound
  carried fixes, correct the record mismatch the rejection named, prove the acceptance suite green
  on this head, and record the cycle honestly.

## Items

### Item 1 — npm 12 `npm pack --json` object shape (priority 1: failing acceptance check)
- Change: exported `packReports()` + `PackReportEntry` in `packages/core/build-npm.ts` accept the
  array (npm ≤ 11) or object-keyed-by-name (npm 12) shape; `packages/core/pack-check.ts` and
  `tests/clean-install-smoke.ts` use it.
- Test: both-shape fixture assertion in `tests/clean-install-smoke.ts`; `smoke:package`.
- Commit: `f86177c`. Proven by `npm run smoke:package` + `npm run check:all`.

### Item 2 — hermetic `installDelegation()` (priority 1)
- Change: `packages/core/eval/delegation.ts` calls `isolateKitEnv()` before setting the helper's
  variables and restores the environment in `cleanup()`, deleting the two variables it added first.
- Test: the eight subagent/workflow smokes under an ambient `PI_KIT_EFFORT_CAP`.
- Commits: `fd76bd3`, `fe8a128`. Proven by `npm run check:all` with the ambient env.

### Item 3 — namespace-aware firewall smoke (priority 1)
- Change: export `currentNamespaceStanding()` from
  `packages/extensions/src/tool-firewall/unattended.ts`; `tests/firewall-unattended-smoke.ts` expects
  the reason that matches the real standing for the two real-mount-table cases only.
- Test: `npm run smoke:firewall-unattended` (15 checks) in this rootless container; the strict
  reason is still asserted deterministically at line 599.
- Commit: `14d43dd`.

### Item 4 — offline runtime-dependency install (priority 1)
- Change: `runtimeLock()` in `tests/clean-install-smoke.ts` cuts a lockfile for the artefact's runtime
  dependencies; the smoke runs `npm ci --prefer-offline` against the shipped cache.
- Test: `npm run smoke:clean-install` offline; the dependencies-closed assertion remains.
- Commit: `794adac`.

### Item 5 — documentation accuracy (priority 5)
- Change: drop the stale `0.1.0` claim from `docs/future-work.md`.
- Test: `npm run docs:check`; the claim is pinned by `smoke:web-ui-api`.
- Commit: `92dbeaf`.

### Carried commits already on this branch (from cycle 04's attempt, re-applied)
- `f766593` web console reports the real package version (B-001), pinned by `smoke:web-ui-api`.
- `3f8ab1b` detached supervisor writes each log line once (B-002), pinned by `smoke:autonomy-cli`.

### Record correction (the rejection's finding)
- Cycle 04 was rejected because its `report.md`/`verify.md` claimed a 6-file diff while the attempt
  branch changed 17 files and carried cycle-03 work the report said it had not. This cycle owns the
  re-applied work in *its own* records and leaves cycle 04's commit `e6f20e6` records as the
  historical description of cycle 04's own two commits. `report.md` here lists the full diff.

## Checks

- `npm run check:all` (the suite the gate runs; 200+ checks).
- `npm run test:typecheck`, `npm run test:lint`, `npm run test:security`, `npm run docs:check`.
- Independent `reviewer` subagent on `git diff a385401..HEAD` against `autonomy/CHARTER.md`.
- The supervisor's gate (`/opt/autonomy/gate.sh`) runs on the pushed head; this cycle's local run is
  evidence, not a substitute.

## Out of scope

- `.github/workflows/release.yml` pack parsing (release pipeline — out of bounds); backlog `B-007`.
- `runtimeLock()` optional/peer dependency closure (low, no current consumer); backlog `B-008`.
