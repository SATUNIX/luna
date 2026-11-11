# Cycle 02 — Report (run luna-ux-01, stream `ux`)

Outcome: successful
Mode: fix

Board: V-05 done - the shipped Luna launch screen now installs on exactly the same TUI predicate as the curated menu, so an older host with `hasUI` and no `ctx.mode` gets the screen instead of silently losing it.

Item: launch-screen TUI guard consolidation - `33814b1` - proven by `npm run -s smoke:launch-screen` (11/11), whose new case asserts `mode: undefined, hasUI: true` installs one header and `hasUI: false` installs none; it fails at the base source's `ctx.mode !== "tui"` check.

## What changed

- `packages/extensions/src/control-center/index.ts`: `registerCommandMenu` already computes
  `isTui = mode === undefined ? ctx.hasUI : mode === "tui"` and documents the older-pi fallback.
  `installLaunchHeader` re-derived the decision as `ctx.mode !== "tui"`, so on a host without
  `ctx.mode` the menu installed but the launch screen did not. The registration now passes its
  `isTui` into `installLaunchHeader`, which checks that argument. Every other guard is unchanged:
  `PI_KIT_INTERNAL_CHILD`, `typeof ctx.ui.setHeader`, and `launchScreen: "off"`. There is still one
  `pi.on("session_start")` handler.
- `tests/launch-screen-smoke.ts`: the fake context can now take an explicit `hasUI` (so `mode:
  undefined` is not replaced by the default `"tui"`), plus the two undefined-mode cases.
- No docs change: `docs/control-center.md` describes TUI behaviour and never claims a `ctx.mode`
  requirement; current pi 1.4 always sets `ctx.mode`, so users see no difference. This is
  consolidation after cycle 01's improve work, not a new feature.

## Verification

`smoke:launch-screen` 11/11, `smoke:command-menu` 11/11, `smoke:control-center` 31/31,
`smoke:docs`, `test:typecheck` and `test:lint` all pass at `33814b1`; an independent reviewer read
the whole diff against the charter and returned REVIEW-PASS with no critical findings. Cycle diff
excluding records and lockfile: 3,619 chars. Never ran `npm test` or `npm run check:all`.

## Left and notes for the next cycle

- Reviewer completeness nit, not taken: the undefined-mode pair asserts header counts only, so the
  child/`launchScreen: "off"` guards are still pinned only on the concrete-mode path. They are
  unchanged code and remain green; a future launch-screen change could add the combination.
- The steward `ci-complete` / `pi-compat` P0 remains unreproducible here: candidate `d827f5063521`
  is not in this checkout or the remote, and only pi 1.4.0 is installed. A rebuilt candidate and
  the failing job log are still the missing evidence; do not repeat the offline sweep.
- Open proposals unchanged: idle-cat blink (needs an operator decision), human-console
  multi-card focus theft, web-console shared runtime (outside `ux`), `trunk` channel alias
  (core/ops).
- Board item V-05 had already been completed by cycle 01; this cycle verified it and fixed the one
  evidenced inconsistency found in that code.
