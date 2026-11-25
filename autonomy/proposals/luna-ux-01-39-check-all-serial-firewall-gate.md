# Run `smoke:firewall-gate` alone in `check-all`

Status: proposal for the owner/steward route. Cycle 38 attempted this as a direct change and the
host refused it as R3 (gate policy: `packages/core/check-all.ts`). This file carries that finding
forward; nothing here is applied.

## Evidence

The host gate runs `check:all --jobs=<cpu quota>`. With 16 checks in flight,
`tests/firewall-gate-smoke.ts` failed its own guards while the same code passed alone:

- growth guard `redact, "mysql "`: 9.10 ms at 51 KB, 115.15 ms at 205 KB (limit 91 ms).
- absolute guard `redact on 200 KB of "curl -u "`: 227 ms of CPU against a 200 ms budget.
- Reproduced by starting eight copies of the smoke together: 3 of 8 runs failed.

## Root cause

The redaction routine is linear. The guards measured work on a machine shared with other
CPU- and memory-heavy checks, so both the wall-clock growth ratio and (under heap pressure) the
measured thread's CPU time inflated.

## Proposed change

Add `smoke:firewall-gate` to the `SERIAL` map in `packages/core/check-all.ts` with the observed
contention as its stated reason, and assert the entry in `tests/check-all-npm-smoke.ts`. `SERIAL`
already exists for exactly this class of check; no test is weakened.

## Relationship to cycle 39

Cycle 39 repaired the measurement itself: `assertSubQuadratic` now defaults to CPU time
(`tests/perf-budget.ts`) and the tight absolute budget takes best-of-five samples
(`tests/firewall-gate-smoke.ts`). That should remove the reported flake without a scheduler
change. This proposal remains as defence in depth if the host still observes contention-induced
failures; the owner decides, because scheduling is gate policy.
