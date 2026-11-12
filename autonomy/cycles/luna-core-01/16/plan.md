# Cycle 16 plan — `luna-core-01`, stream `core`

Mode: fix. No assigned board items; two in-stream items (scout-verified, `review.md`).

## Item 1 — memory-vault first-prompt recall loses pinned/relevant memories
Change: build pinned/hit blocks first, give the recap only leftover room, drop it whole when it does not fit, and add a rel to `injected` only when its rendered line survives; keep truncating a lone recap.
Checks: `smoke:memory-vault` (checks 13/14 fail on base), `test:typecheck`, targeted eslint, `smoke:docs`.

## Item 2 — context-sieve separators and `lastInjected` cleanup
Change: charge the pending separator (`separator = assembled.length > 0 ? 2 : 0`) so `budgetChars` bounds the joined text; clear `lastInjected` in the empty-contribution early return.
Checks: `smoke:context-budget` (2 new tests fail on base), `smoke:ctx-contributions`, `test:typecheck`, targeted eslint, `smoke:docs`.

## Verification
Per-file targeted smokes; independent reviewer on `8669a88..HEAD`; fix or revert failures; `verify.md` line by line.

## Not taken
HANDOFF #4 (test-only); #1 out of stream; V-07/V-08/V-10 no finding list; proposals 05/07/11; two low doc drifts.
