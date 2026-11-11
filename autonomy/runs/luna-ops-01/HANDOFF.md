# Run `luna-ops-01` — handoff

State after cycle 03 (branch `pi/luna-ops-01`, base `a5d1811ab5da`):

- Cycle 03: **successful**, mode fix. The base was red before any work: `smoke:docs` failed with
  `report with no journal entry: luna-core-01/01` because `integration/luna` had been merged in
  carrying the core stream's report with no ops journal line. Fixed by adding that line
  (`e7a91c8`) and by hardening `checkJournal` so an entry whose cycle directory has no `report.md`
  is also a failure (`378744c`, with a `tests/docs-smoke.ts` fixture). A-91 needed no change: the
  cycle-02 harness fix (`bd90afe`, `13e608f`) is present and `smoke:autonomy` (32) and
  `smoke:eval-footprint` (11) pass.
- Operator note carried from the board: after the harness fix merges, the running supervisor and
  worker image still carry the old `HARNESS_COMMANDS` list, so run `upgrade-harness.sh`; streams
  keep working meanwhile because the check fails open after resume.
- Never re-register `/subagents`: three tests pin it as removed (`tests/docs-smoke.ts`,
  `tests/run-query-smoke.ts`, `tests/subagent-observability-smoke.ts`).
- A-01 is complete: the journal now detects drift both ways. The cycle-02 proposal
  `autonomy/proposals/luna-ops-01-02-journal-orphan-entry.md` is closed by
  `autonomy/decisions/luna-ops-01-03-team-journal.md`.
- Process gap noted but not filed: a report merged from another stream must add its journal line
  or the branch goes red; see `autonomy/cycles/luna-ops-01/03/review.md`. A future proposal could
  make the merge step append the line.
- Open but not taken: installer doc drift (lite skill count, `--scope project` `.env` claim,
  unknown `--profile` stack trace); `npmDeliveryEnabled()` vs `docs/releasing.md`.
- Next cycle: take the top ready board item verbatim. Working tree clean and pushed; targeted
  checks and the independent whole-diff review pass.
