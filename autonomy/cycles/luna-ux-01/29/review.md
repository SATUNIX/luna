# Cycle 29 — Review (run `luna-ux-01`, stream `ux`)

Cycle base: `337fb705914d` (head of `stream/ux`). Board item: V-91 (P3), V-09 part 1.

## What the board asks for vs. what is already on the branch

V-91 was written before cycles 27 and 28 landed. Checking each clause against the code:

| Board clause | State at `337fb70` | Evidence |
|---|---|---|
| `tests/tui-layout-smoke.ts` exists and `smoke:tui-layout` is wired | **done** (cycle 27) | `tests/tui-layout-smoke.ts`; `package.json:242` |
| widths 20/32/40/60/80/120, footer light/default/heavy | **done** | `tui-layout-smoke.ts:35,88-91` |
| todo widget with 200-char and emoji/CJK item | **partial** — items are long/wide but none is 200 chars | `tui-layout-smoke.ts:135-138` |
| workflow panel with CJK agent label | **done** | `tui-layout-smoke.ts:174-196` |
| `pairPanel` with qr size 21 and long addresses | **partial** — qr size 25, addresses short | `tui-layout-smoke.ts:201-215` |
| plain and ANSI theme for each surface | **done** | footer `plain`/`wideTheme`/`ansiTheme`; todo same; panel `plainPaint`/`themePaint`; pair styled/unstyled |
| no line contains a newline | **missing** | no assertion |
| footer state with long cwd, branch, CJK session name, **6 statuses** | **partial** — 2 statuses | `tui-layout-smoke.ts:101-108` |
| `renderTodoWidget` optional width cuts every line | **done**, but as the **5th** parameter (`items, theme, max, ascii, width`), not the 4th the board names | `widgets.ts:10,13` |
| `updateTodoWidget` mounts a **component** so width is per render | **not done** — still passes `string[]` and reads `process.stdout.columns` once | `index.ts:275-279` |
| dated `SOURCE.md` entry per vendored dir touched | cycle 27/28 entries exist; a new entry is needed for this cycle's change | `custom-footer/SOURCE.md` tail |

## Findings with evidence

1. **Stale width on the todo widget (real bug, fix mode).**
   `packages/extensions/third_party/custom-footer/index.ts:275-279`:
   ```ts
   // the width is read at mount time, and the footer is re-mounted when the todo list changes.
   const columns = process.stdout.columns;
   const width = typeof columns === "number" ... ? columns : undefined;
   ctx.ui.setWidget(TODO_WIDGET, renderTodoWidget(cache.todos, theme, 8, settings.ascii, width));
   ```
   `setWidget` receives a `string[]`, so pi has no render function to call again: the cut is
   frozen at the columns value seen when the todo list last changed. Resizing the terminal (or
   mounting before the TUI knows its columns, where `process.stdout.columns` is `undefined`)
   leaves the checklist over-wide and wrapped, which is exactly what cycle 27 set out to stop.
   The remote-control pairing panel already uses the correct shape:
   `packages/extensions/src/remote-control/index.ts:206-212` returns
   `(tui, theme) => ({ render: (width) => pairPanel(...), invalidate() {} })`. The todo widget
   should do the same, which is also what the board asks for.

2. **Smoke gaps** (board acceptance, not a product bug): no newline assertion, 2 not 6
   statuses, no 200-char item, qr size 25 not 21, short addresses. These are cheap to close and
   are part of V-91's acceptance.

3. **Signature deviation.** The board names width as the 4th parameter; the shipped signature
   has `ascii` 4th and `width` 5th because cycle 28 pinned the ASCII path through the same call.
   Reordering would break `status-bar-smoke.ts:310,339` and the ASCII contract for no benefit.
   Keep the 5th parameter and record the deviation in the report.

## Checks that exist and pass at base

`npm run smoke:tui-layout` → `tui-layout-smoke: 4 checks passed`. No red gate, no upstream
conflict, no open HANDOFF carry-over other than the open proposals already listed (idle-cat
frames, hub frame/mouse edges, inert Settings rows, `TRUNK_CHANNEL` alias, inbox deadline edges,
workflow-hooks timer races) — none blocks V-91.

## Mode

**Fix mode** (consolidation of the previous improve cycle): one real defect in code cycle 27/28
touched, plus the remaining acceptance gaps of the assigned board item.
