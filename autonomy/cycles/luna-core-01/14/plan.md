# Cycle 14 plan — `luna-core-01`, stream `core`

Mode: fix. Two evidenced defects.

## Item 1 — `/compress` must not crash on a history with no groupable turns
- Justification: real evidenced bug, user-visible (`/compress` cancels instead of summarising).
- Change: guard `buildCompressedSummary`'s first/newest loop with `turns.length > 0`; an empty
  `turns` returns the normal header/objective/files summary with `details.turns` 0.
- Checks: new empty-turn case in `tests/compress-smoke.ts`; `npm run smoke:compress`.

## Item 2 — footprint CLI must report a malformed baseline cleanly
- Justification: cycle-12 consolidation; a corrupt `--baseline` crashes with a stack trace.
- Change: wrap the baseline read; clean `footprint: cannot read baseline ...` line, exit 2, file
  untouched in both report and `--write-baseline` modes; a missing file is still created.
- Checks: malformed-file case in `tests/eval-footprint-smoke.ts`; `npm run smoke:eval-footprint`;
  one sentence in `docs/efficiency-and-loops.md`.
- Deferred: dead code (#9), memory-vault `firstPrompt` (#3), orchestrate-smoke env (#4).

Board: none.
