# Review — cycle 07, run `luna-core-01`, stream `core`

Base: `f0d6ede22af4` (head of `stream/core`, cycle 06 merged). Branch `pi/luna-core-01`.
Charter read in full (`autonomy/CHARTER.md`). No `refs/upstream/trunk` exists (priority 1 clear).

## Assigned board items

### PG-27 [P0] — Record the eval baseline the scoreboard has been missing

**Finding: already done and merged by cycle 06; no work needed this cycle.**

Cycle 06 implemented exactly the acceptance: `packages/core/eval/baseline.ts` (`--write` spawns
`run.ts --json` and writes a dated `baselines/YYYY-MM-DD.json` with success rate, per-category
stats and an offline chars/4 `tokens` estimate labelled `tokensBasis`; `--check` fails closed when
the newest record is missing, malformed or older than 7 days measured from the embedded date, never
mtime). The first artifact `packages/core/eval/baselines/2026-11-11.json` is committed, and
`tests/eval-baseline-smoke.ts` + `smoke:eval-baseline` pin it.

Verified now on the cycle base:

```
$ node packages/core/eval/baseline.ts --check
[eval-baseline] eval baseline 2026-11-11.json is 0 day(s) old, within 7 days   (exit 0)
$ node tests/eval-baseline-smoke.ts
  OK: summariser, canonical text, token estimate and the usage gate
[eval-baseline-smoke] all 4 checks passed
$ cat packages/core/eval/baselines/2026-11-11.json   # successRate 1, 17/17, per-category, tokens 256
```

The stream prompt still lists PG-27 because the steward board was snapshotted before cycle 06
merged. Record it `done - no work needed`, as cycle 06 did for PG-10.

### PG-51 [P0] — Timing assertions in the smokes fail on a busy host

**Finding: reproduced, root cause located, fix designed and evidenced.**

Several smokes assert a wall-clock bound. On a host running other gates the process is preempted,
wall time inflates ~4–9x, and a correct implementation fails its own linear-time guard — discarding
the whole cycle.

Reproduction (12 CPU burners on this 12-core host, `node tests/<name>-smoke.ts`):

```
tests/firewall-gate-smoke.ts:592
  AssertionError: redact on 200 KB of "a-" took 799 ms        (budget 200 ms)

tests/redaction-corpus-smoke.ts:157-168
  + 'table, curl -u without a password: 1854 ms'              (budget 1000 ms)

tests/env-isolation-smoke.ts:312
  assert.equal(result.status, 0, "tests/firewall-gate-smoke.ts must pass …")
  actual 1 !== 0    # it spawns firewall-gate-smoke as a child at line 307, so it fails downstream
```

`tests/workflow-redaction-smoke.ts:131-149` uses best-of-three plus a ratio (already partly
load-tolerant) but still relies on wall clock for the growth factor and the 2 s per-input bound.

Root cause: the guards measure wall-clock time (`performance.now` / `Date.now`). Wall time includes
time the process spent descheduled, which the operation does not control.

Measured fix (same 200 KB inputs, `process.cpuUsage()` around the same `canonical.redact` calls):

```
                       idle      under 12 burners
  "x_token"            4.0 ms     5.8 ms
  "a-"                23.5 ms    35.6 ms
  "curl -u "          62.5 ms    95.4 ms
```

CPU time is stable at ~1.5x inflation, far inside the existing 200/1000 ms budgets, while a
catastrophic-backtracking rule still consumes unbounded CPU. So the property the bound protects
(a quadratic redaction fails) is kept, and the scheduler load is ignored — exactly the tradeoff the
board allows ("measure CPU time of the operation where the runtime allows it").

Every wall-clock assertion found in `tests/` (grep `performance.now|Date.now\(\)`, each asserting on
elapsed time):

| file | line | bound | protects |
|------|------|-------|----------|
| firewall-gate-smoke.ts | 592 | 200 ms / 200 KB | linear redaction |
| redaction-corpus-smoke.ts | 157-168 | 200 / 1000 ms / 1 MB | linear redaction (7 shapes) |
| workflow-redaction-smoke.ts | 147,149 | ratio + 2000 ms | linear redaction |
| save-smoke.ts | 227 | 200 ms | linear redaction |
| tool-firewall-smoke.ts | 489 | 2000 ms | linear neutralise |
| workflow-plan-smoke.ts | 1238,1289 | 300 / 150 ms | linear template, bounded plan |
| skill-routing-smoke.ts | 86 | 2000 ms | slow trigger switched off |
| compress-smoke.ts | 288 | 2000 ms | bounded compression |

These are the CPU-bound `S` guards; they are the ones this cycle converts. The wait-bound
assertions (`Date.now() - t < 2500` around a timer/deadline in firewall-outcomes/unattended/noeffect,
memory-vault, web-console) and `clean-install-smoke.ts:131`'s 90 s child answer bound protect a hang,
not CPU work; CPU time is the wrong unit for them and their headroom (a ~150 ms wait checked at
2500 ms) is already ~16x. They are listed here for completeness and left unchanged.

Acceptance requires a script that runs each changed smoke five times under a full CPU load. No such
script exists (`grep -rn "CPU burner\|load-tolerant" tests/` finds nothing).

## New problems / other candidates

- No new defect found in a bounded scan of the assigned area; the cycle is already near the diff
  budget after the previous improvement, so no unrelated items are pulled in.
- Carry-overs from `HANDOFF.md` remain as recorded (npm/trunk test pending npm delivery; cycle 03
  env-ownership on an attempt branch; CODEOWNERS dead path is operator-controlled; V-07/V-08/V-10
  need the operator's finding list; owner-side `coverage` job). None blocks PG-51.

## Mode

**Fix mode.** PG-51 repairs a reproduced reliability defect (a load-sensitive assertion that turns a
correct change red). PG-27 is already done and is recorded, not re-implemented.
