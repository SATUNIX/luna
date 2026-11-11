# Decision — team journal for the autonomy run

Board: A-01

## Context

Cycle reports lived only under `autonomy/cycles/**/report.md`, so finding every cycle that
touched a board item meant reading each report. A cycle could also close with no visible
record of what it decided or which board item it worked.

## Decision

Add `autonomy/JOURNAL.md`: one line per cycle report, naming the run/cycle key, the board IDs
(or `none`), the outcome, a one-clause summary and any decision record under
`autonomy/decisions/`. `packages/core/lib/journal.ts` parses and checks it, and
`tests/docs-smoke.ts` fails on a missing, duplicate or mismatched entry, an unknown cycle
directory, a missing or unlinked decision file, and a board set that disagrees with the
report's `Board: <ID> done|progress|blocked -` lines. Host close-out reports need no entry;
they surface through `journalWarnings` instead. `.gitattributes` marks the journal
`merge=union` so concurrent cycles append rather than conflict.

## Consequences

Every cycle must now add its journal line and decision record before the docs smoke can pass,
and `grep <ID> autonomy/JOURNAL.md` gives the full history for a board item. The journal is a
derived summary, not a second source of truth: the report and the linked decision record stay
authoritative.
