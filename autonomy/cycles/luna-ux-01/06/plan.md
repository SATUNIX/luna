# Cycle 06 — Plan (run luna-ux-01, stream `ux`)

Base `49e17ff550ba`. Mode: **fix**. One board item (V-03) plus the P0 gate repair.

## Carried from cycle 05

Cycle 05's V-03 and V-73 were not merged (acceptance red). V-03 is re-landed here from the reviewed
commits; V-73 is deferred (diff budget, see review.md).

## Items

### G-0 gate repair (P0, no `Board:` line)

Finding: `npm run smoke:docs` is red on the base — `autonomy/cycles/luna-ux-01/03/report.md` has
no `autonomy/JOURNAL.md` line. Root cause: cycle 03 was merged without its journal entry and cycle
05's fix (`3d6fdc1`) was never merged. Fix: add
`- luna-ux-01/03 | Board: V-01, V-03 | partial | …` and the new `luna-ux-01/06` line in the report
commit. Checks: `npm run smoke:docs`. The other cycle-05 reds (`smoke:firewall-gate`,
`smoke:redaction-corpus`, `smoke:env-isolation`, `smoke:workflow-resume`) are host-load flakes
owned by DE-93 or not reproducible here.

### V-03 fold `/settings` into the `/` menu; kit → menu (P1, steward board)

Justification (charter §What counts as an improvement 1, 2, 3): one obvious menu is the UX goal;
the operator's board item names the exact acceptance. Evidence: the current tree registers
`kit`/`helpers` only (`packages/extensions/src/control-center/index.ts:171,178`), no `menu` command,
no Settings page (`model.ts:83-100`), hidden locations still say `/kit` (`command-menu.ts:26,193`),
and `/settings` is unreachable from the hub.

Change: re-land the reviewed cycle-05 commits `5cf8344`, `ba3ab0e` (cherry-picks of cycle-04
`27b22de`, `a48d910`): register `menu` primary; `kit`/`helpers` forward with `Alias of /menu`;
`alt+m` sends `/menu`; pin `menu`; rename the menu UI strings only; add the `settings` page with
the `/settings` prefill row and the commandMenu/hubKey/pinned/hidden/Display rows; extend
`HubValues`. Then two small fixes:

1. State the Settings-page shape explicitly in both tests: six rows on the page (five setting item
   rows + the `settings.display` page link), five non-page rows.
2. Correct `docs/control-center.md` (and the docs count is now six): the mermaid draws
   `System --> Doctor`, but `doctor`'s parent is `updates` — fix the edge.

Checks: `npm run smoke:command-contract`, `smoke:command-menu`, `smoke:control-center`,
`smoke:menu-settings`, `smoke:docs`, `node packages/core/reference.ts --check`,
`npm run test:typecheck`, `npm run test:lint`, `npm run verify`, `npm run catalog` (no diff).
Then an independent reviewer over the full diff.

Acceptance (from the board): `/menu`, `/kit`, `/helpers` all open the hub on the same handler;
`alt+m` sends `/menu`; Settings page exists with the `/settings` prefill row and the
commandMenu/hubKey/pinned/hidden rows; hidden-command locations read `moved → /menu …`; no
`settings` command registered by the kit; no `/kit` command reference remains in docs except alias
mentions.

## Deferred (HANDOFF, not this cycle)

- V-73 (`384dcf4`, `00ff7c8` on `origin/attempts/luna-ux-01/cycle-05`): canonical alias wording +
  `alias-target-missing`. ~19,600 chars; adding it puts the diff over the 60,000 review budget.
- Settings → Display Back navigation (page stack), overlay mouse forwarding, idle-cat blink
  decision, human-console concurrent cards, web-console shared-runtime smoke, and the new
  `withOverlayFrame` leak.

## Measured budget

V-03 alone is 45,670 characters (excluding lockfile and record files), under the 60,000 review
threshold and the firm stop. Stop taking new items after this.

## Task graph

`task_create`: G-0 gate repair, V-03 re-land; V-03 depends on G-0 (the branch must be green first).
