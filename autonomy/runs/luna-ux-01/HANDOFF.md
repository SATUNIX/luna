# Run `luna-ux-01` — handoff

State after cycle 08 (branch `pi/luna-ux-01`, cycle base `a597e3bf1063`, code head `7b500bd8`).
Report: `autonomy/cycles/luna-ux-01/08/report.md`, evidence in `verify.md`.

## Assignment state

- **V-09** is done and pinned on the base: the bolded `Workflow panel height budget (2026-11-12)`
  entry in `packages/extensions/third_party/subagent/SOURCE.md` names `wf-panel.ts` and `23725c2`,
  and `tests/docs-smoke.ts` requires a bolded dated entry in every `third_party/*/SOURCE.md` and
  the subagent entry to name `wf-panel.ts`. Do not re-open the TUI width work.
- **V-93** is done: `packages/core/shared/visible-text.ts` is the one hand-written filter and
  `oneVisibleLine`; `gen-shared.ts` generates the control-center, autonomy-run and subagent copies,
  and `hub.ts`, `cli.ts`, `store.ts`, `notebook.ts` and `run-query.ts` import them.
- Cycle 08 fixed one new ux defect (commits `4ff581a5`, `7b500bd8`): the curated `/` menu's hidden
  suggestion hints now honour `PI_KIT_ASCII=1` (`moved -> /menu > Page > Row`, ` - ` separator,
  hub-label arrows folded) while default output is byte-identical. The first commit was caught by
  the independent reviewer leaking U+2192 from a hub label; `7b500bd8` folds labels and narrows the
  docs claim (a command's own description is unchanged). Both commits have a test that fails
  without them.

## Next cycle should know

- Never run `npm test` / `npm run check:all`; the host gate owns the full suite.
- Any new `autonomy/cycles/<run>/<NN>/report.md` needs its `autonomy/JOURNAL.md` line in the same
  push or `smoke:docs` fails. `node packages/core/journal.ts` only appends missing lines; if a
  report already has a line (an earlier attempt was merged), replace it with the exact
  `journalLineFor` output from `packages/core/lib/journal.ts`.
- Changing a vendored directory's `SOURCE.md` makes `THIRD_PARTY_NOTICES.md` stale: run
  `node packages/core/gen-notices.ts` in the same commit or `verify` and `smoke:new-extension` fail.
- A new shared helper needs a `SHARED_COPIES` entry and `npm run gen:shared`; generated copies are
  committed byte for byte, and a dynamic `new RegExp` is rejected by lint.
- Cycle 08 records were replaced: an earlier merged attempt had written `08/` (V-73/PG-12, base
  `e22aac206685`); those code changes remain in the tree, but the current `08/` records are this
  cycle's.
- `check-all --for-changed` prints the plan only; run each named script yourself.
- Follow-ups not taken: the footer drops a single right-side critical chip at 20-37 columns
  (`custom-footer/render.ts:229-232`, proposal `luna-ux-01-08-footer-critical-chip-narrow.md`,
  includes the latent `asciiThemeName` env-clause drift); the `/` hint follows `PI_KIT_ASCII`
  only, not the `iso`/`ansi`/`tty`/`ascii` theme-name choice; `asciiLabel` folds a fixed glyph
  set; `autonomy/lib/engine.ts:1011` still applies the notebook-reexported hidden-char transform;
  `wf-panel.ts` `footer()` looks up `current()` twice (readability only).
- Cycle 02 remains rejected and unmerged; its records are superseded by `03/` and later.
