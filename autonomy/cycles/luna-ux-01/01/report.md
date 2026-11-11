# Cycle 01 — Report (run luna-ux-01, stream `ux`)

Outcome: successful
Mode: fix
Base: afecc1bbb33d  Head (last code commit): e7f29cc  Branch: pi/luna-ux-01 (pushed)

## What ran

First cycle of the run; no board items and no HANDOFF, so the review started from discovered
defects. Three parallel `scout` agents surveyed the stream surfaces (`/` menu, TUI overlays, cat
animation/status-bar polish), each told to treat the docs as hypotheses and cite `file:line` with a
reproduction. That produced two confirmed custom-footer defects (F-1, F-2), each fixed by a gated
implementer+reviewer plan and independently verified. A second session re-reviewed the `/` command
menu, found candidate C-1, and independent review **refuted** it before merge, so it was reverted.
Cycle 01 therefore ships F-1 and F-2; C-1 is a no-op.

## Items

Item: F-1 — narrow/default status bar printed the merged critical-warning summary twice - bec874847ccae92249dfdbbc01060cd1915e0ec1 - tests/status-bar-smoke.ts `criticalWarningSummaryAppearsOnceWhenNarrow` (fails at base with `2 !== 1`)
`fitLine`'s `replace` helper scoped `let placed = false` inside its own body, so `replace(l)` and
`replace(r)` each inserted the same `"<first> +N"` segment. Hoisted the flag so the summary is
placed once across both sides.
`packages/extensions/third_party/custom-footer/render.ts`, `tests/status-bar-smoke.ts`

Item: F-2 — `/footer ascii on` did not reach the todo checklist - d4f3ebd39cbf2f2cda0b1a21dfc76545abe0aa56 b33ed760b43dae6ba636ec5b6523351096dac79f - tests/status-bar-smoke.ts `todoWidget` (unit) and `asciiSettingReachesTodoWidget` (wiring through `/footer ascii on`)
`docs/status-bar-and-costs.md` says the todo widget uses plain characters. Added a trailing `ascii`
parameter to `renderTodoWidget`, passed `settings.ascii` from the call site, and asserted both the
parameter and the wiring (loads the extension, renders from a real todo file, runs the command and
checks the widget pi holds).
`packages/extensions/third_party/custom-footer/widgets.ts`, `.../index.ts`, `tests/status-bar-smoke.ts`

Record commits: `a732895` (first review + plan), `e4b3da5` (continuation review + plan).

## Continuation — second session, base `afecc1bbb33d`

Item: C-1 (refuted, reverted) — claimed curated `/` menu lost after `/new`, `/resume`, `/fork` - 0e77b67 (false fix) reverted by e7f29cc - no regression test (the change is a revert); refuted by host source and a live RPC run
The reconnaissance inferred that pi does not re-import the extension module on a session
replacement, so `registerCommandMenu`'s closure `curated` would stay `true`. Independent review
falsified this: `core/extensions/loader.js:513-517` calls `await factory(load.api)` on every
`loadExtension`, and `agent-session-runtime.js` rebuilds the runtime through `createRuntime` for
`/new`, `/resume` and `/fork`, so `curated` is fresh and the provider is re-registered by the new
invocation. The attempted fix `0e77b67` and its synthetic smoke case (fire `session_shutdown`,
clear providers, fire `session_start` without re-invoking the factory — a sequence the host never
produces) were reverted in `e7f29cc`. No functional change remains.

## Verification

`smoke:status-bar` 25/25, `smoke:cat-status` 11/11 at the first-batch head; `smoke:command-menu`
11/11, `test:typecheck`, `test:lint` at `e7f29cc`. Each F-1/F-2 assertion was shown to fail against
the base file and pass after. A read-only `reviewer` subagent reviewed the first batch and returned
**PASS**; its warning (F-2 test did not pin the call site) was fixed in `b33ed76`. The continuation
diff against `afecc1bb` is net zero for non-record files. Full gate (`/opt/autonomy/gate.sh`) left
to the supervisor.

## Recorded, not taken

- `autonomy/proposals/luna-ux-01-01-idle-cat-blink.md` — the `idle` blink frame is dead code
  (`cat.ts:36` vs `index.ts:387-391`) while the smoke asserts it and the docs say it does not
  happen. Intent is ambiguous (two commits disagree); needs an operator decision.
- `autonomy/proposals/luna-ux-01-01-human-console-multi-card-focus-theft.md` — a console card never
  takes an input hold, so `processPending` can open two cards at once. The older
  `human-console-input-hold-race` proposal is refuted (no `await` in the cited gap).
- Also checked and left: `frameAt` returning `""` for non-finite elapsed (unreachable); RPC value
  sub-dialog timeout returning `"back"` (latent); weakening-confirm with no dialog timeout.

## Notes for the next cycle

- The idle-blink intent decision is the strongest carry-over (see `autonomy/runs/luna-ux-01/HANDOFF.md`).
- The `/` command-menu surface is reviewed and is not defective; do not re-file C-1.
- Verify host-behaviour claims against the installed host before writing a fix.
