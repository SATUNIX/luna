# Cycle 04 — Report (run luna-ops-01, stream `ops`)

Outcome: successful
Mode: fix

Workflow: refused the plan-allowance budget for the V-41 trim plan ("no workflow of any size fits
this request: E3 Standard allows 8 planned agents a request and 8 are already planned or started");
the trim was taken through `subagent` implementer + reviewer instead.

The priority-0 red gate (steward backlog) was repaired first, then the assigned board item was done.
The board item is a docs-only recording task, so no code changed this cycle.

Board: V-41 done - inventory and record the shipped `/workflow` / `/workflows` surface and every
remaining caller, with the doc sweep named as follow-up.

Item: P0 (integrator) restore the red `smoke:docs` gate - d9143a6 - `npm run -s smoke:docs` (failed
with `report with no journal entry: luna-ux-01/01` at base, exit 0 after the fix)
Item: V-41 inventory `/workflow` and `/workflows` callers - 86a6b44 64edc7b 8a5a0de e112c29 -
`npm run -s docs:check` and `npm run -s smoke:docs` both exit 0 on the final head; the proposal's
grep counts (629/352/195) reproduce, and the independent whole-diff reviewer returned PASS

## What was done

1. **P0 (no board line, per the prompt).** `smoke:docs` was red on the integration candidate:
   `AssertionError: autonomy/JOURNAL.md disagrees with the cycle reports` listing
   `report with no journal entry: luna-ux-01/01`. Commit `43ace85` (merge `integration/luna` into
   `stream/ops`) had brought in `autonomy/cycles/luna-ux-01/01/report.md` without its journal line.
   Root cause: a report merged from another stream must arrive with its journal line, or
   `checkJournal` (`packages/core/lib/journal.ts`, asserted at `tests/docs-smoke.ts:491`) fails the
   gate. Fixed by adding exactly that one line (`d9143a6`). No check was weakened. This is the same
   class as cycle 03's `luna-core-01/01` fix.

2. **V-41 (V-04 part 1).** One new file, `autonomy/proposals/V-04-unify-workflows.md` (the path the
   item's acceptance names). It records the shipped behaviour (one `runCommand` handler in
   `workflow-tools.ts` registering `/workflows` and `/workflow` as its alias; `list` / `panel [id]` /
   `status <id>` subcommands; a bare run id falls through to `Unknown subcommand` and is not a panel
   open), pinned by `tests/run-query-smoke.ts:268-291` and `docs/reference.md:67-68`. It inventories
   every remaining `/workflow` or `/workflows` caller with an action (change / keep alias / keep
   canonical / regenerate with `npm run catalog`), states that the pre-2026-11-11 design (bare
   `/workflows` or a run id opening the panel; exported `runWorkflowCommand`) was superseded by
   `3c4c571` and must not be re-proposed, and names the doc sweep as the follow-up. `git status`
   shows only that new file for the item; `docs:check` passes.

## Test justification

No test was changed. `smoke:docs` is the repository's own check that `autonomy/JOURNAL.md` agrees
with the cycle reports; the P0 fix restores it rather than loosening it, and it now passes.

## What was left and what the next cycle should know

- **The journal-drift failure is recurring**: `luna-core-01/01` in cycle 03, now `luna-ux-01/01`.
  The in-repo check is correct and must not be weakened; the durable fix belongs in whatever step
  merges another stream's report onto `integration/luna` (outside this repository). No proposal was
  filed because the fix is not in-repo.
- **The doc sweep itself was not performed** (the item is record-only): a future cycle should apply
  the **change** rows in §2 of the proposal (`docs/workflows.md`, `docs/script-workflows.md`,
  `docs/agent-orchestration.md`, `docs/architecture/workflows-and-skills.md`,
  `docs/architecture/subagents-and-orchestration.md`, `docs/control-center.md`, `docs/effort.md`,
  `docs/structured-output.md`, `subagent/SOURCE.md` then regenerate `THIRD_PARTY_NOTICES.md`,
  `control.ts`, `workflow-tools.ts`, `wf-panel.ts`, `runner.ts`, `control-center/index.ts`,
  `effort/ledger.ts`, `effort/strategy.ts`, `human-console/index.ts`,
  `workflow-authoring/references/scripts.md`, `packages/kit/workflows/feature.md`).
- The proposal was first written at 58 KB with pasted transcripts, which pushed the cycle diff to
  60206 bytes — over the 60000 review cap. It was trimmed to 18.5 KB (`8a5a0de`) and the diff is now
  19950 bytes. Watch proposal size: record findings, not full transcripts.
- Carried and untouched: installer doc drift (lite skill count, `--scope project` `.env` claim,
  unknown `--profile` stack trace) and `npmDeliveryEnabled()` vs `docs/releasing.md`.
