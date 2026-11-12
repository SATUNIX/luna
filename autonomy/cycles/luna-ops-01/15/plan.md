# Cycle 15 plan — run `luna-ops-01` (stream `ops`), mode fix

Mode: **fix**. Priority order from the brief: (0) red gate/broken branch, (1) upstream merge
conflict, (2) assigned board items, (3) HANDOFF carry-overs, (4) defects found. Items 0 and 1
dominate this cycle (the P0 upstream merge); the remaining budget goes to the assigned P0/P1 and
the defects the review surfaced in the carried PG-56 code.

## Goal

Land the mandated upstream merge and the reviewable subset of cycle 14 (PG-56 + the installer
carry-over) on a green branch, fix the two real defects those carry, and record the work so the
next cycle can continue.

## Intended changes and proving checks

1. **Merge `refs/upstream/trunk` (`5a888fe`) into `stream/ops` (P0).** Re-use the reviewed cycle-14
   merge `9b751ee`; on a clean re-land branch recreate it against `origin/stream/ops` (`616aa06`).
   Conflicts `tests/firewall-gate-smoke.ts`, `tests/redaction-corpus-smoke.ts` resolved keeping
   both `assertSubQuadratic` and `assertCpuWithin`.
   *Proof:* `git diff --quiet` that the re-land tree equals the run head for all non-record paths;
   `smoke:firewall-gate` 20/20, `smoke:redaction-corpus` 6/6, `smoke:docs`.

2. **PG-56 [P0] — surface unpublished merged work** (carried, `6aabc4d`). Read-only
   `status`/`top`/`inbox`/`doctor` view over `mirror.git`; `doctor` exits 3 while ahead.
   *Proof:* `npm run -s smoke:autonomy-cli` 21/21 (four PG-56 checks), `smoke:docs` for
   `docs/autonomy.md`.

3. **Defect in the carried PG-56 code: `publish()` must advance `refs/integration/remote`.**
   `packages/autonomy/lib/gitmirror.ts` `publish()` pushed the integration branch but left the
   tracking ref stale, so a published run still reported `unpublished:` and `doctor` exited 3.
   Fix: after a successful push that included the integration branch, record its head in
   `refs/integration/remote`.
   *Proof:* new assertions in `tests/autonomy-smoke.ts` that a publish records and advances the
   ref; `smoke:autonomy` 32/32.

4. **Defect in the carried PG-56 code: a recovery must clear a stale failure.**
   `packages/autonomy/lib/unpublished.ts` `lastPublishFailure()` returned an old failure even after
   a newer `"publish recovered"` line. Fix: the most recent publish outcome wins.
   *Proof:* new check in `tests/autonomy-cli-smoke.ts` (fail → recovery) that the reason is cleared
   and `inbox` drops the run from "waiting on operator"; `smoke:autonomy-cli` 21/21.

5. **Installer carry-over** (`6f5e765`): clean `--scope` errors and `--help`/`-h`.
   *Proof:* `smoke:install-marker`.

## Out of scope / deferred

- **PG-52** (the path-glob → check mapping and `--for-changed`) is not started; review records the
  precise addition point and the carry-over.
- **PG-53** stays deferred (re-landing the tool-firewall boundary probe on a 73-file merge is
  unverified risk).
- The rest of cycle 14 (its record commits) stays on `origin/attempts/luna-ops-01/cycle-14`; the
  HANDOFF lists it.

## Constraints honoured

- No network, no new dependencies. Never run `npm test`/`npm run check:all` here; run the targeted
  `npm run -s smoke:<name>` for every changed file. No change to `autonomy/CHARTER.md`, operator
  control paths or any `package.json` `scripts`; no check weakened. Each logical change is one
  commit with finding / root cause / fix / verification, pushed after each.
- The authored diff (excluding lockfile and record files) is measured after every commit; stop
  taking new items once it exceeds 30,000 characters and keep it under the 60,000 review budget.
