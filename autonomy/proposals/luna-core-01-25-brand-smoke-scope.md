# Proposal — close two brand-smoke scope gaps

Status: proposed (not implemented). Author: cycle 25, run `luna-core-01`. Stream: `core`.

## Problem

The V-10 whole-repo brand smoke (`tests/brand-smoke.ts`) passes 18/18 and the rename is complete
for everything it scans, but its scope leaves two gaps:

1. **A tracked fixture is silently skipped.** `tests/skill-routing-fixtures.jsonl:61` contains
   `GOAL: Harden and improve the pi-system repository ...`. `isTextFile()` does not list `.jsonl`,
   so `walkText` never reads it, yet `docs/branding.md` claims "Every line matching `pi[- ]system`
   must be explained by an allowed identity above or by an explicit allowance." Either add an
   explicit branding.md allowance (it is a recorded historical prompt and arguably data), or add
   `.jsonl` to the scanner and rename/anonymise the line.

2. **The `pi-kit` / `PI_KIT_*` namespace has no coverage and no documentation.** `grep` finds no
   `pi-kit` or `PI_KIT` in `tests/brand-smoke.ts` or `docs/branding.md`. User-facing display prose
   still says "pi-kit" in several shipped files, e.g.
   `packages/container/scripts/pi-agent:31,40` (container logs),
   `packages/core/extract-extension.ts:122,124` (console text),
   `packages/core/eval/run.ts:78` (banner),
   `packages/extensions/src/finish-reason-retry/index.ts:131` (stderr prefix),
   `packages/container/mcp-servers/memory-mcp/index.ts:559` (tool description).
   Many other `PI_KIT_*`/`pi-kit` occurrences are plausible external contracts (env vars, state
   dirs, `Symbol.for("pi-kit.*")`, event names), so the fix is not a blind rename: add a `pi-kit`
   section to `docs/branding.md` listing which are deliberate contracts, and teach the smoke which
   forms are allowed versus which are display prose to rename. Without that split the smoke cannot
   distinguish drift from contract.

## Suggested fix

Decide each item with the operator (these are identity/control-adjacent), then make the matching
change: extend `isTextFile`/`SKIP_FILES` and `ALLOWED` in `tests/brand-smoke.ts`, update
`docs/branding.md`'s scope and deliberate-identity list, and rename the genuine display prose to
Luna. Re-run `npm run smoke:brand` after each.
