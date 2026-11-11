# Report — cycle 02, run `luna-core-01`

Outcome: **successful**
Mode: **fix** (V-11) and **improve** (V-101)

Base `06b4d3d7f3a3`, branch `pi/luna-core-01`. Diff 33,521 chars (records excluded),
under the 60,000 read budget. No assumed risk classes changed, so no assumption review
was required.

## Board

- Board: V-11 done — first-prompt memory recall is now framed as background history, so a
  bare greeting no longer reads as a request to resume old work.
- Board: V-101 done — the Luna rename is finished across the docs/README/mkdocs scope and
  guarded by `tests/brand-smoke.ts`; `docs/branding.md` records the two names.

## Items

- Item: Frame first-prompt memory recall as background history — `ca70eea`, `ba1211b` —
  `npm run smoke:memory-vault` (check 13).
- Item: Finish the Luna rename and add a brand guard — `7b5764b` — `npm run smoke:brand`,
  `npm run smoke:docs`, `npm run docs:check`.

## Test justification

`tests/memory-vault-smoke.ts` asserts at lines ~131 and ~275 were edited **in place** and
the new greeting/truncation case was **appended as check 13** (not renumbered) because
`docs/memory.md` and `tests/docs-smoke.ts` cite existing check numbers. `tests/brand-smoke.ts`
is a new file with the new `smoke:brand` script; `tests/docs-smoke.ts` was deliberately not
edited (owned by another stream this wave).

## What was found and fixed

- **V-11.** `before_agent_start` injected `### Where we left off (<project>)` plus recap
  `**Next:**` lines with no history framing, so "hello" looked like "resume". The injected
  header now says background history / not instructions / act on the current message, the
  heading is `### Earlier sessions (<project>) - history only`, `**Next:**` renders as
  `**Was open then:**`, and an end-of-history footer always survives within
  `RECALL_CHARS = 2400`. On-disk recap format and `vault.ts` are unchanged.
- **V-101.** Residual bare `pi-system` prose in `README.md`, `docs/index.md`,
  `docs/updates.md` and the security proposal became `Luna` (backticked package identities
  kept). Added `docs/branding.md` (+ mkdocs nav) and the offline `tests/brand-smoke.ts`.
  Generated pages, `tests/docs-smoke.ts`, `CHANGELOG.md` and `packages/container/**` were
  not touched.

## Verification

See `verify.md`. All targeted commands PASS (`smoke:memory-vault`, `smoke:brand`,
`smoke:docs`, `docs:check`, and a `test:typecheck` by the reviewer). Independent reviews:
V-11 gated workflow reviewer PASS; V-101 subagent fallback reviewer PASS (the gated reviewer
returned empty output twice); cycle reviewer PASS. One cycle-reviewer warning (missing test
citation in `docs/memory.md`) was fixed in `ba1211b`.

## Left / not done

- V-101 sub-item 3 (`packages/container/**` branding) is outside this stream's scope.
- Carry-overs unchanged from cycle 01: env-manifest-ownership proposal, dead
  `.github/CODEOWNERS:43` path, cosmetic `docs/releasing.md` versions, V-07/V-08/V-10 need
  the operator's in-tree finding list.
