# Cycle 5 verify — stream `fleet` (luna-fleet-01/05)

Item: O-01/PG-03, autonomous container runs in `workflow_status` and `/workflows`, carried from
cycle 4 and repaired. Base `83a3ad872d47`, head `e53e06e` before this record. Reviewable diff
excluding records and the lockfile: 44,622 characters (`git diff --no-renames 83a3ad872d47..HEAD --
. ":(exclude)package-lock.json" ":(exclude)autonomy/cycles/luna-fleet-01/"
":(exclude)autonomy/runs/luna-fleet-01/" | wc -c`), under the 60,000 limit.

Per cycle rules `npm test`, `npm run check:all` and `/opt/autonomy/gate.sh` were not run; the
targeted checks below cover every changed file.

| Check | Result | Proving line |
| --- | --- | --- |
| `node tests/run-query-smoke.ts` | PASS (exit 0) | `[run-query-smoke] one query over every run format verified (8 groups)`; autonomy live/blocked/stale/reused, fresh foreign heartbeat live, stale foreign not live, spend, blocker, malformed and traversal dirs skipped |
| `node tests/eval-footprint-smoke.ts` | PASS (exit 0) | `[eval-footprint-smoke] all 11 checks passed`; balanced `8901 < 9500`, delegation `4712 < 4900` |
| `node tests/subagent-roles-isolation-smoke.ts` | PASS (exit 0) | `[subagent-roles-isolation-smoke] all 7 checks passed`; tool text under 4,900 |
| `node tests/new-extension-smoke.ts` | PASS (exit 0) | `new-extension smoke: OK` (notices no longer stale) |
| `node packages/core/verify.ts` | PASS (exit 0) | `[verify] All checks passed.` |
| `node tests/workflow-panel-smoke.ts` | PASS (exit 0) | `workflow-panel-smoke: 14 checks passed` |
| `node tests/autonomy-run-smoke.ts` | PASS (exit 0) | `[autonomy-run-smoke] all 15 checks passed` |
| `node tests/docs-smoke.ts` | PASS (exit 0) | `[docs-smoke] OK: 14 documented commands validated, 62 relative links resolved; ...` |
| `npx tsc -p tsconfig.json` | PASS (exit 0) | no diagnostics |
| `npx tsc -p tests/tsconfig.json` | PASS (exit 0) | no diagnostics |
| `npx eslint --flag unstable_native_nodejs_ts_config --max-warnings 0` on changed TS | PASS (exit 0) | no diagnostics |

## Red checks cycle 4 left (reproduced, then fixed)

On base plus cycle-4's diff, `eval-footprint-smoke` failed `3/11` (balanced `9016` vs baseline
`8919`, lite `7711` vs `7614`, delegation `4827` vs `4730`), `subagent-roles-isolation-smoke` failed
at `4977 > 4,900`, and `new-extension-smoke` + `verify` failed with
`THIRD_PARTY_NOTICES.md is stale`. The fix shortens the `workflow_status` description, updates the
reviewed baseline to the measured `8901`/`4712`, and regenerates `docs/reference.md` and the notices.
All three now pass; `verify` passes.

## Independent review

The workflow-run reviewer returned `VERDICT: FAIL` on `bc82356` for two required fixes: a foreign
host with a fresh heartbeat must read live (matching `packages/autonomy/lib/runlock.ts`
`assessLock`), and the `/workflows` description plus `promptSnippet` still named only workflow and
subagent runs. `e53e06e` fixes both, uses the bounded `readRunFile` helper for autonomy JSON,
documents `budget_exhausted` as non-terminal, and adds a stale-foreign fixture. A second independent
review of `e53e06e` returned `VERDICT: PASS` after re-running every targeted check and measuring the
44,622-character diff.

Residual warnings from that review (not acceptance blockers): `autonomyStateOf` does not check
`schemaVersion`; the /proc-only start-time read cannot detect pid reuse off Linux where `assessLock`
falls back to `ps`; blocked and budget-exhausted runs keep an open-ended elapsed time by design; the
same-id precedence comment names only workflow/script rows though any earlier row wins.
