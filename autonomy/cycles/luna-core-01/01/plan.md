# Cycle plan — luna-core-01 / 01

Mode: **fix**. Two items, each with a proving check. One logical change per commit.

Goal: close two evidenced gaps in the `core` stream (agent-efficacy false green + discoverability
env drift) without touching operator control paths, `.github/`, any `package.json` script, or the
charter.

## Item 1 — eval harness must not report green when it ran nothing

- File: `packages/core/eval/run.ts`
- Change: derive the valid category set from `fixtures`; when `--category` is missing a value,
  names an unknown category, or selects zero fixtures, print the usage line to stderr and exit 2.
  Keep the existing `--json` / `--category <valid>` behaviour and exit code 1 for real failures.
- Proving check: a new assertion in an existing eval smoke
  (`tests/eval-footprint-smoke.ts`, registered as `smoke:eval-footprint`) that spawns
  `node packages/core/eval/run.ts --category __no_such_category__` and asserts a non-zero exit and
  a stderr usage message. Without the change the command exits 0, so the assertion fails.
  Second assertion: `--category security` still exits 0 (guard against over-tightening).
- Docs: the usage comment in `run.ts` already lists valid categories; extend it to state that an
  invalid category is refused. No generated page covers this script.

## Item 2 — declare the message-budget env var so the reference lists it

- Files: `packages/extensions/src/context-sieve/extension.json`, regenerated `docs/reference.md`,
  `tests/extension-manifest-hooks-smoke.ts`.
- Change: add `"PI_KIT_CTX_MESSAGE_BUDGET_TOKENS"` to the context-sieve `env[]`, regenerate
  `docs/reference.md` with `node packages/core/reference.ts`, and add
  `"context-sieve": ["PI_KIT_CTX_BUDGET_TOKENS", "PI_KIT_CTX_MESSAGE_BUDGET_TOKENS"]` to the
  `ENV_ALLOWLIST` (this is exactly the targeted pin the test was built for).
- Proving check: `node tests/extension-manifest-hooks-smoke.ts` — without the manifest/pin change
  the new `assert.deepEqual` fails. `npm run verify` (reference regen check) fails if the manifest
  is edited without regenerating `docs/reference.md`.

## Checks to run (targeted only — never `npm test` / `npm run check:all`)

- `node tests/eval-footprint-smoke.ts`
- `node tests/env-isolation-smoke.ts` (spawns `eval/run.ts`; guards the exit-code contract)
- `node tests/extension-manifest-hooks-smoke.ts`
- `node packages/core/reference.ts --check`
- `npm run smoke:docs`

## Task graph

1. Item 1 implement + commit + push
2. Item 2 implement + commit + push
3. Independent review of the full diff against the charter; then verify/report/HANDOFF.

## Out of scope (recorded, not worked)

- `.github/CODEOWNERS` dead path (outside area).
- Broad env-manifest drift beyond the one user-facing var.
- The `V-*` defect IDs (no in-tree list).
