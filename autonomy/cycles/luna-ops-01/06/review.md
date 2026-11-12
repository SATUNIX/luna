# Cycle 06 — Review (run luna-ops-01, stream `ops`)

Base: `70650a313022` (head of `stream/ops`, cycle start). Branch: `pi/luna-ops-01`.
Charter read in full (`autonomy/CHARTER.md`). Board items read from the prompt's "Assigned work"
(DE-105, DE-106). Read cycle 05's `report.md`, `verify.md`, `plan.md`, this run's proposals and
`autonomy/runs/luna-ops-01/HANDOFF.md`. Two scouts checked the board items against the code and
looked for new ops defects; evidence below.

## Gate state (priority 0): green, nothing to repair

- `git log --oneline 70650a313022..HEAD` is empty at review time.
- Cycle 05's report is merged into the cycle-start branch and its checks passed there. No red
  gate and no upstream merge conflict is present on this base.

## DE-105 [P0] — already fixed in cycle 05; verify only

- `tests/perf-budget.ts:21` takes `clock?: () => number`; `:25` defaults it to
  `() => performance.now()`.
- `tests/redaction-corpus-smoke.ts:176-214` (check 5) uses a fake clock: linear advances
  `text.length`, ten-times-slower advances `10 * text.length`, quadratic advances
  `steps * steps`; the first two pass and `assert.throws(..., /quadratic/)` rejects the third.
  No real clock read remains in check 5.
- Check 4 (`:168-171`) and `tests/firewall-gate-smoke.ts:593` still use real timing, unchanged.
- `npm run -s smoke:redaction-corpus` exits 0, all 6 checks pass. No further change is needed for
  this item; the cycle records it as verified.

## DE-106 [P0] — pi-compat half fixed in cycle 05; coverage half still real

- `.github/workflows/ci.yml:68-78`: `verify` and `pi-compat` are 4-shard matrices; cycle 05
  (`f7c7031`, `72c5af7`) sharded pi-compat. `tests/workflow-policy-smoke.ts:56-92` pins both.
- `.github/workflows/ci.yml:55-66`: `coverage` is still one unsharded job running
  `npm run -s coverage -- --check-timeout=600`. `packages/core/coverage.ts:294-303` creates one
  temporary `NODE_V8_COVERAGE` directory, runs check-all once, reports, and deletes the raw data.
  The board measured this lane at 31.1 / 28.6 minutes, so it still sets PR wall time.
- No coverage threshold exists: `ci.yml:55-59`, `docs/ci-security.md:64-66` and
  `tests/workflow-policy-smoke.ts:129-137` deliberately make coverage measure-only. Cycle 05
  correctly refused to invent a threshold. The board's phrase "the existing threshold" is stale;
  re-adding a gate would reverse the reviewed change `25f9c40e` ("stop the measure-only coverage
  job gating ci-complete"). This cycle shards coverage and merges the raw reports so wall time
  falls, keeps the reviewed measure-only policy, and writes a proposal for a threshold decision.

## Installer defects found (priority 4; not this cycle unless time remains)

- `packages/core/install.ts:758-771` writes the `.env` template to `globalAgentDir()` for every
  scope, including `--scope project`, while `docs/INSTALL.md:70` promises project scope writes only
  project files. A scout reproduced `--dry-run --scope project` printing
  `would scaffold /tmp/.../agent/.env`.
- `packages/core/install.ts:98-115` validates arguments before handling `--help`, so
  `install.ts --help --profile` exits 1 with a missing-value error although `docs/INSTALL.md:58`
  promises `--help` exits 0.
- `packages/core/check-all.ts:499-509` returns from the `--for-changed` plan before skip
  validation, so `--for-changed=... --skip=evl` exits 0 while `--list --skip=evl` exits 2.

## Mode

**Fix mode**: DE-105 is verified complete; DE-106's remaining coverage lane is a measured CI speed
defect with a concrete testable fix. The installer defects are candidates after board work.
