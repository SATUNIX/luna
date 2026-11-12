# Cycle 27 — Verify (run `luna-ux-01`, stream `ux`)

Base `897ff52bce9c`, code head `5eb4d82` (records commit follows). Item: V-09 — narrow-terminal
and glyph-consistency hardening of the existing TUI renderers, delivered as two ordered
sub-items: (1) status bar and todo checklist cut in terminal columns with the theme's ellipsis;
(2) remote-control pairing panel wrapped by display columns.

## Targeted checks (final code head `5eb4d82`)

| Command | Result | Proving line |
| --- | --- | --- |
| `npm run smoke:tui-layout` | PASS (4 checks) | `tui-layout-smoke: 4 checks passed`; widths 20, 32, 40, 60, 80, 120 plus pairing widths 2, 3, in plain and ANSI-dark themes, with ASCII, CJK and emoji input |
| `npm run smoke:status-bar` | PASS (25) | `status-bar-smoke: 25 checks passed` (no existing assertion changed) |
| `npm run smoke:workflow-panel` | PASS (20) | `workflow-panel-smoke: 20 checks passed` (regression pin only; panel already fitted) |
| `npm run smoke:remote-control` | PASS (16) | `remote-control-extension-smoke: 16 checks passed` |
| `npm run smoke:docs` | PASS | `[docs-smoke] OK: ...` |
| `npm run test:typecheck` | PASS | eight `tsc -p ...` projects exit 0 |
| `npm run test:lint` | PASS | `eslint --flag unstable_native_nodejs_ts_config --max-warnings 0 .` exits 0 |
| `npm run verify` | PASS | extension, profile and generated-doc validation exits 0 |

Never ran `npm test` or `npm run check:all`.

## Base-fail evidence

- Item 1: `git archive 71f7c0e` (the pre-fix code head) with the final
  `tests/tui-layout-smoke.ts` overlaid and `/work/node_modules` symlinked:
  `AssertionError: ascii footer default@120: non-ASCII character in > e | on main | /…/d/e ...`
  at `tests/tui-layout-smoke.ts:120` (exit 1). The earlier negative run on `897ff52bce9c`
  reproduced the 50-column todo header at width 20 and the U+2026 cut in ASCII mode.
- Item 2: the same test on the base code reproduced
  `pair panel@20: line 19 is 22 columns` (exit 1), because `wrap()` counted code units and
  ignored wide graphemes.
- The first independent review of `71f7c0e` returned `VERDICT: FAIL` and reproduced a remaining
  U+2026 in ASCII mode from `shortCwd` with a deep cwd
  (`> e | on main | /…/d/e ...`). `5eb4d82` fixes that, threads the ASCII flag into
  `toolPhrase`, and drops an unfittable wide grapheme instead of leaving an over-wide remainder;
  the test now pins the deep path and the tool phrase in ASCII mode.

## Independent reviews

- Item 1 + item 2, first review: gated `workflow_run` implementer + reviewer. The reviewer read
  the diff, ran the smokes and returned `VERDICT: FAIL` on the deep-path `shortCwd` U+2026
  (critical) with warnings on `toolPhrase` and the `wrap` no-progress case. The host does not
  auto-retry on `VERDICT: FAIL`; the fix was committed as `5eb4d82`.
- Re-review of `5eb4d82`: a fresh read-only `reviewer` subagent checked only the fix commit and
  the new assertions, ran `npm run smoke:tui-layout` (exit 0), and returned `VERDICT: PASS`:
  deep-path ASCII output is `/.../d/e`, `toolPhrase` takes the ASCII flag, `wrap` has the
  progress fallback, no assertion was removed or loosened, and no forbidden path is touched.
- Compaction interrupted the first attempt at this re-review before it returned; because the
  whole-diff reviewer is known to be killed by compaction, the proof here is the per-item gated
  reviewer plus the negative run against base described above, not a single whole-cycle review.
  The re-issued minimal re-review completed and passed.

## Review size

`git diff --no-renames 897ff52bce9c..HEAD` excluding lockfile, `THIRD_PARTY_NOTICES.md` and the
cycle/run records: 32,738 characters at the code head (limit 60,000). This is above the 30,000
stop-new-work threshold; no new item was taken after it was crossed, and the remaining work was
the review fix and cycle records.
