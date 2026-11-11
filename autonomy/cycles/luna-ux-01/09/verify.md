# Cycle 09 — Verify (run luna-ux-01, stream `ux`)

Base `25cc6eab64b5`; head after the code commit `dbf1c35`.

## Targeted checks (one line per run)

| Command | Result | Proof line |
| --- | --- | --- |
| `node tests/docs-smoke.ts` | PASS | `[docs-smoke] OK: 14 documented commands validated, ...` (exit 0) — the P0 journal gate is green at base |
| `npm run -s smoke:docs` | PASS | same line, exit 0 |
| `git grep -n 'Alias for' packages/extensions/src` | PASS (empty) | no output |
| `npm run -s smoke:command-contract` | PASS | `[command-contract-smoke] all 12 checks passed` |
| `npm run -s catalog` | PASS | writes the five generated docs; `git status --short` clean after |
| `npm run -s smoke:control-center` (with fix) | PASS | `[control-center-smoke] all 31 checks passed` |
| `npm run -s smoke:control-center` (hub.ts reverted to base, test kept) | FAIL | `[control-center-smoke] 1/31 FAILED` (exit 1) — new case is discriminating |
| `npm run -s test:typecheck` | PASS | exit 0 |
| `npm run -s test:lint` | PASS | exit 0 |

No `npm test` or `npm run check:all` was run, per the cycle ground rules.

## Independent review

A reviewer subagent that did not write the change inspected `git diff 25cc6eab64b5..HEAD` against
`autonomy/CHARTER.md` and `plan.md`, traced both the fixed and the pre-fix control flow, and ran
`npm run -s smoke:control-center` (31/31) plus `test:typecheck` and `test:lint` (both exit 0). It
confirmed scope (no `package.json` scripts, `HARNESS_COMMANDS`, command names, handlers, control
paths or `overlay-frame.ts`), strict TypeScript, and docs/code agreement. Verdict: **PASS**.

The first implementer/reviewer pair ran through `workflow_run` (`plan-b15d`): implementer `dbf1c35`,
reviewer passed. Its implementer step committed but did not push; the commit was checked and pushed
directly.

## Diff size

`git diff --no-renames 25cc6eab64b5..HEAD -- . ":(exclude)package-lock.json"
":(exclude)autonomy/cycles/luna-ux-01/" ":(exclude)autonomy/runs/luna-ux-01/" | wc -c` → **4538**
characters, well under the 30000 review budget.

## Failures found and fixed in this phase

None. The P0 the steward named was already green at base (cycle 06 added
`autonomy/JOURNAL.md:18`), and the new control-center case failed before the fix and passed after,
so no fix-and-rerun was needed.
