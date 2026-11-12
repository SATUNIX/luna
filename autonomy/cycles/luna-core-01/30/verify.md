# Cycle 30 verify — luna-core-01

Base `12a464e594e8`; head after the two items. Review diff limit 60,000; measured 15,000 chars
(`git diff --no-renames 12a464e594e8..HEAD -- . ":(exclude)package-lock.json"
":(exclude)autonomy/cycles/luna-core-01/" ":(exclude)autonomy/runs/luna-core-01/" | wc -c`).

## Targeted checks (only the scripts that cover the changed files)

- `npm run smoke:memory-vault` — **PASS**, `all 17 checks passed`; new check `6b` proves a note
  edited mid-session is re-shown with its new body, and check `16` pins `logs`->`log` plus a
  4-character plural round trip.
- `npx tsc -p tests/tsconfig.json` — **PASS**, exit 0.
- `npx eslint packages/extensions/src/memory-vault/index.ts packages/extensions/src/memory-vault/search.ts tests/memory-vault-smoke.ts` — **PASS**, exit 0.
- `npm run smoke:docs` — **PASS**, `14 documented commands validated, 62 relative links resolved`.
- `npm run smoke:prepush-scan` — **PASS**, `16 checks passed` (DE-96 acceptance).
- `npm run smoke:brand` — **PASS**, `all 23 checks passed` (DE-97 acceptance).
- `npm run verify` — **PASS**, exit 0 after regenerating `docs/reference.md` (`npm run catalog`), which the D1 doc edit made stale because `whereCommand` now links `/remember` to `memory.md`.

Never ran `npm test` or `npm run check:all`; the host gate runs those on a clean checkout.

## Falsification (the tests would catch a regression)

- Item 1: reverting both memory-vault sources to `12a464e` and running the smoke aborts at
  `AssertionError: an updated memory is offered again in the same session` (check 6b). The
  unchanged-note suppression stays pinned by existing check 6 (`second === undefined`).
- Item 2: `git show 12a464e:...search.ts` run under `node --input-type=module` prints
  `base logs-> logs docs-> docs cars-> cars`, so the new exact assertions and the round trip fail
  on the base as the review describes.

## Independent review

- Per-item reviewer on Item 1 (workflow `…plan-0450`, step-2): **VERDICT PASS**. It flagged that
  the change was staged but not committed and that
  `docs/architecture/memory-compaction-context.md:94` still over-claimed once-per-session; both
  were fixed before the commit.
- Per-item reviewer on Item 2 (workflow `…plan-bdbb`, step-2): **VERDICT PASS**. One non-blocking
  note: `stem("cases")` passes on both base and head (it is a length-5 regression guard, not the
  evidencing assertion).
- Final review over the whole cycle diff (workflow `…plan-9bdf`, step-final-review):
  **VERDICT PASS**, no must-fix. Non-blocking nits: the mermaid label said "injected set" (fixed in
  `bd36e71`); docs say an edited note "is offered again" where strictly it becomes eligible again
  and is still gated by the relevance floor (the prior register read the same way, left as is).

## Safety

Changed files: two sources, two docs, one smoke test, the cycle's own records. No change to
`autonomy/CHARTER.md`, `autonomy/BACKLOG.md`, `.github/`, any `package.json` script or lockfile; no
secret. One logical change per commit; each pushed to `origin/pi/luna-core-01`.
