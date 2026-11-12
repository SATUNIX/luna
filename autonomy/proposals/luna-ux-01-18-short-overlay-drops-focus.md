# Short control-centre overlay can clip the focused row

Status: implemented in cycle 19 (`f8a85ce`); the `focus` branch in
`packages/extensions/src/control-center/hub.ts` keeps the focused row (and then the search line)
when a blind slice would hide it. Pinned by `tests/control-center-smoke.ts` "a very short overlay
keeps the focused row when the cursor is not in the head" (focus moved to `cmd19` at 3 and 4
terminal rows; `npm run smoke:control-center`).

## Problem

When the control centre opens on a terminal only a few rows tall, the renderer trims the
SettingsList by lowering `maxVisible`, then slices the result to the row budget:

- `packages/extensions/src/control-center/hub.ts:401-410` computes `budget = max(1, rows - 2)`
  (the two frame borders) and reduces `runtime.maxVisible` until the list fits.
- When even one item does not fit, `hub.ts:410` returns `lines.slice(0, budget)`: the head of the
  list, which is the search line and the first rows.

The focused row is not necessarily in that head. On a 5-row terminal the overlay is roughly three
content lines: search line, first item, hint. If the operator moves to a later row, or the page
reopens on a remembered focus, the focused row is outside the slice. The overlay looks open but
the cursor is not visible, so arrow keys appear to do nothing.

`tests/control-center-smoke.ts` pins the fit (every line within the requested width and the
short-terminal default) but not "the focused row is always rendered".

## Why it matters

This is the failure mode the short-terminal fit was meant to prevent: a clipped overlay that
hides the title or the active row. It is recoverable with `esc` and a taller terminal, but the
operator has no cue about which row is selected.

## Suggested fix

When the trimmed list cannot hold the focused row, render the focused item explicitly instead of
the head of the list:

- Keep the search line only while it fits with the focused item and the hint.
- If needed, drop the hint first, then the search line, then non-focused rows, but always include
  the focused row (and preferably one row of context above or below).
- Apply the same rule to the `/workflows` overlay if it has the same list shape.

Add a smoke case with a terminal of 5-7 rows, a page with several rows, focus moved to the last
row, asserting that the focused row's label appears in the rendered lines and the frame stays
within the row budget. A pre-fix assertion should fail.

## Evidence

- `packages/extensions/src/control-center/hub.ts:401-410` (budget, `maxVisible`, `slice`).
- `tests/control-center-smoke.ts` "the hub overlay fits a short terminal..." covers width and
  border lines, not focused-row visibility.
- Cycle 18 report, "Leftover": short overlays below five rows were left as a proposal rather than
  widening the typed-command change.
