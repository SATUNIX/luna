# Cycle 30 report — luna-core-01

Outcome: successful
Mode: fix

## Board

Board: DE-96 done - the context-aware leak scan landed in cycle 29 at this cycle's base (`ee08e5f`,
`packages/core/lib/leak-scan.ts` + `packages/core/prepush-scan.ts`); re-verified now with
`npm run smoke:prepush-scan` 16/16 and the four real reproductions admitted (placeholder home path
in `compose.dev.yaml:9`, the documented `--answer <id>` inbox example, a run record citing a legacy
id, a commit message citing one) while every true positive still refuses.
Board: DE-97 done - the safe/deterministic brand smoke landed in cycle 29 at this cycle's base
(`72bae06`, `tests/brand-smoke.ts`: every dotenv but `.env.example` skipped, `file:line`-only
findings, `git ls-files` tracked set with a fixed-skip fallback); re-verified now with
`npm run smoke:brand` 23/23.

No code change was needed for either board item; the publication freeze is a host/trunk action, not
agent work. Cycle 29 used the context-aware carve-out (not the "identifier class stays strict,
change the record format" option); the review did not reopen that.

## Items

Item: memory-vault re-offers a note edited mid-session (HANDOFF #16) - `e64256f`, `ca2ffa5` -
`npm run smoke:memory-vault` check 6b: after the first prompt injects a note, `vault.saveMemory`
rewrites it in place and the next prompt must show the new body and not the old one; on the base the
recall is `undefined`. `injected` is now a `Map<rel, sha256(body)>` and a rel is suppressed only
while its fingerprint is unchanged, so `injected.size` over-fetch and pinned/hit marking are
preserved. `docs/memory.md` and `docs/architecture/memory-compaction-context.md` state once per
session per unchanged content.
Item: the stemmer meets 4-character plurals - `fa4a42a`, `bd36e71` -
`npm run smoke:memory-vault` check 16 asserts `stem("logs")==="log"`, `docs`/`cars` likewise, and a
4-character plural note round-trips against the singular query; the base stem guard returned
`logs`/`docs`/`cars` unchanged (observed via `node --input-type=module` on
`git show 12a464e:…/search.ts`). The guard `t.length <= 4` became `< 4` so the existing `-s` rule
(its own minimum is 4) applies; the `ss` and stopword guards are untouched. `bd36e71` fixes the
compaction diagram's stale "injected set" wording.

## Verification

`smoke:memory-vault` 17/17, `smoke:prepush-scan` 16/16, `smoke:brand` 23/23, `smoke:docs` OK,
`tsc -p tests/tsconfig.json` exit 0, targeted eslint exit 0. Falsification: reverting both
memory-vault sources to the base aborts the smoke at check 6b. Independent per-item reviews PASS;
final whole-diff review PASS, no must-fix (two non-blocking doc nits, one fixed). Diff 15,000 chars,
under the 30,000 stop. Never ran `npm test` or `npm run check:all`.

## Left for next cycle

- HANDOFF #15 (memory-vault `firstPrompt` consumed before recall work) stays open: not testable
  without a fault-injection seam; proposal `luna-core-01-28-memory-vault-first-recall-flag.md`.
- HANDOFF #17: the cycle-27 reload proposal is a no-op, do not implement.
- Generated `docs/reference.md` changed as a side effect of the D1 doc edit: `whereCommand`
  (`packages/core/reference.ts:254`) counts command mentions, and the added `` `/remember` `` in
  `docs/memory.md` now outweighs the control-center lists, so `/remember` links to `memory.md` (the
  accurate page). Regenerated with `npm run catalog` and committed; `npm run verify` is green.
- Recommendation to the steward: with the host gate green on a clean checkout, merge
  `pi/luna-core-01` into `stream/core`.
