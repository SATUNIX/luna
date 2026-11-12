# Cycle 29 — Plan (run `luna-ux-01`, stream `ux`)

Mode: **fix**. One item, V-91: finish the narrow-terminal layout smoke and fix the stale-width
todo widget.

## Item V-91 — per-render todo widget width + complete the layout smoke

**Justification (charter 1, 2, 3, 5):** a reproduced defect in code the previous cycle touched
(consolidation), plus the remaining acceptance clauses of the assigned board item. The defect:
`updateTodoWidget` hands pi a `string[]` cut to `process.stdout.columns` read once at mount
(`custom-footer/index.ts:275-279`), so a terminal resize or an early mount leaves the checklist
wrapped. The pairing panel already solves the same problem with a component
(`remote-control/index.ts:206-212`).

**Change:**
1. `packages/extensions/third_party/custom-footer/index.ts` — `updateTodoWidget` mounts a
   component `(tui, th) => ({ render: (w) => renderTodoWidget(cache.todos, th ?? theme, 8,
   settings.ascii, w), invalidate() {} })` instead of a `string[]`. Drop the
   `process.stdout.columns` read. `renderTodoWidget` keeps its shipped signature
   `(items, theme, max, ascii, width)`; width stays the 5th parameter because `ascii` is 4th and
   is pinned by `smoke:status-bar` (deviation from the board text recorded in the report).
2. `tests/status-bar-smoke.ts` — the `asciiSettingReachesTodoWidget` helper must call the mounted
   component's `render(width)` (previously `Array.isArray`). Add an assertion that the same
   component renders narrower at a smaller width, which is the regression pin for the change.
3. `tests/tui-layout-smoke.ts` — close the board's remaining clauses: 6 statuses in the wide
   footer state, a 200-character todo item, a qr of size 21 with long addresses, and a
   no-newline assertion applied to every line of every surface. All four surfaces already run
   both a plain and an ANSI theme.
4. Docs: `docs/status-bar-and-costs.md` says the checklist is cut per render at the terminal's
   current width; `custom-footer/SOURCE.md` gets a new dated entry.
5. If the smoke finds any other overflow in `wf-panel` or `pairPanel`, fix it with
   `truncateToWidth`/`truncateDisplay` in the same item.

**Checks that prove it:**
- `npm run smoke:tui-layout` (all four surfaces, 6 widths, plain + ANSI, new assertions).
- `npm run smoke:status-bar` (component mount, ASCII path, the new narrower-render pin).
- `npm run smoke:workflow-panel` (panel untouched but shares the vendored tree).
- `npm run test:typecheck`, `npm run test:lint`, `npm run verify` (docs/provenance).
- Negative run: the new status-bar pin fails on base with the final test overlaid.

**Acceptance:** `smoke:tui-layout` exits 0 with the new checks; `renderTodoWidget` with a width
cuts every line and without one is unchanged (already pinned by the existing tests); the todo
widget re-renders at the width pi passes; `custom-footer/SOURCE.md` has a new dated entry;
`smoke:status-bar`, `smoke:workflow-panel`, typecheck, lint and verify are green.

**Out of scope:** reordering `renderTodoWidget`'s parameters; any change to `package.json`
scripts (already wired); the open proposals listed in the review.

## Goal and task graph

Goal: V-91 accepted — per-render todo widget width and a complete narrow-terminal layout smoke.
Tasks: implement (above), review, verify, record.
