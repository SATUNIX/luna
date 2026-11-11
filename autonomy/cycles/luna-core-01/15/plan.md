# Cycle 15 plan — `luna-core-01`, stream `core`

Mode: **fix**. Board: none assigned. Two in-stream items.

## Item 1 — memory-vault loses first-prompt recall after a custom-message run
Finding: `memory-vault/index.ts:133` clears `firstPrompt` on every `before_agent_start`, but pi fires that
event for a run started by an extension custom message (`BeforeAgentStartCustomEvent`) too. A custom-message
wake before the first user prompt consumes the flag, so the "Earlier sessions" recap and "Pinned memories"
block never reach it. Change: treat "first prompt" as the first *user* prompt; gate the recap/pinned block on
`firstPrompt && "prompt" in event`, clear `firstPrompt` only for a user prompt, and search against the real
prompt text. Test: in `tests/memory-vault-smoke.ts`, send a custom-message `before_agent_start` after
`session_start` and assert it injects nothing; then send the first user prompt and assert "Earlier sessions"
is present (fails today). Docs: update the memory notes and pin with the smoke. Checks: `smoke:memory-vault`,
`test:typecheck`, targeted eslint, `smoke:docs`.

## Item 2 — dead code shown by grep
Finding: `effort/index.ts:838` always-empty ternary; `context-sieve/index.ts:67` two dead ids. Change: drop the
ternary; remove the two ids. Checks: `smoke:effort`, `smoke:ctx-contributions`, `test:typecheck`, targeted
eslint, `smoke:docs`. Behaviour unchanged by construction.

## Verification
Targeted smokes per changed file, then an independent reviewer on the whole diff against the charter and these
items; fix or revert failures. Keep the diff well under 30,000 characters. Not taken: HANDOFF #4 test-env
hardening; V-07/V-08/V-10 need the operator's finding list; #1 out of stream; #2 no action; proposals 05/07/11.
