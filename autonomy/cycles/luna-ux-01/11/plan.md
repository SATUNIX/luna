# Cycle 11 — Plan (run `luna-ux-01`, stream `ux`)

Mode: **fix**. Both assigned board items are green at the base (see `review.md`), so the cycle
takes the evidenced defects below. Two items; overlay first, then the menu reveal.

## Item 1 — Framed overlays: inner width and mouse forwarding

Justification: `overlay-frame.ts:136` lays the child out four cells wider than it is drawn, and
`:135-148` drops `handleMouse`, so every first-party TUI overlay wraps/clips wrongly and ignores
the pointer. Evidence and the pi-tui event shape are in `review.md` F1; the open proposal
`luna-ux-01-10-hub-overlay-mouse-and-width.md` records the same defect. Priority 3 (carried-over
proposal) / 4 (defect).

Change:

- `overlay-frame.ts` (and the byte-identical vendor copy): render the inner at `width - 4` when
  `width >= 10`, at `width` below that; add `handleMouse` that forwards a translated event
  (`x - 2`, `y - 1`, `width - 4`, `height - 2`) only when the point is inside the content area,
  and forwards untranslated below 10. Leave `screenX`/`screenY` alone.
- `hub.ts`: give the returned overlay component a `handleMouse` that delegates to the `Container`,
  so the event reaches the `SettingsList`.
- Tests in `tests/control-center-smoke.ts`: a recording inner asserts render width 36 for overlay
  width 40 and 8 for width 8/12; a mouse event at the content edge reaches the inner exactly once
  with translated coordinates and the result is returned; border/outside points are not forwarded;
  narrow width forwards untranslated; the hub's overlay component exposes `handleMouse`.
- Docs: `docs/control-center.md` overlay paragraph says the frame sizes its inner content and
  forwards mouse events to the hub rows/search.

Proof: `npm run smoke:control-center`, `npm run smoke:workflow-panel`, `npm run test:typecheck`,
`npm run test:lint`; the new cases must fail with the source reverted.

## Item 2 — Reveal short hidden commands in `/`

Justification: `command-menu.ts:223-235` only reveals a hidden item once four characters are
typed; `/kit` is hidden and three characters, so it can never appear, while
`docs/control-center.md:118-120,207-209` documents both the reveal rule and `/kit` as a working
alias (`review.md` F2). Priority 4 (defect).

Change:

- reveal threshold becomes `Math.min(HIDDEN_VISIBLE_PREFIX_LENGTH, name.length)`, so a name
  shorter than four characters reveals when typed in full.
- `tests/command-menu-smoke.ts`: a hidden `kit` item is absent at `/ki` and present at `/kit`;
  existing four-character cases stay green.
- `docs/control-center.md`: state that a name shorter than four characters reveals at its full
  length.

Proof: `npm run smoke:command-menu`, `npm run test:typecheck`, `npm run test:lint`.

## Not taken

F2-adjacent hub `ctx.mode` predicate, the undocumented hub rows and sub-12-row terminals are
deferred with evidence in `review.md`; they go to `report.md`/proposals, not this diff.
