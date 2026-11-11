# Cycle 13 — Verify (run `luna-ux-01`, stream `ux`)

## What was checked

The re-landed cycle 11/12 code plus the new run-card exception. Targeted checks only; `npm test`
and `npm run check:all` are left to the host gate.

| Check | Result |
| --- | --- |
| `npm run smoke:firewall-workflow-approvals` | 10/10 cases pass, including `two prompts at most are open for one run` (`tests/firewall-workflow-approvals-smoke.ts:140`) |
| `npm run smoke:firewall-overlay-queue` | 35/35 checks pass, including the new run-card case at `tests/firewall-overlay-queue-smoke.ts:867` |
| `npm run smoke:firewall-approvals` | 13/13 checks pass |
| `npm run smoke:human-console-auth` | 8/8 checks pass |
| `npm run smoke:human-console-broker` | OK |
| `npm run smoke:autonomy-gate-overlay` | 5/5 checks pass |
| `npm run smoke:control-center` | 34/34 checks pass (re-landed overlay/`/kit` work) |
| `npm run smoke:command-menu` | 12/12 checks pass (re-landed `/kit` work) |
| `npm run smoke:docs` | passes after the cycle 13 journal line and reports |
| `npm run test:typecheck` | exit 0 |
| `npm run test:lint` | exit 0 |

## Red-gate reproduction

On a clean worktree of `origin/attempts/luna-ux-01/cycle-12`,
`node tests/firewall-workflow-approvals-smoke.ts` failed at `:140` with
`AssertionError: two prompts at most are open for one run` (`1 !== 2`). The same worktree timed
out waiting for the `wf-f` resume question. Both pass on this branch. Without the `openRunCards`
change, the new overlay case sees only one run card open; on the cycle-12 attempt it sees the
second run card blocked by the global hold. On the base, cases 24b/24c fail because non-run cards
and `ask_human` do not hold input at all. The three behaviours are therefore pinned in both
directions.

## Independent review

A reviewer subagent that wrote none of the change read the whole diff against
`autonomy/CHARTER.md`, `review.md` and `plan.md`. Verdict: **PASS**. It found no critical issue and
confirmed the run-card repair, the broker's two-slot contract, the non-run hold, the tests, the
docs and the absence of forbidden edits. Its one substantive warning — `docs/security.md` and
`docs/autonomy-gate.md` said "non-run cards" when the resume question and `ask_human` keep their
own overlays — was fixed in `0992f63`; the two cosmetic test-comment renumberings were left alone
to keep the diff scoped.

## Scope and budget

- Diff from `7647d1b2f347`: **44307 characters** (lockfiles and this run's cycle/run record
  directories excluded), under the 60000 merge-review budget but over the 30000 stop-new-items
  line. No new board item was started for that reason.
- No changes to `autonomy/CHARTER.md`, operator control paths, or any `package.json` `scripts`.
- PG-09 (`pi-autonomy inbox`) is **blocked** on the diff budget, not attempted.
