# Decision — team journal for the autonomy run

Board: A-01

## Context

Cycle reports live only under `autonomy/cycles/**/report.md`, so finding every cycle that
touched a board item meant reading each report.

## Decision

Add `autonomy/JOURNAL.md`: one line per cycle report with the run/cycle key, board IDs (or
`none`), outcome, a one-clause summary and any linked `autonomy/decisions/` record.
`packages/core/lib/journal.ts` parses and checks it; `tests/docs-smoke.ts` fails on a missing,
duplicate or mismatched entry, an unknown cycle directory, a missing or unlinked decision file,
and a board set disagreeing with the report's `Board: <ID> done|progress|blocked -` lines. Host
close-out reports need no entry and surface through `journalWarnings`. `.gitattributes` marks the
journal `merge=union` so parallel cycles append without conflict.

## Consequences

Every cycle adds its journal line and decision record before the docs smoke can pass, and
`grep <ID> autonomy/JOURNAL.md` gives a board item's history. The journal is a derived summary:
the report and linked decision record stay authoritative.
