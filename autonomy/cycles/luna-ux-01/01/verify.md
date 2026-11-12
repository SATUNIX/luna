# Cycle 01 — Verify (run luna-ux-01, stream `ux`)

- Base `a43f32bae871`, head at verification `84e52cf`.
- Cycle diff excluding the cycle records and lockfile: **27,672 chars** (under the 30,000
  stop-new-work line and the 60,000 review cap).

## Targeted checks (all exit 0 at `84e52cf`)

| Check | Result |
|---|---|
| `npm run smoke:launch-screen` | 10/10 |
| `npm run smoke:command-menu` | 11/11 |
| `npm run smoke:control-center` | 31/31 |
| `npm run smoke:docs` | OK, journal in step |
| `npm run test:typecheck` | OK |
| `npm run test:lint` | OK |
| `node packages/core/reference.ts --check` | docs/reference.md up to date |
| `node packages/core/check-all.ts --list \| grep launch` | `smoke:launch-screen` is in the gate |

Never ran `npm test` or `npm run check:all` (the host gate runs the full suite on a clean checkout).

## Independent review

A `reviewer` subagent read `autonomy/CHARTER.md`, the plan and the whole diff (26.5 KB at the
time) and ran the six targeted checks plus the reference check itself. Verdict **REVIEW-PASS**,
no critical findings. Warnings, all addressed or recorded:

1. The documented "twelve frames, about 90 ms" was unpinned; the action list beyond the menu
   command, the frame count and the `PI_KIT_ASCII` registration path were untested. **Fixed** in
   `84e52cf`: the test asserts the final frame lists `alt+m`, `/profile`, `/model`, `/resume`, that
   the reveal settles at `REVEAL_FRAMES - 1` renders, that the count 250 ms in is 1..4 (pinning the
   80-120 ms interval and a burst regression), and renders through the registered header with
   `PI_KIT_ASCII=1` at 20/80/120 columns.
2. `installLaunchHeader`'s `PI_KIT_INTERNAL_CHILD` guard is unreachable because the extension
   returns before registering the handler in a child. **Kept** deliberately: it is the explicit
   condition the cycle was asked to enforce and costs one comparison; the test also pins the
   observable outcome (no header in a child).
3. `installLaunchHeader` requires `ctx.mode === "tui"` while the enclosing registration keeps a
   `hasUI` fallback for hosts without `ctx.mode`. **Accepted**: `setHeader` is a TUI-only surface
   and the pi pin (1.4.0) always sets `ctx.mode`; a host without it gets pi's stock header rather
   than an untested code path.
4. A copy fix (`29569d1`, "command menu" label) was untested. **Fixed** in `84e52cf` with the
   action-label assertion.

## Behaviour evidence, by acceptance criterion

- Header installed exactly once in a TUI session, including when `commandMenu` is `"all"` — test
  `a TUI session installs exactly one header...`.
- No header over rpc/print, in a child, or with `launchScreen: "off"` — test `no header outside
  the TUI...`.
- Widths 20/40/60/80/120: every line `visibleWidth <= width`, output contains `Luna` and the
  menu command, width 20 does not throw; <60 columns is one compact line at 20 and 40 — test
  `every width fits...`.
- Reduced motion (env and `ui.json`) starts no timer and renders identical frames — test
  `reduced motion starts no timer...`; `TERM=dumb` and `CI` are pinned in
  `reduced motion comes from the environment or ui.json`.
- Animated reveal calls `requestRender`, stops by itself and `dispose()` stops it immediately —
  test `the reveal requests renders...`.
- ASCII is printable US-ASCII both pure and through registration — tests `ASCII mode keeps every
  rendered character printable` and `PI_KIT_ASCII=1 through the real registration...`.
- `/menu` when registered, `/kit` otherwise — test `the menu command follows getCommands...`.

## Residual risk

The steward P0 (`ci-complete` / `pi-compat` red on candidate `d827f5063521`) could not be
reproduced offline; see `review.md`. All version-sensitive checks that can run here are green, and
this cycle adds no new pi API surface (the header uses `ctx.ui.setHeader`, `visibleWidth`,
`truncateToWidth` and `stripTerminalSequences`, all already imported by control-center's
overlay-frame at the base). A rebuilt integration candidate is still required to confirm.
