# Cycle 06 review — luna-improve-01

Base: `a385401` (`chore(autonomy): seed integration/luna`). This is the only ref that stands for
`integration/luna` in this clone: `git for-each-ref` and `git ls-remote origin` list no
`integration/luna` (origin has `pi/luna-improve-01`, `attempts/luna-improve-01/cycle-01..04` and
`refs/autonomy/reset`). Every prior cycle record also names `a385401` as the integration base, so the
range `integration/luna..HEAD` is taken as `a385401..HEAD`.

## Operator steering (authoritative)

Cycle 04 was refused at merge review because its `report.md`/`verify.md` did not match the diff
against `integration/luna`: the report said the npm-12 pack shape, `installDelegation`,
firewall-smoke and clean-install changes were "not re-applied", while the diff contained all of them.
`integration/luna` does not carry main's PR #29 yet, so those changes do belong in the diff, as
copies of main. This cycle is a records correction, not new code:

1. Make the carried files byte-identical to main's PR #29 — **superseded by the operator's second
   correction**: this clone is older and may not contain main's `bc5a96b`, so the carried changes
   are kept exactly as they are on the branch.
2. `report.md` must list every commit in `integration/luna..HEAD`, one line each, and mark the
   PR #29 commits `carried from main PR #29, identical to main`.
3. `report.md` must state the true `git diff --stat`.
4. No other new work; do not run `check:all`.

A third correction explicitly says **do not revert** `tests/firewall-unattended-smoke.ts`: without it
the gate is red inside this rootless container, and main's PR #29 made the same namespace-aware
change.

## Findings (checked against the actual code)

- **The records, not the code, are the defect.** Confirmed with
  `git log a385401..HEAD --oneline --name-only` and `git diff a385401..HEAD --stat` (22 files,
  +700/-45). The branch's own commits are ten; five of them (`f86177c`, `fd76bd3`, `fe8a128`,
  `14d43dd`, `794adac`) are the PR #29 copies the cycle-04 report described as "not re-applied".
  Cycle 05's records already re-attribute them as re-applied, which is the mismatch this cycle
  corrects by naming them as carried from main.
- **The firewall smoke is not a loosened test.** In
  `tests/firewall-unattended-smoke.ts:599` the two real-`/proc` provenance cases now compute
  `realWhy` from `currentNamespaceStanding().initialUser`: in the initial user namespace they still
  expect the strict `/neither on a read-only mount nor owned by another user/`, and only outside it
  do they expect `/not in the initial user namespace/`. Both cases still assert `active === false`
  and still assert a specific refusal reason. The test's own mount-table cases keep the strict
  default `why`. Exported helper at `packages/extensions/src/tool-firewall/unattended.ts:201`.
- **No new bug, security gap, or doc drift was found** in the files this cycle touches, and the
  operator scoped the cycle to the records correction. No `check:all` run is required by the
  steering.

## Mode

Fix mode. The defect is a records/diff mismatch named by the operator, which is priority 1
(a broken pushed state) and priority 2 (work carried over in `HANDOFF.md`).
