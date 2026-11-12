# Cycle 19 plan — luna-ops-01 (ops stream)

Mode: **fix** (assigned board item PG-52). Single item; precedence (0) gate green, (1) no upstream
conflict, (2) PG-52.

## Item 1 — PG-52: derive the cycle's verify list from changed files

**Change.** Add `packages/core/lib/check-map.ts`:
- `CHANGED_PATH_CHECKS: readonly { glob: string; checks: readonly string[] }[]` — the data table.
  Rows (globs use the `**`/`*` dialect):
  - `packages/extensions/third_party/**` -> `verify`, `smoke:new-extension`,
    `smoke:eval-footprint`, `smoke:subagent-roles-isolation`, `smoke:workflow-notify`
    (vendored extension text changes registered tool text and the byte-copied fence).
  - `packages/extensions/**` -> `smoke:new-extension`, `verify`.
  - `packages/core/eval/**` -> `smoke:eval-footprint`.
  - `packages/kit/**` -> `verify`, `smoke:autonomy-selfimprove`.
  - `docs/**` and `**/*.md` -> `smoke:docs`, and `docs/**` also `docs:check`.
  - `tests/**` -> `smoke:check-all-npm`? (only if a real script covers it) — keep to checks that
    exist.
- `ALWAYS_CHECKS` baseline (`verify`, `test:typecheck`, `test:lint`) unioned with matches.
- `checksForChangedPaths(paths): string[]` — sorted, de-duplicated plan.
- `verifyPlan(paths, knownChecks): { run: string[]; skipped: string[] }` — the run/skipped split,
  testable.
- Small self-contained glob matcher (mirrors `packages/autonomy/lib/glob.ts`).

Wire it up:
- `packages/core/check-all.ts`: `--for-changed=<comma-separated paths>` prints the plan (and the
  run/skipped split) and exits without running checks; documented in the header and `--help`.
- `packages/autonomy/lib/templates/self-improve.ts` `cyclePrompt()`: render a `{{VERIFY_PLAN}}`
  block instructing the worker to derive the list from `{{START}}..HEAD` via
  `--for-changed`, run every planned check, and record in `verify.md` which ran and which were
  skipped.
- `packages/autonomy/prompts/cycle.md`: accept `{{VERIFY_PLAN}}` in the ground rules / verify step.

**Tests.** Extend `tests/autonomy-selfimprove-smoke.ts` (script `smoke:autonomy-selfimprove`) with
cases over `checksForChangedPaths` / `verifyPlan`: the SOURCE.md + workflow-tools.ts fixture
includes the four required checks; a docs-only diff includes `docs:check` and none of the tool-text
checks; the table is data (array of `{glob, checks}` objects); the split is disjoint and together
equals the known set. `smoke:check-all-npm` and `smoke:autonomy-run` cover the CLI/prompt wiring.

**Checks to run.** `smoke:autonomy-selfimprove`, `smoke:autonomy-run`, `smoke:check-all-npm`,
`smoke:docs`, `test:typecheck`, `test:lint`, `node packages/core/check-all.ts --for-changed=...`
manually, `node packages/core/verify.ts`. Never `npm test` / `npm run check:all`.

**Acceptance.** All four PG-52 acceptance points above; diff well under the 30000-char stop line.
