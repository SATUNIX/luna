# Cycle 27 review — luna-core-01 (stream `core`)

Base `6642ee5ceeba` (head of `stream/core`, cycle 26 merged). Mode: **fix**.
Read: `autonomy/CHARTER.md`, `autonomy/runs/luna-core-01/HANDOFF.md`, cycle 26
`report.md`/`verify.md`, `autonomy/proposals/luna-core-01-26-pg66-pre-report-refusal.md`,
`git log --oneline 6642ee5ceeba..HEAD` (empty: clean base). `autonomy/BACKLOG.md` not touched.

## Assigned board item

**PG-66 [P0]** — a run whose cycles are rejected accumulates diff until no cycle can pass the
review budget. Cycle 26 landed the in-cycle probe (`12957da`). The board acceptance still has an
uncovered clause: *"a cycle that would exceed the budget is refused by its own pre-report check
with the measured number."* The current check (`packages/autonomy/lib/cycle.ts:202-216`,
`budgetStale`) only steers; the refusal is `mergeDecision`'s (`self-improve.ts:694-695`), after the
cycle already closed `"completed"`.

## Scouts (one parallel plan, run `2026-11-12T02-16-53-853Z-plan-c481`)

### PG-66 gap (scout 1-1)
- Covered today: reset to the last merged head (`gitmirror.ts` `startCycleBranch` via
  `self-improve.ts:514`; fixture `tests/autonomy-selfimprove-smoke.ts:1314-1316`); attempts tag and
  remote branch preservation (`:1330-1334`); measured count (from `c1.mergeReason`).
- Not covered: the cycle's own refusal. `budgetStale` returns `boolean` and only `say`s a steer
  (`cycle.ts:213`), then the loop closes `"completed"` (`:261`).
- Smallest sound change: measure first, key the warned set on the measured head, and on a head
  that is *still* over budget after the steer return a refusal; the loop closes `"partial"` with
  `refused_budget: the diff this cycle would submit is ...`. `"partial"` is deliberate: 
  `mergeDecision:666` accepts it and still hits the over-budget branch (`:694`), so the existing
  `mergeReason` shape assertions keep passing.

### Probe correctness (scout 1-3)
- **Real bug.** `budgetStale` reads `rt.headSha()` (`cycle.ts:204`) and keys
  `budgetWarnedHeads` on it (`:205`,`:208`), but `diffBudget` independently re-reads `repo.head()`
  (`self-improve.ts:434`) and measures *that* head. A commit landing between the two reads records
  the wrong sha, so the measured head is never in the set, and the next settled tick re-measures
  and re-steers forever — defeating the once-per-head dedup the probe advertises (`cycle.ts:200`).
- Spurious-steer (not safety) cases: the probe ignores a red gate, an unresolved upstream conflict
  and a dropped upstream scope, all of which `mergeDecision:667-682` refuses before the review read.
  Low impact because the probe only advises.

### Stream area (scout 1-2)
- **Candidate A (medium), taken:** `packages/extensions/src/memory-vault/vault.ts:743-760` —
  `migrateMemoryLocal` writes the `migrated-memory-local` marker even when `readJson` returned
  `null` (invalid JSON / unreadable source), permanently recording "migrated 0". A repaired store
  is then never imported; docs (`docs/memory.md:98`) only promise "imported automatically once".
- **Candidate B (low, not taken):** `search.ts:24-25` `t.length <= 4` bypasses the `-s` rule, so
  `stem("logs") != stem("log")`. Real but the stemmer is the known cycle-24/25 trade-off needing a
  lexicon or an operator decision; not worth reopening inside this budget.
- Candidate C (session_start reload duplicates recap) recorded as a proposal note for a later cycle.

## Chosen this cycle
1. PG-66 clause 3 + the measured-head bug: `cycle.ts`, the `diffBudget` contract in
   `self-improve.ts`, and the fixture in `tests/autonomy-selfimprove-smoke.ts`.
2. Defect A: `migrateMemoryLocal` must not tombstone an unreadable store, plus a smoke assertion
   and a docs sentence.
