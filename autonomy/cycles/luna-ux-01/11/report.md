# Cycle 11 — Report (run `luna-ux-01`, stream `ux`)

Outcome: successful
Mode: fix

## Board

- Board: PG-59 done - `smoke:update-notice` is already green at base `7647d1b2f347` (8/8, including the pi 0.99.2 update-notice case); no change was needed.
- Board: V-05 done - `smoke:launch-screen` is already green at base (11/11); the launch screen ships with the wordmark, first actions, animation and reduced-motion path.

Both assigned items were already fixed and merged before this cycle, so the cycle spent its
budget on real defects found in review.

## Items

- Item: Frame hub overlays at the inner width and forward the mouse - `8b5bc41` - `smoke:control-center` (34/34) and `smoke:workflow-panel` (14/14)
- Item: Reveal short hidden commands in `/` - `faea4f3` - `smoke:command-menu` (12/12)

## What changed

1. `overlay-frame.ts` rendered the child at the full overlay width and then clipped the frame to
   `width-4`, so width-sensitive children wrapped or clipped four cells too wide. The wrapper also
   never implemented `handleMouse`, so pointer events never reached the hub's list or search. The
   child now lays out at `width-4` (full width under 10 columns), and `handleMouse` forwards
   component-local points translated into the child's `x-2, y-1, width-4, height-2`, keeping
   `screenX/screenY`; the hub overlay delegates to its container. The vendor copy stays
   byte-identical. New smoke cases pin the width translation, a narrow width, point translation,
   border rejection and the hub's delegation, and `docs/control-center.md` describes the contract.
2. The curated `/` autocomplete revealed a hidden command only after four characters, but `/kit`
   is hidden and three characters, so it could never reappear although the docs promise it. The
   threshold is now `min(4, name.length)`, so a shorter hidden name reveals at its full name; new
   cases check `/ki` absent and `/kit` present, and the docs and module comments state the rule.

## Checks

Green: `smoke:control-center` 34/34, `smoke:workflow-panel` 14/14, `smoke:command-menu` 12/12,
`smoke:update-notice` 8/8, `smoke:launch-screen` 11/11, `smoke:docs` OK, `test:typecheck` exit 0,
`test:lint` exit 0. Both new cases fail when their source change is reverted. Diff 18718
characters against the 30000 stop line. No scripts, charter, control-path, credential or release
change. Details in `verify.md`.

## Leftovers

- A whole-diff reviewer returned no output after two items (same interruption seen in cycle 10);
  the per-item reviewers and both negative runs are the review evidence. Not a merge blocker, but
  the gap is recorded.
- Open proposals were not merged or fixed here: `luna-ux-01-10-hub-overlay-mouse-and-width.md`
  stays open for the remaining width/mouse polish (short-terminal clipping), and the deferred
  hub `ctx.mode` fallback, undocumented hub rows and the multi-card focus-theft / idle-cat
  proposals carry to cycle 12 via `HANDOFF.md`.
- No board item needed a change, so no board status changed.
