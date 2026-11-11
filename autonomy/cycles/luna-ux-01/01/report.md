# Cycle 01 — Report (run luna-ux-01, stream `ux`)

Outcome: successful
Mode: improve

Board: V-05 done - a TUI session now opens on a Luna launch screen (wordmark, pi version, five first actions) with a self-stopping reveal, reduced-motion, narrow-terminal and ASCII fallbacks, wired through the existing `session_start` handler.

Item: launch screen renderer and factory - `f22cfe5` (with the ASCII fix and generated reference), `29569d1` (menu label), `84e52cf` (test hardening) - proven by the new `npm run -s smoke:launch-screen` (10/10), which fails at base because `tests/launch-screen-smoke.ts` cannot load the module; the wiring assertions pin one `setHeader` in the TUI (including `commandMenu: "all"`) and none over rpc/print, in a child, or with `launchScreen: "off"`.

Item: records and plan - `b6fd708` - proven by `npm run -s smoke:docs` (the cycle's own record/journal consistency gate).

## What changed

- `packages/extensions/src/control-center/launch-screen.ts` (new): pure
  `launchLines({ width, frame, reducedMotion, ascii, version, hubKey, menuCmd, theme })` and the
  `launchHeader({ version, hubKey, menuCmd, ascii, reducedMotion })` factory, plus exported
  `isReducedMotion(ui)` and `REVEAL_FRAMES`/`REVEAL_FRAME_MS`/`COMPACT_WIDTH`. The reveal is a
  progressive slice of the same content over at most twelve 90 ms frames on an `unref()`ed
  interval, each frame calling `tui.requestRender()`; the interval stops itself at the final frame
  and again in `dispose()`. Reduced motion (`PI_KIT_REDUCED_MOTION=1`, `ui.json`
  `reducedMotion: true`, `TERM=dumb`, or `CI`) returns the final frame with no timer. Every line is
  `truncateToWidth`-clipped and `visibleWidth`-fits the given width; below 60 columns the art is
  replaced by one compact line that keeps `Luna` and the menu command adjacent; ASCII mode strips
  terminal escapes so the output is printable US-ASCII.
- `packages/extensions/src/control-center/index.ts`: `installLaunchHeader(pi, ctx)` runs inside
  the **one existing** `pi.on("session_start")` handler, after `curated = true` and before the
  `commandMenu === "all"` early return, so it also runs for the all-commands menu. It requires
  `ctx.mode === "tui"`, `PI_KIT_INTERNAL_CHILD !== "1"`, a `setHeader` function, and
  `launchScreen !== "off"`. The menu action is `/menu` when `pi.getCommands()` lists it, else
  `/kit`. No second `session_start` handler was added.
- `packages/extensions/src/control-center/extension.json`: declares `PI_KIT_ASCII` and
  `PI_KIT_REDUCED_MOTION`; `docs/reference.md` regenerated with `npm run catalog`.
- `package.json`: exactly one added script, `smoke:launch-screen`; no existing script changed.
- `docs/control-center.md`: new "Launch screen" section with the actions, reveal and reduced
  motion, narrow and ASCII modes, and the `launchScreen: "off"` opt-out.
- `tests/launch-screen-smoke.ts` (new): 10 cases covering the renderer, widths, ASCII, reduced
  motion from both sources, the reveal timer and `dispose()`, the registration guards, `commandMenu:
  "all"`, and the `/menu`/`/kit` fallback.

## Verification

`smoke:launch-screen` 10/10, `smoke:command-menu` 11/11, `smoke:control-center` 31/31,
`smoke:docs`, `test:typecheck`, `test:lint`, and `node packages/core/reference.ts --check` all pass
at `84e52cf`. An independent `reviewer` subagent read the charter, the plan and the whole diff and
returned REVIEW-PASS; its coverage warnings are fixed in `84e52cf` and its two accepted deviations
are recorded in `verify.md`. The cycle diff excluding the records and lockfile is 27,672 chars.
Never ran `npm test` or `npm run check:all`.

## The steward P0 (not a board item)

The steward reports `ci-complete` and both `pi-compat` lanes red on candidate `d827f5063521`. That
candidate is not in this checkout or the remote (`git cat-file -t d827f5063521` fails; the only
refs are this branch and `refs/autonomy/reset`, both at the base), only pi 1.4.0 is installed and
only `pi-tui-1.4.0.tgz` is cached, so an older-pi lane cannot be run offline. Every
plausible version-sensitive check is green at this head: `smoke:docs`, `smoke:control-center`,
`smoke:command-contract`, `smoke:observability-contracts`, `smoke:pi-host-peers`,
`smoke:prompt-arguments`, `smoke:liveness-containment`, `smoke:command-menu`. The change adds no new
pi-tui import (control-center's overlay-frame already imports `stripTerminalSequences`,
`visibleWidth` and `truncateToWidth` at the base). No speculative compat edit was made: it would
lack an evidenced problem and risk the pinned lane. A rebuilt integration candidate is required to
reproduce; if it is still red, the failing job's log is the missing evidence.

## Left and notes for the next cycle

- P0: reproduce on a rebuilt candidate; if red, capture the failing `pi-compat` step's log — it
  cannot be reached from here.
- The earlier incarnation's cycle-01 report was replaced; `autonomy/JOURNAL.md`'s
  `luna-ux-01/01` line now names V-05 and this cycle's summary (the old line named the status-bar
  fixes, which remain in git history and on the base).
- Not taken (unchanged proposals): idle-cat blink, human-console focus theft, web-console shared
  runtime, trunk channel alias.
- Process: the `workflow_run` implementer committed but did not push (same as cycles 06, 08, 09);
  the coordinator checked and pushed each commit. One reviewer step again produced no visible text,
  so this cycle ran a separate independent reviewer for the verdict.
