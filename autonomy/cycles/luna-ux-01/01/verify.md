# Cycle 01 — Verify (run luna-ux-01, stream `ux`)

- Base `6accaa653a47`, verified head `b33ed76`. Branch `pi/luna-ux-01`, pushed.
- Reviewed diff (excluding records and lockfile): 7,736 characters — well under the 30,000 limit.
- Changes: `custom-footer/render.ts` (F-1), `custom-footer/widgets.ts`, `custom-footer/index.ts`
  (F-2), `tests/status-bar-smoke.ts` (regression tests). No other file touched.

## Independent review

A read-only `reviewer` subagent (no writes) reviewed `git diff 6accaa653a47..HEAD`, reasoned from
the base sources, and ran both targeted smokes. Verdict: **PASS**, no must-fix items. It raised
one non-blocking warning — the F-2 test pinned the new parameter but not the call site — which
this cycle then fixed (commit `b33ed76`).

## Checks run at the verified head

| Check | Result |
|---|---|
| `npm run smoke:status-bar` | 25/25 passed |
| `npm run smoke:cat-status` | 11/11 passed |
| `npm run test:typecheck` | passed (all workspaces) |
| `npm run test:lint` | passed (`--max-warnings 0`) |

`npm test` and `npm run check:all` were deliberately not run (host gate runs the full suite).

## Proof each test fails without its change

Both failures were reproduced by checking the base file back in, running the smoke, then restoring
the head file; the working tree was confirmed clean afterwards.

- **F-1** — with `6accaa653a47:custom-footer/render.ts` and the new test,
  `criticalWarningSummaryAppearsOnceWhenNarrow` failed with `2 !== 1` and printed the duplicated
  `! UNATTENDED +3  ! UNATTENDED +3` line. With the fix it passes.
- **F-2 (unit)** — with `6accaa653a47:custom-footer/widgets.ts`, the `todoWidget` ascii assertion
  failed: the forced-ASCII line still contained `░`. With the fix it is ASCII-only.
- **F-2 (wiring)** — with the base `widgets.ts`, `asciiSettingReachesTodoWidget` failed after
  `/footer ascii on` with `Todos 0/2 ░░░░░░░░░░  …  ▸ #1 write the test`, proving the setting did
  not reach the widget. With the fix the widget is ASCII-only and the `▸` marker is gone.

## What is covered

- F-1: `fitLine` merges several priority-0 warnings once across both sides; the summary appears
  exactly once at a narrow width while a right-hand critical chip is present.
- F-2: `renderTodoWidget` honours an ascii flag; `/footer ascii on` re-renders the widget pi holds
  (integration path through `session_start` → `refresh` → `updateTodoWidget` → `setWidget`).
- No regression in the other 23 status-bar tests or the 11 cat tests.

## Residual risk / not verified here

- The idle-cat blink contradiction and the human-console one-shot hold check are recorded as
  proposals, not fixed; they are out of this cycle's scope.
- The host acceptance gate (`/opt/autonomy/gate.sh`) is run by the supervisor on the pushed head;
  it was not run here by policy.
