# Cycle 28 — Report (run `luna-ux-01`, stream `ux`)

Outcome: successful
Mode: fix

Board: V-09 done - narrow-terminal and glyph-consistency hardening, residual glyph defects repaired
Item: `toolPhrase` clips by display columns and whole graphemes - 823f168, 637256b - `npm run smoke:tui-layout` 4/4; on base the 40-column cut emitted a lone surrogate (`\ud83d`) and the ASCII form was 42 columns
Item: the automatic ISO/ANSI/TTY ASCII choice reaches the tool phrase - 823f168 - `npm run smoke:status-bar` 26/26, case `autoAsciiThemeReachesToolPhrase`; on base the working line kept U+2026 under `ansi-dark`

## What changed

Cycle 27 hardened the footer, todo widget, workflow panel and pairing panel for narrow
terminals but left two glyph defects in the same surface, both in the working line's tool
phrase. Cycle 28 is the fix consolidation: two files of production code, tests that pin each
defect, and the documentation that claimed the now-true behaviour.

**Item 1 — `toolPhrase` cut (823f168, pinned by 637256b).** `clip` measured the command with
`v.length` and cut with `v.slice(0, n - 1)`. A UTF-16 emoji straddling the 40-unit boundary lost
its low surrogate, so the working line could contain an unpaired `\uD83D`; the ASCII variant
appended `...` to a 39-character prefix and produced a 42-column phrase. The fix replaces the
hand-rolled cut with the extension's existing `truncateDisplay(v, n, ascii ? "..." : "…")`, so
the cut is measured in terminal columns, whole grapheme clusters survive, and the result stays
inside the existing 40-column budget. Plain ASCII commands cut exactly as before
(39 characters plus the theme's ellipsis); wide glyphs are dropped whole instead of split.

**Item 2 — automatic ASCII (823f168).** `footerGlyphs` selects the ASCII glyph set for
`iso`/`ansi`/`tty` themes as well as for `/footer ascii on`, but `tool_execution_start` passed
only `settings.ascii` to `toolPhrase`. On those themes the bar was ASCII while the working line
still ended in `…`, contradicting `docs/status-bar-and-costs.md`. A new `effectiveAscii()` helper
resolves `footerGlyphs(theme, settings.ascii).ascii` at call time and is passed to `toolPhrase`;
the explicit `/footer ascii` setting keeps its meaning unchanged.

**Tests.** `tests/tui-layout-smoke.ts` gains assertions inside the existing todo-checklist block:
the emoji boundary command has no unpaired surrogate, its command portion is at most 40 columns,
it keeps the theme ellipsis, and the ASCII form is all-ASCII, ends in `...` and also fits
40 columns. `tests/status-bar-smoke.ts` gains the case `autoAsciiThemeReachesToolPhrase`: with an
`ansi-dark` theme, no `/footer ascii` setting and a `tool_execution_start` carrying a long bash
command, `__footerDebug.workingText` contains `...` and no `…`. No existing assertion in
`status-bar-smoke` or `workflow-panel-smoke` was changed; the new tests only add coverage.

**Docs and provenance.** `docs/status-bar-and-costs.md` now states that the working line's tool
phrase follows the same automatic ASCII choice as the bar and todo widget and is cut in terminal
columns, dropping a wide glyph whole at the cut. The dated `custom-footer/SOURCE.md` entry
records both behaviours for the vendored tree, and `THIRD_PARTY_NOTICES.md` was regenerated.

## Test justification

Both new checks fail on `051d491a20b3` with the final tests overlaid and pass at `637256b`
(`/tmp/base28` with `/work/node_modules` symlinked): `smoke:tui-layout` exits 1 with
`tool phrase has no lone surrogate: "Running \`aaaa…\ud83d…\`"`, and `smoke:status-bar` exits 1
with `FAIL autoAsciiThemeReachesToolPhrase`. The tests use a fixed string and the existing
`__footerDebug` seam; they add no timers, model calls, subprocesses or network. The ASCII
assertion is not loosened: it requires `...`, rejects `…`, and checks the width, rather than
only checking that the output is printable.

## Left for later

- The 40-column budget applies to the command inside the backticks, not the surrounding
  `Running \`…\`` wrapper; that matches the previous intent and the plan, and is now documented
  in the test comment. If the whole line ever needs a hard cap, it belongs with the footer
  fitting logic, which was out of scope.
- Open proposals unchanged: idle-cat frames (needs an intent decision), hub 1-4-row frame/mouse
  edges, inert Settings value rows, `TRUNK_CHANNEL` alias, inbox deadline edges, and the
  `workflow-hooks-smoke.ts` timer races. No new proposal was needed: this cycle closes the
  defects it found instead of deferring them.

## For the next cycle

- Never run `npm test` / `npm run check:all`; the host gate owns the full suite.
- A new `report.md` needs its `autonomy/JOURNAL.md` line in the same push or `smoke:docs` fails.
- A gated `workflow_run` plan does not auto-retry after a reviewer `VERDICT: FAIL`; read the
  verdict and issue a second plan.
- A whole-diff reviewer can be killed by compaction; per-item gated reviewers plus a negative
  run against base are the accepted substitute, stated in `verify.md`.
- Non-record diff is 8,735 characters, far below the 30,000 stop-new-work threshold.
