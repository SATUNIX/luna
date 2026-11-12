# Cycle 06 — Verify (run luna-ux-01, stream `ux`)

Base `8416c502acc4`, head `88bc809d` before the proposal and record commits. `npm test` and
`npm run check:all` were not run, per the cycle rules. The check plan was derived with
`node packages/core/check-all.ts --for-changed="$(git diff --name-only 8416c502acc4..HEAD | tr '\n' ',')"`;
it named the ten checks below (all RAN and PASS).

## Targeted checks

| Command | Result | Proof |
| --- | --- | --- |
| `docs:check` | RAN PASS | `[docs-nav-check] OK: nav entries exist and internal links resolve.` |
| `smoke:docs` | RAN PASS | `[docs-smoke] OK: 14 documented commands validated, 62 relative links resolved ...` |
| `smoke:eval-footprint` | RAN PASS | `[eval-footprint-smoke] all 13 checks passed` |
| `smoke:new-extension` | RAN PASS | `new-extension smoke: OK` |
| `smoke:subagent-roles-isolation` | RAN PASS | `[subagent-roles-isolation-smoke] all 7 checks passed` |
| `smoke:workflow-notify` | RAN PASS | `workflow-notify-smoke: 10 checks passed` |
| `smoke:workflow-panel` | RAN PASS | `workflow-panel-smoke: 21 checks passed` (new prune case included) |
| `test:lint` | RAN PASS | exit 0 |
| `test:typecheck` | RAN PASS | exit 0, all projects |
| `verify` | RAN PASS | `[verify] All checks passed.` |

## Acceptance checks added to the plan

| Command | Result | Proof |
| --- | --- | --- |
| `smoke:redaction-corpus` | RAN PASS | `[redaction-corpus-smoke] all 6 checks passed` (the cycle-05 host red does not reproduce) |
| `smoke:tui-layout` | RAN PASS | `tui-layout-smoke: 5 checks passed` |
| `smoke:control-center` | RAN PASS | `[control-center-smoke] all 46 checks passed` (V-93 unchanged) |
| `smoke:autonomy-inbox` | RAN PASS | `[autonomy-inbox-smoke] all 7 checks passed` (V-93 unchanged) |
| `node packages/core/gen-notices.ts --check` | RAN PASS | `[gen-notices] OK: THIRD_PARTY_NOTICES.md is up to date.` |
| `npm run -s gen:shared -- --check` | RAN PASS | `gen-shared: every copy matches its source` |

## Behavioural evidence

- `tests/workflow-panel-smoke.ts` new case: open a finished run, start and finish 25 newer runs
  (`RunRegistry.prune()` drops it), then the list body and list footer render, `esc back` does not,
  `listIndex` is 0, and the first `down` moves it to 1. The independent reviewer confirmed this
  fails at base (`pressRun`'s `!run` fallback leaves `listIndex` at 0) and passes on the head.
- `tests/docs-smoke.ts`: the generic scan fails on the base (eleven of twelve
  `third_party/*/SOURCE.md` have no bolded dated entry) and passes after `17e0d4ab`; the subagent
  pin now selects the entry naming `wf-panel.ts` and `23725c2` and requires its bolded
  `(2026-11-12)` label.
- V-93: no file under `packages/core/shared/` or its generated copies changed this cycle; one
  hand-written class literal remains and `gen-shared --check` is clean.

## Review

An independent `reviewer` subagent read `git diff 8416c502acc4..HEAD` against `autonomy/CHARTER.md`
and the assigned items and returned **PASS** with non-blocking warnings only (the docs sentence does
not spell out that an open confirm still owns the keys; `footer()` looks up `current()` twice).
Neither changes behaviour or tests.

## Budget

Non-record diff is 25,486 characters excluding the lockfile and record files, under the 30,000
stop-new-items line and the 60,000 review limit. No dependencies, scripts or shared helpers added.
