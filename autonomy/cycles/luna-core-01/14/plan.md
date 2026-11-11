# Cycle 14 plan — `luna-core-01`, stream `core`

Mode: fix. Goal: repair two evidenced defects without widening scope.

## Item 1 — `/compress` must not crash on a history with no groupable turns
- Justification: charter "fixes a real, evidenced problem"; user-visible (`/compress` cancels).
- Change: guard the first/last-turn loop in `buildCompressedSummary` so an empty `turns` array
  yields the header/objective/files summary with `turns: 0` instead of throwing.
- Checks: add an empty-turn case to `tests/compress-smoke.ts`; run `npm run smoke:compress`.
- Docs: none (no user-visible command change; the bug is that it failed to behave as documented).

## Item 2 — footprint CLI must report a malformed baseline cleanly
- Justification: cycle-12 consolidation; today a corrupt `--baseline` crashes with a stack trace.
- Change: wrap the baseline read; on parse failure print one `footprint: cannot read baseline ...`
  line and return 2, leaving the file untouched (operator removes it to regenerate).
- Checks: add a malformed-file case to `tests/eval-footprint-smoke.ts`; run
  `npm run smoke:eval-footprint`.
- Docs: `docs/efficiency-and-loops.md` if it documents CLI exit codes; otherwise none.

## Deferred (HANDOFF/proposals)
Dead code (`effort:838`, `context-sieve:67`), memory-vault `firstPrompt` (#3), orchestrate-smoke
env (#4) — out of this cycle's budget; next cycle.

## Board
No assigned items.
