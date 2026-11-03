# Cycle 05 review — luna-improve-01

- Run: `luna-improve-01`, cycle 5 of 200 — **Mode: fix**
- Branch: `pi/luna-improve-01`
- Cycle start: `a385401` ("chore(autonomy): seed integration/luna", the current head of
  `integration/luna`; `origin/pi/luna-improve-01` also points here)
- Environment: Node `v26.12.1`, npm `12.2.1`, rootless container, offline.

## Context

Cycle 04 ended `successful` on `origin/attempts/luna-improve-01/cycle-04` but was **not merged**
into `integration/luna`: the independent review rejected it because its `report.md`/`verify.md`
claimed a 6-file, two-item diff while the attempt branch actually changed 17 files and carried the
cycle-03 work the report said was "not re-applied here". So this cycle starts from `a385401`, which
has none of that work, and must re-apply the sound parts, correct the record mismatch, and verify.

The prior session of this run had already re-applied the carried commits onto this branch and fixed
the cycle-04 records; that session exited before verification. This cycle keeps the re-applied
commits, restores cycle-04's own records to their historical (rejected-attempt) state so that this
cycle owns the re-application, re-verifies everything, and records the result.

## Findings

### F-01 (confirmed) — npm 12 breaks every `npm pack --json` parser (acceptance failure)

- Evidence: the base parsers accept only the npm ≤ 11 array:
  `a385401:packages/core/build-npm.ts:34` (`const PackDryRun = array(object({ files: ... }))`),
  and a private copy in `packages/core/pack-check.ts`. npm here is `12.2.1`, which prints an object
  keyed by package name, so `smoke:package` and `smoke:clean-install` fail with
  `ValidationError: npm pack --dry-run: expected array of object with files, got object`.
- Fix: commit `f86177c` adds exported `packReports()`/`PackReportEntry` in `build-npm.ts`, validating
  `union(array(entry), record(entry))` and folding to a flat list; `pack-check.ts` and
  `clean-install-smoke.ts` use it, with a both-shape fixture assertion.

### F-02 (confirmed) — `installDelegation()` is not hermetic against ambient kit env (acceptance failure)

- Evidence: `a385401:packages/core/eval/delegation.ts:49` reads the ambient environment while loading
  the effort extension, before any test isolates it, and saves/restores only three variables. An
  ambient `PI_KIT_EFFORT_CAP` (set by a live pi session, and by this run's environment) clamps the
  fake children, failing eight subagent/workflow smokes (e.g. `smoke:subagent-containment` expects
  `stopReason "timeout"`, gets `"denied"`).
- Fix: commits `fd76bd3` and `fe8a128` call `isolateKitEnv()` before setting the helper's own
  variables and restore that environment in `cleanup()`, deleting the two variables the helper added
  first so the environment returns to its pre-call state.

### F-03 (confirmed) — firewall provenance smoke assumes the initial user namespace

- Evidence: `a385401:tests/firewall-unattended-smoke.ts:601` (and the `refused` default at line 584)
  hard-codes `/neither on a read-only mount nor owned by another user/` for the two real-mount-table
  cases. In this rootless container the process is not in the initial user namespace, so the
  firewall correctly refuses for a different reason and the check fails.
- Fix: commit `14d43dd` exports `currentNamespaceStanding()` from
  `packages/extensions/src/tool-firewall/unattended.ts`, and the smoke expects the
  not-in-initial-user-namespace reason only when the real standing says `initialUser` is false.
- Reviewer concern from cycle 04, answered: this is **not** a loosening. The refusal is still
  asserted, and the strict reason is still asserted deterministically at line 599 (the same-user 0444
  forged file, before the real `/proc` is consulted) on every machine. Only the two cases that
  deliberately read the real mount table adapt their expected reason to the real namespace standing;
  the host path is unchanged. The namespace-specific cases below them are explicit and unaffected.

### F-04 (confirmed) — `smoke:clean-install` cannot install runtime dependencies offline

- Evidence: `a385401:tests/clean-install-smoke.ts:153` runs `npm install --omit=dev` inside the
  unpacked artefact, which needs the registry; the acceptance gate has no network and fails with
  `ENOTCACHED`.
- Fix: commit `794adac` adds `runtimeLock()`, which cuts a lockfile for exactly the artefact's runtime
  dependencies (closed transitively) from the repo `package-lock.json`, and runs
  `npm ci --prefer-offline` against the shipped cache in a scratch directory, then copies the result
  into the unpacked artefact.

### F-05 (confirmed) — `docs/future-work.md` describes the fixed version defect

- Evidence: `a385401:docs/future-work.md` still said "Two version constants still read `0.1.0`
  (`routes.ts`, `configinfo.ts`)", but `f766593` (already re-applied on this branch from cycle 04)
  replaced both with `kitVersion()`. Charter priority 5 (documentation accuracy).
- Fix: commit `92dbeaf` drops the now-false clause and keeps the still-true session-panel sentence.

### Not selected

- `.github/workflows/release.yml` still indexes `require("./pack.json")[0]`, which is `undefined`
  under npm 12's object shape. Fixing it changes a release pipeline, which the charter keeps out of
  bounds; recorded as backlog `B-007` for the operator.

## Backlog checked against the code

- B-001 (web-ui version) — `packages/web-ui/server/routes.ts`/`configinfo.ts` now call `kitVersion()`
  (re-applied as `f766593`, part of the carried cycle-04 commits on this branch); smoke asserts the
  real value. Done.
- B-002 (supervisor log written twice) — `defaultEngineLog`/`stdoutIsFile` present (re-applied as
  `3f8ab1b`); `smoke:autonomy-cli` asserts one write. Done.
- B-003..B-006 (npm 12 pack shape, offline clean-install, delegation hermeticity, namespace-aware
  firewall smoke) — confirmed against the base lines above and fixed in this cycle.
- B-004 follow-up from `HANDOFF.md` (the old numbering: `runtimeLock()` resolves only
  `dependencies`) — still true; noted as new open item `B-008` (low).
- B-007 — open, proposal to operator (release pipeline, out of bounds).

## Outcome

`fix`: six confirmed findings, five fixed by commits on this branch (F-01..F-05), one recorded as an
out-of-bounds proposal (B-007). No new work was invented; the cycle is the resubmission of the
rejected cycle-04 delivery with the record mismatch corrected and the full gate run.
