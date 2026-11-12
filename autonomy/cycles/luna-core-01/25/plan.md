# Cycle 25 plan — `luna-core-01`, stream `core`

Mode: **fix** (precedence 4 defect). No board items. Scope is one cycle-sized reviewable diff;
stop taking items once the measured diff passes 30,000 characters.

Goal: stop the standing-mode reminder from being appended to the session unchanged every turn,
while keeping the full standing guidance in the system prompt and still showing the reminder on
the first turn and whenever its size/budget changes.

## Item 1 — deduplicate the standing-mode reminder

- Justification: a real token-efficiency defect (review Finding B). While standing mode is on,
  `packages/extensions/src/effort/index.ts:760-775` puts the full `policy/standing.md` text inside
  the effort block *and* adds a hidden reminder message every turn; the reminder text is identical
  each turn and adds ~38-42 tokens permanently (measured 152-168 chars), while the same guidance is
  already in that turn's system prompt. `docs/effort.md:325-326` admits the gap. The codebase
  already uses the fix pattern (`context-sieve/index.ts:327-336` `lastInjected`; the effort
  extension resets `cardSeen` per session). Charter items 1 (evidenced problem), 2 (tested) and
  3 (documented) apply.
- Change: `packages/extensions/src/effort/index.ts`. Add `let lastReminder: string | null = null`;
  emit the reminder only when it is non-null and differs from `lastReminder`, otherwise fall back to
  the card (or no message); update `lastReminder` each turn (set it to `null` when standing is off
  or the `workflow` tool is inactive, so it re-emits later); clear it in the `session_start` and
  `session_compact` handlers next to `cardSeen`. The message's `customType` stays
  `STANDING_REMINDER_TYPE` when the reminder is emitted and `WORKFLOW_CARD_TYPE` otherwise.
- Test: extend `tests/effort-standing-smoke.ts` (the check at line 178). Keep the first-turn
  reminder assertion; add a second unchanged turn whose result has `messageOf(...) === null`; then
  change the size with `/effort uc --size ...` (or equivalent) and assert the reminder appears
  again with the new size; add a session_start reset assertion if the harness supports it. The
  second-turn assertion must fail on the base (base always returns the reminder) and pass with the
  fix.
- Docs: update `docs/effort.md` so "each turn carries a hidden reminder message" and the "Not
  covered: the hidden reminder is one more message … every turn" sentence describe the deduped
  behaviour.
- Checks: `npm run smoke:effort-standing`, `npm run smoke:effort`,
  `npx tsc -p tests/tsconfig.json`, and targeted `npx eslint` on the changed files.
  Do not run `npm test` or `npm run check:all`.

## Attempted and reverted — the `-es` stemmer regression (review Finding A)

An implementer changed the `-es` branch so an s-ending base returned its own stem, intending
`buses -> bus` / `lenses -> lens`. The independent reviewer rejected it (**FAIL**): every rule that
detects "the singular ends in s" by looking at the plural's stripped base also catches silent-e
plurals, whose base happens to end in s (`cases -> cas` vs `case -> case`,
`houses -> hous`, `causes -> caus`), trading a rare miss for a regression on a more common class.
The structural ambiguity (`buses` and `cases` both end `-ses`) cannot be resolved without a
lexicon, which is out of scope. The commit and working tree were reverted to the cycle base; the
cycle-24 heuristic limit stands. Recorded in `review.md` and handed to the next cycle.

## Out of scope / not taken (recorded in `review.md`, proposals written)

- Finding A (s-ending singulars still miss their `-es` plural): needs a lexicon or an operator
  decision on the trade-off; not a net-positive heuristic fix.
- Finding C (E5 `PLAN_STEER` / workflow card repeat `exhaustive.md`): folded into proposal
  `luna-core-01-25-standing-reminder-dedupe.md`.
- Finding D (brand smoke skips `.jsonl`; `pi-kit` namespace unscanned/undocumented): proposal
  `luna-core-01-25-brand-smoke-scope.md`. V-10 rename itself complete (`smoke:brand` 18/18).
- HANDOFF #1 firewall timing noise (out of this stream); #6/#7/#12 operator decisions; V-07/V-08
  awaiting the operator's finding list.

## Acceptance

- `smoke:effort-standing` green with the new checked turn, and the new assertion fails on the
  base; `smoke:effort`, `tsc -p tests/tsconfig.json` and targeted eslint green; `smoke:docs` green
  after this cycle's records are written. One commit, pushed. Final diff well under 30,000
  characters.
