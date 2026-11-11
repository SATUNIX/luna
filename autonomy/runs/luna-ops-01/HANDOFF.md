# Run `luna-ops-01` — handoff

State after cycle 02 (branch `pi/luna-ops-01`, base `dc71c739409e`):

- Cycle 02: **successful**, mode fix. Both assigned items are done and pushed. A-91: the worker
  harness contract now lists only commands the long-horizon profile registers (no `subagents`) and
  a per-session `HarnessCheck` fails closed within 30s. A-01: `autonomy/JOURNAL.md`,
  `autonomy/decisions/` and `packages/core/lib/journal.ts`, wired into `smoke:docs`.
- Operator note carried from the board: after this merges, the running supervisor and worker image
  still carry the old `HARNESS_COMMANDS` list, so run `upgrade-harness.sh`; streams keep working
  meanwhile because the check fails open after resume.
- Never re-register `/subagents`: three tests pin it as removed (`tests/docs-smoke.ts`,
  `tests/run-query-smoke.ts`, `tests/subagent-observability-smoke.ts`).
- A-01 hardening not taken: `checkJournal` does not flag a journal entry whose cycle directory has
  no `report.md`. Proposal `autonomy/proposals/luna-ops-01-02-journal-orphan-entry.md`.
- Open but not taken: B-011 (`packages/autonomy/eval/run.ts:21` ignores `--category` with no
  value); installer doc drift (lite skill count, `--scope project` `.env` claim, unknown `--profile`
  stack trace); `npmDeliveryEnabled()` vs `docs/releasing.md`.
- Next cycle: take the top ready board item verbatim. Working tree clean and pushed; targeted
  checks and the independent whole-diff review pass.
