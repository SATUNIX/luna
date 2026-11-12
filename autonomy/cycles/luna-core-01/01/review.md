# Cycle review — luna-core-01 / 01

Base commit: `5a511f35e7d5` (head of `stream/core`, the cycle start). This is cycle 1 of the
current run; the `autonomy/cycles/luna-core-01/01/` records that shipped in the base belong to an
earlier run instance, so this session rewrites them for the current cycle.

Mode: **fix**. Stream area: core (rebrand, memory recall, discoverability, agent efficacy, token
efficiency, defects). Assigned board: PG-55 and PG-67, both P0.

## What was checked (with commands)

- `git status`, `git log --oneline 5a511f35e7d5..HEAD`, `git ls-remote origin`: the branch is clean
  at the cycle-start commit and no cycle work exists yet.
- Read `autonomy/CHARTER.md`, `autonomy/runs/luna-core-01/HANDOFF.md` and this run's proposals.
- Grepped the autonomy package for the two board subjects: `PublishBlocked`, `publishBlocker`,
  `publishBlockedCycles`, `syncIntegration`, `integration_diverged`.
- Read `packages/autonomy/lib/gitmirror.ts`, `lib/templates/self-improve.ts` (seed, `publishNow`,
  `runStep`, `closeCycle`), `lib/unpublished.ts`, `lib/lifecycle.ts`, `cli.ts` status path, and the
  existing `tests/autonomy-selfimprove-smoke.ts` / `tests/autonomy-smoke.ts` coverage.
- Read `docs/autonomy.md` sections "Unpublished work" and the self-improve publication text.

## Findings

### PG-55 — already implemented and pinned on this base (re-verify, no code change)

Every acceptance clause is present in the base:

- State and status: `SelfImproveState.publishBlocker` / `publishBlockedCycles`
  (`lib/lifecycle.ts:219-222`); `publishNow` sets/clears them (`lib/templates/self-improve.ts:234-250`);
  `status` exposes `publishBlocker` and `unpublished` and prints the `publication BLOCKED` line
  (`cli.ts:319,346`).
- Next-cycle prompt: `## Publication blocked (pre-push leak scan)` with the commit and location and
  the "first job" instruction (`lib/templates/self-improve.ts:387-389`).
- Two consecutive blocked merged cycles park the run on a question
  (`lib/templates/self-improve.ts:512-530`), and a clean publish clears all three.
- Pinned by `tests/autonomy-selfimprove-smoke.ts` ("publish range scanning…", "PG-55: a leak-scan
  refused merge is counted…", "two merged cycles…", the answer/stop tests, and the clean-publish
  test around lines 717-1020). `docs/autonomy.md:285-302,700-711` documents the behaviour.

Conclusion: PG-55 is **done**; this cycle re-verifies it with `smoke:autonomy-selfimprove` and does
not change the scan, its patterns or its exceptions.

### PG-67 — reproduced: a diverged destination kills the run instead of reconciling (P0)

`syncIntegration` fetches the destination and compares it with the local integration branch
(`lib/gitmirror.ts:153-167`). When neither side is an ancestor it returns
`{ state: "diverged", head, remote }`. At every cycle start the template turns that into a terminal
failure:

    if (sync.state === "diverged") { engine.go("failed", { reason: "integration_diverged", detail:
    `${branch} at the destination (...) and here (...) have diverged; reconcile them, then start a
    new run` }); return; }

(`lib/templates/self-improve.ts:549`). `FAILURE_REASONS` lists `integration_diverged`
(`lib/lifecycle.ts:41`) and `docs/autonomy.md:1013-1014` states that a diverged branch stops the run.
The run's own contract has no reconciliation step: the operator must notice, reconcile by hand and
start a fresh run, which restarts the cycle counter and abandons the merged-but-unpublished cycles —
exactly the loss reported for `luna-ux-01` (cycle 10 merged green) and `luna-guard-01`. This is an
agent-efficacy defect: a run that dies loses work.

Fix direction (item 1 in `plan.md`): on divergence, mechanically rebase `mergeBase..local` onto the
fetched destination head in a temporary host worktree, move the local integration ref and the cycle
tags in the rebased range, record the reconciliation in state and log, then continue the same cycle.
Only a conflicting rebase parks the run (blocked with an operator question), never `failed`.

### Lower-priority observations (not this cycle)

- `.github/CODEOWNERS:43` names `/packages/core/gitlab-release.ts`, which does not exist; a
  `.github/` edit is out of bounds here (carried in the handoff).
- Broad env-manifest drift is already proposed (`autonomy/proposals/luna-core-01-01-env-manifest-ownership.md`).
- The `V-07/V-08/V-10/V-11` defect IDs still have no in-tree finding list, so they stay
  unactionable without the operator's list (carried in the handoff).

## Verification plan

`smoke:autonomy` (new reconcile unit checks), `smoke:autonomy-selfimprove` (new end-to-end
divergence/conflict checks plus all existing PG-55 checks), `smoke:docs` (docs updated),
`test:typecheck`, targeted `eslint`, derived by `check-all --for-changed`.
