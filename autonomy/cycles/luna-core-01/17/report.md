# Cycle 17 report — `luna-core-01`, stream `core`

Outcome: successful (fix mode). One scout-found, test-pinned memory-recall defect fixed.
Mode: fix.
Base `ff6083ca18b2`; code head `3c1a9f3`. No assigned board items, so no `Board:` lines.

Workflow: refused the second item plan — `plan-allowance`: E3 Standard allows 8 planned agents a
request and 7 were already planned or started, so only 1 more would fit; fell back to `subagent` for
the implementer (and the reviewer, which then hung).

Item: memory-vault first-turn recall let pinned memories crowd out relevant ones and hid a truncated pinned line from the relevance search - 3c1a9f39625473d513e26adda9f5d8f9681c035a - node tests/memory-vault-smoke.ts (new check `pinned memories ranking above a relevant one do not crowd it out of the first-prompt recall` fails on base source `expected: /### Relevant memories/` and passes on head; `smoke:memory-vault` 14/14)

Finding: `packages/extensions/src/memory-vault/index.ts:143-146` built the search exclusion set from
`injected` plus every pinned rel, but over-fetched only `cfg.recallLimit + injected.size`. On the
first turn `injected` is empty, so pinned notes occupying the top `recallLimit` BM25 slots were
filtered out and the turn showed no `### Relevant memories` even when a non-pinned memory cleared the
floor just below them. The same code put a pinned line cut by the `RECALL_CHARS` cap into the
exclusion set without ever marking it injected, so it was hidden from the relevance search for the
rest of the session. Root cause: the over-fetch ignored the pinned entries the filter removes, and
the exclusion set was built before the cap decided which pins survive. Fix: over-fetch by
`pinnedLines.length`, exclude only already-injected rels, and iterate the hit set against the pinned
lines that actually survived the cap, so a cut pin stays eligible. Docs updated: `docs/memory.md` now
notes the once-per-session record is cleared at compaction, and that an oversized recap is dropped
whole only when a pinned/relevant block needs the room (a lone recap is truncated).

Justification for the changed test: the new check lowers `PI_KIT_MEMORY_MIN_SCORE` to 0.1 so the
relevance gate cannot mask the over-fetch defect; it is the over-fetch limit, not the floor, under
test. It fails on base source and passes on head, so it is not a weakened or vacuous test.

## Left / carried

- context-sieve hidden-message framing outside its budget + under-reported `message.tokens` (LOW) —
  proposal `luna-core-01-17-context-sieve-message-framing.md`.
- `docs/architecture/memory-compaction-context.md` 64-token drift and `guidelines/README.md` search
  order + missing `pentest` profile (doc-only) — proposal
  `luna-core-01-17-doc-drift-64-token-and-guidelines.md`.
- skill-router `re:` switch-off is process-lifetime, not session-lifetime (security-adjacent) —
  proposal `luna-core-01-17-skill-trigger-session-lifetime.md`.
- Not actionable here: HANDOFF #1 (out of stream), #4 (test-only), V-07/V-08/V-10 (no finding list).

## For the next cycle

- The reviewer subagent hung again (run `2026-11-11T22-23-38-772Z-reviewer-20dbf0`, status `toolUse`,
  no verdict); its partial log shows it was doing a `git archive` base-check. The objective
  base-vs-head checks replaced it. This is now the second cycle running.
- One implementer subagent also no-op'd once (emitted a JSON tool stub as text, 725 tokens, no
  edits); a re-dispatch with an explicit "edit files now, do not output a plan" instruction worked.
- Item 1 is memory-recall scoped; the three proposals above are cheap next-cycle items, and the two
  doc drifts are one-liners.
