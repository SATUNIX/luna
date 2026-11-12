# Cycle 31 plan — luna-core-01

Base `4e0b562fee2c`. Mode: **fix** (two evidenced defects in stream). Budget ~$5.

## Item 1 — memory-vault first-recall flag (fix)

- **Justification:** charter §"What counts" 1 (a reliability bug shown in code) and HANDOFF #15.
  `firstPrompt` is consumed at `index.ts:154` before the recall work; a synchronous throw in that
  work is caught (`:203-205`) and the earlier-session recap and pinned block are lost for the whole
  session, although `docs/memory.md:41-45` promises them on the first prompt.
- **Change:** move `if (isUserPrompt) firstPrompt = false;` from `:154` to immediately before
  `if (!final) return undefined;` (`:197`), so the flag is consumed only after the recall work has
  completed (including the `!final` no-message exit, matching today's semantics).
- **Tests:** add a check to `tests/memory-vault-smoke.ts`: write a recap, `session_start`, call
  `before_agent_start` with `{ prompt: 123 }` (throws inside, caught), then call it again with a
  real prompt and assert the response carries the `Earlier sessions` recap. Fails on base (second
  call returns `undefined`), passes after the move.
- **Docs:** none needed; `docs/memory.md` already states the intended behaviour.
- **Checks:** `npm run smoke:memory-vault`; `tsc -p tests/tsconfig.json`; targeted eslint.

## Item 2 — skill-hint truncation and token claim (improve)

- **Justification:** charter §"What counts" 1 (friction users hit; measured evidence). Hint lines
  cut 25/34 shipped descriptions mid-word and can cut the "Use when …" clause, and the documented
  "~30 tokens" claim is ~2× low (measured average 240 chars).
- **Change:** in `packages/extensions/src/skill-router/index.ts:78`, truncate the description at a
  word boundary (append `…` only when cut); correct the "name + path … ~30 tokens" statements in
  `index.ts:15` and `match.ts:8` to the real measured shape. Keep the one-line hint contract.
- **Tests:** extend `tests/skill-routing-smoke.ts` to assert a long description is cut on a word
  boundary (no partial word, ends with `…`, length within a small cap).
- **Docs:** the two source comments; confirm `smoke:docs` still green.
- **Checks:** `npm run smoke:skill-routing`; `npm run smoke:docs`; targeted eslint.

## Out of scope / proposals

- skill-router `re:` switch-off lifetime: security-lifetime operator decision → proposal
  `autonomy/proposals/luna-core-01-31-skill-trigger-lifetime.md`.
- `searchMemories` over-fetch snippet reads: wider change → proposal
  `autonomy/proposals/luna-core-01-31-memory-search-exclude.md`.

## Order

Item 1 then item 2; each through `workflow_run` (implementer, then a gated independent reviewer,
`max_loops` 1). Commit + push after each item. Keep the measured review diff under 30,000 chars.
