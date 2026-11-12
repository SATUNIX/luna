# Verify — cycle 11, run `luna-core-01`, stream `core`

Base `d5c2cffe6d06` (head of `stream/core`). Cycle commits: `7ec19bf` (review + plan), `822fcc8`
(Item A), `6c98e36` (Item B), plus the records commit.

## Reviewable diff

`git diff --no-renames d5c2cffe6d06..HEAD -- . ":(exclude)package-lock.json"
":(exclude)autonomy/cycles/luna-core-01/" ":(exclude)autonomy/runs/luna-core-01/" | wc -c`

Measured **23,627 chars** at `6c98e36` (records excluded by the pattern). Under the 60,000 read
budget; new items stopped once it passed the 30,000 mark (it did not). Changed source/test files:
`tests/timing.ts`, `tests/timing-load-check.ts`, `tests/tool-capture-smoke.ts`,
`tests/trace-ledger-bound-smoke.ts`, `tests/workflow-redaction-smoke.ts`,
`tests/workflow-sandbox-smoke.ts`, `tests/workflow-structured-smoke.ts`, `CHANGELOG.md`
(Item A), `packages/extensions/src/compress/index.ts` + `tests/compress-smoke.ts` (Item B). No
lockfile, `package.json` `scripts`, charter, or operator control path changed.

## Item A — PG-51 thread-scoped CPU timing guards (`822fcc8`)

Applied the cycle-08 tests-only range; `cpuMs()` now reads `process.threadCpuUsage()` with a
`process.cpuUsage()` fallback. Checks (all PASS):

| Check | Result |
| --- | --- |
| `node tests/tool-capture-smoke.ts` | 14 checks passed |
| `node tests/trace-ledger-bound-smoke.ts` | 5 checks passed |
| `node tests/workflow-redaction-smoke.ts` | 4 checks passed |
| `node tests/workflow-structured-smoke.ts` | 7 checks passed |
| `node tests/workflow-sandbox-smoke.ts` | 19 checks passed |
| `node tests/timing-load-check.ts` | 53/55 runs passed — see below |

`workflow-sandbox-smoke` failed once with `'idle' !== 'timeout'` on the microtask-loop watchdog;
that is the known load flake (proposal `luna-core-01-08`). It passed after cleaning up orphan CPU
burners left by an earlier background `timing-load-check.ts` run (12 processes saturated the host);
it is not caused by this change.

**Harness shortfall.** The full load harness reports **53/55**, not 55: `firewall-gate-smoke.ts`
run 1/5 and 5/5 failed with `redact on 200 KB of "curl -u " took 219 ms of CPU (budget 200 ms)`
(`tests/timing.ts:72`). That guard is **not** in this cycle's diff (it keeps best-of-three while
`workflow-redaction-smoke.ts` was moved to best-of-nine). Measured alone under twelve burners the
same guard reads 95 ms best-of-three and process-wide CPU 97 ms, so the 219 ms is aggregate
contention noise. Written up in `autonomy/proposals/luna-core-01-11-load-guard-firewall-noise.md`.
The harness is not part of `check:all`, so the gate is unaffected; the commit message's "55/55" is
therefore not reproducible on this host and this record supersedes it.

## Item B — `/compress` budget overrun (`6c98e36`)

`fixed` now charges `## Conversation\n`, and the omission marker (~45 chars) plus its separator are
reserved before the older-turns loop, so `summary.length <= lim.budget`. Reproduced: 100 turns and
a 120-char previous summary at budget 4000 gave **4047** before, **3995** after.

| Check | Result |
| --- | --- |
| `node tests/compress-smoke.ts` | 9/9 passed, includes new `testBudgetReservesOmissionMarker` |

## Independent review

Item A: a strict `subagent` reviewer returned `VERDICT: PASS` (its only warning — `workflow-
structured-smoke.ts` keeps two wall-clock cut-off guards despite joining the load harness — is the
deliberate `Date.now()`-deadline case documented in `tests/timing.ts:19-24`).

Item B: **no independent reviewer was dispatched.** The E3 child allowance for this request was
already spent (3/3), and `workflow_run` and `subagent` both refused; per the fallback the
coordinator reviewed the diff directly (correct accounting, only the two intended files changed,
message states finding/root cause/fix/verification). This cycle's Item B therefore still needs an
independent pass at merge review.

## Checks run (never `npm test` or `npm run check:all`)

| Check | Result |
| --- | --- |
| `node tests/compress-smoke.ts` | 9/9 passed |
| `node tests/tool-capture-smoke.ts` | 14 checks passed |
| `node tests/workflow-structured-smoke.ts` | 7 checks passed |
| `node tests/workflow-sandbox-smoke.ts` | 19 checks passed (after burner cleanup) |
| `node tests/trace-ledger-bound-smoke.ts` | 5 checks passed |
| `node tests/workflow-redaction-smoke.ts` | 4 checks passed |
| `node tests/docs-smoke.ts` | green (journal gate included) |
| `node tests/timing-load-check.ts` | 53/55 — failure documented above |

## Charter and scope

One logical change per commit with finding, root cause, fix and verification. No new dependency. Docs
and tests accompany every behaviour change. No mergeable-path violation.
