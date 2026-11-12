# Cycle 04 — Verify (run luna-ux-01, stream `ux`)

- Base `c8e76e224640`, HEAD `5f59714`. Non-record diff (lockfile, cycle/run records excluded):
  **35,648 characters**, measured with
  `git diff --no-renames c8e76e224640..HEAD -- . ":(exclude)package-lock.json" ":(exclude)autonomy/cycles/luna-ux-01/" ":(exclude)autonomy/runs/luna-ux-01/" | wc -c`.
  The 30,000 figure is the stop-taking-new-items line; the review limit is 60,000, and this is the
  one board item already taken.
- Planned with `node packages/core/check-all.ts --for-changed="$(git diff --name-only c8e76e224640..HEAD | tr '\n' ',')"`,
  which named the 13 checks below; the acceptance-named and directly affected smokes were added.

## Checks run on the final tree

| Check | Result |
| --- | --- |
| `node packages/core/gen-shared.ts --check` | RAN, PASS — `gen-shared: every copy matches its source` |
| `node packages/core/gen-notices.ts --check` | RAN, PASS — `OK: THIRD_PARTY_NOTICES.md is up to date` |
| `npm run -s docs:check` | RAN, PASS — `[docs-nav-check] OK: nav entries exist and internal links resolve.` |
| `npm run -s smoke:autonomy` | RAN, PASS — `[autonomy-smoke] all 34 checks passed` |
| `npm run -s smoke:autonomy-run` | RAN, PASS — `[autonomy-run-smoke] all 15 checks passed` |
| `npm run -s smoke:autonomy-selfimprove` | RAN, PASS — `[autonomy-selfimprove-smoke] all 57 checks passed` |
| `npm run -s smoke:control-center` | RAN, PASS — `[control-center-smoke] all 46 checks passed` (includes the unchanged 600→500 cap and bidi page-title case, plus the new shared-filter case) |
| `npm run -s smoke:docs` | RAN, PASS — `[docs-smoke] OK: 14 documented commands validated, 62 relative links resolved; ...` |
| `npm run -s smoke:eval-footprint` | RAN, PASS — `[eval-footprint-smoke] all 13 checks passed` |
| `npm run -s smoke:new-extension` | RAN, PASS — `new-extension smoke: OK` |
| `npm run -s smoke:subagent-roles-isolation` | RAN, PASS — `[subagent-roles-isolation-smoke] all 7 checks passed` |
| `npm run -s smoke:workflow-notify` | RAN, PASS — `workflow-notify-smoke: 10 checks passed` |
| `npm run -s test:lint` | RAN, PASS — exit 0 (first run failed with four `no-restricted-syntax` errors on the dynamic anchored RegExp; fixed in `5f59714`) |
| `npm run -s test:typecheck` | RAN, PASS — exit 0 (first run failed `TS2322` on the new synchronous smoke callback; fixed before `36565d9`) |
| `npm run -s verify` | RAN, PASS — `[verify] All checks passed.` |
| `npm run -s smoke:autonomy-inbox` | RAN, PASS — `[autonomy-inbox-smoke] all 7 checks passed` (acceptance-named) |
| `npm run -s smoke:redaction-corpus` | RAN, PASS — `[redaction-corpus-smoke] all 6 checks passed` (acceptance-named) |
| `npm run -s smoke:autonomy-notebook` | RAN, PASS — `[autonomy-notebook-smoke] all 10 checks passed` |
| `npm run -s smoke:tui-layout` | RAN, PASS — `tui-layout-smoke: 5 checks passed` |
| `npm run -s smoke:run-query` | RAN, PASS — `[run-query-smoke] one query over every run format verified (8 groups)` |
| `/opt/autonomy/gate.sh`, `npm test`, `npm run check:all` | SKIPPED locally by cycle rule — host gate runs the full suite on a clean checkout |

## Failing-first and consolidation evidence

- **V-93 copy count.** Before the change, `grep -rln 'Default_Ignorable_Code_Point' packages tests docs`
  named four hand-written class literals: `control-center/hub.ts:177`,
  `autonomy/lib/notebook.ts:126`, `autonomy-run/index.ts:192`,
  `third_party/subagent/run-query.ts:216`. After the change the same grep finds only
  `packages/core/shared/visible-text.ts` plus the three generated `shared/visible-text.ts` copies
  (excluded by the new smoke case's assertion), so the hand-written copy count is 1.
- **New case.** `tests/control-center-smoke.ts` (`the one shared visible-text filter removes a bidi
  override and is written once`) asserts `stripHiddenChars("safe\u202eoverride") === "safeoverride"`,
  that `oneVisibleLine` removes `\u202e`, that `oneVisibleLine("v".repeat(600)).length === 600`
  (the helper does not cap; the hub's 500 cap is pinned by the unchanged case at lines 457-464),
  and that no file outside the generated copies contains the class literal. It fails on the base
  tree, where the literal lives in four files and the shared module does not exist.
- **No assertion changed.** `git diff c8e76e224640..HEAD -- tests` adds imports, a `ROOT` constant
  and one `tests.push` case; every existing assertion is byte-identical.

## Review

Independent `reviewer` subagent PASS on the final pushed HEAD (no must-fix items; one non-blocking
warning: `autonomy/lib/engine.ts:1011` still applies its own `HIDDEN_CHARS` transform via the
notebook re-export, which duplicates no class literal and is outside V-93's declared scope).
An earlier gated review returned FAIL on the uncommitted tree, the `TS2322` smoke callback and the
dynamic RegExp; all three were fixed and re-verified.
