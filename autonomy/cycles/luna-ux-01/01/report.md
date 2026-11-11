# Cycle 01 — Report (run luna-ux-01, stream `ux`)

Outcome: successful
Mode: fix
Base: afecc1bbb33d  Head: e7f29cc  Branch: pi/luna-ux-01 (pushed)

## What ran

First cycle of the run; no board items and no HANDOFF, so the review started from discovered
defects. Three parallel `scout` agents surveyed the three stream surfaces (`/` menu, TUI overlays,
cat animation/status-bar polish); each was told to treat the docs as hypotheses and cite
`file:line` with a reproduction. That produced two confirmed defects in the custom-footer and three
lower-confidence candidates that were recorded and deliberately left alone. Both confirmed defects
were fixed, each by a gated implementer+reviewer plan, then independently verified and pushed.

## Items

Item: F-1 — narrow/default status bar printed the merged critical-warning summary twice - bec874847ccae92249dfdbbc01060cd1915e0ec1 - tests/status-bar-smoke.ts `criticalWarningSummaryAppearsOnceWhenNarrow` (fails at base with `2 !== 1`)
`fitLine`'s `replace` helper scoped `let placed = false` inside its own body, so `replace(l)` and
`replace(r)` each inserted the same `"<first> +N"` segment. Hoisted the flag so the summary is
placed once across both sides.
`packages/extensions/third_party/custom-footer/render.ts`, `tests/status-bar-smoke.ts`

Item: F-2 — `/footer ascii on` did not reach the todo checklist - d4f3ebd39cbf2f2cda0b1a21dfc76545abe0aa56 b33ed760b43dae6ba636ec5b6523351096dac79f - tests/status-bar-smoke.ts `todoWidget` (unit) and `asciiSettingReachesTodoWidget` (wiring through `/footer ascii on`)
`docs/status-bar-and-costs.md` already says the todo widget uses plain characters. Added a trailing
`ascii` parameter to `renderTodoWidget`, passed `settings.ascii` from the call site, and asserted
both the parameter and the wiring (loads the extension, renders from a real todo file, runs the
command and checks the widget pi holds).
`packages/extensions/third_party/custom-footer/widgets.ts`, `.../index.ts`,
`tests/status-bar-smoke.ts`

Record: `a732895` (review + plan). Cycle artefacts: this directory.

## Verification

`smoke:status-bar` 25/25, `smoke:cat-status` 11/11, `test:typecheck`, `test:lint` all pass at the
head. Each new assertion was shown to fail against the base file and pass after. A read-only
`reviewer` subagent reviewed the full diff and returned **PASS** with no must-fix items; its one
warning (the F-2 test did not pin the call site) was fixed in `b33ed76`. Reviewed diff is 7,736
characters. Full gate (`/opt/autonomy/gate.sh`) left to the supervisor.

## Recorded, not taken

- `autonomy/proposals/luna-ux-01-01-idle-cat-blink.md` — the `idle` blink frame is dead code
  (`cat.ts:36` vs `index.ts:387-391`) while the smoke asserts it and the docs say it does not
  happen. Intent is ambiguous (two commits disagree); deferred.
- `autonomy/proposals/luna-ux-01-01-human-console-input-hold-race.md` — `human-console` defers on
  a one-shot `inputHeld()` check instead of `showWhenFree`, leaving a narrow focus-theft window.
- Also checked and left: `frameAt` returning `""` for non-finite elapsed (unreachable from
  callers); RPC value sub-dialog timeout returning `"back"` (latent, no shipped subpage value row);
  weakening-confirm with no dialog timeout (lower confidence pi's select hangs).

## Notes for the next cycle

- The two proposals are the strongest carry-overs; the idle-blink one needs an intent decision.
- The `/` command-menu scout returned an empty report; that surface has not been reviewed yet and
  is the obvious next target.
- Budget used this cycle is well inside the plan; no blockers.

---

## Continuation — second session, cycle base `afecc1bbb33d`

The prior batch (`6accaa653a47..b33ed76`) is already merged into the new cycle base
`afecc1bbb33d`. This session investigated the `/` command menu against that base. Its single
candidate finding, C-1, was **refuted by independent review before it could merge**, so the
attempted fix and its synthetic regression case were reverted and this session ships no
behavioural change of its own. The cycle's shipped items remain F-1 and F-2 above.

## Items

Item: C-1 (refuted, reverted) — claimed curated `/` menu lost after `/new`, `/resume`, `/fork` -
e7f29cc — no regression test (the change is a revert); refuted by host source
(`core/extensions/loader.js:513-517` re-invokes the extension factory per session) and a live RPC
run that logged the factory once per session
The initial reconnaissance concluded the extension module was not re-imported on a session
replacement, so `registerCommandMenu`'s closure `curated` flag would stay `true`. An independent
`reviewer` subagent falsified this: pi calls `await factory(load.api)` on every `loadExtension`, and
`agent-session-runtime.js` rebuilds the runtime through `createRuntime` for `/new`, `/resume` and
`/fork`, so `curated` is fresh and the provider is re-registered by the new invocation. The
attempted fix `0e77b67` and its synthetic smoke case (fire `session_shutdown`, clear providers, fire
`session_start` without re-invoking the factory) were reverted in `e7f29cc`. No functional change
remains; the base behaviour is correct.

Record-only commits this session: `e4b3da5` (continuation review and plan), plus the corrected
cycle records. `e4b3da5` is superseded by the refutation.

## Verification (continuation)

After the revert: `npm run smoke:command-menu` 11/11, `npm run test:typecheck`, `npm run test:lint`
all pass at `e7f29cc`. The refutation rests on the installed host source and a live RPC run, not on
a test. Full gate left to the supervisor.

## Recorded, not taken (continuation)

- `autonomy/proposals/luna-ux-01-01-human-console-input-hold-race.md` — **refuted**; the cited path
  has no `await` and runs in one synchronous turn. A separate, real `processPending` multi-card
  focus-theft needs its own proposal.
- `autonomy/proposals/luna-ux-01-01-idle-cat-blink.md` — **confirmed dead at runtime**; still needs
  an intent decision (drive a timer vs delete the frame), so deferred again.

## Notes for the next cycle

- The `/` command-menu surface is not defective; do not re-file C-1.
- The idle-blink intent decision is the strongest carry-over.
- Verify host-behaviour claims against the installed host before writing a fix; the C-1 miss came
  from inferring host behaviour instead of running it.
