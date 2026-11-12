# Run `luna-ux-01` — handoff

State after cycle 06 (branch `pi/luna-ux-01`, cycle base `8416c502acc4`). Report:
`autonomy/cycles/luna-ux-01/06/report.md`, evidence in `verify.md`.

## Assignment state

- **V-93** is done (already merged at `36565d9`/`5f59714`): `packages/core/shared/visible-text.ts`
  holds the one hidden-character filter and `oneVisibleLine`, with generated copies for
  control-center, autonomy-run and subagent; hand-written copies 4 -> 1. Cycle 06 verified it
  (`gen-shared --check`, `smoke:control-center`, `smoke:autonomy-inbox`, `smoke:tui-layout`,
  `smoke:redaction-corpus`) without re-opening it.
- **V-09** is done. Cycle 03 had pinned only the subagent `SOURCE.md`; cycle 06 added one truthful
  bolded `Vendored upstream (YYYY-MM-DD):` entry to each of the other eleven vendored
  `SOURCE.md` files, made the subagent pin select the entry naming `wf-panel.ts`/`23725c2` and
  require its bolded `(2026-11-12)` label, and added a generic docs-smoke scan over every
  `third_party/*/SOURCE.md` (commit `17e0d4ab`). Do not re-open the TUI width work.
- The cycle-03 WorkflowPanel/prune proposal is implemented (commit `88bc809d`): one `inRun()` drives
  the body, footer and key dispatch, `view`/`confirm` are kept, and the new prune case in
  `tests/workflow-panel-smoke.ts` pins the first `down` moving the cursor.

## Next cycle should know

- Never run `npm test` / `npm run check:all`; the host gate owns the full suite.
- Any new `autonomy/cycles/<run>/<NN>/report.md` needs its `autonomy/JOURNAL.md` line in the same
  push or `smoke:docs` fails. `node packages/core/journal.ts` appends missing lines but does not
  rewrite an existing one; derive the replacement with `journalLineFor` from
  `packages/core/lib/journal.ts`.
- Changing a vendored directory's `SOURCE.md` makes `THIRD_PARTY_NOTICES.md` stale: run
  `node packages/core/gen-notices.ts` in the same commit or `verify` and `smoke:new-extension` fail.
- A new shared helper needs a `SHARED_COPIES` entry and `npm run gen:shared`; generated copies are
  committed byte for byte, and a dynamic `new RegExp` is rejected by lint.
- Gated `workflow_run` plan implementers on this host do the file work and checks but leave it
  **staged**, then claim they committed; the reviewer correctly returned FAIL twice. Always inspect
  `git status`/`git log` after a plan, review the staged diff, then commit and push yourself.
- The cycle-05 host red (`check-all`, `smoke:redaction-corpus`) did not reproduce on the cycle-06
  base: the corpus passes all 6 checks and `smoke:docs` is green. Treat it as host-load flake unless
  it repeats with a named failing assertion.
- Follow-ups not taken: `autonomy/lib/engine.ts:1011` still applies its own `HIDDEN_CHARS` transform
  via the notebook re-export (no class-literal duplicate, outside V-93's scope); cycle-05 V-73
  (canonical `Alias of /<target>` wording) remains on `origin/attempts/luna-ux-01/cycle-05`;
  `docs/workflows.md` could spell out that an open confirm still owns the keys after the prune
  fallback, and `wf-panel.ts` `footer()` looks up `current()` twice.
- Cycle 02 remains rejected and unmerged; its records are superseded by `03/` and later.
