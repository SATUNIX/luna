# Cycle 22 — Verify (run `luna-ux-01`, stream `ux`)

Base `f19788240eaa`, verified head `f289f48` (records follow; they change no code).

## Gate cause

`tests/docs-smoke.ts:518` `checkJournal` disagrees with the cycle reports when a report has no
`autonomy/JOURNAL.md` line. The cycle-21 attempt added `cycles/.../21/report.md` without the
line, so `smoke:docs` and `check-all` failed. This branch adds the `luna-ux-01/22` line with its
report; the rejected cycles' reports are not re-landed.

## Targeted checks (head)

- `npm run smoke:control-center` — PASS — `[control-center-smoke] all 45 checks passed`.
- `npm run smoke:launch-screen` — PASS — `[launch-screen-smoke] all 12 checks passed`.
- `npm run smoke:workflow-panel` — PASS — `workflow-panel-smoke: 15 checks passed`.
- `npm run smoke:command-menu` — PASS — `[command-menu-smoke] all 14 checks passed`.
- `npm run smoke:update-notice` — PASS — `[update-notice-smoke] all 8 checks passed`
  (PG-12: exact line, in-sync null, `session start never waits for a check whose git call never
  resolves`).
- `npm run smoke:suppression-inventory` — PASS — `suppression-inventory smoke: 2 checks passed`.
- `npm run smoke:typescript-coverage` — PASS — `14 eslint-disable comments, each with a reason
  (ceiling 15)`.
- `npm run smoke:docs` — PASS — `[docs-smoke] OK: 14 documented commands validated, 62 relative
  links resolved; ...`.
- `npm run docs:check` — PASS — `[docs-nav-check] OK: nav entries exist and internal links
  resolve.`
- `npm run docs:mermaid` — PASS — `[check-mermaid] OK: 54 diagram(s) in 382 Markdown file(s) parse`.
- `npm run test:typecheck` — PASS — all 8 `tsc` projects exit 0.
- `npm run test:lint` — PASS — `eslint ... --max-warnings 0 .` exits 0.

## Negative runs (new tests fail without the change)

- Restored `f19788240eaa:packages/extensions/src/control-center/index.ts` →
  `smoke:control-center` `4/45 FAILED` (`an invalid hubKey falls back to alt+m with one warning`,
  the terminal-controls case, the duplicate-modifier case, the session-restart header case);
  45/45 with the change.
- Restored `f19788240eaa:.../wf-panel.ts` → `smoke:workflow-panel` FAIL
  `the panel fits 16 rows at 20 rows (got 37)`; 15/15 with the change.
- The docs correction `f289f48` changes only `docs/workflows.md` wording (no behaviour claim can
  be tested); `smoke:docs`, `docs:check` and `docs:mermaid` cover it.

## Independent review

A `reviewer` subagent that did not write the change read the whole diff against
`autonomy/CHARTER.md` and returned `VERDICT: PASS`, with the warnings that became `f289f48`:
`docs/workflows.md` claimed every selected agent was kept at very short heights, and "ten agents
show at a time" ignored the height budget. It confirmed the hubKey validator against pi-tui's
`parseKeyId`/`matchesKey`, the two-row frame reservation against the overlay host, no weakened
test, no dependency or `package.json`/charter change.

## Diff size

`git diff --no-renames f19788240eaa..HEAD -- . ":(exclude)package-lock.json"
":(exclude)autonomy/cycles/luna-ux-01/" ":(exclude)autonomy/runs/luna-ux-01/" | wc -c`
= 44706 characters, under the 60000 review cap (past the 30000 stop-taking-new-work line, so no
new item was started).
