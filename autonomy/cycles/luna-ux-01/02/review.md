# Cycle 02 — Review (run luna-ux-01, stream `ux`)

Base: `8ec00f9726bd` (head of `stream/ux`, cycle start). Branch `pi/luna-ux-01`. Area: TUI
overlays, the `/` command menu, launch screen, animation and polish (V-01, V-02, V-03, V-05, V-09).

## Charter and state

Read `autonomy/CHARTER.md` in full. No red gate reproduced at the base: `smoke:launch-screen`
(10/10), `smoke:command-menu` (11/11) and `smoke:control-center` (31/31) pass. No upstream ref is
configured in this checkout (`git show-ref` has only this branch), so there is no merge conflict to
resolve. Previous cycle 01 is merged and its report records V-05 as done.

Board item **V-05** is therefore already implemented on HEAD. Because cycle 01 was an improve cycle
and the prompt asks for a consolidation pass first, this cycle checks the shipped launch screen
against its acceptance criteria and the code around it rather than re-adding it.

## Confirmed defect — the launch-screen TUI guard contradicts the menu's own fallback

Evidence:

- `packages/extensions/src/control-center/index.ts:61` documents the enclosing registration's
  rule: "older pi without `ctx.mode` falls back to `hasUI`".
- `index.ts:69-70` implements it: `const isTui = mode === undefined ? ctx.hasUI : mode === "tui";`
  and returns for a non-TUI.
- `index.ts:43-44`, `installLaunchHeader`, then re-derives the decision as `if (ctx.mode !== "tui")
  return;`. On the very host the comment names — `ctx.mode` absent, `hasUI` true — the curated menu
  is installed but the launch header is silently skipped.
- No test covers that combination: `tests/launch-screen-smoke.ts`'s `start()` always passes a
  concrete `mode` (`tui`, `rpc`, `print`), and its `hasUI` is derived from it.

The board item says the header runs "only when isTui", i.e. the same predicate the registration
uses. Passing the already-computed `isTui` into `installLaunchHeader` removes the contradictory
second check and makes the documented fallback true for both features.

Fix: pass `isTui` from `registerCommandMenu` into `installLaunchHeader`, replace the `ctx.mode`
check with that argument, and extend `tests/launch-screen-smoke.ts` with an undefined-mode,
`hasUI: true` case (header installed) and an undefined-mode, `hasUI: false` case (no header).

## Checked and set aside

- Width clipping, reduced motion from env and `ui.json`, timer self-stop and `dispose()`, ASCII
  output, and the `/menu`/`/kit` fallback: all implemented and pinned by the 10 existing checks.
- `installLaunchHeader`'s `PI_KIT_INTERNAL_CHILD` guard remains intentionally redundant (the
  extension returns before registering in a child); the observable child outcome is tested.
- Idle-cat blink, human-console multi-card focus theft, web-console shared runtime and the `trunk`
  channel alias remain as proposals; they need an operator decision or sit outside `ux`.
- No other runtime-reachable defect was found in the stream area during this review.

## Mode

**Fix mode.** The board item is already green, so the cycle's work is the evidenced consolidation
fix above; there is no new improvement to invent.
