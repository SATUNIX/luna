# Cycle 02 verification — `luna-ops-01`

Branch `pi/luna-ops-01`, base `dc71c739409e`. Targeted checks only; the host gate runs the full
suite on a clean checkout. Each line is one run, command then result and the line that proves it.

## A-91 — harness check contract, timeout, per-session reset

- `npm run smoke:autonomy` — PASS, exit 0: `[autonomy-smoke] all 32 checks passed`. The check
  `harness check: every required command is registered by the long-horizon worker profile` loads
  the profile through `registeredCommands` (same path as `eval/footprint.ts`), asserts every
  `HARNESS_COMMANDS` name is registered and that `subagents` is not; `harness check: HarnessCheck
  is per-session, fails closed on missing commands and times out` pins reset, missing-command
  failure, expiry, and that a late reply cannot overwrite the timeout.
- `npm run smoke:eval-footprint` — PASS, exit 0: `[eval-footprint-smoke] all 10 checks passed`
  (the profile-measuring path still works after exporting `registeredCommands`).
- `npm run test:typecheck` — PASS, exit 0.
- `npm run test:lint` — PASS, exit 0 (`--max-warnings 0`).
- Independent reviewer (whole diff) — PASS; it re-ran `smoke:autonomy`, `smoke:eval-footprint`,
  `smoke:docs`, `test:typecheck`, `test:lint`, `--check-wiring` all green, and confirmed the three
  `subagents` absence guards (`tests/docs-smoke.ts`, `tests/run-query-smoke.ts`,
  `tests/subagent-observability-smoke.ts`) are untouched.

## A-01 — team journal

- `npm run smoke:docs` — PASS, exit 0: `[docs-smoke] OK: 14 documented commands validated, ...`.
  The block asserts `checkJournal(ROOT)` is `[]` and exercises five fixtures: missing entry (it
  prints the exact `- <key> | Board: ...` line to add), dangling linked decision, board mismatch,
  legacy `cycles/<NN>/report.md`, and a host close-out report that yields no failure but is named
  by `journalWarnings`.
- Negative test (A-01 reviewer, in place) — FAIL as intended: deleting the
  `luna-improve-01/08` entry makes `npm run smoke:docs` exit 1 with
  `report with no journal entry: luna-improve-01/08; add: - luna-improve-01/08 | Board: none | ...`;
  file restored, tree clean.
- `node packages/core/check-all.ts --check-wiring` — PASS, exit 0:
  `check-all: every test file is wired into a script and asserts something`.
- `npm run test:typecheck` / `npm run test:lint` — PASS, exit 0 (after the journal and comment
  trims).

## Review-budget measurement

`git diff --no-renames dc71c739409e..HEAD -- . ":(exclude)package-lock.json"
":(exclude)autonomy/cycles/luna-ops-01/" ":(exclude)autonomy/runs/luna-ops-01/" | wc -c`
— 32,392 chars, inside the 60,000-char review cap.

## Not run (by rule)

`npm test` and `npm run check:all` are deliberately not run by a worker; the host gate runs them
on a clean checkout.
