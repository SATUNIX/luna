# Cycle 30 — Verify (run `luna-ux-01`, stream `ux`)

Base `fc5dc46`; code head `6c2d1c6`, test follow-up `b7306ca`. Item: the footer's width
measurement must agree with pi-tui for VS16/keycap emoji and tabs, pinned by a fixture measured
with pi-tui's `visibleWidth`.

## Targeted checks (head `b7306ca`)

| Command | Result | Proving line |
| --- | --- | --- |
| `npm run smoke:tui-layout` | PASS (4) | `tui-layout-smoke: 4 checks passed`; every line now asserted with both `displayWidth` and pi-tui `visibleWidth` |
| `npm run smoke:status-bar` | PASS (26) | `status-bar-smoke: 26/26 passed` |
| `npm run smoke:workflow-panel` | PASS (20) | `workflow-panel-smoke: 20 checks passed` (unchanged, shared vendored tree) |
| `npm run test:typecheck` | PASS | exit 0 |
| `npm run test:lint` | PASS | exit 0 |
| `npm run verify` | PASS | `[verify] All checks passed.` |
| `node packages/core/gen-notices.ts` | PASS | `[gen-notices] OK: THIRD_PARTY_NOTICES.md is up to date.` |

Never ran `npm test` or `npm run check:all`.

## Base-fail evidence

The final `tests/tui-layout-smoke.ts` over base `fc5dc46`'s `width.ts` fails:

- `AssertionError: todos@20: line 5 is 22 columns by pi-tui visibleWidth, limit 20:
  ☐ #5 ship ❤️ the ⚠️…`
- With the footer fixture added in `b7306ca`, the first failure is the footer itself:
  `wide footer light@20: line 0 is 22 columns by pi-tui visibleWidth, limit 20:
  ● ❤️-⚠️-another-long-…`

Both fail because base `clusterWidth` counted `❤️`/`⚠️` as 1 column and a tab as 0; the fix
promotes a VS16/keycap cluster to 2 and a tab to 3. Head `smoke:tui-layout` is 4/4.

## Independent review

A `reviewer` subagent that did not write the change returned `VERDICT: PASS` after reading the
diff, the plan and the charter, and re-running the allowed checks. It raised two non-blocking
warnings:

1. The first fixture put VS16/keycap/tab text only in a todo item, not in the footer's own text.
   Fixed in `b7306ca` (cwd, branch, session name and a status chip), with the footer base-fail
   above. Re-review of that test-only follow-up was not run separately; the change is the exact
   fixture the reviewer asked for and `smoke:tui-layout` is 4/4.
2. The plan said `2026-11-14`; the SOURCE.md entry says `2026-11-13`, matching cycle 29 and the
   run's recorded dates. The entry is correctly dated for the run; the plan line was off by one.

## Notes

- The gated `workflow_run` implementer wrote the change and staged it but did not commit; the
  workflow then failed before the reviewer finished. I inspected the staged diff, ran the targeted
  checks and base-fail reproduction, committed it as `6c2d1c6`, and sent a separate reviewer
  subagent. This is the accepted per-item-review substitution for a whole-diff reviewer; the
  negative run against base is the proof.
- Non-record diff: `9,506` bytes, below 30,000 and the 60,000 review cap. No `package.json`
  script, `CHARTER.md` or control path changed.
