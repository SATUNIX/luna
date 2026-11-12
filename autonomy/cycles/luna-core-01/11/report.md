# Report — cycle 11, run `luna-core-01`, stream `core`

Outcome: successful
Mode: fix

Base `d5c2cffe6d06` (head of `stream/core`, holds cycles 01–10). No assigned board items; the cycle
carried the first HANDOFF carry-over and fixed one evidenced defect. Reviewable diff 23,627 chars at
`6c98e36` (records excluded).

## Items

Item: Carry the PG-51 thread-scoped CPU timing guards onto this base - `822fcc8` (with `7ec19bf` review+plan) - `tool-capture-smoke` 14, `trace-ledger-bound-smoke` 5, `workflow-redaction-smoke` 4, `workflow-structured-smoke` 7, `workflow-sandbox-smoke` 19; `timing-load-check` 53/55 (the two failures are a guard not in this diff, see below)
Item: Make `/compress` charge the omission marker and the conversation newline to the budget so the summary always fits - `6c98e36` - `compress-smoke` 9/9 including new `testBudgetReservesOmissionMarker` (4047 > 4000 before, 3995 after)

Workflow: refused — the E3 child allowance (3/3) was spent before Item B's reviewer and before the
plan step, so Item B was implemented by a bare `subagent` implementer and reviewed by the
coordinator directly; `workflow_run` and `subagent` both refused further children.

## What was done

**PG-51 (carry-over).** Applied the cycle-08 tests-only range from
`origin/attempts/luna-core-01/cycle-08`. `tests/timing.ts`'s `cpuMs()` now reads the calling
thread's CPU (`process.threadCpuUsage()`, with a `process.cpuUsage()` fallback on older Node), so
worker-thread CPU no longer pollutes a timing window; the `workflow-redaction` guard is best-of-nine
and warms both sizes, and the load harness lists only CPU-bound smokes (the sandbox smoke is
excluded with its reason: it still asserts wall-clock watchdogs). Root cause: process-wide CPU made
a linear 200 KB redaction read as quadratic under load. No product code changed.

**`/compress` budget (defect).** `packages/extensions/src/compress/index.ts` sized `fixed` from five
elements but the final summary joins up to six (`previous` adds a separator) and the ~45-char
omission marker was never subtracted from `remaining`. With a small residual budget and a
`previousSummary` the summary was 4047 against a 4000 budget, contradicting the README's "fits".
The fix charges `## Conversation\n` to `fixed` and reserves the marker and its separator before the
older-turns loop; turn priority is unchanged. One smoke case added.

## Verification

All targeted checks green; `npm test` and `npm run check:all` were never run. Item A was reviewed by
a strict `subagent` reviewer (`VERDICT: PASS`). Item B had no independent reviewer (allowance
exhausted) and needs one at merge review. See `verify.md`.

**Harness shortfall (recorded, not fixed).** The full `node tests/timing-load-check.ts` reports 53/55
on this host: `firewall-gate-smoke.ts` failed twice with
`redact on 200 KB of "curl -u " took 219 ms of CPU (budget 200 ms)`. That guard is not in this
cycle's diff and keeps best-of-three; measured alone under load it reads 95 ms, so the failure is
aggregate contention noise. The commit message's "55/55" is therefore not reproducible and this
record supersedes it. Proposal:
`autonomy/proposals/luna-core-01-11-load-guard-firewall-noise.md`.

## Left for the next cycle

- Stale `session_start` "wipe" docs (`docs/capability-research-workflow.md:45-48`,
  `third_party/caveman/index.ts:194`) — the code is mtime-scoped (priority 6).
- Dead code: `effort/index.ts:838` no-op ternary; unreachable `DYNAMIC_IDS` in
  `context-sieve/index.ts:67` (priority 7).
- V-07/V-08/V-10 still need the operator's in-tree finding list.
- `luna-core-01-11-load-guard-firewall-noise.md` (firewall-gate guard noise).
- The standing operator-decision proposals (`-01`, `-05`, `-07`, `-08`) and cycle-08's
  attempt-only records.

## Notes

No board items were assigned, so no `Board:` lines. One logical change per commit; both pushed.
