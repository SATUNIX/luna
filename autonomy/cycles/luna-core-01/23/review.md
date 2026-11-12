# Cycle 23 review — `luna-core-01`, stream `core`

Base: `cc7f37d2aa6f` (head of `stream/core`, cycle 22 merged). `git diff cc7f37d2aa6f..HEAD` is
empty at cycle start. No `refs/upstream/*` ref exists in this clone, so priority 1 (upstream
conflict) has nothing to merge.

## Assigned board item V-10 (rebrand) — acceptance already holds

The prompt's V-10 acceptance is met on the base by cycles 18–22; no new code is needed this cycle.

- `npm run smoke:brand` → `[brand-smoke] all 18 checks passed`; the smoke walks `WORKSPACE_ROOT`
  (`tests/brand-smoke.ts:136`) and fails `file:line` on any unexplained `pi[- ]system`.
- `mkdocs.yml:1` `site_name: Luna`; `:59` nav lists `Branding: branding.md`.
- `README.md:1` `# Luna`; hero `:6` `alt="Luna, …"` with a `docs/assets/luna-*` src.
- `AGENTS.md:1` `# Luna: instructions for the agent`; `CLAUDE.md:3` "working **on** Luna".
- `package.json` name is still `@satunix/pi-system`.
- `docs/branding.md` (88 lines) lists npm name, bin names, `PI_SYSTEM_*`, install paths, compose and
  container names, symbol/urn ids, `CAPABILITY_ID`, governance MCP name, TLS org, identity
  sets/regexes, `previousSources`/`legacySources`, CHANGELOG, legacy-source tests and temp-dir
  prefixes, and ends with a `## Rename proposal` section (`docs/branding.md:82`).
- Residual `git grep -iI 'pi[- ]system'` hits are all allowed identities (spot-checked
  `docs/ARCHITECTURE.md`, `docs/INSTALL.md`, `docs/index.md`, `docs/profiles.md`, `docs/roadmap.md`,
  `CODE_OF_CONDUCT.md`, `docs/architecture/profiles-and-install.md`: only `@satunix/pi-system` and
  quoted `pi-system` history remain).

Conclusion: `Board: V-10 done` (verified, no commit). The remaining work is consolidation of the
cycle-22 improve plus the carried-over fixes.

## Consolidation of cycle 22 (previous improve cycle)

Read `tests/brand-smoke.ts` end to end and probed its scope. No defect found: the walker skips
`node_modules`/`.git`/`dist`/`site`/`.pi` and the top-level `autonomy/` records, includes
`.md/.ts/.js/.mjs/.json/.yml/.yaml/.sh/.ps1/.py/.html/.css/.toml/.env` plus `Dockerfile` and the
`pi-agent*` scripts, and the raw-grep-by-file list contains no file outside that set that still
carries unexplained prose. Recorded, no change.

## Carry-over candidates (HANDOFF #11 and #10), confirmed against the code

### #11 two doc drifts are real

1. `docs/architecture/memory-compaction-context.md:90` says budgets are cut "**never below 64
   tokens**, and any budget … is held to half the window". `budgetFor`
   (`packages/extensions/src/context-sieve/index.ts:200-207`) applies the 64-token floor first and
   then clamps to half the window; `tests/context-budget-smoke.ts:321` already pins
   `budgetFor(undefined, 4096, 0.1, 100).tokens === 50`. The code is right and the sentence is
   wrong.
2. `packages/extensions/src/guidelines/README.md:8-13` lists `AGENTS.md` as search step 3, but
   `guidelines/index.ts:5-11` deliberately never reads it (`CANDIDATE_NAMES = ["GUIDELINES.md",
   ".pi/GUIDELINES.md"]`), so `.pi/GUIDELINES.md` is second, not fourth. The same README `:24` and
   `packages/extensions/src/spec-plan/README.md:22` both say "Included in: `balanced`,
   `long-horizon`, `autonomous`, `self-improving`" while both `extension.json` files add
   `pentest` (and `packages/kit/profiles/pentest.json:9` includes both).

No smoke currently ties a README `Included in:` list to its `extension.json` `profiles`, which is
why the drift survived; the fix should add that assertion.

### #10 context-sieve hidden-message framing is outside its budget

Confirmed by reading `packages/extensions/src/context-sieve/index.ts`: `assembleWithBudget` bounds
only the contribution blocks (`:311`), while the injected content (`:347`) prepends a 78-char
header and a `stillCurrent` line after the budget is spent, and `message.tokens` (`:337`) records
`estimateTokens(messageText)` — the blocks only, not what was injected. On a small message budget
the injected hidden message can exceed the documented cap by ~40% (`docs/architecture/
memory-compaction-context.md:90` documents the channel as budgeted). Low severity,
token-efficiency only; the fix and tests are specified in
`autonomy/proposals/luna-core-01-17-context-sieve-message-framing.md`.

## New problems found

None outside these carry-overs. Other HANDOFF items are operator decisions (#12, #14, #6, #7),
out of stream (#1), or not reproduced here (#4: `tests/orchestrate-commands-smoke.ts` does not
reference `PI_KIT_INTERNAL_CHILD` at all today; the orchestrator reads it at
`packages/extensions/src/orchestrator/index.ts:56`, so it stays a real but low-value test-robustness
note and is left for a later cycle).
