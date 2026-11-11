# Cycle 15 review — `luna-core-01`, stream `core`

Base `a0ded595f7bc` clean; charter read; no assigned board items; cycle 14 (fix) merged.

## Carry-overs checked

- HANDOFF #9 dead code: `effort/index.ts:838` is an always-empty ternary
  (`...${s.pinned && s.source !== "env" ? "" : ""}`), so `s.pinned` is read and thrown away;
  `context-sieve/index.ts:67` `DYNAMIC_IDS` lists `memory-vault` and `skill-router`, but no
  extension writes a ctx-contribution with either id (producers from `grep 'id: "'`:
  `autonomous-loop`, `conductor`, `goal-core`, `guidelines`, `memory-local`, `orchestrator`;
  `progress-guard`/`recovery-orchestrator` via `CONTRIB_ID`). Two dead set entries. Evidenced,
  small, safe.
- HANDOFF #3 memory recall defect: `memory-vault/index.ts:133` clears `firstPrompt` on every
  `before_agent_start`, including a run started by an extension custom message (pi
  `BeforeAgentStartCustomEvent`, no `prompt`). The reCAP/pinned "first prompt" recall is then
  lost for the real first user prompt. In-stream (memory recall). Evidenced by the type at
  `/opt/pi-tools/.../core/extensions/types.d.ts:736` and the code's own comment at line 134.
- HANDOFF #4 `tests/orchestrate-commands-smoke.ts` does not clear `PI_KIT_INTERNAL_CHILD`;
  test-robustness only, deferred.
- #1 firewall timing noise (out of stream); #2 cycle-08 records (no action); V-07/V-08/V-10 still
  have no in-tree finding list; proposals 05/07/11 unchanged.

## New defects found

None beyond the carry-overs above after reading `memory-vault`, `context-sieve`, `effort` and the
offline harness. No red gate: HEAD is `a0ded595f7bc`, tree clean, all cycle-14 checks previously
green.

Decision: **fix mode**. Take the memory-recall defect (priority 4) and the evidenced dead-code
cleanup (priority 7) as two small, tested commits. Defer the test-env hardening.
