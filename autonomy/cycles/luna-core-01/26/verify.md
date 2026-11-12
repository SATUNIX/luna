# Cycle 26 verify — luna-core-01

Base `29eeab10123a`; head after `12957da`. Never ran `npm test` or `npm run check:all`.
Every line is a command, its result, and what proves it.

## PG-66 (pre-report diff probe)

- `npm run smoke:autonomy-selfimprove` — **PASS** — `[autonomy-selfimprove-smoke] all 44 checks
  passed` (was 43); the new check reads `OK: an over-budget cycle is caught pre-report: the live
  worker is steered with the measured number, then splits and the next cycle merges`.
- Falsification of that check (temporarily replaced `if (await budgetStale()) continue;` with a
  no-op, ran, then restored `cycle.ts` and `git add`-ed it) — **FAIL as expected** —
  `AssertionError [ERR_ASSERTION]: cycle 1 got a pre-report budget steer`. The fixture therefore
  proves the probe, not just prompt text.
- `npm run test:typecheck` — **PASS** — exit 0 (all eight `tsc -p` projects).
- `npm run test:lint` — **PASS** — exit 0 (`eslint ... --max-warnings 0 .`).
- `npm run smoke:autonomy-run` — **PASS** — `[autonomy-run-smoke] all 15 checks passed`
  (runtime interface unchanged in behaviour).
- Independent reviewer (`subagent`, did not write the change) on `12957da` — **VERDICT: PASS** —
  no must-fix. It independently ran `smoke:autonomy-selfimprove` 44/44, `test:typecheck` and
  `test:lint`, confirmed `diffBudget` matches `mergeDecision`'s range/exclusions, the
  `ReviewDiffRead` change is backward compatible, `budgetStale` is head-guarded and outcome-neutral,
  and the fixture fails without the probe. Non-blocking notes recorded in the proposal.

## V-102 (already-held acceptance re-verified)

- `npm run smoke:brand` — **PASS** — `[brand-smoke] all 18 checks passed`.
- `npm run smoke:kit-update` — **PASS** — `[kit-update-smoke] all 40 checks passed`.
- `npm run smoke:install-marker` — **PASS** — `[install-marker-smoke] all checks passed`.
- `npm run verify` — **PASS** — `[verify] All checks passed.`
- `npm run test:security` — **PASS** — exit 0 (tail: `kit-root-trust-smoke: 10/10 passed`).
- `npm run gen:shared` — **PASS** — no drift (`git status --porcelain` empty afterwards).
- `/update status` prints `Luna update status`: `packages/extensions/src/kit-update/index.ts:782`;
  the only `pi[- ]system` left in the named files are identity tokens listed in `docs/branding.md`.

## Diff budget

- `git diff --no-renames 29eeab10123a..HEAD -- . ":(exclude)package-lock.json"
  ":(exclude)autonomy/cycles/luna-core-01/" ":(exclude)autonomy/runs/luna-core-01/" | wc -c`
  — **13909** characters, well under the 30000 stop and the 60000 merge-review budget.

## Conclusion

Both items verified. PG-66's root cause (the worker cannot see the would-be review size) is fixed
and pinned; V-102 holds on the base. No acceptance check was weakened.
