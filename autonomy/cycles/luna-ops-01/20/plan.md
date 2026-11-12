# Cycle 20 plan — luna-ops-01 (ops stream)

Mode: **fix** (consolidation of the merged PG-52 improvement). Single item; precedence (0) gate
green, (1) no upstream conflict, (2) board item PG-52.

## Item 1 — PG-52: make `--for-changed` cover copy pairs and test files

**Justification (charter 1, evidence).** Cycle 19's map still omits checks the gate runs on the
cycle's own files, the exact defect PG-52 exists to fix:
`--for-changed=packages/extensions/src/secret-guard/index.ts` and
`--for-changed=packages/autonomy/lib/templates/common.ts` both print
`check-all: skipped: smoke:workflow-notify`; `--for-changed=tests/autonomy-selfimprove-smoke.ts`
never plans `smoke:autonomy-selfimprove` (review.md, reproduced at `6aeb90441a4b`).

**Change.**
- `packages/core/lib/check-map.ts`:
  - Add data rows for both source sides of the `smoke:workflow-notify` byte-copy assertion:
    `packages/extensions/src/secret-guard/**` -> `smoke:secret-guard`, `smoke:workflow-notify`;
    `packages/autonomy/lib/templates/common.ts` -> `smoke:workflow-notify` (the row stays data).
  - Union the table with checks whose package.json script directly runs a changed file: import
    `scriptTargets` from `./wiring.ts`; `checksForChangedPaths(paths, scripts?)` and
    `verifyPlan(paths, knownChecks, scripts?)` gain the optional scripts record. Only names in the
    check namespace (`smoke:` / `test:` / the exact checks) are added. The table remains the spine.
  - Export the check-name prefix/exact constants so `check-all.ts` reuses them (one definition).
- `packages/core/check-all.ts`:
  - `checkNames()` announces the covered-aggregate skip line only when asked; `runAll` asks once,
    `buildRuns` does not, and plan mode (`--for-changed`) does not. This ends the duplicate line
    and the contradictory line in plan mode.
  - The plan branch calls `verifyPlan(paths, <runnable names>, scripts)` so the plan lists exactly
    the gate's checks (a covered aggregate such as `test:security` is not a gate check and no
    longer appears as SKIPPED; the aggregate's own files still plan their checks).
- Docs: `docs/ci-security.md` and `docs/ARCHITECTURE.md` note that a changed file a check runs
  (a test file, or either side of a copy pair) plans that check.

**Tests.**
- Extend the `check-map` case in `tests/autonomy-selfimprove-smoke.ts`
  (`smoke:autonomy-selfimprove`): the secret-guard-source fixture plans `smoke:workflow-notify`
  and `smoke:secret-guard`; the `templates/common.ts` fixture plans `smoke:workflow-notify`; a
  fixture scripts record maps `tests/foo-smoke.ts` to `smoke:foo` via `scriptTargets` and
  `verifyPlan` splits it disjointly; the existing third_party and docs-only assertions still hold.
- Extend `tests/check-all-npm-smoke.ts` (`smoke:check-all-npm`): `--for-changed` output contains
  no `skipping test:security` line and plans `smoke:workflow-notify` for the secret-guard source.
- `docs/check` (`smoke:docs`, `docs:check`) after the doc edits.

**Checks that prove it.** `smoke:autonomy-selfimprove`, `smoke:check-all-npm`, `smoke:docs`,
`docs:check`, `test:typecheck`, `test:lint`, `verify`, plus the manual fixtures in `verify.md`.
Never `npm test` / `npm run check:all`.

**Acceptance / scope.** All cycle-19 PG-52 acceptance points still hold (third_party fixture,
docs-only fixture, RAN/SKIPPED split, mapping is data); the three reproduced gaps above close.
One logical change; diff well under the 30000-char new-item stop line. No control path, no
`package.json` script, no charter edit.
