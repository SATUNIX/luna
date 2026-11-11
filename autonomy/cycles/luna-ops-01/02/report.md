Outcome: successful
Mode: fix

# Cycle 02 — `luna-ops-01` (stream ops)

Run `luna-ops-01`, cycle 02. Branch `pi/luna-ops-01`, base `dc71c739409e` (head of `stream/ops`).
Documents: `autonomy/cycles/luna-ops-01/02/review.md`, `plan.md`, `verify.md`, this file.

Board: A-91 done - the worker harness contract now names only commands the long-horizon profile registers, and the check fails closed within 30s per session.
Board: A-01 done - `autonomy/JOURNAL.md` plus `autonomy/decisions/` are now self-checked by `smoke:docs`; one entry per cycle report, searchable by board ID.

Item: A-91 harness check contract, timeout and per-session reset - `bd90afe`, `13e608f` - `npm run smoke:autonomy` (32 checks, profile subset plus HarnessCheck timeout) and `npm run smoke:eval-footprint` (10 checks).
Item: A-01 team journal - `ff5d8ed`, `d1d0292` - `npm run smoke:docs` (real tree plus five fixtures) and `node packages/core/check-all.ts --check-wiring`.

## Changed tests, and why

- `tests/autonomy-smoke.ts`: the harness test now asserts the six-name list and that `subagents`
  is absent, loads `long-horizon` through `registeredCommands` (the same resolve/load path
  `packages/core/eval/footprint.ts` uses) and asserts every required name is registered, so an
  unregistered name fails the test. The `HarnessCheck` case pins reset, missing-command failure,
  expiry, no-op repeat expiry, and that a late reply cannot overwrite the timeout. Three other
  tests (`docs-smoke.ts`, `run-query-smoke.ts`, `subagent-observability-smoke.ts`) pin `/subagents`
  as removed and were left untouched.
- `tests/docs-smoke.ts`: added `checkJournal(ROOT)` deep-equal `[]` and five fixtures — missing
  entry (printing the exact line to add), dangling linked decision, entry/report board mismatch,
  legacy `cycles/<NN>/report.md`, and a host close-out report (no failure, named by
  `journalWarnings`). `package.json` scripts are unchanged; the check rides the existing
  `smoke:docs` script.

## What was done

- **A-91.** `packages/autonomy/lib/rpc.ts` dropped `subagents` from `HARNESS_COMMANDS` (never
  re-register it — `a69f0ef` removed it and the panel is `/workflows`) and added
  `HARNESS_CHECK_TIMEOUT_MS = 30_000` plus the exported `HarnessCheck` (`reset`/`settle`/`expire`).
  `packages/autonomy/lib/runtime.ts` replaced the two latch fields with one `HarnessCheck`, resets
  it per worker session, arms an unref'd timer, clears it on reply/exit, and fails the worker with
  a clear reason when the reply is missing or malformed. The independent review then found a late
  reply could overwrite the timeout, fixed in `13e608f` and pinned by the smoke.
- **A-01.** New `packages/core/lib/journal.ts` (`parseJournal`, `cycleReports`, `checkJournal`,
  `journalWarnings`), `autonomy/JOURNAL.md` with one line per report on the branch,
  `autonomy/decisions/luna-ops-01-02-team-journal.md`, `.gitattributes` last line
  `autonomy/JOURNAL.md merge=union`, and the `tests/docs-smoke.ts` wiring above.

## Left for next cycle / notes

- A-01's check enforces report→entry and entry→existing cycle directory, but an entry for a
  directory with no `report.md` is not flagged yet (today's `luna-ops-01/02` line is such an entry
  until this report lands). Hardening proposal:
  `autonomy/proposals/luna-ops-01-02-journal-orphan-entry.md`.
- Not taken from HANDOFF: B-011 (`eval/run.ts:21` ignores `--category` with no value); installer
  doc drift (lite skill count, `--scope project` `.env` claim, unknown `--profile` stack trace);
  `npmDeliveryEnabled()` vs `docs/releasing.md`. Next cycle should take the top ready board item.
- Diff under the review cap: 32,392 chars. Target checks and the independent whole-diff review all
  pass; the host gate owns `npm test` and `npm run check:all`.
