# Cycle 28 review — luna-core-01

Base `ee45b3cc3636` (head of `stream/core`). Mode: **fix**. One scout checked the candidate items
against the code; the rest is file:line evidence.

## Assigned work: PG-66 [P0]

The board item's three acceptance clauses are already met on the base by
`tests/autonomy-selfimprove-smoke.ts`:

- the fixture at line 1288 ("an over-budget cycle is caught pre-report ...") runs two rejected
  cycles, asserts both start from the seed (`c1.start === c2.start === c3.start === seedSha`,
  lines 1313-1316), that the rejected work is preserved as tags and `attempts/<run>/cycle-NN`
  branches (lines 1333-1339), that only the under-budget cycle reaches the model review
  (`calls.filter(/You review one cycle/).length === 1`, line 1342), and that each over-budget
  cycle closes `partial` with `^refused_budget: ... <n> characters ...` (lines 1329-1332);
- `startCycleBranch` (`templates/self-improve.ts:541`) resets the worker branch to the integration
  head every non-resumed cycle, so host-side accumulation is already removed.

**But one path is not covered, and it breaks the third clause.** The cycle's own pre-report check
(`budgetStale`, `cycle.ts:205-218`) is invoked only in the live branch
(`if (settled && !dead && !pendingTrigger)`, `cycle.ts:259-266`). The dead-session branch returns
`close("completed", "report recorded")` at `cycle.ts:244` (or `"host close-out after session
exit"` at `cycle.ts:249`) without ever measuring the diff. A worker that commits `report.md` and a
>60000-character diff and then exits therefore closes the cycle `completed`; the only refusal is
the later `mergeDecision` (`templates/self-improve.ts:695`). This is exactly the asymmetry between
the live fixture (line 1288) and the dead-session fixture (line 468): the same over-budget diff is
refused by the cycle itself when the session lives, and not when it dies. Scout confirmed the gap
and that it is reachable with `t.write(...); report(t,...); t.commit(...); t.crash()`.

## Candidate: cycle-27 memory-vault reload proposal — **refuted**

`autonomy/proposals/luna-core-01-27-memory-vault-reload-recap.md` claims the same extension
instance gets `firstPrompt = true` and `injected.clear()` re-applied on a `reload`/`resume`, and
proposes to fix it by *skipping* that reset.

The premise is wrong. pi replaces the extension runtime on `/reload` and on session replacement;
this is pi's bundled extension documentation (`@earendil-works/pi-coding-agent`,
`docs/extensions.md`): line 50 ("Reload replaces the extension runtime"), line 145 ("Reload and
session replacement invalidate the old runtime"), and the lifecycle diagram at lines 127-143
(`Reload --> Shutdown --> load replacement extension runtime --> SessionStart`). `firstPrompt`
(`memory-vault/index.ts:91`) and `injected` (`:92`) are per-factory-invocation closures, so a
replacement runtime re-runs `createMemoryVault` and they start at `true`/empty before any handler
runs. The handler reset at `:105-106` is therefore redundant, and the proposed fix (skip the
reset) is a **no-op**: the fresh closure is already `true`. The observed re-injection is real, but
its cause is the new instance's initializer, not carried-over state. **Do not implement the
proposal as written.**

## Two real defects found instead (both in the stream area)

1. **A failed first recall permanently disables the recap for the session.**
   `memory-vault/index.ts:140` sets `if (isUserPrompt) firstPrompt = false;` *inside* the `try`
   opened at `:131`, before the search and `assemble` work. If anything in that block throws, the
   `catch` at `:186-188` logs and returns `undefined`, but `firstPrompt` is already `false`, so
   the first-turn recap and pinned block are never offered again. The comment at `:122-124`
   ("isFirstTurn") intends the flag to be consumed by a real first-prompt recall. Evidence: the
   assignment precedes any call that can throw (`searchMemories` at `:146`, the assemble loop at
   `:171-179`).

2. **`injected` is keyed by relative path, so an in-session memory update is never re-shown.**
   `:145-147` filters hits already in `injected`, and `:184` records by `h.rel`; `saveMemory`
   updates a note in place keeping the same `rel` (`vault.ts:494-541`). After a note is injected,
   a later `memory_save` update to it is filtered out for the rest of the session and the model
   keeps acting on the stale snippet. Not selected this cycle; proposal written.

## Precedence applied

(0) gate green, branch clean; (1) no upstream conflict; (2) board item PG-66 first; then (4) the
first-recall defect. No security item, no docs-only item. Defect 2 is a proposal (own new idea).

## Checks to prove the fix

- `npm run smoke:autonomy-selfimprove` — the new dead-session over-budget fixture must fail on the
  base and pass with the fix.
- `npm run smoke:memory-vault` — the new first-recall failure check must fail on the base.
- `npm run test:typecheck`, targeted `eslint`, `npm run smoke:docs` for the docs touched.
