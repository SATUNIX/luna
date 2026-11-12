# Run `luna-ux-01` — handoff

State after cycle 01 (branch `pi/luna-ux-01`, cycle base `5fda5d526514`, code head `c638796` plus
the records commit). Report: `autonomy/cycles/luna-ux-01/01/report.md`, evidence in `verify.md`.
The run number restarts at 01 on this base; the earlier cycle 34 record and its `ui.json` merge fix
remain in the tree and in `JOURNAL.md`.

## What cycle 01 landed

- DE-98 needed no repair: `CHANGELOG.md` already had all five merged ux entries and
  `tests/tui-layout-smoke.ts` already used a 25-row QR fixture.
- `c56acda` adds the control-centre `displayText()` filter: pi-tui strip, then every `Cc`, `Cf` and
  `Default_Ignorable_Code_Point` character, trim, 500-code-point cap; used by header, page titles
  and parents, informational rows and typed commands. `smoke:control-center` is 45/45 and the new
  cases fail on the base source.
- `922e732` hardens the owner inbox: strict `isIsoTimestamp()` deadlines shared with `lib/board.ts`,
  refusal of uploaded `answer`/`outcome`, refusal (exit 3, card named) of `--answer` on a settled
  card, one-line sanitised listing including `outcome.at`, and a `wrap()` that carries a wide
  grapheme to the next line instead of dropping the rest of the word. `smoke:autonomy-inbox` 7/7,
  `smoke:tui-layout` 4/4, `smoke:remote-control` 16/16.
- `4e2938e`, `834963d` and `c638796` are the documentation and review follow-ups: CHANGELOG entries
  for both hardening changes, corrected `/remote` entry, wrap remainder in
  `docs/remote-control.md`, both offset signs in `docs/autonomy.md`, and a page-parent filter test.
- Non-record diff is 35,617 characters. Independent read-only `reviewer`: first FAIL on stale docs
  and unfiltered `outcome.at`/`page.parent`, then PASS after the follow-ups.

## Next cycle should know

- Never run `npm test` / `npm run check:all`; the host gate owns the full suite.
- Any new `autonomy/cycles/<run>/<NN>/report.md` needs its `autonomy/JOURNAL.md` line in the same
  push or `smoke:docs` fails. `journal.ts` does not rewrite an existing line for the same cycle id;
  replace it by hand when a cycle is re-recorded.
- Gated `workflow_run` plans here have reported `passed` with no implementation; always inspect
  `git status`/`git log` after a step rather than trusting the status. A reviewer that temporarily
  restores base source can leave it staged; check and restore before committing.
- The control-centre filter is display-only; `stripTerminalSequences` is still what removes CSI from
  values before the filter. Keep both.
- Follow-ups not taken: the hub's `MAX_DISPLAY_LENGTH` cap counts code points, not terminal
  columns; an uploaded file still cannot correct an existing host card's question/default after the
  first save (only the host file path can); the wrap test proves behaviour through a newly exported
  `wrap`, so it does not exercise `pairPanel` at a width where the old drop branch is reachable.
