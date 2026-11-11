# Decision — complete the team journal check across streams

Board: A-01

## Context

`integration/luna` was merged into `stream/ops` (commit `a5d1811`), carrying the core stream's
cycle report `autonomy/cycles/luna-core-01/01/report.md`. The journal check `checkJournal` is
run-agnostic: it compares every `autonomy/cycles/**/report.md` on the branch against
`autonomy/JOURNAL.md`. The ops journal had no `luna-core-01/01` line, so `npm run smoke:docs`
failed on the base with `report with no journal entry: luna-core-01/01` — the branch was red
before this cycle did any work.

Separately, cycle 02's hardening proposal
(`autonomy/proposals/luna-ops-01-02-journal-orphan-entry.md`) recorded the reverse drift: an entry
whose cycle directory exists but has no `report.md` was not flagged.

## Decision

1. Add the missing line to `autonomy/JOURNAL.md`:
   `- luna-core-01/01 | Board: none | successful | ...`. Its report has no `Board:` lines, so the
   checker-derived value is `none`.
2. Harden `checkJournal` in `packages/core/lib/journal.ts`: when an entry's cycle directory exists
   but `<dir>/report.md` does not, fail with `journal entry has no report: <key>`. The existing
   "no cycle directory" branch is unchanged, and the host close-out path is untouched because a
   close-out report is still a report file.
3. Pin the new behaviour with a `tests/docs-smoke.ts` fixture (entry next to a reportless
   directory), alongside the existing fixtures.
4. Land this cycle's own `luna-ops-01/03` journal line and its `report.md` in the same commit, so
   the hardened orphan check never sees a reportless entry on the branch.

## Consequences

The journal now detects drift in both directions: a report without an entry, and an entry without
a report. A cycle whose report is merged from another stream must add its journal line before
`smoke:docs` passes, which is what the base failure exposed. The proposal
`luna-ops-01-02-journal-orphan-entry.md` is closed by this decision.
