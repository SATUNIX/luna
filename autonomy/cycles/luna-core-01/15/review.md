# Cycle 15 review — `luna-core-01`, stream `core`

Base `a0ded595f7bc` clean; charter read; no assigned board items; cycle 14 (fix) merged.

## Carry-overs checked
- #9 dead code: `effort/index.ts:838` always-empty ternary `${s.pinned && s.source !== "env" ? "" : ""}`;
  `context-sieve/index.ts:67` `DYNAMIC_IDS` names `memory-vault`/`skill-router`, but no extension writes
  either id (producers: autonomous-loop, conductor, goal-core, guidelines, memory-local, orchestrator,
  progress-guard, recovery-orchestrator). Evidenced, small, safe.
- #3 memory-vault: `memory-vault/index.ts:133` clears `firstPrompt` on every `before_agent_start`, including
  an extension custom message (pi `BeforeAgentStartCustomEvent`, no `prompt`), so the real first user prompt
  loses recap/pinned recall. In-stream; type at `/opt/pi-tools/.../core/extensions/types.d.ts:736`.
- #4 `tests/orchestrate-commands-smoke.ts` does not clear `PI_KIT_INTERNAL_CHILD`; test robustness only,
  deferred. #1 firewall timing out of stream; #2 no action; V-07/V-08/V-10 lack a finding list.

## New defects
None after reading the three modules and the offline harness. No red gate. Decision: **fix mode**; take the
memory-recall defect and dead-code cleanup, defer test-env hardening.
