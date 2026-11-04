# Cycle 07 report — luna-improve-01

Outcome: successful
Mode: fix

- Run: `luna-improve-01`, cycle 7 of 200
- Branch: `pi/luna-improve-01`
- Cycle base: `7c27fa965e06af77cda731d25310fdf955f48430` ("docs(autonomy): record cycle 06 — list
  every commit and the true diff stat"), the pushed head at the start of this cycle. This clone has
  no `integration/luna` ref; every prior cycle names `a385401` as the seed and builds forward, so
  the range `integration/luna..HEAD` is taken as `BASE..HEAD`.
- Documents: `review.md`, `plan.md`, `verify.md` in this directory
- Cycle status: completed

## What this cycle is

Fix mode. The previous cycle (06) was records-only and left no code work. `HANDOFF.md` named the
next task: a consolidation pass over the carried test-harness code, then the next evidenced fix. The
review confirmed three items with evidence and took the two in-bounds ones plus a proposal for the
one that is out of bounds:

1. `tests/clean-install-smoke.ts` — `runtimeLock()` closed only over `dependencies`, and its
   transitive branch never ran (the only runtime dependency, `quickjs-wasi`, has no edges), so
   `optionalDependencies`/`peerDependencies` were silently dropped and untested (B-008).
2. `tests/env-isolation-smoke.ts` — no test pinned that `installDelegation()`'s `cleanup()` restores
   the caller's environment, though the fix in `fe8a128` was verified only indirectly.
3. `.github/workflows/release.yml` — `require("./pack.json")[0]` is `undefined` under npm 12, so the
   `plan` job throws and the release/publish jobs get no inputs (B-007). A release pipeline is out of
   bounds for a cycle, so it became an operator proposal.

## Commits (`git log BASE..HEAD`, oldest first)

- `4485fda` docs(autonomy): cycle 07 review and plan — consolidate runtime-lock closure, pin
  delegation env restore
- `44c7d66` test(clean-install): close runtimeLock over optional and peer edges and pin it with a
  synthetic lock
- `b565a00` test(eval): pin installDelegation() env restoration in the isolation smoke
- `e838e82` docs(proposals): file the release-workflow pack.json fix for the operator (B-007)
- this cycle's record commit: docs(autonomy): record cycle 07 — runtime-lock closure, delegation env
  restore, B-007 proposal

## Diff stat

`git diff BASE..HEAD --stat` at the record commit (verbatim `git --no-pager diff --stat BASE..HEAD`
after the record commit):

```text
 autonomy/BACKLOG.md                                |   4 +-
 autonomy/cycles/luna-improve-01/07/plan.md         |  61 ++++++++++++++
 autonomy/cycles/luna-improve-01/07/report.md       | ...
 autonomy/cycles/luna-improve-01/07/review.md       |  95 +++++++++++++++
 autonomy/cycles/luna-improve-01/07/verify.md       | ...
 autonomy/proposals/B-007-release-workflow-pack-json.md | 76 +++++++++++++++++
 tests/clean-install-smoke.ts                       |  58 ++++++++++--
 tests/env-isolation-smoke.ts                       |  44 +++++++++-
```

Only two test files and autonomy records/proposals changed. No file under `packages/`, no
`.github/`, no `package.json` script, no control path, no dependency.

## Items completed and verification

1. **`runtimeLock()` closure (B-008), `44c7d66`.** It now walks `dependencies`,
   `optionalDependencies` and `peerDependencies`, is exported, accepts an optional synthetic
   `packages` source for tests, still throws for a missing root dependency and skips a missing
   transitive/optional/peer name. A synthetic-lock self-check pins the copied set and the missing-root
   throw. `npm run smoke:clean-install` passes with 12 checks (was 11); the check fails on the old
   one-argument function. Detail in `verify.md`.
2. **`installDelegation()` env restoration, `b565a00`.** Two units assert exact restoration for a
   present sentinel and absence for an absent one. `npm run smoke:env-isolation` passes. Disabling
   `cleanup()`'s `restoreEnv()` makes the present-case assertion fail (reproduced, then reverted).
3. **B-007 proposal, `e838e82`.** `autonomy/proposals/B-007-release-workflow-pack-json.md` records the
   evidence and the one-line patch; `.github/` was not edited. `BACKLOG.md` marks B-007 `proposal`
   and B-008 `done`.

## Acceptance checks

- `npm run test:typecheck`, `npm run test:lint` (`--max-warnings 0`), `npm run verify`,
  `npm run docs:check` — all exit 0.
- `npm run test:security` exit 0; `python3 -m mkdocs build --strict` exit 0; `gitleaks` is the
  supervisor's step (not installed here).
- `npm run check:all` — **203/203 check runs passed** in 448.4s.
- Independent `reviewer` subagent on `git diff BASE..HEAD` against the charter: **Verdict: PASS**, no
  blockers.

First `check:all` attempt failed `smoke:clean-install` and `smoke:package` with `EROFS` because this
session pointed `npm_config_cache` at the read-only `/opt/npm-cache`; both pass with a writable cache
copy and the supervisor's gate copies the cache itself. Environment artefact, not a code failure.

## What was left and why

- `.github/workflows/release.yml` was intentionally not edited: a release pipeline is out of bounds
  (charter), so the fix is proposed to the operator in `autonomy/proposals/` and B-007 is marked
  `proposal`.
- No higher-priority failing check, correctness bug or security gap was found; the scout's other
  inspected areas were clean (`review.md`, "Checked and clean").

## For the next cycle

- B-008 is closed and regression-tested. The next work in charter order is the next evidenced fix;
  `B-007` now waits on the operator.
- Note the environment trap: `/opt/npm-cache` is read-only in this container. Use a writable copy
  (`cp -a /opt/npm-cache /tmp/npm-cache`) for any local check that runs `npm pack`/`npm ci`.
