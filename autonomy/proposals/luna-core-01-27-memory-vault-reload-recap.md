# memory-vault: a reload/resume re-injects the first-prompt recap

Cycle 27 scout finding (not fixed this cycle; recorded as a proposal). Stream `core` covers memory
recall and token efficiency.

## Finding

`packages/extensions/src/memory-vault/index.ts:97-106` handles `session_start` for any reason and
unconditionally sets `firstPrompt = true` and clears `injected`. `session_start` fires with reasons
`startup | reload | new | resume | fork`, but the handler ignores `event.reason`. On a reload or a
resume the conversation is still in context, yet the next user prompt takes the first-turn path
(`index.ts:134-137`) and injects `recentRecaps(cfg.root, project, 3)` again as
"### Earlier sessions", plus memories whose once-per-session dedup entry was just cleared.

Evidence: `event` is unused in the handler; the recap block is built whenever `isFirstTurn` is true
and `recaps.length` is non-zero. The recall message is capped (~2400 chars), so a reload can
duplicate up to roughly 600 tokens, and the "Earlier sessions" label is false when the recap is
from the current session.

## Why it is not fixed here

It changes first-turn recall semantics at a session boundary and needs a decision about which
`session_start` reasons should count as a new session (a `reload`/`resume` clearly should not; `new`
and `fork` plausibly should). That is larger than the cycle's budget and touches a documented
behaviour (`docs/memory.md` frames the recap as "the first user prompt"), so it belongs in a
proposal.

## Proposed fix

Gate the reset on the reason: treat `reload` and `resume` as continuation (keep `firstPrompt`
false and `injected` populated) and `startup`/`new`/`fork` as a new session. Test: fire the first
prompt, call `session_start` with `{ reason: "reload" }`, fire the same prompt again, and assert the
second `before_agent_start` emits no second `memory-recall` message for an already-injected recap
or memory. Update `docs/memory.md` with the exact reasons that start a new recap.
