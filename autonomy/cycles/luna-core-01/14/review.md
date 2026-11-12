# Cycle 14 review — `luna-core-01`, stream `core`

Base `68d70c78940c` clean; charter read; no assigned board items; cycle 13 (fix) merged.

## Carry-overs checked
- #9 dead code: `effort/index.ts:838` is an always-empty ternary; `context-sieve/index.ts:67`
  `DYNAMIC_IDS` lists `memory-vault` and `skill-router`, but both inject via custom messages, never a
  ctx-contribution. Dead; deferred.
- #1 firewall timing noise (out of stream), #2 cycle-08 records (no action), V-07/V-08/V-10 (no
  in-tree finding list): none actionable here.

## New defects (scout + direct repro)
1. `compress/index.ts:301` — `for (const i of [0, turns.length - 1])` runs `i=0` when `groupTurns`
   yields no turns; `cost(0)`→`turnAt(0)` throws `turn 0 is out of range`, so `/compress` cancels
   with a misleading reason. Repro: `buildCompressedSummary` over one assistant string → THREW.
2. `core/eval/footprint.ts:469` — baseline read outside try/catch; a corrupt `--baseline` throws a
   Node stack trace. Repro: `node packages/core/eval/footprint.ts --profile lite --baseline=package.json`.
3. `memory-vault/index.ts:133` consumes `firstPrompt` on a promptless run, losing first-prompt history.
4. `tests/orchestrate-commands-smoke.ts` does not clear `PI_KIT_INTERNAL_CHILD`.

Decision: fix mode; take defects 1 and 2; defer 3, 4 and #9.
