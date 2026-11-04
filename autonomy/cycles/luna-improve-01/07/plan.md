# Cycle 07 plan — luna-improve-01

Base: `7c27fa965e06af77cda731d25310fdf955f48430`. Mode: **fix** (see `review.md`).

Goal: finish the handoff's consolidation of the carried test-harness code by making the
clean-install runtime-lock closure complete and tested, pin `installDelegation()`'s environment
restoration with a direct assertion, and answer the out-of-bounds B-007 release-workflow bug with an
operator proposal. Keep the diff small enough to be reviewed whole.

## Item 1 — complete and test `runtimeLock()` (B-008)

- **Justification:** charter priority 2 (handoff carry: consolidation pass) and priority 5 (test for
  untested behaviour). Evidence: `tests/clean-install-smoke.ts:52-68` walks only
  `entry.dependencies`; the only real runtime dependency (`quickjs-wasi`) has no edge lists, so the
  transitive branch is dead and the optional/peer gap is invisible.
- **Change:** in `tests/clean-install-smoke.ts`, export `runtimeLock`, let it accept the parsed lock
  `packages` map as an optional argument (default: read the root `package-lock.json`), and follow
  `dependencies`, `optionalDependencies` and `peerDependencies` of each copied entry. A name with no
  entry in the source lock is skipped (it is not installable from this lock; `npm ci` still fails
  loudly if it is genuinely needed). Update the helper comment to match.
- **Checks:** a new self-check beside the existing `packReports` both-shape check feeds a synthetic
  lock with a transitive chain and an optional/peer edge and asserts every reachable entry is
  copied; `npm run smoke:clean-install` still passes with the real artefact.

## Item 2 — pin `installDelegation()` environment restoration

- **Justification:** charter priority 5 (tests for untested behaviour). Evidence: `delegation.ts`
  mutates `PI_CODING_AGENT_DIR`/`PI_KIT_EFFORT` and restores them in `cleanup()`, but
  `tests/env-isolation-smoke.ts` only tests `isolateKitEnv()`, and consumers rely on the
  `process.on("exit")` cleanup.
- **Change:** extend `tests/env-isolation-smoke.ts` with a unit that seeds sentinel
  `PI_CODING_AGENT_DIR`/`PI_KIT_EFFORT`, calls `installDelegation()`, asserts they changed while
  installed, calls `cleanup()`, and asserts the exact pre-call values are back (and that the same
  holds when they were absent). Test-only.
- **Checks:** `npm run smoke:env-isolation` passes; the assertion fails if `cleanup()` is changed to
  skip the restore.

## Item 3 — operator proposal for the broken release workflow (B-007)

- **Justification:** charter item 8 (evaluations and proposals) and "Out of bounds" (a cycle must
  not edit release/publish pipelines). Evidence: `release.yml:136,138` throw under npm 12 (see
  `review.md`).
- **Change:** add `autonomy/proposals/B-007-release-workflow-pack-json.md` with the evidence, the
  one-line patch (`Object.values(require("./pack.json"))[0]`, or reuse `packReports()`), and the note
  that it needs the operator. Mark B-007 in `BACKLOG.md` as `proposal`.
- **Checks:** `npm run docs:check` and `npm run verify` stay green; the proposal matches the file.

## Out of scope

- Editing `.github/workflows/release.yml` (out of bounds).
- `npm run check:all` is run in the verify phase, not here; the supervisor's `/opt/autonomy/gate.sh`
  runs the full acceptance set on the pushed head.

## Acceptance for the cycle

1. `npm run test:typecheck`, `npm run test:lint`, `npm run verify`, `npm run docs:check` pass.
2. `npm run smoke:clean-install` and `npm run smoke:env-isolation` pass, and the new assertions
   fail without their fixes.
3. `npm run check:all` passes on the cycle head.
4. An independent `reviewer` subagent checks `git diff 7c27fa96..HEAD` against the charter and
   returns PASS.
