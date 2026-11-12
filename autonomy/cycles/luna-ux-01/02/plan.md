# Cycle 02 — Plan (run luna-ux-01, stream `ux`)

Mode: **fix**. Board item V-05 is already implemented and verified on the base; this cycle fixes a
guard inconsistency in that shipped code (consolidation after cycle 01's improve work).

## Item 1 — launch header must use the registration's `isTui` predicate

Justification against the charter (§1 real problem, §2 tested, §3 documented): the code contradicts
its own documented fallback. `registerCommandMenu` deliberately treats `ctx.mode === undefined` as
TUI when `ctx.hasUI` is true, but `installLaunchHeader` rejects every host whose `ctx.mode` is not
exactly `"tui"`. On such an older host the menu appears and the launch screen silently does not,
although the board item requires the header when `isTui` is true.

Change:

- `packages/extensions/src/control-center/index.ts`: pass the computed `isTui` into
  `installLaunchHeader(pi, ctx, isTui)` and use that argument instead of re-reading `ctx.mode`.
  Keep every other guard (child, `setHeader`, `launchScreen: "off"`) unchanged.
- `tests/launch-screen-smoke.ts`: let the fake context take an explicit `hasUI`, add a case with
  `mode: undefined, hasUI: true` that asserts one header, and one with `mode: undefined,
  hasUI: false` that asserts none.
- No user-facing behaviour changes for current pi (1.4 always sets `ctx.mode`), so
  `docs/control-center.md` needs no edit; the existing "TUI" wording stays accurate.

Checks that prove it (do not run `npm test` or `npm run check:all`):

- `npm run -s smoke:launch-screen` — new case fails at base's module shape only after the test edit;
  with the fix the undefined-mode/TUI host installs exactly one header and the non-UI host none.
- `npm run -s smoke:command-menu` — the single `session_start` handler and curated-menu behaviour
  stay green.
- `npm run -s smoke:control-center` — the hub wiring stays green.
- `npm run -s test:typecheck` and `npm run -s test:lint`.

Deliverable: one commit with the finding, root cause, fix and verification in its message.

## Goal and task graph

Goal: make the launch-screen installation honour the same TUI predicate as the curated menu, pinned
by a test, with all targeted checks green.
Tasks: (1) implement and test the guard fix; (2) independent review of the diff against the charter;
(3) run the targeted checks and record `verify.md` / `report.md` / journal / handoff.

## Budget check

The change touches two files and adds one test case; the cycle diff stays far below the 30,000
character stop-taking line. One implementation item is enough for the remaining budget.
