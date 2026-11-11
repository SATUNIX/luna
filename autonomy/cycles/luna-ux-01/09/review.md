# Cycle 09 — Review (run luna-ux-01, stream `ux`)

Base: `25cc6eab64b5` (head of `stream/ux` after cycle 08). Mode chosen: **fix** (a gate repair and a
reproduced UX defect; board item V-73 is already merged).

## Charter and bookkeeping

Read `autonomy/CHARTER.md` in full. Stream bookkeeping paths (`autonomy/cycles/luna-ux-01/09/`,
`autonomy/runs/luna-ux-01/HANDOFF.md`, `autonomy/proposals/luna-ux-01-09-*.md`) take precedence over
the older shared references. `autonomy/BACKLOG.md` is not edited. Previous reports and the run
handoff were read; all open `luna-ux-01-*` proposals were listed.

## P0 — integration-candidate `verify` / `pi-compat` red on `smoke:docs`

Steward steering says PR #63 is red because `autonomy/JOURNAL.md` lacks a `luna-ux-01/03` line while
`autonomy/cycles/luna-ux-01/03/report.md` exists, and that `tests/docs-smoke.ts:491`
(`checkJournal`) reports `report with no journal entry: luna-ux-01/03`.

**Already repaired on this branch.** Verified at HEAD `25cc6eab64b5`:

- `autonomy/JOURNAL.md:18` is `- luna-ux-01/03 | Board: V-01, V-03 | partial | ...`, added by
  cycle 06 (`629d998`, "repaired the smoke:docs journal gate for luna-ux-01/03").
- `grep -c luna-ux-01/03 autonomy/JOURNAL.md` is 2; one entry line plus the cycle-06 summary text.
- `node tests/docs-smoke.ts` → `[docs-smoke] OK: 14 documented commands validated, ...` (exit 0).
- `npm run -s smoke:docs` → same, exit 0.

**No change is correct here.** `packages/core/lib/journal.ts:100` rejects a duplicate entry
(`duplicate journal entry: luna-ux-01/03`), so appending a second line as literally instructed would
re-redden the same check. The candidate PR #63 predates cycle 06; a candidate rebuilt from this head
already carries the line. The `coverage` job is owner-side and out of scope per steering.

## Board item V-73 — already merged, re-verified

The assigned item "V-07c one wording for aliases, enforced" is exactly what cycle 08 shipped
(`be6c1bb`, report 08). Re-verified at HEAD:

- `git grep -n 'Alias for' packages/extensions/src` → empty.
- `npm run -s smoke:command-contract` → `all 12 checks passed`, including
  `an alias target must be a registered command, prompt template or built-in`,
  `a non-alias description is not alias-checked` and `the checkout satisfies the command contract`.
- `npm run -s catalog` → writes `docs/registry.json`, `docs/EXTENSIONS.md`,
  `docs/skills-catalogue.md`, `docs/capability-matrix.md`, `docs/reference.md`; `git status` clean
  (no diff).

No further work; it is recorded as done, not re-implemented.

## Reproduced UX defect (HANDOFF carry-over 1) — back navigation is not a stack

Evidence:

- `packages/extensions/src/control-center/model.ts:88` — `settings.parent = "main"`;
  `model.ts:93` — `display.parent = "system"`; the Settings page links to Display
  (`model.ts`, `settings.display` row → `targetPage: "display"`, pinned by
  `tests/control-center-smoke.ts:338`).
- `packages/extensions/src/control-center/hub.ts:376-380` — on `"back"` `openHub` sets
  `page = parentPage(deps.model, page)`, the single static parent, ignoring how the page was
  reached. So Settings → Display → Back lands on **System**, not Settings.
- `tests/control-center-smoke.ts:596` only covers a page opened directly at top level
  (`startPage "autonomy"`), where static parent and navigation history agree, so the bug is untested.

Fix: track a visited-page stack in `openHub` and use its top as the back target, falling back to
`parentPage` when the page was opened directly. Docs `docs/control-center.md:95` already claims "Back
returns the cursor to the row that opened the page"; the fix makes that true for a page reached
through another page.

## Other carry-overs checked and left

- Overlay mouse forwarding (`overlay-frame.ts`): both overlays still swallow wheel/click; no small
  fix, out of this cycle's budget. Left in HANDOFF.
- Idle-cat blink intent: needs an operator decision; unchanged.
- `smoke:web-console` shared runtime: outside the `ux` stream; proposal stands.
- Alias wording after the target (`aliasDeclarationsInSource` stops at `handler:`): accepted in
  cycle 08; all current registrations put `description` first.
- `trunk` channel alias: core/ops, not `ux`.

## New problems found

None outside the back-navigation defect. Candidate checks run during review all passed
(`smoke:command-contract`, `smoke:control-center`, `smoke:workflow-panel`, `smoke:docs`,
`smoke:web-console`, `smoke:wiring`, `test:typecheck`).
