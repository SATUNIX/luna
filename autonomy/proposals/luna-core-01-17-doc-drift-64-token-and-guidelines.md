# Proposal — two one-line doc drifts (64-token floor; guidelines README)

Status: proposed (not implemented). Author: cycle 17, run `luna-core-01`. Stream: `core`.

Both are doc/code mismatches found by scout in cycle 17 and left because the cycle took only one
code item. Each is a one-line correction.

## 1. `docs/architecture/memory-compaction-context.md:90` — "never below 64 tokens"

The line says: "With a known model context window the defaults are cut to 10% (system) and 3%
(message) of the window when that is smaller, **never below 64 tokens**, and any budget, even an
explicit one, is held to half the window."

`budgetFor` (`packages/extensions/src/context-sieve/index.ts:200-207`) applies the 64-token floor
first and then clamps the result to half the window:

```ts
const base = explicit ? wanted : Math.min(wanted, Math.max(MIN_BUDGET_TOKENS, Math.floor(window * share)));
const tokens = Math.min(base, Math.max(1, Math.floor(window * MAX_WINDOW_SHARE)));
```

For `contextWindow = 100`, both budgets resolve to 50. The suite already pins this as intended:
`tests/context-budget-smoke.ts:321` asserts `budgetFor(undefined, 4096, 0.1, 100).tokens === 50`
("floor of 64 never exceeds half of a tiny window"). So the **code is correct and the doc sentence
is wrong**; it should say the 64-token floor is itself capped at half the window.

## 2. `packages/extensions/src/guidelines/README.md` — search order and profile list

- The README's "Search order" lists `AGENTS.md` at step 3 and `.pi/GUIDELINES.md` at step 4. The
  code (`guidelines/index.ts:5-9`) deliberately never reads `AGENTS.md` (pi already loads it) and
  uses `CANDIDATE_NAMES = ["GUIDELINES.md", ".pi/GUIDELINES.md"]`, with `PI_KIT_GUIDELINES_PATH`
  first. So step 3 does not exist and `.pi/GUIDELINES.md` is second, not fourth.
- The README's "Included in" line (`:24`) lists `balanced`, `long-horizon`, `autonomous`,
  `self-improving` but omits `pentest`, which `guidelines/extension.json:11` and
  `packages/kit/profiles/pentest.json:9` both include (and `docs/EXTENSIONS.md:22` lists).

## Suggested fix

Correct the two README lines and the one docs sentence. No code change. Re-run `node
tests/docs-smoke.ts`; if the docs sentence is generated, regenerate its source instead.
