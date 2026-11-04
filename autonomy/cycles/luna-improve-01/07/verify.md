# Cycle 07 verify — luna-improve-01

Base: `7c27fa965e06af77cda731d25310fdf955f48430` (cycle 06's record commit, the pushed head at the
start of this cycle). Head under test: this cycle's commits
`4485fda`, `44c7d66`, `b565a00`, `e838e82`, plus the review/plan and this record commit.

Diff (excluding the record files for this directory): 6 files, +326/-12 — two test files, the B-007
proposal, `BACKLOG.md`, and this cycle's own `review.md`/`plan.md`. No file under `packages/`, no
`.github/`, no `package.json` script, no control path, no dependency.

## Item 1 — `runtimeLock()` closes over optional and peer edges (B-008)

Commit `44c7d66`.

- `tests/clean-install-smoke.ts:59-82`: the effective-read closure now queues
  `dependencies`, `optionalDependencies` and `peerDependencies` of every copied entry; a name
  missing from the source lock is skipped unless it is a root dependency (then it throws).
- New synthetic-lock self-check at `tests/clean-install-smoke.ts:166-190` asserts the copied key set
  is exactly `["", node_modules/a, b, c, d, e]` (the peer `f` with no source entry is skipped) and
  that a missing root throws `/no entry for missing/`.
- Falsifiability: the old function (`git show 7c27fa96:tests/clean-install-smoke.ts:52-68`) ignored
  the second argument and threw `no entry for a`, so the new check fails on the old code.
- `npm_config_cache=/tmp/npm-cache npm run smoke:clean-install` → `[clean-install-smoke] OK (12
  checks)` (was 11), including the new `runtimeLock closes over ...` check and the real offline
  `npm ci` step.

## Item 2 — `installDelegation()` environment restoration pinned

Commit `b565a00`.

- `tests/env-isolation-smoke.ts:101-146`: unit 1c seeds sentinel `PI_CODING_AGENT_DIR`,
  `PI_KIT_EFFORT` and `PI_KIT_FIREWALL_POLICY`, asserts they change while installed
  (`PI_KIT_EFFORT === "exhaustive"`) and are restored exactly by `cleanup()`; unit 1d asserts an
  absent variable stays absent.
- Falsifiability (run in this session): with `packages/core/eval/delegation.ts` `cleanup()`'s
  `restoreEnv();` commented out, `npm run smoke:env-isolation` fails at
  `tests/env-isolation-smoke.ts:113` with `actual: undefined, expected:
  'sentinel-agent-dir-delegation'`; the file was then restored (`git status` clean).
- `npm_config_cache=/tmp/npm-cache npm run smoke:env-isolation` → `[env-isolation-smoke] OK`.

## Item 3 — B-007 proposal

Commit `e838e82`.

- `autonomy/proposals/B-007-release-workflow-pack-json.md` quotes the reproduced npm 12 shape and
  `TypeError`, and proposes `Object.values(require("./pack.json"))[0]`.
- `.github/workflows/release.yml` was **not** touched (`git diff 7c27fa96..HEAD -- .github/` is
  empty); `npm run docs:check` and `npm run verify` exit 0.
- `autonomy/BACKLOG.md`: B-007 → `proposal`; B-008 → `done` (`44c7d66`).

## Acceptance checks (run on the pushed head before this record commit)

- `npm run test:typecheck` → exit 0.
- `npm run test:lint` (`--max-warnings 0`) → exit 0.
- `npm run verify` → "All checks passed."
- `npm run docs:check` → exit 0.
- `npm run test:security` → exit 0 (log `/tmp/sec-cycle07.log`).
- `python3 -m mkdocs build --strict` → exit 0 (log `/tmp/mkdocs-cycle07.log`).
- `npm run check:all` → **all 203 check runs passed** in 448.4s (log `/tmp/checkall-cycle07b.log`).

The first `check:all` attempt failed `smoke:clean-install` and `smoke:package` with
`EROFS: read-only file system, open '/opt/npm-cache/_cacache/tmp/...'` because this session passed
`npm_config_cache=/opt/npm-cache`, which is read-only; the same two smokes pass individually and in
the full run once the cache is a writable copy (`/tmp/npm-cache`). This is an environment artefact,
not a code failure — the supervisor's gate copies the cache to `/gate/npm-cache`. The first attempt's
log is `/tmp/checkall-cycle07.log`.

## Reviewer

An independent `reviewer` subagent that did not write the change reviewed `git diff 7c27fa96..HEAD`
against `autonomy/CHARTER.md` and returned **Verdict: PASS** with no blockers. Non-blocking notes:
the synthetic check exercises the skip rule through a peer name only (the branch is shared); unit 1d
alone would not falsify a missing restore (1c does). Full evidence is in the reviewer's report and
the recorded verdict.

## Verdicts

- `reviewer`: PASS.
- `check:all`: PASS (203/203).
- `security+docs`: PASS (`test:security`, `mkdocs --strict`, `test:typecheck`, `test:lint`).
