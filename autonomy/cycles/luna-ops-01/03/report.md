Outcome: successful
Mode: fix

# Cycle 03 — `luna-ops-01` (stream ops)

Run `luna-ops-01`, cycle 03. Branch `pi/luna-ops-01`, base `a5d1811ab5da` (head of `stream/ops`,
which is `integration/luna` merged into `stream/ops`). Documents:
`autonomy/cycles/luna-ops-01/03/review.md`, `plan.md`, `verify.md`, this file.

Board: A-01 done - the team journal check now covers every stream's merged cycle and fails in both directions (report without entry, entry without report).
Board: A-91 done - verified only; the harness contract fix from cycle 02 is present on the base and its smokes pass.

Item: A-01 fix the red `smoke:docs` gate and complete `checkJournal` - `e7a91c8`, `378744c` - `npm run smoke:docs` (real tree plus six fixtures) and `node packages/core/check-all.ts --check-wiring`.
Item: A-91 verify the harness contract - no code change (`bd90afe`, `13e608f` on the base) - `npm run smoke:autonomy` (32 checks) and `npm run smoke:eval-footprint` (11 checks).

## What was found and fixed

The base was **red before any cycle-03 work**: `npm run smoke:docs` exited 1 with
`AssertionError: autonomy/JOURNAL.md disagrees with the cycle reports` →
`report with no journal entry: luna-core-01/01` (`tests/docs-smoke.ts:491`). The merge
`750fe48` brought `autonomy/cycles/luna-core-01/01/report.md` from the core stream into this
branch, and the journal is run-agnostic, so the report→entry check correctly flagged it.

1. `autonomy/JOURNAL.md` — added
   `- luna-core-01/01 | Board: none | successful | Refused a value-less or unknown --category in
   the eval harness and declared the context-sieve message-budget env var`. The report has no
   `Board:` lines, so the checker-derived value is `none`. Commit `e7a91c8`.
2. `packages/core/lib/journal.ts` — an entry whose cycle directory exists but has no
   `report.md` now fails with `journal entry has no report: <key>`, closing the reverse drift
   recorded in `autonomy/proposals/luna-ops-01-02-journal-orphan-entry.md`. The host close-out
   path is untouched (a close-out report is still a report file). `tests/docs-smoke.ts` gained a
   fixture for it. Commit `378744c`.

## Changed tests, and why

- `tests/docs-smoke.ts`: one new fixture — an entry next to a directory with no `report.md` must
  be reported. The existing fixtures (missing entry, dangling decision, board mismatch, legacy
  layout, host close-out warning) are unchanged, and `checkJournal(ROOT)` still deep-equals `[]`
  on the real tree. `package.json` scripts are unchanged.

## Not in this cycle

- A proposal for the cross-stream merge/journal process gap is recorded in `review.md` but not
  filed, to stay inside scope.
- B-011 (`eval --category` with no value) is already fixed by the merged core cycle 01.
- Installer doc drift and `npmDeliveryEnabled()` vs `docs/releasing.md` remain unevidenced
  carry-overs from the HANDOFF.
- `npm test` and `npm run check:all` are left to the host gate.

## Left for next cycle / notes

- A-01's check now enforces both directions. No further journal hardening is known.
- Scoped diff (excluding lockfile and this cycle's dirs): 2,750 chars, well inside the
  60,000-char review cap.
- Working tree clean and pushed; targeted checks and the independent whole-diff review pass.
