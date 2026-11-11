# Handoff — run `luna-core-01`, stream `core`

## Where the work stands

- Branch `pi/luna-core-01`, base `f0d6ede22af4` (head of `stream/core`, cycle 06 merged). Cycle 07
  commits, all pushed: `8e290d3` (PG-51), `29d7379` (reviewer's skill-routing bound fix), plus the
  records under `autonomy/cycles/luna-core-01/07/` and
  `autonomy/proposals/luna-core-01-07-skill-trigger-wall-cap.md`.
- Cycle 07 outcome: **successful** (fix).
- Reviewable diff 36,933 chars — under the 60,000 read budget, past the 30,000 stop-new-items mark.

## What cycle 07 did

1. **Board PG-51 (fix).** Eight smoke guards bounded linear time with wall clock
   (`performance.now` / `Date.now`), which includes descheduled time; on a busy host they failed
   correct code (`redact on 200 KB of "a-" took 799 ms` vs 200 ms; redaction-corpus 1854 ms vs
   1000 ms; `env-isolation-smoke` downstream). New `tests/timing.ts` (`cpuMs`, `bestCpuMs`,
   `assertCpuWithin`) measures `process.cpuUsage()` user+system; all eight guards converted with
   every budget unchanged. A self-test in `tests/firewall-gate-smoke.ts` proves a catastrophic
   `/^(a+)+$/` rule still blows a 40 ms CPU budget. New `tests/timing-load-check.ts` runs each
   changed smoke 5× under a CPU burner per core — 40/40 passed.
2. **The same load exposed two real defects, both fixed in `8e290d3`.** (a) The skill-router's
   untrusted `re:` guard used `node:vm`'s 50 ms timeout, which is wall clock, so a busy host
   switched off a correct `codebase-navigation` trigger (`expected ["codebase-navigation"] got []`,
   2/5 under load); `match.ts` now decides on a 50 ms CPU budget with a 500 ms wall cap to
   interrupt a runaway match and one retry. (b) `workflow-plan-smoke`'s 40 ms plant timer fired
   after run cleanup (`ENOENT ... symlink`); it now waits for m1's output file.
3. **Reviewer fix in `29d7379`.** The skill-routing bound wrapped a caching function in
   best-of-three (two cached no-ops made it vacuous); it now times one real run.
4. **Board PG-27** was already done and merged in cycle 06; recorded, no work needed.

## Checks that were run

`node tests/timing-load-check.ts` (40/40 under full CPU load), the eight changed smokes plus
`env-isolation`, `npx tsc -p tests/tsconfig.json`, `npx tsc -p packages/core/tsconfig.json`,
`npm run test:lint`, `node packages/core/check-all.ts --check-wiring`, `node tests/docs-smoke.ts`,
`node tests/eval-baseline-smoke.ts`, `node packages/core/eval/baseline.ts --check` — all PASS. Never
run `npm test` or `npm run check:all`. See `verify.md`.

## Merge

Cycle complete; every targeted check passes and an independent `subagent` reviewer returned
`VERDICT: PASS`. Its one warning was fixed before the cycle closed. Merge `pi/luna-core-01` into
`stream/core` only after the acceptance checks pass on a clean checkout.

## Carry over to the next cycle

1. The skill-router `re:` trigger wall cap is now 500 ms per trigger (was 50 ms wall) because a CPU
   budget cannot interrupt a running match. Bounded (switch-off is per session, `safe-regex.ts`
   caps the pattern), but tightening it is an operator choice —
   `autonomy/proposals/luna-core-01-07-skill-trigger-wall-cap.md`.
2. `packages/core/install.ts`'s npm/`trunk` guard is untested while `distribution.json` has no
   `npm.enabled`; add a test when npm delivery is enabled. The rest of
   `autonomy/proposals/luna-core-01-05-npm-trunk-channel.md` is implemented and can be closed.
3. Cycle 03's env-ownership work (`472a37f`, `0b02622`, `31d77ca`) is on
   `origin/attempts/luna-core-01/cycle-03` only; sound but not re-verified on this base.
4. Proposal `luna-core-01-03-codeowners-dead-path.md`: `.github/CODEOWNERS:43` names a path with 0
   tracked files. `.github/` is a control path — operator decision.
5. Defect IDs V-07/V-08/V-10 still have no in-tree finding list; need the operator's list.
6. The `coverage` CI job is red owner-side; not touched, per the steward.

## Rules for the next session

One logical change per commit (finding, root cause, fix, verification), push after each commit,
targeted checks only, diff read budget 60,000 chars and stop new items past 30,000, never edit
`.github/`, `autonomy/CHARTER.md`, or operator control paths (propose them instead). The only
allowed `package.json` edit is adding `smoke:<name>` → `node tests/<name>-smoke.ts`. Cite only the
new board-id shape (`PG-<n>`, `DE-<n>`); old single-letter-hyphen-digit ids are blocked by the
pre-push leak scan. Never run `npm test` or `npm run check:all`; run targeted smokes. A long
subagent can hit the 30-minute wall limit — check its staged output rather than re-dispatching
blind.
