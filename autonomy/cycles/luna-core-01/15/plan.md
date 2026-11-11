# Cycle 15 plan — `luna-core-01`, stream `core`

Mode: **fix**. Board: none assigned. Two items, both in-stream.

## Item 1 — memory-vault loses first-prompt recall after a custom-message run

Finding: `packages/extensions/src/memory-vault/index.ts:133` sets `firstPrompt = false` on every
`before_agent_start`, but pi fires that event for a run started by an extension custom message
(`BeforeAgentStartCustomEvent`) as well as a user prompt. The code's own comment on line 134
admits custom-message runs exist. A custom-message wake before the user's first prompt consumes
the flag, so the "Earlier sessions" recap and "Pinned memories" block never reaches the first
user prompt — the primary continuity feature of the memory stream.

Change: treat "first prompt" as the first *user* prompt. Guard the recap/pinned block with
`firstPrompt && "prompt" in event`, clear `firstPrompt` only for a user prompt, and search against
the real prompt text. Test: in `tests/memory-vault-smoke.ts` (section 5+6), after `session_start`
send a custom-message `before_agent_start` and assert it injects nothing; then send the first user
prompt and assert the "Earlier sessions" history is still present (currently fails). Docs: the
behaviour is described in `docs/` memory notes — check and pin with the smoke.

Checks: `npm run smoke:memory-vault`, `npm run test:typecheck`, targeted eslint, `npm run smoke:docs`.

## Item 2 — dead code shown by grep

Finding: `packages/extensions/src/effort/index.ts:838` has an always-empty ternary
`${s.pinned && s.source !== "env" ? "" : ""}` — the condition is evaluated and discarded, and the
status line it was meant to decorate never changes. `packages/extensions/src/context-sieve/index.ts:67`
lists `memory-vault` and `skill-router` in `DYNAMIC_IDS`, but neither ever writes a
ctx-contribution (producers are `autonomous-loop`, `conductor`, `goal-core`, `guidelines`,
`memory-local`, `orchestrator`, `progress-guard`, `recovery-orchestrator`).

Change: drop the empty ternary; remove the two dead ids. Test: extend the context-sieve smoke if one
exists; otherwise `smoke:docs`/`test:typecheck` plus the existing `smoke:effort` and any
context-sieve coverage. Behaviour is unchanged by construction.

Checks: `npm run smoke:effort`, `npm run test:typecheck`, targeted eslint, `npm run smoke:docs`.

## Verification

Run the targeted smokes for every changed file, then an independent reviewer on the whole diff
against the charter and these items. Fix or revert anything that fails. Keep the reviewable diff
well under 30,000 characters (it is a handful of lines).

## Not taken

- HANDOFF #4 orchestrate-commands test-env hardening (test robustness only).
- V-07/V-08/V-10 need the operator's finding list; #1 is out of stream; #2 no action.
- Proposals 05/07/11 remain operator decisions.
