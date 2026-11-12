# Verify — cycle 07, run `luna-core-01`, stream `core`

Base `f0d6ede22af4`; commits `8e290d3` (PG-51) and `29d7379` (skill-routing bound fix). Diff
36,933 chars against the base (records/lockfile excluded) — under 60,000, past the 30,000
stop-new-items mark.

## Acceptance (PG-51)

- `node tests/timing-load-check.ts` — **all 40 runs passed under full CPU load** (8 changed smokes
  × 5 runs, one CPU burner per core). This is the board's acceptance. Note: 12 orphaned burners
  from an aborted first attempt were still running, so the passing run had roughly 2× the
  intended load.
- Catastrophic-regex teeth: `tests/firewall-gate-smoke.ts` asserts a quadratic rule
  (`/^(a+)+$/`) still blows a 40 ms CPU budget; the reviewer reproduced it throwing
  (`510 ms of CPU (budget 40 ms)`). A weakened no-op guard would make `assert.throws` fail.
- Every converted guard kept its original budget (reviewer checked all eight sites; no budget
  raised). `tests/timing.ts` is the only new helper; `tests/timing-load-check.ts` is deliberately
  not wired into the gate.

## Reproduced defect and fix evidence

- Before: under 12 burners, `firewall-gate-smoke` `redact on 200 KB of "a-" took 799 ms` (budget
  200 ms) and `redaction-corpus-smoke` `'table, curl -u without a password: 1854 ms'` (budget
  1000 ms); `env-isolation-smoke` failed downstream (it spawns `firewall-gate-smoke`).
- CPU time idle vs 12 burners for the same inputs: `"x_token"` 4.0 → 5.8 ms, `"a-"` 23.5 → 35.6 ms,
  `"curl -u "` 62.5 → 95.4 ms (~1.5×, inside the unchanged budgets).
- Skill-router, on the base under load: `skill-routing-smoke` failed 2/5 with
  `expected ["codebase-navigation"] got []`; with the fix it passed 5/5. A correct project `re:`
  trigger was switched off because `node:vm`'s 50 ms timeout is wall clock. Confirmed by reverting
  `match.ts` to `HEAD~1` under the same burners.
- `workflow-plan-smoke` timer race: the load-check found `ENOENT ... symlink
  outside-secret.md` (plant timer fired after run cleanup). Fixed by waiting for m1's output file
  instead of a 40 ms timer; 5/5 under load after the fix.
- Reviewer finding (fixed): `tests/skill-routing-smoke.ts` wrapped stateful `matchTriggers` in
  best-of-three, making the 2000 ms bound vacuous (cached runs ≈ 0 ms). Changed to one real run.

## Ledger

| run | result |
|-----|--------|
| `node tests/timing-load-check.ts` (8 smokes × 5, full load) | PASS (40/40) |
| `node tests/firewall-gate-smoke.ts` | PASS |
| `node tests/redaction-corpus-smoke.ts` | PASS |
| `node tests/workflow-redaction-smoke.ts` | PASS |
| `node tests/save-smoke.ts` | PASS |
| `node tests/tool-firewall-smoke.ts` | PASS |
| `node tests/workflow-plan-smoke.ts` (idle) | PASS |
| `node tests/workflow-plan-smoke.ts` (5× full load) | PASS 5/5 |
| `node tests/skill-routing-smoke.ts` (idle) | PASS |
| `node tests/skill-routing-smoke.ts` (5× full load) | PASS 5/5 |
| `node tests/compress-smoke.ts` | PASS |
| `node tests/env-isolation-smoke.ts` | PASS |
| `node tests/eval-baseline-smoke.ts` (PG-27) | PASS (4 checks) |
| `node packages/core/eval/baseline.ts --check` (PG-27) | exit 0 |
| `npx tsc -p tests/tsconfig.json` | PASS |
| `npx tsc -p packages/core/tsconfig.json` | PASS |
| `npm run test:lint` | exit 0 |
| `node packages/core/check-all.ts --check-wiring` | exit 0 |
| `node tests/docs-smoke.ts` | PASS |

Never ran `npm test` or `npm run check:all`.

## Independent review

`subagent` reviewer over `git diff f0d6ede22af4..HEAD` returned `pass: true` (VERDICT: PASS) and
checked: budgets preserved at all eight sites; `timing.ts` measures `process.cpuUsage` user+system;
the self-test has teeth; docs accurate to the code; no `package.json`, `.github/` or
`autonomy/CHARTER.md` touched; the skill-router change keeps the switch-off control (bounded DoS
trade-off, acceptable). Its one warning (the vacuous skill-routing bound) was fixed in `29d7379`;
the follow-on suggestion to tighten the wall cap is filed as
`autonomy/proposals/luna-core-01-07-skill-trigger-wall-cap.md`.

## Not in scope / left unchanged

Wait-bound assertions (a timer/deadline checked with a large margin: firewall-outcomes /
firewall-unattended / firewall-noeffect, memory-vault, web-console, `clean-install-smoke.ts` 90 s
child answer) protect a hang, not CPU work. CPU time is the wrong unit for them and their headroom
is already ~16×; they are listed in `review.md` and deliberately left alone.
