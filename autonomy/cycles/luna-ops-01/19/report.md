Outcome: successful
Mode: fix
Board: PG-52 done - a cycle now derives its verify list from its own diff via a data table, a `--for-changed` plan printer, and a prompt rule that records each check RAN or SKIPPED
Item: PG-52 derive a cycle's verify list from changed files - 0ce02ec - `smoke:autonomy-selfimprove` (41/41) + reviewer PASS

# Cycle 19 — derive a cycle's verify list from the changed files

## What changed

A cycle's verify list was assembled by hand while the host gate decided independently from
`package.json`, so a check covering the cycle's own changed files could go unrun until the gate
rejected the cycle (luna-fleet-01/04 missed `smoke:eval-footprint`, `smoke:subagent-roles-isolation`,
`smoke:new-extension`, `verify`; luna-guard-01/03 missed `smoke:workflow-notify`). The mapping is now
data, not prose:

- `packages/core/lib/check-map.ts` — `CHANGED_PATH_CHECKS` (glob -> checks rows), `ALWAYS_CHECKS`,
  `checksForChangedPaths`, `verifyPlan` (the disjoint run/skipped split), and a self-contained
  `**`/`*`/`?` matcher.
- `packages/core/check-all.ts` — `--for-changed=<a,b>` prints `check-all: run:` / `check-all:
  skipped:` and exits 0 without running anything.
- `packages/autonomy/prompts/cycle.md` + `lib/templates/self-improve.ts` — `{{VERIFY_PLAN}}` tells
  the worker to derive the plan from `{{START}}..HEAD` with `--for-changed`, run every planned
  check, and write one RAN/SKIPPED line per check.
- `docs/ARCHITECTURE.md`, `docs/ci-security.md` — describe the new mode.
- `tests/autonomy-selfimprove-smoke.ts` — pins the third_party fixture, the docs-only fixture, the
  table shape (every check exists in `package.json`), the disjoint split, and the prompt text.

## Verification

Targeted checks only (never `npm test` / `npm run check:all`): `smoke:autonomy-selfimprove` 41/41,
`smoke:autonomy-run` 15/15, `smoke:check-all-npm`, `smoke:autonomy` 32/32, `smoke:docs`, `docs:check`,
`test:typecheck`, `test:lint`, `verify` — all PASS. The plan for this cycle's own diff named
`docs:check`, `smoke:autonomy`, `smoke:autonomy-run`, `smoke:autonomy-selfimprove`,
`smoke:check-all-npm`, `smoke:docs`, `test:lint`, `test:typecheck`, `verify` (run/skipped split in
`verify.md`). Diff 26080 chars. An independent reviewer that did not write the change returned PASS
on all seven acceptance points.

## Left / next cycle should know

- Non-blocking: `checkNames()` prints an informational `check-all: skipping test:security: …` line
  before the `--for-changed` plan. It runs nothing; a follow-up could suppress it in plan mode.
- The re-land requirement is unchanged: the run branch `pi/luna-ops-01` is non-promotable (it carries
  the cycle-12 `-s ours` bridge ancestry); the integrator must fast-forward `stream/ops` from
  `pi/luna-ops-01-reland`, and cycle 19's commit must be re-landed onto it.
- `--for-changed` is opt-in and does not change the default gate path, so no control change is
  proposed.
- No new proposal this cycle: no out-of-stream problem, no control-path change.
