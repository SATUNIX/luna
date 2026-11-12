# Cycle 08 — Verify (run `luna-ops-01`, stream ops)

- Base `83a3ad872d47` (head of `stream/ops`); branch `pi/luna-ops-01`; verified head `c74e679`, pushed.
- Reviewed diff (excluding `package-lock.json`, this cycle's records and the run records):
  49,415 characters — under the 60,000-character reviewer read budget, over the 30,000-character
  "stop taking new items" line, so PG-46 was not started.
- Files changed: `packages/core/lib/journal.ts`, `packages/core/journal.ts`, `tests/docs-smoke.ts`
  (PG-20); `packages/extensions/third_party/subagent/workflow.ts`, `plan.ts`, docs, skill
  (PG-45 carry-over); `tests/perf-budget.ts`, `tests/redaction-corpus-smoke.ts`,
  `tests/firewall-gate-smoke.ts` (DE-93); `packages/core/eval/footprint-baseline.json` (the
  deliberate footprint repair). No `autonomy/CHARTER.md`, no `package.json` `scripts`, no
  operator control path.
- `npm test` and `npm run check:all` were deliberately not run (host gate runs the full suite);
  only the targeted checks below.

## Checks run at the verified head

| Check | Result | Proving line |
|---|---|---|
| `npm run -s test:typecheck` | exit 0 | all workspaces type-check |
| `npm run -s test:lint` | exit 0 | `--max-warnings 0` |
| `npm run -s smoke:docs` | exit 0 | `[docs-smoke] OK: 14 documented commands validated, 62 relative links resolved` |
| `npm run -s smoke:eval-footprint` | exit 0 | `all 11 checks passed` |
| `npm run -s smoke:subagent-roles-isolation` | exit 0 | `all 7 checks passed` |
| `npm run -s smoke:workflow` | exit 0 | `all 14 checks passed` |
| `npm run -s smoke:workflow-plan` | exit 0 | `91 checks passed` |
| `npm run -s smoke:redaction-corpus` | exit 0 | `all 6 checks passed` |
| `npm run -s smoke:firewall-gate` | exit 0 | `all 19 checks passed` |
| `npm run -s smoke:run-query` | exit 0 | `one query over every run format verified (8 groups)` |
| `npm run -s smoke:workflow-redaction` | exit 0 | `4 checks passed` |
| `node packages/core/journal.ts --check` | exit 0 | `journal: every report has a journal entry` |
| `npm run -s check:all -- --check-wiring` | exit 0 | `check-all: every test file is wired into a script and asserts something` |

`npm run -s smoke:workflow-resume` is a pre-existing flake: it fails on the clean base
`83a3ad872d47` and intermittently on this head (timing-shaped checkout-queue assertion), and is
recorded in `autonomy/proposals/luna-ops-01-08-flaky-resume-checkout.md` rather than papered over.

## Independent review

A read-only `reviewer` subagent reviewed the whole diff (excluding records and the lockfile) twice.
The first pass returned **PASS** with one actionable warning: `reportDecisions` could link an
`autonomy/decisions/*.md` path a report merely named, so `syncJournal` could derive a line its own
`checkJournal` rejects. That was fixed (`558744d`, threading `root` and filtering to existing
files) and pinned by two new `docs-smoke` fixtures (`c74e679`). The second pass returned **PASS**
and confirmed no fail-closed control was weakened.

## Per-item verification

### PG-20 — derive the journal line from the report

- `journalLineFor`/`syncJournal` derive the `Board:`/outcome/summary/decisions line from
  `report.md`; `checkJournal` still fails hard on a genuinely missing entry.
- Fixtures in `tests/docs-smoke.ts`: identical duplicate accepted, conflicting duplicate rejected,
  missing entry named with the exact line to add, and the new ones — a report naming a nonexistent
  decisions file derives a line with no link that `checkJournal` accepts, while a report naming an
  existing file gets the link and satisfies the Board-and-reference rule.
- `node packages/core/journal.ts --check` exit 0.

### PG-45 carry-over — the plain-text gate reads the verdict line

- `gatePasses` matches a plain-text pass only on the last non-empty line; the `/regex/` path is
  unchanged. `tests/workflow-smoke.ts` (14/14) covers the FAIL-in-prose and quoted-earlier-PASS
  cases. `PLAN_DESCRIPTION`, `docs/reference.md`, `docs/workflows.md` and the workflow-authoring
  skill describe the rule. The footprint repair records the deliberate new tool-text size.

### DE-93 — load-independent perf assertions

- `tests/perf-budget.ts` `assertSubQuadratic` compares 1x and 4x timings and fails only when the
  large run exceeds `max(small, 2 ms) * 10`, so host speed no longer decides the gate.
  `tests/redaction-corpus-smoke.ts` (6/6) and `tests/firewall-gate-smoke.ts` (19/19) use it, and a
  fixture proves a synthetic quadratic function is rejected and a 10x-slowed linear function
  accepted.

## Residual risk / not verified here

- PG-46 (review a red-gate cycle) was **not taken**: the diff already exceeded the 30,000-character
  stop line. Recorded honestly, not silently skipped.
- The host acceptance gate (`/opt/autonomy/gate.sh`) is run by the supervisor on the pushed head; it
  was not run here by policy.
- The `workflow-resume` flake is diagnosed but not fixed, per the proposal.
