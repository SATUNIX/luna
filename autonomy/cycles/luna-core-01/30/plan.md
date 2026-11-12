# Cycle 30 plan — luna-core-01

Mode: **fix**. The assigned board items are already landed on the base (cycle 29), so this cycle
re-verifies them and fixes the in-stream memory-recall defects the review found. Priorities from
`autonomy/CHARTER.md`: (2) board items — re-verify, no work left; (3) HANDOFF carry-over #16; (4)
defect D2 found this cycle.

## Goal

A memory updated mid-session is re-shown with its new content (D1), and a 4-character plural note is
found by its singular query (D2), each pinned by a test that fails on this base and passes at head.

## Item 1 — D1 / HANDOFF #16: fingerprint-keyed injection

**Justification.** Real recall defect: `index.ts:92,145-147` filters by `rel` alone, and
`saveMemory` keeps the `rel` (`vault.ts:494-545`), so an updated note is silently stale for the
rest of the session. The proposal `luna-core-01-28-memory-vault-injected-path.md` records it.
Charter rule 1 (evidenced bug) and rule 2 (test).

**Change.** `packages/extensions/src/memory-vault/index.ts`:
- `injected` becomes `Map<string, string>` (`rel` -> content fingerprint).
- A fingerprint helper hashes the note body read from disk (stronger than mtime+size, which the
  scout showed can collide on a same-ms same-size atomic rewrite). On an unreadable file the
  fingerprint is a sentinel, so the entry never matches and is retried.
- The filter keeps a `rel` only when its stored fingerprint equals the current one; a changed note
  is offered again. `injected.size` still counts distinct rels (one entry per rel).
- The two `injected.add` sites record the fingerprint of the note they rendered.
- `session_start` / `session_compact` still `clear()`.

**Docs.** `docs/memory.md` once-per-session wording and the `index.ts` header comment say a memory
is injected at most once per session; scope that to "per unchanged content".

**Tests.** `tests/memory-vault-smoke.ts` check 6: in a dedicated vault and repo, inject a note on
the first prompt, update it in place via `vault.saveMemory` with a new body carrying a new term,
then assert the next prompt in the same session re-shows the note with the new body (fails on the
base: `undefined`).

**Checks.** `npm run smoke:memory-vault`, `npx tsc -p tests/tsconfig.json`, targeted eslint on the
two changed files, `npm run smoke:docs`.

## Item 2 — D2: 4-character plural recall

**Justification.** `search.ts:25` returns early at `length <= 4` before the `-s` rule (whose own
minimum is 4), so `stem("logs")` stays `logs` while `stem("log")` is `log`; a note saved with
`logs`/`docs`/`cars`/`apis` is unreachable by the singular query, contradicting `docs/memory.md`.
Charter rule 1 (evidenced bug) and rule 2 (test).

**Change.** `packages/extensions/src/memory-vault/search.ts`: guard `t.length < 4` so the `-s`
rule applies to 4-character words, keeping the `ss` guard and every other rule unchanged.

**Tests.** `tests/memory-vault-smoke.ts` check 16: add exact `stem()` assertions (`logs`->`log`,
`docs`->`doc`, `cases` still `case`) and a round trip where a note saved with a 4-character plural
is found by the singular query and vice versa. Fails on the base.

**Checks.** `npm run smoke:memory-vault`, `npx tsc -p tests/tsconfig.json`, targeted eslint,
`npm run smoke:docs`.

## Board re-verification (no code)

DE-96 and DE-97 are re-verified on this base (see `review.md`): `npm run smoke:prepush-scan` 16/16,
`npm run smoke:brand` 23/23, and the four real reproductions admitted while the true positives
still refuse. Recorded `done`; no change.

## Constraints

One logical change per commit; push after each. Never `npm test` or `npm run check:all`; the host
gate runs the full suite on a clean checkout. Revert rather than land an unverified change.
Proposals for anything outside the stream; never edit `autonomy/BACKLOG.md`, `autonomy/CHARTER.md`,
`.github/` or a control path. Watch the review-diff budget (stop new items past 30,000 chars).
