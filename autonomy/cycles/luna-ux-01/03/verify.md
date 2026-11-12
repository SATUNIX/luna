# Cycle 03 — Verify (run luna-ux-01, stream `ux`)

- Base `dfb939dd9e0a`, HEAD `c12d02a`. Non-record diff (lockfile, cycle/run records excluded):
  **14,564 characters**, measured with
  `git diff --no-renames dfb939dd9e0a..HEAD -- . ":(exclude)package-lock.json" ":(exclude)autonomy/cycles/luna-ux-01/" ":(exclude)autonomy/runs/luna-ux-01/" | wc -c`.
- Planned with `node packages/core/check-all.ts --for-changed="<8 changed paths>"`, which named the
  ten checks below. Each planned check was run on the final tree.

## Checks run on the final tree

| Check | Result |
| --- | --- |
| `npm run -s docs:check` | RAN, PASS — `[docs-nav-check] OK: nav entries exist and internal links resolve.` |
| `npm run -s smoke:docs` | RAN, PASS — `[docs-smoke] OK: 14 documented commands validated, 62 relative links resolved; ... 97 shipped pages name no removed delegation surface.` |
| `npm run -s smoke:eval-footprint` | RAN, PASS — `[eval-footprint-smoke] all 13 checks passed` |
| `npm run -s smoke:new-extension` | RAN, PASS after the notices regeneration — `new-extension smoke: OK` (first run failed: `FAIL: THIRD_PARTY_NOTICES.md is stale — run 'node packages/core/gen-notices.ts'`, fixed in the same commit by running that generator) |
| `npm run -s smoke:subagent-roles-isolation` | RAN, PASS — `[subagent-roles-isolation-smoke] all 7 checks passed` |
| `npm run -s smoke:tui-layout` | RAN, PASS — `tui-layout-smoke: 5 checks passed`, including `remote pairing panel: a shown QR code fits the reserved rows and the note's minimum is honest` |
| `npm run -s smoke:workflow-notify` | RAN, PASS — `workflow-notify-smoke: 10 checks passed` |
| `npm run -s test:lint` | RAN, PASS — exit 0 |
| `npm run -s test:typecheck` | RAN, PASS — exit 0 |
| `npm run -s verify` | RAN, PASS after the notices regeneration — `[verify] All checks passed.` |
| `npm run -s smoke:remote-control` | RAN, PASS — `remote-control extension smoke: OK (16 checks)` (the changed module's own smoke) |
| `/opt/autonomy/gate.sh` | SKIPPED locally by design — it runs the full `check:all` suite, which the branch must not run; the host gate runs it on the accepted head |
| `npm test`, `npm run check:all` | NOT RUN — host-only by cycle instruction |

## Failing-first evidence

- **V-09 clause.** Before the `SOURCE.md` edit, the new docs-smoke case failed with
  `AssertionError [ERR_ASSERTION]: SOURCE.md \`- Changes:\` needs a 2026-11-12 entry: files:
  \`wf-panel.ts\` (commit 23725c2), describing the optional \`maxLines\` height budget`.
  After the entry and the notices regeneration it prints the `[docs-smoke] OK: ...` line above. The
  independent reviewer also inspected `HEAD~1:packages/extensions/third_party/subagent/SOURCE.md`
  and confirmed it had no 2026-11-12 entry and no `23725c2`, so the case genuinely fails without the
  change.
- **`pairPanel` row budget.** The new grid case in `tests/tui-layout-smoke.ts` failed on the base
  source with `AssertionError: pair panel 55: the note's 46 rows fit 38 lines` (run from a
  `git archive dfb939dd9e0a` tree under `/tmp` with the new test overlaid, so the worktree was not
  touched); with the fix it passes and the four existing tui-layout cases still pass.

## Independent review

- `pairPanel` change: `reviewer` step of workflow run
  `2026-11-12T13-05-42-793Z-plan-367e`, `step-1` → `VERDICT: PASS`. It confirmed beside/stacked/
  details-only all count emitted rows, already-fitting beside output is byte-identical,
  `rowsNeeded = RESERVED + out.length + bodyHeight` is honest, and `termRows = 0`, tiny widths and an
  absent QR behave as before; it recorded two non-blocking warnings (the beside fallback is not
  exercised by the grid's heights, and the note's row figure is measured at the current inner width).
  Its only must-fix list is empty. Docs matched `RESERVED_ROWS = 10`.
- V-09 clause: `reviewer` step of workflow run `2026-11-12T13-07-47-531Z-plan-aaf3`, `step-2` →
  `VERDICT: PASS` after one gate retry. It verified the entry is factually correct against
  `wf-panel.ts` and `23725c2`, the case isolates the dated entry rather than matching the whole file,
  the pre-edit file would fail it, and the commit touches only `SOURCE.md`, `docs-smoke.ts` and the
  generated notices.

No change in this cycle touches a control path, a `package.json` script, `package-lock.json`,
`packages/web-ui/`, Android, `autonomy/CHARTER.md` or `autonomy/BACKLOG.md`:
`git diff --name-only dfb939dd9e0a..HEAD` lists only the remote-control module, its doc, the two
tests, `SOURCE.md`, `THIRD_PARTY_NOTICES.md` and cycle/proposal records.

## Left for next cycle

- `wf-panel.ts` footer/view divergence after `RunRegistry.prune()` — proposal
  `autonomy/proposals/luna-ux-01-03-workflow-panel-footer-after-prune.md` (needs its own failing test
  on the prune path).
- The reviewer's two warnings on `pairPanel`: add a wide-but-short beside-fallback case, and word the
  details-only note so its row figure is not read as sufficient at a different width.
