# Cycle 24 plan — `luna-core-01`, stream `core`

Mode: **fix** (precedence 3 HANDOFF carry-over #4, then precedence 4 defect). No board items.
Scope is one cycle-sized reviewable diff; stop taking items once the measured diff passes 30,000
characters.

Goal: make memory recall find a memory whichever number the user's prompt uses, and make the
orchestrator command smoke tell the truth under an ambient kit-child environment.

## Item 1 — plurals and singulars must meet in memory recall

- Justification: a real recall loss (review Finding A). A memory saved with "files"/"processes"/
  "classes"/"notes"/"values"/"addresses" is unreachable by the singular query, in both automatic
  injection and `memory_search`; the code comment and `docs/memory.md:57` say stemming is meant
  to make inflections meet. Charter item 1 (evidenced problem) and 2 (tested) apply.
- Change: `packages/extensions/src/memory-vault/search.ts` `stem()`. For the `-es` suffix, strip
  to the base and then restore the singular: if the base ends in a sibilant that plurals as
  `-es` (`ss`, `x`, `z`, `ch`, `sh`) keep the base; otherwise add the silent `e` back when the
  resulting singular is short (length <= 5), and keep the stripped base when the singular is
  long enough that the singular branch strips its own `e` (so `response`/`responses` still both
  become `respons`). For the plain `-s` suffix, return the base without the doubled-consonant
  collapse (`files` -> `file`, `cliffs` -> `cliff`). Keep `-ies`/`-ied`, `-ing`, `-ed`, `-ation`,
  `-ence` behaviour and the `configure` -> `configur` rule unchanged.
- Test: extend `tests/memory-vault-smoke.ts` with a check that fails on the base: assert the
  exact stemmer outputs (`files`->`file`, `notes`->`note`, `values`->`value`,
  `processes`->`process`, `classes`->`class`, `addresses`->`address`, plus the already-working
  `commits`->`commit`, `response`/`responses`->`respons`) and a `searchMemories` round trip
  (save a note whose text has the plural, find it with the singular query, and vice versa).
  Update the smoke header comment's check list to number the new check.
- Docs: add a short clarifying clause to the recall section of `docs/memory.md` that singular
  and plural forms match. No new user command or setting.
- Checks: `npm run smoke:memory-vault`, `npx tsc -p tests/tsconfig.json`, and targeted
  `npx eslint` on the two changed files. Do not run `npm test` or `npm run check:all`.

## Item 2 — make `orchestrate-commands-smoke` hermetic

- Justification: HANDOFF carry-over #4, reproduced in the review (`PI_KIT_INTERNAL_CHILD=1` makes
  3/7 checks fail, including a misleading missing-file error). Test-only robustness; charter item
  1 (evidenced problem) and 6 (tests accuracy) apply.
- Change: `tests/orchestrate-commands-smoke.ts` imports `isolateKitEnv` from the harness and uses
  `const restore = isolateKitEnv()` in place of every `setEnv("PI_KIT_ORCH_DISABLE", undefined)`
  (six sites, lines 27/50/72/93/150/175), dropping the now-unused `setEnv` import. This strips
  all `PI_KIT_*`/`PI_SUBAGENT_*` ambient variables and restores them, matching the peer smokes.
- Test: the smoke itself; on the base it fails with `PI_KIT_INTERNAL_CHILD=1` and must pass with
  the change.
- Docs: none (test-only, no behaviour described anywhere changes).
- Checks: `npm run smoke:orchestrate-commands` both plain and under
  `PI_KIT_INTERNAL_CHILD=1`, `npx tsc -p tests/tsconfig.json`, targeted `npx eslint`.
  Do not run `npm test` or `npm run check:all`.

## Out of scope / not taken

- `skill-router` session-lifetime switch-off: real defect, but proposal 17 reserves the
  re-enable-vs-document trade-off for the operator. Recorded in the handoff, not implemented.
- HANDOFF #1 firewall timing noise (out of this stream), #6/#7/#12/#14 operator decisions,
  V-07/V-08 awaiting the operator's finding list.

## Acceptance

- Both targeted smokes green on a clean tree, `tsc -p tests/tsconfig.json` and targeted eslint
  green; the new memory check fails on the base and passes with the fix; the orchestrate smoke
  passes under `PI_KIT_INTERNAL_CHILD=1`; `smoke:docs` green after this cycle's records are
  written. One commit per item, pushed after each. Final diff well under 30,000 characters.
