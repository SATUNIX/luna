# Cycle 27 verify — luna-core-01

Base `6642ee5ceeba`; commits `66e7c51` (PG-66 refusal), `4ece751` (docs wording),
`6f8702f` (memory-vault migration tombstone). Never ran `npm test` or `npm run check:all`.
Every line is a command, its result, and what proves it.

## Item 1 — PG-66 pre-report refusal

- `npm run smoke:autonomy-selfimprove` — **PASS** — `[autonomy-selfimprove-smoke] all 44 checks
  passed`; the fixture `an over-budget cycle is caught pre-report ...` now also asserts both
  refused cycles closed `outcome === "partial"` with `reason` `^refused_budget: the diff this
  cycle would submit is <n> characters, over the merge review's budget of 60000 characters`.
- Falsification (implementer + independent reviewer each temporarily removed the refusal) —
  **FAIL as expected** — `cycle 1 closed partial ...` assertion error; files restored, `git
  status` clean.
- `npm run test:typecheck` — **PASS** — exit 0 (all eight `tsc -p` projects).
- targeted eslint `packages/autonomy/lib/cycle.ts packages/autonomy/lib/templates/self-improve.ts`
  — **PASS** — exit 0, `--max-warnings 0`.
- `npm run smoke:docs` — **PASS** — `[docs-smoke] OK: 14 documented commands validated, ...`
  (the `docs/autonomy.md` wording change resolves).

## Item 2 — memory-vault migration tombstone

- `npm run smoke:memory-vault` — **PASS** — `[memory-vault-smoke] all 16 checks passed`
  (was 15); the new check `a malformed memory-local store is retried, not tombstoned` asserts
  return 0 and no marker for invalid JSON, then 1 for the repaired file.
- Falsification (independent reviewer reverted the guard) — **FAIL as expected** —
  `AssertionError: an unreadable store leaves no migration marker`; restored.
- `npm run smoke:docs` — **PASS** (the `docs/memory.md` sentence resolves).

## Whole-cycle independent review

- `subagent` reviewer (did not write either change) on `git diff 6642ee5ceeba..HEAD` — **VERDICT:
  PASS** — no must-fix. It independently ran `smoke:autonomy-selfimprove` 44/44,
  `smoke:memory-vault` 16/16 and `test:typecheck`, confirmed both fixtures fail without their fix,
  no security control / test weakening / CHARTER / `package.json` script change, and the diff is
  under budget. Two non-blocking warnings recorded in the report.

## Diff budget

- `git diff --no-renames 6642ee5ceeba..HEAD -- . ":(exclude)package-lock.json"
  ":(exclude)autonomy/cycles/luna-core-01/" ":(exclude)autonomy/runs/luna-core-01/" | wc -c`
  — **13975** characters, under the 30000 stop and the 60000 merge-review budget.

## Conclusion

Both items verified with a failing-on-base test each; the independent review passed. No acceptance
check was weakened.
