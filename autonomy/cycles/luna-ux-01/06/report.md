# Cycle 06: vendored provenance pinned, workflow panel prune fallback fixed

Outcome: successful
Mode: fix

Board: V-09 done - `tests/docs-smoke.ts` now reads every `third_party/*/SOURCE.md` and requires a bolded dated entry, the subagent pin selects the `wf-panel.ts`/`23725c2` entry, and the eleven files that lacked that shape gained a truthful `Vendored upstream (Date)` entry.
Board: V-93 done - verified already merged at `36565d97`/`5f59714f`, not redone: one hand-written hidden-character filter in `packages/core/shared/visible-text.ts`, generated copies clean via `gen-shared --check`, and the control-centre/inbox/tui-layout/redaction checks still pass.

Item: V-09 vendored SOURCE.md provenance scan - `17e0d4ab` - `npm run -s smoke:docs` (`[docs-smoke] OK: 14 documented commands validated ...`; the new scan fails on the base for eleven files and passes after the entries).
Item: WorkflowPanel falls back to the list when its run is pruned - `88bc809d`, `aa9d5367` - `npm run -s smoke:workflow-panel` (`21 checks passed`; new case: after the open run is pruned the list body and footer render and the first `down` moves `listIndex` 0 -> 1).
Item: V-93 shared hidden-character filter (verify only) - `36565d97`, `5f59714f` (merged before this cycle) - `smoke:control-center` (46), `smoke:autonomy-inbox` (7), `smoke:tui-layout` (5), `smoke:redaction-corpus` (6), `gen-shared --check`.

# What was found and fixed

The cycle-05 host gate was red on `check-all` and `smoke:redaction-corpus`. Both do not reproduce on
this base: `smoke:redaction-corpus` passes all 6 checks and `smoke:docs` is green (the journal line
it missed is already present). The cycle-05 redaction failure is a host-load CPU budget, not a code
regression, so no test was changed for it.

V-09's remaining clause was real: the old docs-smoke case read only the subagent `SOURCE.md`; the
other eleven vendored directories had no bolded dated entry, so their provenance was unpinned. Each
now has one truthful `Vendored upstream (Date)` bullet using its own `- Date:` value, and a generic
scan holds every third_party directory to that shape. The subagent pin now finds the entry that
names `wf-panel.ts` and `23725c2` instead of the first `2026-11-12` entry, so a reorder cannot pin
the wrong bullet. `THIRD_PARTY_NOTICES.md` is regenerated.

The WorkflowPanel defect from the cycle-03 proposal was still present: `render()` used `current()`
while `footer()` and `press()` used `view`, so after `RunRegistry.prune()` the list body appeared
under the run legend and the first `down` was swallowed. One `inRun()` now drives all three;
`view` and an open save/stop confirm keep their state (the existing confirm case still passes).

# Left / next cycle

- Cycle-05 V-73 (canonical `Alias of /<target>` wording and `alias-target-missing`) was not taken;
  this cycle's board named V-09 and V-93. It stays on `origin/attempts/luna-ux-01/cycle-05`.
- Non-blocking review notes: `docs/workflows.md` could spell out that an open confirm still owns
  the keys after the prune fallback, and `wf-panel.ts` `footer()` looks up `current()` twice.
- The other open ux proposals are untouched and remain for later cycles.
