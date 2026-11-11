# Cycle 02 — Plan

Mode: **fix**. Base `dc71c739409e`.

## Item 1 — A-91 [P0] Fail the harness check closed, and stop requiring `/subagents`

**Justification (charter 1, 2, 3, 4).** Board priority 2. A fresh autonomous session currently
fails its own start-up check on every run (supervisor `HARNESS FAIL ... missing commands:
subagents` on all three 2026-11-11 runs), because `HARNESS_COMMANDS` names a command `a69f0ef`
removed and three tests pin as removed. A reply that never arrives is not detected, and one bad
session latches. This is the precondition for all three streams.

**Change.**

1. `packages/autonomy/lib/rpc.ts`
   - Drop `subagents` from `HARNESS_COMMANDS` (six names: `goal`, `handoff`, `verify`,
     `firewall:status`, `orchestrate`, `trace`).
   - Add `HARNESS_CHECK_TIMEOUT_MS = 30_000` and a `HarnessCheck` class that owns one session's
     verdict: `reset()` clears it (per worker session), `settle(response)` verifies or records
     the missing names, `expire()` fails closed when no reply arrived in time, `failure`/`verified`
     read it. Every failure message is explicit (timeout vs missing commands).
2. `packages/autonomy/lib/runtime.ts`
   - Replace `harnessFailure`/`harnessOk` fields with one `HarnessCheck`.
   - `startWorker` calls `reset()` per session, arms a `setTimeout(..., HARNESS_CHECK_TIMEOUT_MS)`
     that calls `expire()`, clears it on the reply and on child exit; a missing or malformed
     `harness-check` reply now sets the failure instead of lapsing.
3. `packages/core/eval/footprint.ts`
   - Export `registeredCommands(profile)`, loading a profile exactly as `measureFootprint` does
     (`resolveProfile` + `loadExtension` + `fakePi`, session_start fired, external skipped) and
     returning the registered command names. No behaviour change to measurement.
4. `tests/autonomy-smoke.ts`
   - Update the harness test to the six names and assert `subagents` is absent.
   - New test: load `long-horizon` via `registeredCommands` and assert every `HARNESS_COMMANDS`
     name is registered; a name the kit does not register fails.
   - New test: `HarnessCheck` verifies on a full reply, fails on a bare one and on `expire()`
     with a timeout reason, and `reset()` clears a prior failure so a later session verifies.

**Checks to prove it (targeted only; never `npm test`/`npm run check:all`).**

- `npm run smoke:autonomy` (rpc/runtime tests, harness and HarnessCheck cases).
- `npm run smoke:eval-footprint` (the new `registeredCommands` export).
- `npm run test:typecheck`, `npm run test:lint`.
- `node packages/core/check-all.ts --list` for the exact script of each changed file.

**Docs.** The harness contract is internal; no user-facing doc names the command list. The
existing rpc.ts comment is updated to state the fail-closed rule; no other doc changes.

**Out of scope.** No command is added to the kit. `autonomy/CHARTER.md`, `package.json` `scripts`,
control paths and release files are untouched.

## Item 2 — A-01 [P1] Team journal (A-91 committed first)

As specified by the board item: `packages/core/lib/journal.ts` (`parseJournal`, `cycleReports`,
`checkJournal`), `autonomy/JOURNAL.md`, `autonomy/decisions/`, one `.gitattributes` line, wired
into `tests/docs-smoke.ts`. Two clarifications for the implementer:

- Entries are required for every `autonomy/cycles/**/report.md` on the branch, which today is
  `luna-improve-01` 04–09 plus this cycle (`luna-ops-01/02`). The `luna-improve-01` reports carry
  no `Board:` lines, so their entries are `Board: none`. This cycle worked A-91 and A-01, so its
  entry is `Board: A-91, A-01` (the report will carry a `Board:` line for each), and the decision
  file is `Board: A-01` per the board item.
- `checkJournal(root): string[]` returns failures only: a host close-out report (its text contains
  `Host close-out: the worker exited before recording report.md`) never produces one. The warning
  is observable through a sibling export (e.g. `journalWarnings(root)`), and a fixture pins that
  the close-out tree has no failure but does have the warning. The real tree asserts
  `checkJournal(ROOT)` deep-equals `[]`.

Checks: `npm run smoke:docs`, `npm run test:typecheck`, `npm run test:lint`, and
`node packages/core/check-all.ts --check-wiring` (never the full `npm run check:all`).

## Set goal / task graph

Goal: A-91 fixed, tested and pushed, with autonomy, eval-footprint, typecheck and lint green;
A-01 started only if the A-91 budget leaves room.
