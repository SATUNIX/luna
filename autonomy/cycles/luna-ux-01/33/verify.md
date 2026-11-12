# Cycle 33 — Verification (run `luna-ux-01`, stream `ux`)

Item: run-card input hold (V-02), carry-over. Code head reviewed: `1a34f8f`; base
`3925c17a2485`. DE-98 was re-verified against HEAD with no change.

## Checks

| Check | Result | Proving line |
| --- | --- | --- |
| `npm run smoke:firewall-workflow-approvals` | PASS | `firewall-workflow-approvals smoke passed` (includes new case 2g) |
| `npm run smoke:firewall-overlay-queue` | PASS | `[firewall-overlay-queue-smoke] all 36 checks passed` (case 24d two-card pin and new 24e) |
| `npm run smoke:tui-layout` | PASS | `tui-layout-smoke: 4 checks passed` (DE-98 fixture) |
| `npm run smoke:docs` | PASS | `[docs-smoke] OK: 14 documented commands validated, 62 relative links resolved ...` |
| Typecheck | PASS | reviewer: both `tsc -p` projects exit 0 |
| Lint | PASS | reviewer: `eslint --max-warnings 0` on the changed files exits 0 |
| Base-vs-head test proof | PASS | reviewer traced 2g (`firewall-workflow-approvals-smoke.ts:326`) and 24e (`firewall-overlay-queue-smoke.ts:925`) to fail on HEAD, pass on the fix |
| Diff size (non-record, no lockfile) | PASS | 17791 characters before records, below the 30,000 stop-new-work threshold |

The full suite (`npm test`, `npm run check:all`) was not run; the host gate owns it.

## Independent review

First reviewer round returned `VERDICT: FAIL`: the `ask_human` half had no regression test, plus
two warnings (no wait notice, stale comment). The implementer added case 24e, one-shot notices and
the corrected comment; the same checks re-ran green. A fresh `reviewer` subagent that did not write
the change then reviewed `git diff 3925c17a2485..HEAD` against `autonomy/CHARTER.md` and the plan:
it confirmed run cards stay outside the shared registry (24d's `inputHeld() === undefined` pin
holds), both prompt paths fail closed and do not deadlock (`pauseAnswered` still in `finally`), both
new tests would fail on HEAD and are deterministic, `docs/security.md` matches, and no unrelated
file or script changed. `VERDICT: PASS`, no critical finding.

## Changed-test justification

No existing assertion was weakened or deleted (the test diffs add cases only). Case 2g answers the
11th distinct approval while the broker's 12th card is open; case 24e times out an `ask_human`
behind two open run cards. Both fail on HEAD and pass with the fix.
