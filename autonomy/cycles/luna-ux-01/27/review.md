# Cycle 27 review

Mode: improve (assigned board item V-09, narrow-terminal and glyph-consistency hardening).

Base: `897ff52bce9c` (head of `stream/ux`). Branch: `pi/luna-ux-01`.

## Scope read

- `autonomy/CHARTER.md` (acceptance, evidence, tests, docs, one logical change per commit).
- `autonomy/runs/luna-ux-01/HANDOFF.md` (cycle 26 closed the red `smoke:workflow-resume` gate;
  next cycle may take a stream improvement).
- `autonomy/cycles/luna-ux-01/26/report.md` (green acceptance, reviewer PASS).
- `git log --oneline 897ff52bce9c..HEAD` (no new commits at review time).
- Open proposals, including `luna-ux-01-19-workflow-panel-height.md` and
  `luna-ux-01-25-hub-tiny-terminal.md`.

## Board item under review

V-09: narrow-terminal and glyph-consistency hardening over the existing pure TUI renderers
(no new animations or widgets). Rendered as two ordered sub-items in `split`.

Acceptance in the assignment: every line of the four renderers fits widths 20, 32, 40, 60, 80
and 120, including wide-character and emoji input; ASCII-mode footer output has no non-ASCII
character; `smoke:tui-layout` exists and exits 0; existing status-bar, workflow-panel,
remote-control and acceptance checks stay green; touched vendored directories update `SOURCE.md`.

## Evidence

1. **Status bar in ASCII mode still emits a Unicode ellipsis.** `truncateDisplay` defaults to
   `…` (`packages/extensions/third_party/custom-footer/width.ts:75`), and the fit path calls it
   without an ASCII alternative (`render.ts:170,231,232,350,356,386`). `footerGlyphs` switches
   markers and separators but never reaches these cuts. A new smoke at width 20 failed:

   ```
   AssertionError: ascii footer light@20: non-ASCII character in > proj | ! UNATTEND…
   ```

2. **The todo checklist is never cut to the terminal.** `renderTodoWidget` has no width
   parameter (`packages/extensions/third_party/custom-footer/widgets.ts:9`) and its only call
   site passes four arguments (`packages/extensions/third_party/custom-footer/index.ts:275`).
   pi then wraps a long item onto extra rows. The same smoke at width 20 measured:

   ```
   todos@20: line 0 is 50 columns, limit 20: Todos 1/3 ███░░░░░░░  /footer todos off hides this
   ```

3. **The remote pairing panel measures code units, not columns.** `wrap` compares and slices
   with `String#length` (`packages/extensions/src/remote-control/index.ts:138,146-148`). A CJK
   token therefore overflows a narrow terminal. Against the base source the smoke failed:

   ```
   pair panel@20: line 19 is 22 columns, limit 20:  日本語日本語日本語 🚀
   ```

4. **The /workflows panel already fits.** `WorkflowPanel.render` truncates every line with
   pi-tui's `truncateToWidth` (`packages/extensions/third_party/subagent/wf-panel.ts`), and the
   new smoke passes the run and list views at every acceptance width with wide input, including
   ANSI styling. No change is needed there; the new test pins it against regression.

## Decision

Two ordered sub-items, each one commit with its own tests:

1. **Footer and todo checklist glyph/width consistency** — thread the glyph set's ASCII
   ellipsis through every generated cut in the status bar, and give the todo widget an optional
   width that its call site supplies. This is the glyph-consistency half of V-09.
2. **Pairing panel column wrapping** — replace code-unit wrapping with pi-tui display-width
   primitives, and pin the panel with wide input. This is the narrow-terminal half.

Not taken: the workflow-panel height proposal (`render` does not read terminal rows) is a
separate, larger layout question already proposed; this cycle only pins its width. The hub
1–4-row edges, idle-cat intent and `TRUNK_CHANNEL` alias remain proposals/carry-overs.
