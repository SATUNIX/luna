# Cycle 25 review — `luna-core-01`, stream `core`

Mode: **fix**. Base `69945c63d794` (head of `stream/core`, cycle 24 merged). HEAD is clean and
the pre-cycle diff is 0 bytes, so priority 0 (red gate) and priority 1 (upstream conflict) are
clear. No board items were assigned. `autonomy/CHARTER.md`, the cycle-24 report and
`autonomy/runs/luna-core-01/HANDOFF.md` were read; proposals under `autonomy/proposals/` read.

Method: one parallel scout plan of four read-only scouts, each checking a candidate area
against the code and running only targeted smokes (never `npm test` / `npm run check:all`).
Audit/roadmap prose was treated as a hypothesis.

## Finding A — cycle 24's stemmer regressed short s-ending singulars (real defect, regression)

`packages/extensions/src/memory-vault/search.ts:33-37` handles the `-es` suffix by restoring a
silent `e` (`files -> file`) unless the base is a sibilant. A base that already ends in a single
`s` (a singular like `bus`, `gas`, `lens`, `virus`) is not a sibilant, so the code appends the
restored `e` and yields a token that can never match the singular. Reproduced against the pure
function:

```
bus -> bus     buses -> buse
gas -> gas     gases -> gase
lens -> lens   lenses -> lense
virus -> viru  viruses -> virus
```

Documents and queries share `tokenize()/stem()` and BM25 matches exact tokens, so a note saved
with "buses" is invisible to a "bus" query and vice versa. This is a **regression**: the
pre-cycle-24 `stem()` (shown by `git show 24e704d^:...search.ts`) stripped `-es` to the base and
collapsed doubled consonants, giving `buses -> bus`, `gases -> gas`, `lenses -> lens` — all
matching. Cycle 24's fix named this class as a residual heuristic but did not record that it got
*worse* than the base. It hits automatic recall (`memory-vault/index.ts:146`, `gate: true`) and
`memory_search`. Check 16 (`tests/memory-vault-smoke.ts:458-472`) only asserts
`files/notes/values/processes/classes/addresses`, so it never exercised a short s-ending singular.

Attempted and reverted: a change that returned `stem(base)` for any s-final base (so
`buses -> bus`) was implemented and then **rejected by independent review (FAIL)**: the plural's
stripped base ends in `s` for silent-e plurals too (`cases -> cas`, `houses -> hous`,
`causes -> caus`), so it turned a rare miss into a broader regression (base already matched
`cases`/`case`). The structural ambiguity (`buses` and `cases` both end `-ses`) needs a lexicon.
The attempt was reverted to the cycle base; the cycle-24 heuristic limit stands. No net-positive
heuristic fix is available this cycle.

## Finding B — the standing reminder is re-injected unchanged every turn (real token waste)

`packages/extensions/src/effort/index.ts:760-775` sets `standingShown` and both appends the full
`policy/standing.md` text inside the effort block *and* emits a hidden `message` reminder. The
reminder has no dedup: the same ~152-168-char string is added as a new `custom` (user-role)
message every turn while standing mode is on, while the full standing text is already in that
same turn's system prompt. `docs/effort.md:325-326` documents this as an admitted gap ("the hidden
reminder is one more message in the session for every turn while standing mode is on").
`context-sieve/index.ts:327-336` already solves the same problem with a `lastInjected` map, and the
effort extension itself resets `cardSeen` per session/compaction, so the pattern exists. This is a
real, measured duplication (~40 tokens/turn; ~2k over 50 turns) and an efficacy nudge that repeats
verbatim. Sized as a follow-up (Finding C), not taken this cycle.

## Finding C — the broader standing/plan text duplicates itself (minor)

At E5, `strategy.ts:63` `PLAN_STEER` repeats the "one step, one file and one check" sentence that
`policy/exhaustive.md:1` already carries, and `workflow-card.md:1` repeats it a third time. ~31
tokens/turn at E5. Recorded, not taken.

## Finding D — brand smoke scope gaps (V-10 residual)

`tests/skill-routing-fixtures.jsonl:61` is a tracked fixture carrying `pi-system` prose;
`tests/brand-smoke.ts` `isTextFile()` does not list `.jsonl`, so the scanner silently skips it,
while `docs/branding.md` claims "Every line matching `pi[- ]system` must be explained". Also the
entire `pi-kit` / `PI_KIT_*` namespace is outside the scanner and absent from `docs/branding.md`,
so drift there is invisible (`packages/container/scripts/pi-agent:31,40`,
`packages/core/extract-extension.ts:122,124`, `packages/core/eval/run.ts:78`,
`finish-reason-retry/index.ts:131`, `memory-mcp/index.ts:559`). Most are likely deliberate
contracts, but they are undocumented. `npm run smoke:brand` still passes 18/18, so the rename
itself is complete. Low/medium; recorded as a proposal, not taken.

## Audited and clean (no change this cycle)

- Memory-vault recall assembly (`index.ts:145-186`): injected-once semantics, pinned/room
  arithmetic (content ≤ 2400 in both branches), scope default/prefix filtering and the
  over-fetch limit all checked; a fuzz found no duplicate render, lost line or false injection.
- `recap.ts` gating, `isTrivial`, `parseRecap`: sound.
- context-sieve/compress/guidelines/ctx-contributions budget accounting: all targeted smokes
  green (`smoke:context-budget` 16/16, `smoke:compress` 10/10, `smoke:effort` 38/38,
  `smoke:effort-standing` 13/13, `smoke:ctx-contributions` 13/13).
- V-10 rebrand: `smoke:brand` 18/18; README/AGENTS/CLAUDE/mkdocs name Luna. Remaining items are
  the deliberate `pi remote` app identity and the `pi-kit` namespace (Finding D).
- Discoverability scout returned no finding (empty output); no evidence gathered, not treated as
  clean. No change made there.

## Chosen work (see `plan.md`)

1. Fix the `-es` regression so a short s-ending singular and its plural meet (Finding A), with a
   regression check in `tests/memory-vault-smoke.ts`.
