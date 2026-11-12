# Cycle 05 — Review (run luna-ops-01, stream `ops`)

Base: `4da2716e9c9f` (head of `stream/ops`, cycle start). Branch: `pi/luna-ops-01`.
Charter read in full (`autonomy/CHARTER.md`). Board items read from the prompt's "Assigned work"
(DE-105, DE-106). Read cycle 03/04 records, this run's proposals, and
`autonomy/runs/luna-ops-01/HANDOFF.md`. Three scouts checked the assigned items and the gate
against the actual code; their findings are below with file:line evidence.

## Gate state (priority 0): green, nothing to repair

- `npm run -s smoke:docs` → exit 0 (`[docs-smoke] OK: 14 documented commands ... 97 shipped pages ...`).
- `node packages/core/journal.ts --check` → exit 0 (`journal: every report has a journal entry`).
- `npm run -s docs:check`, `node packages/core/check-all.ts --check-wiring`,
  `npm run -s smoke:workflow-policy` (5/5), `smoke:autonomy-selfimprove` (57/57),
  `smoke:autonomy-contract` (16/16), `smoke:handoff`, `smoke:prepush-scan` (13/13) all exit 0.
- The cycle-04 rejection (claimed work absent from the host diff) does not leave a red branch here:
  the journal line for `luna-ux-01/01` and `autonomy/proposals/V-04-unify-workflows.md` are present
  in this checkout, and the journal check agrees. No P0 item exists.
- `git log --oneline 4da2716e9c9f..HEAD` is empty at review time.

## DE-105 [P0] — confirmed, timing-dependent guard regression test

- `tests/perf-budget.ts:14-39` (`assertSubQuadratic`) reads `performance.now()` directly; it has
  no injectable clock. Bound is `max(smallMs, 2) * maxRatio`, `maxRatio` default 10.
- `tests/redaction-corpus-smoke.ts:175-198` (check 5) drives it with real loops at 200k/800k chars.
  The quadratic probe does `(len/100)^2` steps: 4M at 1x, 64M at 4x, a true 16x ratio against a
  10x bound. The margin is only 13-14x measured, so host noise flips it (the board records
  `verify (4)` failing on the 2026-11-12 promotion PR until a re-run).
- Only check 5 is the guard's own regression; check 4 (`:146-173`) and
  `tests/firewall-gate-smoke.ts:593` use the guard against real redactors and must keep real timing.
- Checks that cover the change: `smoke:redaction-corpus`, `smoke:firewall-gate`,
  `test:typecheck`, `test:lint`, `smoke:docs`, `verify`.

## DE-106 [P0] — partly stale; pi-compat sharding still real, coverage already off the gate

- `.github/workflows/ci.yml:28-51`: `verify` is a 4-way `check:all --shard=${{ matrix.shard }}/4`
  matrix. `packages/core/check-all.ts:34-35,199-200` implements the disjoint round-robin shards.
- `.github/workflows/ci.yml:120-152`: `pi-compat` has a pi-version matrix (0.85.1, 0.99.2) but **no
  shard axis** and runs the whole suite per lane — the slowest remaining lane the board names.
- The coverage half of the board text is already superseded by reviewed policy: `coverage` is a
  measure-only job deliberately outside `ci-complete` (`tests/workflow-policy-smoke.ts:110-125`,
  `docs/ci-security.md:52-73`), with no threshold. Re-introducing a threshold/merge job would
  change that reviewed policy and cannot be measured here (no network / no PR runs), so it is not
  taken this cycle; it belongs in a proposal if the operator wants to reverse the policy.
- Taking this cycle: shard `pi-compat` like `verify` (matrix shard, `--shard`, `--jobs`,
  `--check-timeout`), keep both pi lanes non-advisory, keep every check in the union, and pin the
  new shape in `tests/workflow-policy-smoke.ts` and `docs/ci-security.md`. The 12-minute PR
  measurement is not reproducible in this sandbox; the report will say so.

## Other findings (not taken)

- HANDOFF's installer `--profile`/lite-count/`npmDeliveryEnabled` carry-overs are already fixed or
  documented on this base (`packages/core/install.ts:539-541`, `docs/INSTALL.md:60-65`,
  `docs/releasing.md:184-190`); no work.
- `tests/workflow-resume-smoke.ts:382` flake proposal (luna-ops-01-08) is open but outside this
  cycle's assigned slice and the diff budget.

## Mode

**Fix mode**: board item DE-105 is a real reliability defect in the gate; DE-106 is an assigned
improvement taken after it, scoped to pi-compat sharding.
