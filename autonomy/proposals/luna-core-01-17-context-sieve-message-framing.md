# Proposal — charge the context-sieve hidden-message framing against its budget

Status: proposed (not implemented). Author: cycle 17, run `luna-core-01`. Stream: `core`.

## Problem

`packages/extensions/src/context-sieve/index.ts` bounds the message channel's *contribution text*
but injects more than that:

- `assembleWithBudget` (`:237-258`) bounds only the assembled contribution blocks to
  `messageBudgetTokens * CHARS_PER_TOKEN` (`:311`).
- The injected content (`:347`) is
  `[Context for this request — injected automatically, not written by the user]\n\n${fresh.join("\n\n")}${stillCurrent}`.
  The 78-char header plus `"\n\n"` and the `"\n\n(Still current, injected earlier in this
  conversation: …)"` line are **outside** that bound.
- The recorded telemetry `message.tokens` (`:337`) is `estimateTokens(messageText)`, i.e. only the
  assembled blocks, so `sieve-budget.json` also under-reports what was injected.

On a small context window this is material: with `PI_KIT_CTX_MESSAGE_BUDGET_TOKENS` small, one
200-char contribution makes `assembleWithBudget` return exactly the budget, and the injected content
is `78 + 200 = 278` chars (~70 tokens) — roughly 40% over a 50-token message budget. The docs
(`docs/architecture/memory-compaction-context.md:90`) say each channel is budgeted and truncated
separately, so the message budget is documented as the cap on the hidden message.

## Why it is bounded (why this is not urgent)

The overrun is a fixed ~78-char header plus a still-current line bounded by the number of live
message contribution ids, so it is tens of tokens, not unbounded. The contribution text itself is
still bounded. Severity: low, token-efficiency only.

## Suggested fix

1. Reserve the framing when assembling: pass
   `messageBudgetTokens * CHARS_PER_TOKEN - (header.length + 2)` to the message
   `assembleWithBudget`, so the whole injected message fits.
2. Account for `stillCurrent` explicitly: build it after assembly, include it only while it fits the
   remaining room (drop or shorten the id list otherwise), so it cannot push the message over.
3. Record the real injected size: compute `message.tokens` from the final content (framing
   included), not from `messageText`, and keep `tests/context-budget-smoke.ts` in step.

## Tests to add

- A check that the whole `result.message.content` (not just the assembled blocks) is within the
  message budget in characters when a contribution exactly fills it.
- A check that `sieve-budget.json`'s `message.tokens` matches the injected content.

Cite `tests/context-budget-smoke.ts` (`testBudgetForPureFunction`, `testSeparatorChargedInBudget`)
for the existing conventions.
