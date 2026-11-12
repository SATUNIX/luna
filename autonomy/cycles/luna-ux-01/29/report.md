# Cycle 29 — Report (run `luna-ux-01`, stream `ux`)

Outcome: successful
Mode: fix

Board: V-91 done - the todo checklist now re-cuts at the width pi passes on every render, and the narrow-terminal smoke covers all six widths, both themes, all four surfaces and the board's fixture clauses
Item: todo widget re-renders at the passed width instead of a mount-time `process.stdout.columns` - eb739d5, 2599c21, d3ead52 - `npm run smoke:status-bar` 26/26 (`asciiSettingReachesTodoWidget` fails on base at 24 columns), `npm run smoke:tui-layout` 4/4
Item: narrow-terminal layout smoke closed to the board's clauses (six statuses, long cwd, 200-character todo, size-21 QR, no-newline assertion) - eb739d5, 2599c21, d3ead52 - `npm run smoke:tui-layout` 4/4; `smoke:workflow-panel` 20/20; `test:typecheck`, `test:lint`, `verify` exit 0
Item: docs and provenance for the per-render width - eb739d5 - `docs/status-bar-and-costs.md`, dated `custom-footer/SOURCE.md` entry, regenerated `THIRD_PARTY_NOTICES.md`; `npm run smoke:docs` passes

## Review

V-91 was written before cycles 27-28 landed, so most of its clauses already
shipped: `renderTodoWidget` already took an optional width, and
`tests/tui-layout-smoke.ts` already covered the four surfaces at six widths. The
honest remainder was one real defect and several fixture gaps.

The defect: `updateTodoWidget` (`custom-footer/index.ts:275-279`) built a
`string[]` cut once from `process.stdout.columns` at mount. A terminal resize,
or a mount before the terminal reports a size, left the checklist wrapped. The
pairing panel already solves the same problem by mounting a component whose
`render(width)` is called each frame (`remote-control/index.ts:206-212`).

## What changed

**Per-render width (`eb739d5`).** `updateTodoWidget` now mounts
`(_tui, th) => ({ render: (w) => renderTodoWidget(cache.todos, th ?? theme, 8,
settings.ascii, w), invalidate() {} })`, mirroring `pairWidget`. The
`process.stdout.columns` read is gone; the `undefined` branches for an absent
component are kept. Width stays `renderTodoWidget`'s 5th parameter, after
`ascii`, because `ascii` is 4th in the shipped signature and is pinned by
`smoke:status-bar` — a recorded deviation from the board text.

**Regression pin (`eb739d5`).** `tests/status-bar-smoke.ts`
`asciiSettingReachesTodoWidget` now reads lines through the mounted component's
`render(width)` instead of `Array.isArray`, and renders the same widget at 24
columns, asserting every line fits. On base this fails (50 columns), so the pin
is what the change flips.

**Smoke completion (`eb739d5`, `2599c21`, `d3ead52`).** `tests/tui-layout-smoke.ts`
now asserts no line contains `\n` or `\r` on every surface, uses six statuses in
the wide footer state, gives the todo widget fixture its own 200-character item
and emoji/CJK item (`2599c21` — the first pass put the 200-character item only
in the footer state, which merely counts todos), a long CJK cwd (`d3ead52` —
reviewer: the earlier path was wide but short), and a size-21 QR with long IPv4
and IPv6 addresses. No other overflow in `wf-panel` or `pairPanel` was found, so
no production overflow fix was needed there.

**Docs.** `docs/status-bar-and-costs.md` says the checklist is mounted as a
component and cut on every render at the width pi passes, and that calls without
a width keep the old output. `custom-footer/SOURCE.md` has a dated 2026-11-13
cycle 29 entry; `THIRD_PARTY_NOTICES.md` was regenerated. No `package.json`
script, `CHARTER.md`, or operator control path changed (`smoke:tui-layout` was
already wired in cycle 27).

## Process

The gated `workflow_run` implementer produced `eb739d5` but the workflow errored
afterwards ("declared output `implement.md` not written"), so the reviewer step
ran as separate `reviewer` subagents; the missing `implement.md` was written by
hand and records the failure. The first reviewer was interrupted before a
verdict; the second returned `VERDICT: FAIL` on the short cwd, fixed in
`d3ead52`; a minimal re-review returned `VERDICT: PASS`. Per-item checks plus the
negative run against base are the accepted proof, as noted in `verify.md`.

## Left for later

- No new proposal. The cycle closes the defect it found.
- Non-record diff is ~9.2 KB, below the 30,000 stop-new-work threshold.
- Open proposals unchanged: idle-cat frames (needs an intent decision), hub
  frame/mouse edges, inert Settings value rows, `TRUNK_CHANNEL` alias, inbox
  deadline edges, `workflow-hooks-smoke.ts` timer races.
