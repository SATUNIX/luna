# Cycle 28 — Verify (run `luna-ux-01`, stream `ux`)

Base `051d491a20b3`, code head `637256b` (records commit follows). Item: V-09 — two residual
glyph defects in the working line's tool phrase: a cut that split a surrogate pair (and made the
ASCII form 42 columns) and an automatic ASCII choice that did not reach the tool phrase.

## Targeted checks (head `637256b`)

| Command | Result | Proving line |
| --- | --- | --- |
| `npm run smoke:tui-layout` | PASS (4 checks) | `tui-layout-smoke: 4 checks passed`; the new assertions are in the todo-checklist block |
| `npm run smoke:status-bar` | PASS (26) | `status-bar-smoke: 26/26 passed`, including `ok autoAsciiThemeReachesToolPhrase` |
| `npm run smoke:workflow-panel` | PASS (20) | `workflow-panel-smoke: 20 checks passed` (no assertion changed) |
| `npm run smoke:remote-control` | PASS (16) | `remote-control extension smoke: OK (16 checks)` |
| `npm run smoke:docs` | PASS | `[docs-smoke] OK: 14 documented commands validated, 62 relative links resolved` |
| `npm run test:typecheck` | PASS | exit 0 |
| `npm run test:lint` | PASS | exit 0 |
| `npm run verify` | PASS | `[verify] All checks passed.` (73 OK lines) |

Exit codes were captured explicitly for typecheck, lint and verify (0/0/0). Never ran `npm test`
or `npm run check:all`.

## Base-fail evidence

Base tree extracted to `/tmp/base28` with `node_modules` symlinked to `/work/node_modules` and
the final test files overlaid (source otherwise at `051d491a20b3`).

- `smoke:tui-layout` exit 1:
  `AssertionError: tool phrase has no lone surrogate: "Running \`aaaa…\ud83d…\`"`. The base
  `clip` sliced 39 UTF-16 units, so the boundary emoji lost its low surrogate. The same function
  returns `"x".repeat(39) + "..."` for the ASCII form — 42 single-column characters — which is
  what the new `<= 40` assertion checks; the test stops at the earlier surrogate failure on base.
- `smoke:status-bar` exit 1: `FAIL autoAsciiThemeReachesToolPhrase`. On base the working line
  under `ansi-dark` kept the Unicode `…`, because `tool_execution_start` passed only
  `settings.ascii`.

The two new tests pass at head, so the diff is what flips both.

## Independent review

- First attempt: gated `workflow_run` reviewer over the whole diff. It was interrupted by
  automatic context compaction before returning a verdict (known failure mode for whole-diff
  reviewers).
- Second attempt: a fresh read-only `reviewer` subagent restricted to the diff and the two fast
  smokes (`2026-11-12T02-21-40-936Z-reviewer-39b36d`). It read all seven changed files, ran
  `smoke:tui-layout` (exit 0, 4/4) and `smoke:status-bar` (exit 0, 26/26), independently
  reproduced the base failures, found no critical or warning issue, and returned
  `VERDICT: PASS`. Its three notes were all non-defects: a duplicated ASCII case, a redundant
  positive `...` check, and the small fallback theme object copied into `effectiveAscii()`.
- Because a single whole-diff reviewer can be killed by compaction, the accepted proof is the
  per-item checks above plus the negative run against base, not one whole-cycle review. This
  substitution is stated here as required.

## Review size

`git diff --no-renames 051d491a20b3..HEAD -- . ":(exclude)package-lock.json"
":(exclude)autonomy/cycles/luna-ux-01/" ":(exclude)autonomy/runs/luna-ux-01/" | wc -c`
reports 8,735 characters, well under both the 30,000 stop-new-work threshold and the 60,000
review limit.
