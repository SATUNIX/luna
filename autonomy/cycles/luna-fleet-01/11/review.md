# Cycle 11 review — luna-fleet-01

Base: `2c6b0737a66c` (head of `stream/fleet`, cycle start). Mode: **fix**, with the board's O-01
fleet-visibility slice carried forward as an improvement already reviewed once.

## Previous cycle

`autonomy/cycles/luna-fleet-01/10/report.md` on `origin/attempts/luna-fleet-01/cycle-10` recorded
`Outcome: successful`, but the merge review rejected the cycle and it is not in this base. The
rejection names four points, all checked against the attempt branch:

1. **README corruption.** `packages/extensions/src/autonomy-run/README.md:23-28` on
   `origin/attempts/luna-fleet-01/cycle-10` reads `... sets a` then a bare
   `<run> (<question>)\`. ...` followed by a duplicated dangling `command (docs/autonomy.md, ...)`
   line. The fleet footer format added in `6879700` is missing. Confirmed; the report's claim that
   the README describes the new output was false. `smoke:docs` validates commands and links, not
   prose, so it did not catch it.
2. **O-01 over-claimed.** The attempt report says `Board: O-01 done`, but PG-06 (host event log),
   PG-07 (live `/autonomy` widget), PG-08 (web console panel), PG-09 (owner inbox) and the recorded
   non-Claude walkthrough do not exist in the tree. Only the `status` list / `/autonomy` footer
   slice shipped. This cycle records O-01 as **progress**, not done.
3. **Unanchored eval assertion.** `tests/eval-footprint-smoke.ts:475-479` on the attempt branch
   matched `new RegExp(\`"toolText": ${reviewedLiteChars}\`)`, so `75960` would also match `7596`.
   Confirmed; accepted for repair rather than carry.
4. **Duplicated `oneLine` sanitiser.** `packages/autonomy/lib/store.ts:148` and
   `packages/extensions/src/autonomy-run/index.ts:191` each define it. The extension is deliberately
   self-contained (it imports only pi and node builtins), so the store cannot share it without a new
   cross-package dependency. Accepted as a documented, non-blocking duplication.

## Carried work that is sound

The three code commits on `origin/attempts/luna-fleet-01/cycle-10` were cherry-picked:
`91a56a6` (repair the red eval-footprint literal), `6879700` (RunSummary spend/budget/step/blocker
plus the status list and fleet footer) and `0b6f90a` (collapse worker-written blocker text). The
targeted tests and typecheck passed on the base after each pick.

## Board items

### O-01 (P0, rank 0) — owner visibility without a Claude session

Still open. The fleet list and footer now answer what is running, its step, spend against budget
and why it is blocked without knowing each run id; PG-06..PG-09 and the walkthrough remain absent.
Delivering four new surfaces plus a recorded walkthrough does not fit this cycle's budget, so this
cycle finishes and re-verifies the rejected fleet slice instead of starting another half-surface.

### A-92 (P0, rank 92) — dispatch template

Its claim primitive is merged (cycle 07, `5bd9289`, `6e30118`); the dispatch template itself is
complete but unmerged on `origin/attempts/luna-fleet-01/cycle-09` with a 56,430-character diff,
above the 30,000 stop-new-items line. It needs its own cycle; not started here.

## New problems found

- The attempt's README edit typo is structural, not cosmetic: it removed the sentence opening and
  the documented footer format. Fixed in this cycle and pinned by `smoke:docs` plus a manual read.
- The eval assertion was unanchored. Fixed by parsed equality on the written baseline field.

## Cycle choice

Fix mode: carry the rejected cycle-10 commits, repair the README and the eval assertion, re-run the
targeted checks, and record O-01 honestly as progress. No new surfaces this cycle.
