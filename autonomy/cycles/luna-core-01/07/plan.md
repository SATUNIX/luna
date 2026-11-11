# Plan — cycle 07, run `luna-core-01`, stream `core`

Mode: **fix**. Base `f0d6ede22af4`. Budget ~$5 / 3 h; diff read budget 60,000 chars, stop new items
at 30,000.

## Items

### Item 1 (board PG-27) — record the already-implemented eval baseline as done

No change. The acceptance is already met on the base (see `review.md`). Recorded in `report.md` as
`done - no work needed`. This is bookkeeping, not a commit.

### Item 2 (board PG-51) [P0] — make the smoke timing guards load-tolerant

**Justification (charter 1):** a reproduced reliability defect: `firewall-gate-smoke.ts:592` fails at
799 ms > 200 ms and `redaction-corpus-smoke.ts:157-168` at 1854 ms > 1000 ms under CPU load on
correct code; `env-isolation-smoke.ts` fails downstream because it spawns `firewall-gate-smoke`.
**Charter 2 (tested):** the guards keep protecting linear time; a unit test proves a quadratic rule
still fails. **Charter 3 (documented):** the new helper and the load-check script are documented.

**Change:**

1. New `tests/timing.ts`: `cpuMs()` (`process.cpuUsage()` user+system / 1000), `bestCpuMs(attempts,
   fn)` (minimum CPU ms over repeats) and `assertCpuWithin(label, budgetMs, fn)` (best-of-three CPU
   time vs the same budget, same failure semantics). CPU time excludes descheduled time, so a busy
   host does not inflate it while catastrophic backtracking still does.
2. Convert the eight CPU-bound guards in `review.md` from `performance.now` / `Date.now` to
   `assertCpuWithin` **without changing any budget** — the same property, a load-independent unit:
   - `firewall-gate-smoke.ts:592` (200 ms)
   - `redaction-corpus-smoke.ts:157-168` (200 / 1000 ms)
   - `workflow-redaction-smoke.ts:147,149` (ratio + 2000 ms, ratio measured in CPU time)
   - `save-smoke.ts:227` (200 ms)
   - `tool-firewall-smoke.ts:489` (2000 ms)
   - `workflow-plan-smoke.ts:1238,1289` (300 / 150 ms)
   - `skill-routing-smoke.ts:86` (2000 ms)
   - `compress-smoke.ts:288` (2000 ms)
3. Self-test in `firewall-gate-smoke.ts`: `assertCpuWithin` with a deliberately catastrophic regex
   (`/^(a+)+$/` on a short run) must throw, proving the guard still fails a quadratic rule on any host
   (the acceptance's "a deliberately quadratic regex still fails the firewall-gate smoke").
4. New `tests/timing-load-check.ts`: starts `os.cpus().length` CPU burners, runs each changed smoke
   five times, and exits non-zero unless every run passes. Not wired into the gate (it burns CPU by
   design); run directly for the acceptance evidence.
5. Docs: add a short note where the smoke conventions live (`docs/ARCHITECTURE.md` near the eval /
   test section) and a `CHANGELOG.md` entry.

**Checks that prove it:** `node tests/timing-load-check.ts` (every changed smoke 5x under full load);
`node tests/firewall-gate-smoke.ts`, `node tests/redaction-corpus-smoke.ts`, `node
tests/workflow-redaction-smoke.ts`, `node tests/save-smoke.ts`, `node tests/tool-firewall-smoke.ts`,
`node tests/workflow-plan-smoke.ts`, `node tests/skill-routing-smoke.ts`, `node
tests/compress-smoke.ts`; `npx tsc -p tests/tsconfig.json`; `npm run test:lint`;
`node packages/core/check-all.ts --check-wiring`. No package.json `scripts` edit.

**Do not run** `npm test` or `npm run check:all` (10 min+; the host gate runs them). Only targeted
`smoke:<name>` / `test:<name>` scripts for the files changed.

## Diff budget

This is the only code item; expected well under 30,000 chars, so it does not block.

## Acceptance / done

- PG-51: the load-check script passes all changed smokes 5x under full CPU load; the quadratic
  self-test proves the guard has teeth; the eight guards keep their original budgets.
- PG-27 recorded done.
- Independent reviewer (not the implementer) checks the diff against this plan and the charter.
