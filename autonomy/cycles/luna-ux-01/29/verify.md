# Cycle 29 — Verify (run `luna-ux-01`, stream `ux`)

Base `337fb705914d`, code head `d3ead52` (this records commit follows). Item V-91
— the todo checklist widget must re-cut itself at the width pi passes instead of
a width read once at mount, and the narrow-terminal layout smoke must close the
board's remaining fixture clauses.

## Targeted checks (head `d3ead52`)

| Command | Result | Proving line |
| --- | --- | --- |
| `npm run smoke:tui-layout` | PASS (4 checks) | `tui-layout-smoke: 4 checks passed`; all four surfaces, widths 20-120, plain + ANSI, no newline on any line |
| `npm run smoke:status-bar` | PASS (26) | `status-bar-smoke: 26/26 passed`, including `ok asciiSettingReachesTodoWidget` (mounted component rendered at 24 columns) |
| `npm run smoke:workflow-panel` | PASS (20) | `workflow-panel-smoke: 20 checks passed` (no assertion changed) |
| `npm run smoke:docs` | PASS | `[docs-smoke] OK: 14 documented commands validated, 62 relative links resolved` |
| `npm run test:typecheck` | PASS | exit 0 |
| `npm run test:lint` | PASS | exit 0 |
| `npm run verify` | PASS | `[verify] All checks passed.` |

Exit codes captured explicitly: 0/0/0. Never ran `npm test` or `npm run check:all`.

## Base-fail evidence

Base `337fb705914d` extracted to `/tmp/base29` with `/work/node_modules`
symlinked and the final `tests/status-bar-smoke.ts` and `tests/tui-layout-smoke.ts`
overlaid:

- `npm run smoke:status-bar` exit 1:
  `FAIL asciiSettingReachesTodoWidget`,
  `AssertionError: a narrow todo line fits 24 columns: 50 Todos 0/2 ----------  /footer todos off hides this`.
  The base widget captured `process.stdout.columns` once at mount, so rendering
  the component at 24 columns returned the width it was mounted at.
- `npm run smoke:tui-layout` exits 0 on base. The layout assertions were already
  true after cycles 27-28; the regression pin for this cycle is the status-bar
  mount case. The new fixture clauses (200-character todo, long cwd, six
  statuses, size-21 QR, no newline) add coverage but do not by themselves fail
  on base.

## Independent review

- First reviewer (`2026-11-12T02-34-27-763Z-reviewer-d4a38a`) was interrupted
  before returning a verdict (known whole-diff reviewer failure mode).
- Second reviewer subagent, restricted to the diff and the two fast smokes,
  returned `VERDICT: FAIL` with one must-fix: the footer fixture had no long cwd.
  Commit `d3ead52` fixed it.
- Third, minimal re-review returned `VERDICT: PASS`: `d3ead52` touches only
  `tests/tui-layout-smoke.ts`, the cwd is now long, and `smoke:tui-layout` is
  4/4. The 200-character todo fixture gap found while the reviewer ran was fixed
  in `2599c21` (its own commit) and is covered by the passing layout smoke.
- Because a whole-diff reviewer can be killed by compaction, the accepted proof
  is the per-item checks above plus the negative run against base, not one
  whole-cycle review. This substitution is stated here as required.

## Review size

`git diff --no-renames 337fb705914d..HEAD -- . ":(exclude)package-lock.json"
":(exclude)autonomy/cycles/luna-ux-01/" ":(exclude)autonomy/runs/luna-ux-01/" | wc -c`
reports about 9.2 KB, well under both the 30,000 stop-new-work threshold and the
60,000 review limit.
