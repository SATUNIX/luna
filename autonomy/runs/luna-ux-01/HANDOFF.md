# Run `luna-ux-01` — handoff

State after cycle 04 (branch `pi/luna-ux-01`, cycle base `c8e76e224640`). Report:
`autonomy/cycles/luna-ux-01/04/report.md`, evidence in `verify.md`.

## Assignment state

- **V-93** is done: `36565d9` adds `packages/core/shared/visible-text.ts` (`HIDDEN_CHARS`,
  `isHiddenChar`, `stripHiddenChars`, `oneVisibleLine`), registers it in `SHARED_COPIES` for
  control-center, autonomy-run and subagent, and converts hub.ts, autonomy/cli.ts (both call
  sites), store.ts, notebook.ts, autonomy-run/index.ts and subagent/run-query.ts. `5f59714`
  rebuilds `isHiddenChar` without a dynamic RegExp (lint). Hand-written copies 4 -> 1; docs,
  CHANGELOG, subagent SOURCE.md and THIRD_PARTY_NOTICES.md updated.
- **V-09** was already merged at the cycle base (cycle 03's `c12d02a`); checked and not re-opened.
  Do not re-open the TUI width work — it is pinned by `tests/tui-layout-smoke.ts`.

## Next cycle should know

- Never run `npm test` / `npm run check:all`; the host gate owns the full suite
  (`/opt/autonomy/gate.sh` is skipped locally for the same reason).
- Any new `autonomy/cycles/<run>/<NN>/report.md` needs its `autonomy/JOURNAL.md` line in the same
  push or `smoke:docs` fails. `node packages/core/journal.ts` writes it from the report.
- Changing a vendored directory's `SOURCE.md` makes `THIRD_PARTY_NOTICES.md` stale: run
  `node packages/core/gen-notices.ts` in the same commit or `verify` and `smoke:new-extension` fail.
- A new shared helper needs a `SHARED_COPIES` entry and `npm run gen:shared`; the generated copies
  are committed byte for byte. Extension copies cannot import `packages/core`, and a dynamic
  `new RegExp` is rejected by lint — build predicates from the one literal instead.
- Gated `workflow_run` plans here have reported `passed` even when the reviewer's last line was
  `VERDICT: FAIL`; always read the step output and `git status`/`git log` after a plan.
- Follow-ups not taken: `autonomy/lib/engine.ts:1011` still applies its own `HIDDEN_CHARS`
  transform via the notebook re-export (no class-literal duplicate, outside V-93's scope);
  `wf-panel.ts` `footer()` vs `render()` divergence after `RunRegistry.prune()` (proposal
  `autonomy/proposals/luna-ux-01-03-workflow-panel-footer-after-prune.md`, needs a failing test on
  the prune path).
- Cycle 02 remains rejected and unmerged; its records are superseded by the `03/` and `04/` records.
