# Cycle plan — luna-core-01 / 01

Mode: **fix**. Base `5a511f35e7d5`. One board item needs a change; the other already holds and is
re-verified. One logical change per commit; every commit pushed.

Goal: stop a run dying with `integration_diverged` when the published integration branch has moved
under it; reconcile mechanically and keep the cycle counter.

## Item 1 — PG-67: reconcile a diverged integration branch instead of failing the run

Evidence: `packages/autonomy/lib/gitmirror.ts:153-167` detects divergence; the cycle start turns it
into a terminal `failed`/`integration_diverged` (`lib/templates/self-improve.ts:549`), and
`docs/autonomy.md:1013-1014` documents that death. Both reported runs (ux-01, guard-01) lost merged
cycles and restarted their counters.

Change:

- `lib/gitmirror.ts`: add `reconcileIntegration(g, cfg, divergence)` that fetches nothing new (the
  sync already fetched `refs/integration/remote`), creates a temporary host worktree at the local
  integration head, runs `git rebase --rebase-merges --onto <remote> <mergeBase> <local>` with the
  run identity and hooks disabled, updates the integration ref to the rebased head, moves the
  cycle/abandoned tags whose commits were rewritten to their new equivalents (only when the old and
  new commit ranges pair one-to-one), and removes the worktree. Returns `reconciled` with the old
  head, new head, destination head, commit count, tag count and the old→new mapping, or `conflict`
  after aborting the rebase. No network beyond the destination the sync already contacted.
- `lib/templates/self-improve.ts`: on `sync.state === "diverged"`, call `reconcileIntegration`
  before the cycle is numbered. On success, log the reconciliation, rewrite the recorded cycle
  heads (`history[].head`/`start`, `lastGoodSha`, `current.startSha`) through the mapping, append a
  `reconciliations` entry to `state.selfImprove` (at, old/new/destination head, commits, tags), save,
  and continue from the reconciled head (publish follows as today). On conflict, `enterBlocked` with
  a question naming the branch and short shas (options: reconcile by hand and resume, or stop) —
  never `failed`.
- `lib/lifecycle.ts`: type the optional `SelfImproveState.reconciliations` record.
- `docs/autonomy.md`: replace "a diverged branch stops the run as integration_diverged" with the
  reconciliation behaviour, and describe the blocking question when the rebase conflicts.
- Tests:
  - `tests/autonomy-smoke.ts` (fixture bare remote): a diverged local integration branch whose
    local commits rebase cleanly is reconciled onto the destination, the destination is an ancestor
    of the new head, and a subsequent `publish` succeeds and pushes the reconciled head; a
    conflicting local change returns `conflict`, aborts cleanly and leaves the ref unchanged; the
    existing strict-ancestor fast-forward assertions stay green.
  - `tests/autonomy-selfimprove-smoke.ts`: a scripted run whose destination moves between cycles in
    a non-conflicting way continues with the next cycle number and publishes the reconciled head
    (cycle counter kept); a conflicting move parks the run `blocked` with an
    `integration-diverged` question instead of a `failed` run.

Proving checks: `npm run smoke:autonomy`, `npm run smoke:autonomy-selfimprove`, `npm run
smoke:autonomy-cli`, `npm run smoke:docs`, `npm run test:typecheck`, targeted `eslint` over the
changed files.

## Item 2 — PG-55: re-verify (no code change expected)

Run `npm run smoke:autonomy-selfimprove`, which pins every acceptance clause: status carries
`publishBlocker` and the unpublished count, the next prompt names the commit and location (never the
value), the run parks after the second blocked merged cycle, and a clean publish clears all three.
Report `Board: PG-55 done` with the command evidence if it holds; if a clause fails, fix that clause
in a follow-up commit before the cycle ends. Do not change the scan, its patterns or its exceptions.

## Checks to run (targeted only — never `npm test` / `npm run check:all`)

Derived after the edits with
`node packages/core/check-all.ts --for-changed="$(git diff --name-only 5a511f35e7d5..HEAD | tr '\n' ',')"`;
expected: `smoke:autonomy`, `smoke:autonomy-selfimprove`, `smoke:docs`, `test:typecheck`, `test:lint`
(or targeted eslint), plus `smoke:autonomy-cli` because `cli.ts` reads the state.

## Task graph

1. Item 1 implement + commit + push (one commit: code, tests, docs).
2. Item 2 re-verify with the self-improve smoke; record only.
3. Independent review of `git diff 5a511f35e7d5..HEAD`; then verify/report/HANDOFF/journal.

## Out of scope (recorded, not worked)

- `.github/CODEOWNERS` dead path (a `.github/` edit; proposal territory).
- Broad env-manifest drift (already proposed in `autonomy/proposals/`).
- `V-07/V-08/V-10/V-11` need the operator's finding list.
