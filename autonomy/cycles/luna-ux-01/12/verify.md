# Cycle 12 — Verify (run `luna-ux-01`, stream `ux`)

Base `7647d1b2f347` (head of `stream/ux`), branch `pi/luna-ux-01`, code head `2ee1e3f` before
this record commit. `npm test` and `npm run check:all` were not run, per the cycle rules.

## Red gate (priority 0)

Cycle 11 was not merged because `tests/docs-smoke.ts` failed on its attempt branch:

```text
node tests/docs-smoke.ts
AssertionError: autonomy/JOURNAL.md disagrees with the cycle reports
+ 'report with no journal entry: luna-ux-01/11; add: - luna-ux-01/11 | Board: ...'
```

The cycle 11 code was cherry-picked unchanged (`faa6c2b`, `7394173`, `9dbd71c`), the journal
line added, and its `- Board:` bullets changed to `Board:`. `node tests/docs-smoke.ts` now exits
0, and `git diff origin/attempts/luna-ux-01/cycle-11 HEAD -- packages docs tests` showed only
this cycle's intended changes.

## V-02 — console cards serialised and ask_human holds

The console checked `inputHeld()` but never held, so two pending files in one scan opened two
cards; the second stole focus. The fix takes the hold synchronously before the first `await` in
`processOne` (`index.ts:457`) and `processRunApproval` (`:387`), releases before `askToResume`,
and re-checks then holds inside `askToResume` (`:345`) and `ask_human` (`:535`). `session_shutdown`
calls `releaseInputHolds()`.

Negative runs, source reverted with `git checkout 205590d -- packages/extensions/src/human-console/index.ts`:

```text
npm run smoke:firewall-overlay-queue
  FAIL: two child approvals in one scan open one card at a time
  FAIL: ask_human holds input so a console card does not open over it
  FAIL: two run approvals in one scan open one card at a time
  [firewall-overlay-queue-smoke] exit 1
```

At HEAD the same suite passes 35/35. The cases also assert the notice text
(`close the open console card to see it`, never `close human-console`) and that the console
request keeps its pending file while the question card is open, then is asked after it closes.

## Checks (all exit 0)

| check | result |
| --- | --- |
| `smoke:firewall-overlay-queue` | all 35 checks passed |
| `smoke:control-center` | all 34 checks passed |
| `smoke:command-menu` | all 12 checks passed |
| `smoke:workflow-panel` | all 14 checks passed |
| `smoke:human-console-broker` | OK |
| `smoke:human-console-auth` | all 8 checks passed |
| `smoke:update-notice` | all 8 checks passed |
| `smoke:launch-screen` | all 11 checks passed |
| `smoke:docs` | OK: 14 documented commands, 62 relative links |
| `test:typecheck` | exit 0 |
| `test:lint` | exit 0 |

## Review verdicts

- First whole-diff reviewer: found the hold label `human-console` was interpolated into notices
  as "close human-console", and that `ask_human` took no hold (reverse direction). Both fixed in
  `f2767e2`/`7a52139`; the reviewer's other finding (no test for the run-approval hold) is fixed
  in `2ee1e3f`.
- Second whole-diff reviewer (`reviewer` subagent, read-only): **PASS**. It confirmed the holds
  are synchronous before the first `await`, no hold wraps a `showWhenFree`, shutdown releases,
  labels are actionable on every path, and the two new cases fail without their source change.
  Its remaining warnings were addressed: the ask_human assertions moved inside `try`, a
  two-run-approval case added, the held-notice sentence tightened, and `CHANGELOG.md` updated.
- pi-lens reports four pre-existing findings in `index.ts` (`Reflect.get/apply`, `unknown`
  return, unguarded `JSON.parse`) on lines this cycle did not change; `test:lint` exits 0.

## Scope

`git diff --no-renames 7647d1b2f347..HEAD -- . ":(exclude)package-lock.json"
":(exclude)autonomy/cycles/luna-ux-01/" ":(exclude)autonomy/runs/luna-ux-01/" | wc -c` →
**40296** characters including this cycle's records, over the 30000 stop line but under the
60000 review budget. No `package.json` `scripts`, `autonomy/CHARTER.md`, control path, credential
or release change.
