# Cycle 06 — Plan (run luna-ux-01, stream `ux`)

Base `8416c502acc4`. Mode: **fix**.

## Items

### C-0 gate (priority 0)

Re-run the two checks the cycle-05 host gate failed (`smoke:redaction-corpus`, `smoke:docs`) before
and after the change. Both pass at the base; no test change is made for the host-load redaction
budget. This is bookkeeping only, so it gets no `Board:` line.

### V-09 vendored provenance scan (P2, assigned)

Finding: `tests/docs-smoke.ts` reads only `third_party/subagent/SOURCE.md`; eleven of twelve
vendored directories have no bolded dated entry (grep count 0), so their provenance is unpinned.

Change:
1. Add one truthful bolded dated entry, `**Vendored upstream (YYYY-MM-DD):**`, to each of the
   eleven `SOURCE.md` files, using the file's own `- Date:` value. Do not reformat unrelated
   bullets.
2. Tighten the existing subagent case to select the change entry that names `wf-panel.ts` (and
   `23725c2`), then assert that entry carries the bolded `(2026-11-12)` label. A future reorder
   cannot make it pin the height entry by accident.
3. Add the generic scan over every `packages/extensions/third_party/*/SOURCE.md`: at least one
   `  - **Label (YYYY-MM-DD):**` entry per directory. It fails on the current tree (eleven files)
   and passes after step 1.
4. Run `node packages/core/gen-notices.ts` and commit the regenerated `THIRD_PARTY_NOTICES.md`.

Checks: `npm run -s smoke:docs`, `npm run -s verify`, `test:typecheck`, `test:lint`, and
`node packages/core/check-all.ts --for-changed` for the touched paths.

### WorkflowPanel prune fallback (P2, defect)

Finding: after `RunRegistry.prune()` drops the open run, `render()` shows the list but `footer()`
and `press()` still use the run view; the first `down` is swallowed and the run legend is wrong.

Change: private `inRun()` (`view === "run" && current() !== undefined`) drives the body branch,
`footer()` and `press()`; `view`/`confirm` stay untouched so a surviving save or stop confirm keeps
its choices. Add a smoke case: open a run, prune it, assert list body + list footer, assert the
first `down` moves `listIndex` 0 -> 1. Keep the existing confirm-after-prune case. Add a dated
subagent `SOURCE.md` entry, a `docs/workflows.md` sentence and a `CHANGELOG.md` `Fixed` entry;
regenerate notices.

Checks: `npm run -s smoke:workflow-panel`, `smoke:docs`, `smoke:tui-layout`, `test:typecheck`,
`test:lint`, `verify`, notices check.

### V-93 verify only (P2, assigned, already merged)

No change. Run `smoke:control-center`, `smoke:autonomy-inbox`, `smoke:tui-layout`,
`smoke:redaction-corpus`, `npm run -s gen:shared -- --check` and confirm one hand-written copy.

## Deferred

Cycle-05 V-73 (alias wording + `alias-target-missing`) is not taken: this cycle's board names V-09
and V-93, and the diff budget is better spent on the pinned V-09 clause. It stays on
`origin/attempts/luna-ux-01/cycle-05` for a later cycle.

## Measured budget

Expected non-record diff: about 10,000 characters (well under the 30,000 stop-new-items line and
60,000 review limit). No new dependencies, scripts or shared helpers.

## Task graph

1. V-09 provenance scan.
2. WorkflowPanel prune fallback.
3. Verify (targeted checks, independent review), record report/verify/journal/handoff.
