# Cycle 01 — Plan (run luna-ux-01, stream `ux`)

- Mode: **improve** (assigned board item V-05; steward P0 checked and recorded, no code change
  justified).
- Base: `a43f32bae871`. Branch: `pi/luna-ux-01`.
- Budget: ~$5 model spend, ~3 h. One item, finished and verified.

## Goal

Give a Luna terminal session a custom launch screen: a "Luna" wordmark with the pi version and up
to five useful first actions, a short reveal animation that respects reduced motion, a narrow-
terminal fallback, and an ASCII mode — wired through the one existing `session_start` handler in
control-center, tested, and documented.

## Item V-05 — launch screen

Justification (charter 1, 2, 3): pi 1.4 offers `ctx.ui.setHeader` and Luna does not use it
(`grep -rn "setHeader" packages tests` → no `ctx.ui.setHeader`), so the first screen of the
product is pi's stock header with no Luna identity or first actions. The API and examples exist in
the installed host (`types.d.ts:114-117`, `examples/extensions/custom-header.ts`); the need is
the `ux` stream's assigned V-05.

### Change

1. New `packages/extensions/src/control-center/launch-screen.ts`:
   - `launchLines(opts: { width, frame, reducedMotion, ascii, version, hubKey, menuCmd, theme })`
     — pure. Returns the rendered lines for the given reveal `frame` (0-based); final frame when
     `reducedMotion`. Every line through `truncateToWidth` and `visibleWidth`-checked at `width`.
     Below 60 columns: no art, one compact action line. ASCII mode: printable ASCII only.
     Content: "Luna" wordmark + `v<version>` (pi VERSION) and up to 5 actions: `<menuCmd>`,
     `<hubKey>` for the control centre, `/profile`, `/model`, `/resume`.
   - `launchHeader(deps)` — the `ctx.ui.setHeader` factory: keeps a frame counter, starts at most
     12 frames on `setInterval(..., 80..120).unref()`, calls `tui.requestRender()` per frame,
     clears the timer when the reveal finishes and in `dispose()`. Reduced motion (env
     `PI_KIT_REDUCED_MOTION=1`, `ui.json` `reducedMotion: true`, `TERM=dumb`, or `CI` set) → final
     frame, no timer.
   - Pure helpers exported for tests; no new dependencies, only node builtins and pi-tui peers.
2. Wire into the existing `session_start` handler in `control-center/index.ts` **after**
   `curated = true` and **before** the `commandMenu === "all"` early return. Run only when the
   session is TUI, `PI_KIT_INTERNAL_CHILD !== "1"`, `typeof ctx.ui.setHeader === "function"`, and
   `readUiFile()?.launchScreen !== "off"`. `menuCmd` is `/menu` when `pi.getCommands()` lists it,
   else `/kit` (works after V-03).
3. `packages/extensions/src/control-center/extension.json`: add `PI_KIT_REDUCED_MOTION` to `env`.
4. `package.json`: add `"smoke:launch-screen": "node tests/launch-screen-smoke.ts"` (the only
   scripts change; no existing script is modified).
5. `docs/control-center.md`: new `## Launch screen` section (behaviour, actions, reduced motion,
   narrow and ASCII modes, `launchScreen: "off"`). Run `npm run catalog` so `docs/reference.md`
   lists the new env var.

### Proof — `tests/launch-screen-smoke.ts`

Uses `harness` `loadModule`/`fakePi`/`isolateKitEnv`/`setEnv`/`tmpWorkspace`, and asserts:

- the TUI `session_start` calls `setHeader` exactly once;
- no header over rpc/print mode, in a child session, or with `launchScreen: "off"`;
- at widths 20, 40, 60, 80 and 120 every line has `visibleWidth(line) <= width`, and the output
  contains "Luna" and the menu command; width 20 does not throw;
- reduced motion via env and via `ui.json`: no timer starts and successive frames are identical;
- animated mode clears its timer by itself after the reveal and on `dispose()`;
- ASCII mode output is printable ASCII only;
- the menu command falls back to `/kit` when `getCommands()` lacks `menu`.

### Checks to run

- `npm run smoke:launch-screen` (new), `npm run smoke:command-menu`, `npm run smoke:control-center`,
  `npm run smoke:docs`, `npm run test:typecheck`, `npm run test:lint`.
- `npm run catalog` then `git status` (generated reference committed with the change).
- Independent `reviewer` subagent on the cycle diff against `autonomy/CHARTER.md`.
- Never `npm test` or `npm run check:all` (host gate runs the full suite on a clean checkout).

## Out of scope

- Steward P0 compat lane: not reproducible offline; see `review.md`. Recorded, not edited.
- Proposals (idle-cat blink, human-console focus theft, web-console shared runtime, trunk channel
  alias): remain proposals, not this cycle.
