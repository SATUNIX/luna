# Proposal — forward mouse events and give the framed overlay its inner width

Run `luna-ux-01`, cycle 10 (stream `ux`). Status: proposal, not implemented.

## Findings

`withOverlayFrame` (`packages/extensions/src/control-center/overlay-frame.ts:117-148`) wraps the
hub's `SettingsList` and the `/workflows` panel, but its `render` gives the inner component the
full overlay width and only then clips each produced line to `width - 4`:

- `:136` — `frameLines(inner.render(width), width, theme)`; `frameLines` (`:73-77`) reserves two
  border cells and two padding cells. Any component that lays out to `width` (the hub's
  `SettingsList` does, and its description/hint wrapping is width-sensitive) is laid out four
  cells wider than the space it is drawn into, so its right-hand content is truncated rather
  than wrapped.
- `:137-147` — the wrapper forwards `handleInput` and `dispose` but not `handleMouse`. pi-tui
  dispatches pointer events to a component's `handleMouse`, so inside the frame the hub rows and
  the panel buttons do not respond to clicks; the user sees a box that looks interactive but
  only accepts keys. Cycle 10's short-terminal test exercises `render` only and does not cover
  this.

Both are real at `9e4e345` and affect both first-party overlays because the vendor copy
(`packages/extensions/third_party/subagent/overlay-frame.ts`) is byte-identical and asserted so
by the smokes.

## Proposed change

1. Pass the inner width to the child:
   `render: (width) => frameLines(inner.render(Math.max(1, width - 4)), width, theme)`.
   Keep `frameLines` clipping as a safety net for components that ignore the width.
2. Add `handleMouse?: (event: MouseEvent) => void` to the wrapper's returned component and
   forward it to `inner.handleMouse?.(event)`, translating coordinates by the one-cell border
   and one-cell padding offset (the same offset `contentLine` applies) if pi-tui's event carries
   row/column rather than component-relative coordinates. Check the `MouseEvent` shape in
   `@earendil-works/pi-tui` before deciding whether translation is needed.
3. Keep the vendor copy byte-identical and extend the two smoke assertions:
   - a framed component whose `render` records the width it was given receives `width - 4`;
   - a `handleMouse` event reaches the inner component (and is not delivered twice);
   - the existing frame tests (borders, `width < 10`, dimming) stay green.

## Tests to add

`tests/control-center-smoke.ts`: a fake inner component that records `render` calls and
`handleMouse`; assert the recorded width is `overlayWidth - 4`, the returned lines are still
`overlayWidth` visible cells, and one forwarded mouse event reaches the inner handler. Mirror the
same assertions in the `/workflows` panel case if its component defines `handleMouse`.

## Why not this cycle

It changes the pointer contract for two overlays plus the vendored copy and the fakes, and needs
a `MouseEvent` shape check against the pinned pi-tui. That is a larger change than the rest of
cycle 10, which is already scoped to the three carried-over control-center fixes; doing it here
would either crowd the review diff or land it without the pointer tests it needs. It stays a
proposal until a cycle can take it with both assertions above.
