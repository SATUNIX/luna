# Cycle 04 — Review (run luna-ux-01, stream `ux`)

- Base: `c8e76e224640` (head of `stream/ux`, cycle 03 merged). Working branch `pi/luna-ux-01`.
- Read: `autonomy/CHARTER.md` (full), cycle 03 `report.md` and `verify.md`,
  `autonomy/runs/luna-ux-01/HANDOFF.md`, every `autonomy/proposals/luna-ux-01-*.md`, and
  `git log --oneline c8e76e224640..HEAD` (empty: the branch starts exactly at the cycle base).
- Mode: **fix mode** (consolidation). The previous merged cycle was an improve/fix cycle; the
  assigned board item V-93 is a measured duplication defect, which is cleanup with evidence and
  outranks any new idea.

## Gate and upstream

- No red gate: `git status --short` is clean, HEAD equals the cycle base, and the branch is the
  pushed `stream/ux` head. No upstream merge conflict is present in the tree.
- `autonomy/CHARTER.md` is untouched by this cycle.

## Board item V-09 — already done, do not re-open

Cycle 03 landed exactly the remaining clause and it is merged at the base:

- `packages/extensions/third_party/subagent/SOURCE.md:279` holds the dated entry
  `- **Workflow panel height budget (2026-11-12):** ... wf-panel.ts ...` naming `wf-panel.ts`.
- `tests/docs-smoke.ts:473-490` isolates that entry and requires both `wf-panel.ts` and `23725c2`
  (the case failed before the entry, per cycle 03 `verify.md`).
- The TUI width work is pinned by `tests/tui-layout-smoke.ts` (`smoke:tui-layout`).

No change is made to V-09 in this cycle.

## Board item V-93 — confirmed, this cycle's work

The same rule (strip Unicode `Cc`, `Cf` and `Default_Ignorable_Code_Point`, then collapse to one
visible line) is hand-written in four places, and the `oneLine` helper in two more:

- `packages/extensions/src/control-center/hub.ts:177` — `HIDDEN_DISPLAY_CHARS` class literal, plus
  `displayText()` at 188-189 (cap 500).
- `packages/autonomy/lib/notebook.ts:126` — `HIDDEN_CHARS` class literal; `stripControls` at 129.
- `packages/extensions/src/autonomy-run/index.ts:192` — inline class literal inside `oneLine`.
- `packages/extensions/third_party/subagent/run-query.ts:216` — `HIDDEN_CHARS` class literal in
  `workerText()`.
- `packages/autonomy/cli.ts:719` and `packages/autonomy/lib/store.ts:148` — identical `oneLine`
  expressions; `packages/autonomy/cli.ts:249` is a third variant that keeps the class but not the
  collapse.

`grep -rln 'Default_Ignorable_Code_Point' packages tests docs` names exactly those four class
literals (plus tests and docs), so the measured baseline is 4 hand-written copies.

The repository already has the mechanism for this: `packages/core/gen-shared.ts`
`SHARED_COPIES` plus `npm run gen:shared`, which generates byte-identical copies into each
extension's `shared/` directory (`control-center/shared/input-owner.ts` is an existing example).
VISION section 2 opinion 5 (one obvious way) and 3C (a measured consolidation) are the charter
justification; charter "What counts as an improvement" items 1 (evidence), 2 (tests) and 3 (docs).

## Other findings

- `autonomy/proposals/luna-ux-01-03-workflow-panel-footer-after-prune.md` (handoff carry-over) is a
  real but separate defect needing its own failing test on the prune path. It is not taken this
  cycle: V-93 is a board item and outranks it, and the budget is one item.
- No new defect was found in the stream's area that outranks V-93.

## Checks planned for this cycle

Derived with `node packages/core/check-all.ts --for-changed` over the intended paths:
`docs:check`, `smoke:autonomy`, `smoke:autonomy-run`, `smoke:autonomy-selfimprove`,
`smoke:control-center`, `smoke:docs`, `smoke:eval-footprint`, `smoke:new-extension`,
`smoke:subagent-roles-isolation`, `smoke:workflow-notify`, `test:lint`, `test:typecheck`,
`verify`, plus the acceptance-named `smoke:autonomy-inbox`, `smoke:redaction-corpus` and the
directly affected `smoke:autonomy-notebook`. `npm test`, `npm run check:all` and
`/opt/autonomy/gate.sh` stay host-only.
