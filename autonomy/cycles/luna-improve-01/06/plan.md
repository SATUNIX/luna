# Cycle 06 plan — luna-improve-01

Mode: **fix**. Objective: correct the cycle records so they account for the whole diff against
`integration/luna`, per the operator's authoritative steering. No source, test, or config change.

## Items

1. **List every commit in `integration/luna..HEAD`, one line each, marking the PR #29 copies.**
   - Justification: charter priority 1 (broken pushed state) and priority 2 (carried work); the
     cycle-04 refusal was exactly this mismatch.
   - Change: `autonomy/cycles/luna-improve-01/06/report.md` lists all ten existing commits plus this
     cycle's record commit, with the five PR #29 commits marked
     `carried from main PR #29, identical to main`.
   - Evidence: `git log a385401..HEAD --oneline --name-only`.
2. **State the true `git diff --stat`.**
   - Justification: the merge review compares the report to the diff; the stat must be the real one,
     including this cycle's record files.
   - Change: the report quotes `git diff a385401..HEAD --stat` verbatim.
   - Evidence: the command's own output, re-run after this cycle's record commit.
3. **Justify keeping `tests/firewall-unattended-smoke.ts`.**
   - Justification: the operator's third correction requires keeping it; the charter forbids loosening
     a test, so the record must show it is not loosened.
   - Change: a report section explains `realWhy` chooses the expected refusal reason by
     `currentNamespaceStanding().initialUser`, that both cases still assert a specific refusal and
     `active === false`, and that main's PR #29 made the same change.
   - Evidence: `git show 14d43dd`, `tests/firewall-unattended-smoke.ts:599`.
4. **No other new work; do not run `check:all`.**

## Checks

- `git diff a385401..HEAD --stat` matches the stat printed in the report.
- `git log a385401..HEAD --oneline` matches the commit list in the report; the PR #29 marker is on
  exactly the five carry commits.
- Independent `reviewer` subagent reads the report against the diff and the charter and returns PASS.
- The full acceptance gate is the supervisor's, run on the pushed head; per steering it is not run
  in this session.
