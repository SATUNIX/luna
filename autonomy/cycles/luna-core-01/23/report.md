Outcome: successful
Mode: fix

# Cycle 23 report — `luna-core-01`, stream `core`

Board: V-10 done - re-verified the whole-repository rebrand acceptance already holds on the base
(`smoke:brand` 18/18, `mkdocs.yml`/README/`AGENTS.md`/`CLAUDE.md` say Luna, package name still
`@satunix/pi-system`), so no rebrand commit was needed.

Item: HANDOFF #11 three doc drifts plus the README/profiles regression — `947f272` —
`npm run smoke:extensions-catalogue` (new assertion fails on the base for `guidelines` and
`spec-plan`), plus `smoke:docs` and `smoke:brand`.

Item: HANDOFF #10 charge context-sieve hidden-message framing to the message budget — `2ef965a` —
`npm run smoke:context-budget` (16/16; the two new checks fail on the base), plus
`tsc -p tests/tsconfig.json` and targeted eslint.

## What changed

Item A: `docs/architecture/memory-compaction-context.md:90` no longer claims a 64-token floor that
`budgetFor` actually caps at half the window; `guidelines/README.md` drops `AGENTS.md` from the
search order (the code's `CANDIDATE_NAMES` deliberately excludes it, `index.ts:6-9`) and both that
README and `spec-plan/README.md` add the missing `pentest` profile. A new assertion in
`tests/extensions-catalogue-smoke.ts` ties every first-party README `Included in:` backtick list to
its `extension.json` `profiles`, so this drift cannot return.

Item B: `packages/extensions/src/context-sieve/index.ts` now reserves the injected-context header
(`MESSAGE_HEADER.length + 2`) from the message-channel assembly budget, drops the `stillCurrent`
line when it would overflow, and records `message.tokens` from the final injected content (0 when
nothing is injected). Docs and two `tests/context-budget-smoke.ts` checks updated with it.

## Verification

`smoke:context-budget` 16/16, `smoke:extensions-catalogue`, `smoke:docs`, `smoke:brand` 18/18,
`tsc -p tests/tsconfig.json` and targeted eslint all green. Independent reviewer
(`2026-11-12T00-49-10-247Z-reviewer-ba71db`): **PASS**, no must-fix. Diff ~15,883 bytes over six
non-record files; no `package.json` scripts, `package-lock.json`, `.github/**` or
`autonomy/CHARTER.md` touched.

## Left / next cycle

Both HANDOFF carry-overs #10 and #11 are now closed. Still open and not in this stream's scope:
HANDOFF #4 (`tests/orchestrate-commands-smoke.ts` not clearing `PI_KIT_INTERNAL_CHILD`, test
robustness), and the operator decisions #12/#14/#6/#7. V-07/V-08 still need the operator's finding
list. No new proposal was needed; the two existing proposal files
`autonomy/proposals/luna-core-01-17-context-sieve-message-framing.md` and
`.../luna-core-01-17-doc-drift-64-token-and-guidelines.md` are now implemented and can be closed by
the operator.
