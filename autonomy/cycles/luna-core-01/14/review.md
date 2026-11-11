# Cycle 14 review — `luna-core-01`, stream `core`

Charter read. Base `68d70c78940c` clean. No assigned board items. Cycle 13 (fix) merged; the
review treats audit/roadmap prose as hypotheses and checked each carry-over against code.

## Carry-overs checked
- HANDOFF #1 firewall timing noise: outside this stream (tests/timing), left.
- HANDOFF #2 cycle-08 records: not brought over; no action needed until a report is copied.
- HANDOFF #9 dead code: confirmed `effort/index.ts:838` is an always-empty ternary; confirmed
  `context-sieve/index.ts:67` `DYNAMIC_IDS` lists `memory-vault` and `skill-router`, but
  memory-vault injects via a `memory-recall` custom message and skill-router via a `skill-router`
  custom message, never a ctx-contribution file. Both entries are dead.
- V-07/V-08/V-10 still have no in-tree finding list (checked repo-wide); not actionable.

## New defects found (scout + direct repro)
1. `extensions/compress/index.ts:301` — `for (const i of [0, turns.length - 1])` runs `i=0`
   when `groupTurns` yields no turns; `cost(0)` → `turnAt(0)` throws `turn 0 is out of range`.
   Repro: `buildCompressedSummary({preparation:{messagesToSummarize:[{role:"assistant",
   content:"plain string"}],firstKeptEntryId:"e1",tokensBefore:1}})` → THREW. `/compress` then
   cancels with a misleading reason instead of summarising. User-visible, token-efficiency path.
2. `core/eval/footprint.ts:469` — the baseline read is outside any try/catch, so a corrupt
   baseline throws a Node stack trace (not the CLI's clean exit 2). Repro:
   `node packages/core/eval/footprint.ts --profile lite --baseline=package.json` → uncaught
   `parseJsonAs` error. Cycle-12 artefact; consolidation target.
3. `memory-vault/index.ts:133` — `firstPrompt = false` runs even when the event has no prompt
   (an extension-triggered run), so the operator's first real prompt silently loses the
   "Earlier sessions" history (contradicts the comment at :134). Lower value; not taken.
4. `tests/orchestrate-commands-smoke.ts` does not clear `PI_KIT_INTERNAL_CHILD`, so it fails
   inside any Luna child; test hygiene, not taken.

## Decision
Fix mode. Take defects 1 and 2 (user-visible bug + cycle-12 consolidation). Log 3–4 as
proposals/HANDOFF. Dead-code cleanup (#9) recorded but deferred to keep the diff reviewable.
