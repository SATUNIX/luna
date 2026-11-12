# Cycle plan — luna-core-01 / 01

Mode: **fix**. Base `5a511f35e7d5`. PG-67 needs a change; PG-55 already holds and is re-verified.
One logical change per commit; every commit pushed.

Goal: stop a run dying with `integration_diverged` when the published integration branch has moved
under it; reconcile mechanically and keep the cycle counter.

## Item 1 — PG-67: reconcile a diverged integration branch instead of failing the run

Evidence: `packages/autonomy/lib/gitmirror.ts:153-167` detects divergence; the cycle start turned it
into a terminal `failed`/`integration_diverged` (`lib/templates/self-improve.ts:549`), and
`docs/autonomy.md:1013-1014` documented that death. Both reported runs (`luna-ux-01`, `luna-guard-01`)
lost merged cycles and restarted their counters. Reproduced on the base: the new non-conflicting
end-to-end check ends `failed` with `integration_diverged` before the fix.

Change:

- `lib/gitmirror.ts`: `reconcileIntegration(g, cfg, divergence)` uses the destination the sync
  already fetched (`refs/integration/remote`, no new network call), creates a temporary host
  worktree at the local integration head, runs `git rebase --rebase-merges --onto <remote>
  <merge-base> <local>` with the run identity and hooks disabled, and moves only the integration
  ref to the rebased head. It returns `reconciled` with the old head, new head, destination head,
  commit count and a first-parent old→new mapping, or `conflict` after aborting the rebase and
  leaving the integration ref unchanged. **Tags are never moved**: publication is fast-forward only
  and a moved tag would be refused by the destination, so a run tag keeps naming the commit that
  was originally published.
- `lib/templates/self-improve.ts`: on `sync.state === "diverged"`, call `reconcileIntegration`
  before the cycle is numbered. On success, log the reconciliation, rewrite the recorded cycle
  heads (`history[].head`/`start`), `lastGoodSha` and `current.startSha` through the mapping, append
  a `reconciliations` entry (at, old/destination/new head, commits), save, and continue the same
  cycle (publish follows as today). On conflict, `enterBlocked` with an `integration-diverged`
  question naming the branch and short shas (reconcile by hand and resume, or stop) — never
  `failed`.
- `lib/lifecycle.ts`: type the optional `SelfImproveState.reconciliations` record.
- `docs/autonomy.md`: replace "a diverged branch stops the run as integration_diverged" with the
  reconciliation behaviour, the first-parent mapping, immutable tags, and the blocking question when
  the rebase conflicts.
- Tests:
  - `tests/autonomy-smoke.ts` (fixture bare remote): a diverged local integration branch whose
    local commits rebase cleanly is reconciled onto the destination, the destination is an ancestor
    of the new head, the local work survives, the recorded head maps to the reconciled head, the
    cycle tag still names the original commit, and a subsequent `publish` fast-forwards the
    destination to the reconciled head; a conflicting local change returns `conflict`, aborts
    cleanly and leaves the ref unchanged.
  - `tests/autonomy-selfimprove-smoke.ts`: a diverged destination between cycles is reconciled at a
    cycle start, published, and the run keeps its cycle counter (`[1,2,3]`, one reconciliation
    record, no `integration_diverged`, tag unmoved); a conflicting move parks the run `blocked` with
    an `integration-diverged` question, leaving both refs and the history unchanged.

Proving checks: `smoke:autonomy`, `smoke:autonomy-selfimprove`, `smoke:autonomy-run`, `smoke:docs`,
`docs:check`, `verify`, `test:typecheck`, `test:lint`.

## Item 2 — PG-55: re-verify (no code change)

`smoke:autonomy-selfimprove` pins every acceptance clause: status carries `publishBlocker` and the
unpublished count, the next prompt names the commit and location (never the value), the run parks
after the second blocked merged cycle, and a clean publish clears all three. All PG-55 checks pass
on this base, so the item is reported `done` with no change. The scan, its patterns and its
exceptions are untouched.

## Checks to run (targeted only — never `npm test` / `npm run check:all`)

Derived after the edits with
`node packages/core/check-all.ts --for-changed="$(git diff --name-only 5a511f35e7d5..HEAD | tr '\n' ',')"`;
it names `docs:check`, `smoke:autonomy`, `smoke:autonomy-run`, `smoke:autonomy-selfimprove`,
`smoke:docs`, `test:lint`, `test:typecheck` and `verify`.

## Task graph

1. Item 1 implement + commit + push (one commit: code, tests, docs).
2. Item 2 re-verify with the self-improve smoke; record only.
3. Independent review of `git diff 5a511f35e7d5..HEAD`; then verify/report/HANDOFF/journal.

## Out of scope (recorded, not worked)

- `.github/CODEOWNERS` dead path (a `.github/` edit; proposal territory).
- Broad env-manifest drift (already proposed in `autonomy/proposals/`).
- `V-07/V-08/V-10/V-11` need the operator's finding list.
