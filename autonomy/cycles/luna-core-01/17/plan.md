# Cycle 17 plan — `luna-core-01`, stream `core`

Mode: fix. No assigned board items. One in-stream item taken (scout-verified, `review.md`).

Goal: make the memory-vault first-prompt recall stop letting pinned memories crowd relevant ones out
of the first-turn recall, and stop a truncated pinned line from being hidden from the relevance
search, without regressing the cycle-16 block-sizing work.

## Item 1 — memory-vault first-turn recall drops relevant memories
Evidence: `packages/extensions/src/memory-vault/index.ts:143-146` over-fetches by `injected.size`
only while `chosen` also contains every pinned rel; on the first turn `injected` is empty and pins
that rank in the top `recallLimit` slots are filtered out, leaving no relevant block. A pinned line
cut by the `RECALL_CHARS` cap was in `chosen` but never in `injected`, so it was hidden forever.
Change: over-fetch by `pinnedLines.length` too; build `chosen` from `injected` only and iterate the
hit set against the pinned lines that actually survived the cap, so a cut pin stays eligible.
Checks: new `tests/memory-vault-smoke.ts` check 15 (three pins outranking a non-pinned relevant
memory) that fails on base source and passes on head; `smoke:memory-vault`, `test:typecheck`,
targeted eslint, `smoke:docs`. Docs: `docs/memory.md` once-per-session and oversized-recap sentences.

## Not taken (proposed, not fixed this cycle)
- context-sieve hidden-message framing outside the message budget + telemetry — proposal
  `luna-core-01-17-context-sieve-message-framing.md`.
- 64-token doc drift and `guidelines/README.md` search order/profile drift — proposal
  `luna-core-01-17-doc-drift-64-token-and-guidelines.md`.
- skill-router `re:` switch-off process-lifetime vs session-lifetime — proposal
  `luna-core-01-17-skill-trigger-session-lifetime.md`.
- HANDOFF #4 (test-only), #1 (out of stream), V-07/V-08/V-10 (no finding list).

## Verification
Targeted smokes per changed file; independent review of `ff6083ca18b2..HEAD` against the charter
(reviewer subagent hung again; replaced by the objective base-vs-head checks, as in cycle 16);
fix or revert failures; `verify.md` line by line.
