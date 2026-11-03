# Cycle 06 report — luna-improve-01

Outcome: successful
Mode: fix

- Run: `luna-improve-01`, cycle 6 of 200
- Branch: `pi/luna-improve-01`
- Cycle base: `a3854019e198922c7582b8d68949a3a6d36b895b` ("chore(autonomy): seed integration/luna").
  This clone has no `integration/luna` ref (`git for-each-ref` and `git ls-remote origin` list only
  `pi/luna-improve-01`, `attempts/luna-improve-01/cycle-01..04` and `refs/autonomy/reset`), and every
  prior cycle record names `a385401` as the integration base, so the range `integration/luna..HEAD`
  is the range `a385401..HEAD`.
- Documents: `review.md`, `plan.md`, `verify.md` in this directory
- Cycle status: completed

## What this cycle is

Operator-steered records correction. Cycle 04 was refused at merge review because its
`report.md`/`verify.md` did not match the diff against `integration/luna`: the report said the
npm-12 pack shape, `installDelegation`, firewall-smoke and clean-install changes were "not
re-applied", while the diff contained all of them. They are copies of main's PR #29, which
`integration/luna` does not carry yet, so they legitimately belong in the diff. This cycle does no
new code work; it makes the records account for the whole diff. Per the operator's later
corrections, the carried changes are left exactly as they are on the branch (this clone is older and
may not contain main's `bc5a96b`), and `tests/firewall-unattended-smoke.ts` is kept.

## Every commit in `git log integration/luna..HEAD` (base `a385401`)

Newest first. **carried from main PR #29, identical to main** marks the five commits whose content
main's PR #29 also contains; the rest are this run's own earlier work and records.

- `HEAD` (this cycle's record commit; a report cannot contain the hash it produces) docs(autonomy): record cycle 06 — list every commit and the true diff stat
- `92ef9ac` docs(autonomy): record cycle 05 — re-applied carried fixes on a clean base
- `92dbeaf` docs(future-work): drop the stale 0.1.0 version claim
- `794adac` test(clean-install): install runtime dependencies offline from a cut lockfile — **carried from main PR #29, identical to main**
- `14d43dd` test(firewall): handle a rootless user namespace in the unattended smoke — **carried from main PR #29, identical to main**
- `fe8a128` test(eval): return the environment to its pre-call state after installDelegation — **carried from main PR #29, identical to main**
- `fd76bd3` test(eval): make installDelegation hermetic against ambient kit env vars — **carried from main PR #29, identical to main**
- `f86177c` fix(packaging): accept npm 12's object shape from npm pack --json — **carried from main PR #29, identical to main**
- `e6f20e6` docs(autonomy): record cycle 04 review, plan, verify and report
- `f766593` fix(web-ui): report the real package version instead of hard-coded 0.1.0
- `3f8ab1b` fix(autonomy): stop writing every detached supervisor log line twice

## True diff stat

`git diff a385401..HEAD --stat` of the pushed head (verbatim):

```text
 autonomy/BACKLOG.md                                |   9 +-
 autonomy/cycles/luna-improve-01/04/plan.md         |  34 ++++++
 autonomy/cycles/luna-improve-01/04/report.md       |  68 +++++++++++
 autonomy/cycles/luna-improve-01/04/review.md       |  55 +++++++++
 autonomy/cycles/luna-improve-01/04/verify.md       |  52 ++++++++
 autonomy/cycles/luna-improve-01/05/plan.md         |  64 ++++++++++
 autonomy/cycles/luna-improve-01/05/report.md       |  77 ++++++++++++
 autonomy/cycles/luna-improve-01/05/review.md       | 101 ++++++++++++++++
 autonomy/cycles/luna-improve-01/05/verify.md       |  88 ++++++++++++++
 autonomy/cycles/luna-improve-01/06/plan.md         |  36 ++++++
 autonomy/cycles/luna-improve-01/06/report.md       | 131 +++++++++++++++++++++
 autonomy/cycles/luna-improve-01/06/review.md       |  51 ++++++++
 autonomy/cycles/luna-improve-01/06/verify.md       |  60 ++++++++++
 docs/future-work.md                                |   3 +-
 packages/autonomy/lib/engine.ts                    |  16 ++-
 packages/autonomy/lib/fsutil.ts                    |  11 ++
 packages/core/build-npm.ts                         |  23 +++-
 packages/core/eval/delegation.ts                   |  11 +-
 packages/core/pack-check.ts                        |  17 +--
 .../extensions/src/tool-firewall/unattended.ts     |   5 +
 packages/web-ui/server/configinfo.ts               |   5 +-
 packages/web-ui/server/routes.ts                   |   5 +-
 tests/autonomy-cli-smoke.ts                        |  21 +++-
 tests/clean-install-smoke.ts                       |  52 ++++++--
 tests/firewall-unattended-smoke.ts                 |  10 +-
 tests/web-ui-api-smoke.ts                          |  18 +++
 26 files changed, 978 insertions(+), 45 deletions(-)
```

## Why the `tests/firewall-unattended-smoke.ts` change is kept (not a loosened test)

Commit `14d43dd` ("**carried from main PR #29, identical to main**") changes the two real-`/proc`
provenance cases in `tests/firewall-unattended-smoke.ts`:

```ts
const realStanding = (await loadModule<typeof UnattendedModule>("extensions/tool-firewall/unattended.ts")).currentNamespaceStanding();
const realWhy = realStanding.initialUser ? /neither on a read-only mount nor owned by another user/ : /not in the initial user namespace/;
await refused("a same-user file, real mount table", envFor(forged), realWhy);
await refused("even one in the directory the tests call read-only", envFor(contract), realWhy);
```

- Inside a rootless user namespace the real mount table gives
  `not in the initial user namespace` as the refusal reason; the strict
  `neither on a read-only mount nor owned by another user` reason is only produced when the process
  is in the initial user namespace. Without this choice the gate is red inside the rootless
  container.
- It is **not** a loosening: `refused()` always asserts `unattended().active === false` and
  `assert.match(b.stderr, why)`, so both cases still assert a specific refusal reason. The strict
  reason remains the expected one whenever the host is in the initial user namespace, and every
  synthetic mount-table case keeps the unchanged strict default `why`.
- Main's PR #29 made the same change (`realWhy` chooses the expected reason by whether the host
  namespace is the initial one), so this is the upstream behaviour, not a local weakening. This
  clone does not contain main's `bc5a96b`, so identity is per the operator's steer; no local
  weakening was introduced. The new helper is `packages/extensions/src/tool-firewall/unattended.ts:201`.

## Verification

- `npm run check:all` is **not** run in this session, per the operator's explicit steering
  ("...without running check:all"). The supervisor's acceptance gate (`/opt/autonomy/gate.sh`) runs
  it on the pushed head. This cycle changes only files under
  `autonomy/cycles/luna-improve-01/06/`, so the gate's code/test result is unchanged from cycle 05's
  green run (203/203).
- `git log a385401..HEAD --oneline` and `git diff a385401..HEAD --stat` were re-run after the record
  commit; the lists above and the stat below are their output. Evidence in `verify.md`.
- Independent `reviewer` subagent on this cycle's records against the diff and the charter:
  **Verdict: PASS** (all six checks: commit list, exactly five PR #29 markers, byte-identical stat
  block, firewall justification, record-commit scope, no control-path change; the first review
  returned FAIL on an inflated stat block, which was corrected and re-checked).

## What was left and why

- No code, test or documentation under `packages/`/`tests/`/`docs/` was changed; the operator scoped
  the cycle to the records correction and to ending without `check:all`.
- `B-007` (`.github/workflows/release.yml` pack parsing) and `B-008` (`runtimeLock()` closure)
  remain open and are unchanged; they still need the operator decision / a later cycle.

## For the next cycle

- The records now match the diff; the five PR #29 carry commits are named. A future cycle that is
  merged into `integration/luna` can keep them; when `integration/luna` later receives main's
  PR #29, these commits will already match it.
- Next work is the normal charter order: a consolidation pass over the carried test-harness code,
  then the next evidenced fix.
