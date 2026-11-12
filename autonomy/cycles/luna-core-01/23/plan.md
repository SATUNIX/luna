# Cycle 23 plan — `luna-core-01`, stream `core`

Mode: **fix** (consolidate the cycle-22 improve, then two carried-over fixes). Board item V-10 is
already satisfied and needs no code; no new improvement is evidenced.

## Goal

Close the two confirmed HANDOFF carry-overs (#11 doc accuracy, #10 context-sieve message framing)
and add the regression that makes each stay fixed, without touching any control path.

## Items

### Item A — HANDOFF #11: three doc drifts (priority 3)

Justification: each claim is contradicted by the code that defines it (`budgetFor` clamps the
64-token floor to half the window; `guidelines` never reads `AGENTS.md`; both `pentest` profiles
include the two extensions). Docs that describe behaviour the code does not have are a charter
failure.

Change:
1. `docs/architecture/memory-compaction-context.md:90` — say the 64-token floor is itself capped at
   half the window; cite `tests/context-budget-smoke.ts` (`budgetFor` check).
2. `packages/extensions/src/guidelines/README.md` — drop `AGENTS.md` from the search order and
   renumber so `.pi/GUIDELINES.md` is step 3; add `pentest` to the `Included in:` line.
3. `packages/extensions/src/spec-plan/README.md:22` — add `pentest` (same omission).
4. `tests/extensions-catalogue-smoke.ts` — add the regression: for every first-party extension with
   both a `README.md` and an `extension.json`, an `Included in:` backtick list must equal the
   manifest's `profiles`. It fails on the pre-fix tree for `guidelines` and `spec-plan`.

Checks (targeted only; never `npm test`/`check:all`): `npm run smoke:extensions-catalogue`,
`npm run smoke:docs`, `npm run smoke:brand`, `npx eslint tests/extensions-catalogue-smoke.ts`.
Docs-only, so no typecheck needed beyond the smoke.

### Item B — HANDOFF #10: charge the hidden-message framing against the message budget (priority 3)

Justification: `context-sieve` documents the message channel as budgeted
(`docs/architecture/memory-compaction-context.md:90`) but injects a 78-char header plus a
`stillCurrent` line outside `assembleWithBudget`, and records `message.tokens` from the blocks
only, so `sieve-budget.json` under-reports. Confirmed at `context-sieve/index.ts:311,337,347`.

Change (`packages/extensions/src/context-sieve/index.ts`):
1. Name the header constant; assemble the message channel with
   `messageBudgetTokens * CHARS_PER_TOKEN - (header.length + 2)` so the whole injected message fits.
2. Build `stillCurrent` only while it fits the room left after the fresh blocks; drop it otherwise.
3. Record `message.tokens` from the final injected content (framing included), 0 when nothing is
   injected; keep `docs/architecture/memory-compaction-context.md:90` in step and name the test.
4. Add checks to `tests/context-budget-smoke.ts`: the whole `result.message.content` is within the
   message budget characters when a contribution exactly fills it, and `message.tokens` matches the
   injected content (not the blocks).

Checks: `npm run smoke:context-budget`, `npm run smoke:docs`,
`npx tsc -p tests/tsconfig.json`, `npx eslint packages/extensions/src/context-sieve/index.ts
tests/context-budget-smoke.ts`.

## Order and boundaries

Item A before Item B (both edit `docs/architecture/memory-compaction-context.md`). One commit per
item, pushed immediately. No `package.json` scripts, `package-lock.json`, `.github/`, or
`autonomy/CHARTER.md` touched. Read budget: stop taking items past 30,000 chars.

## Checks that prove the cycle

- Item A: `smoke:extensions-catalogue` fails before, passes after; `smoke:docs`, `smoke:brand`.
- Item B: new `smoke:context-budget` checks fail before, pass after; typecheck and eslint.
- Close: independent reviewer on `git diff cc7f37d2aa6f..HEAD`; `/opt/autonomy/gate.sh` is the host
  gate on a clean checkout (not run here).
