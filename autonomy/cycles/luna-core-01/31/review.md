# Cycle 31 review — luna-core-01

Base `4e0b562fee2c` (head of `stream/core`). Charter read; stream `core` (rebrand, memory recall,
discoverability, agent efficacy/token efficiency, defects V-10/V-11/V-07/V-08). Mode: **fix** —
real defects in stream, higher in the charter than improvement.

## State

- No board items assigned. No upstream ref (`git remote -v` → only `origin`; `git show-ref` has no
  `refs/upstream/trunk`), so no merge work.
- Red gate: none. Working tree clean, `git diff base..HEAD` is 0 chars.
- V-10 (rebrand) and V-11 (first-prompt recall framing) are done and merged; V-07/V-08 still need
  the operator's in-tree finding list (unchanged). No action.
- HANDOFF carry-overs reviewed. Most are done or operator decisions (timing noise #1, wall cap #3,
  install guard #4, CODEOWNERS #6, watchdog #7, codeql name #14, first-recall flag #15,
  reload no-op #17). #12 (skill-router switch-off outlives the session) is a security-lifetime
  decision, not an autonomous fix (see below).

## Candidate findings (scouts against the code)

1. **memory-vault `firstPrompt` consumed before the recall work — HANDOFF #15. Real and now
   testable.** `packages/extensions/src/memory-vault/index.ts:154` runs
   `if (isUserPrompt) firstPrompt = false;` before `searchMemories` (`:163`), the `assemble`
   loop (`:170-195`) and the injected writes (`:199-200`); any synchronous throw is swallowed by
   the catch (`:203-205`) while the flag is already false, so the earlier-session recap and pinned
   block are never offered again that session. The cycle-28 proposal called it untestable because
   it only considered filesystem faults; the handler passes `event.prompt` straight to
   `tokenize(query)` (`search.ts:56`, `text.toLowerCase()`) with no type guard (`:139` checks only
   `"prompt" in event`), and the harness types the event as `unknown` (`harness.ts:185`). A
   `{ prompt: 123 }` event throws after `:154` and is caught — a test can pin it with no production
   seam. Smallest fix: move the assignment to just before `if (!final) return undefined;` (`:197`),
   behaviour-preserving on every success path, only changing the throw path.
   Evidence: scout read of `index.ts`, `vault.ts`, `search.ts`, `harness.ts`, `tests/memory-vault-smoke.ts`.

2. **Skill hints cut descriptions mid-word; the documented cost is ~2× low — discoverability +
   token efficiency.** `packages/extensions/src/skill-router/index.ts:78` emits
   ``s.description.slice(0, 160)``; measured on the shipped hidden skills, 33/34 descriptions
   exceed 160 chars and 25 of those are cut mid-word, routinely cutting the "Use when …" clause
   that is the reason to read the skill. Measured hints average 240 chars (~60 tok), max 263;
   `index.ts:15` and `match.ts:8` claim "name + path … ~30 tokens". Fix: truncate at a word
   boundary and state the real cost. Smoke: `smoke:skill-routing`.
   Evidence: scout measurement over shipped skill frontmatter.

3. **`searchMemories` over-fetches and reads a snippet for every already-injected note, every
   prompt** (`index.ts:163` limit `recallLimit + injected.size + pinnedLines`; `vault.ts:573-584`
   reads each candidate before the caller filters). Real IO waste, but a new `exclude` parameter
   is a wider change; deferred to a proposal.

## Rejected / out of scope

- **skill-router `re:` switch-off lifetime (HANDOFF #12).** Confirmed process-lifetime, not
  per-session (`match.ts:82,116-117`, `index.ts:47-53`). Option 1 (reset on `session_start`)
  relaxes a containment control and is an operator decision; option 2 (align the wording to "for
  the process") is safe but LOW value next to item 2. Left as proposal.
- `context-sieve` `budgetTokens` Infinity smell and `effort` standing-reminder type reuse: weak
  evidence, no shipped producer.

## Items chosen

1. Fix the memory-vault first-recall flag and pin it with a test that fails on the base.
2. Truncate skill hints at a word boundary and correct the documented token claim, with a test.

Checks to run: `npm run smoke:memory-vault`, `npm run smoke:skill-routing`, `npm run smoke:docs`,
`tsc -p tests/tsconfig.json`, targeted eslint. Never `npm test` / `npm run check:all`.
