# Cycle 08 — Review (run luna-ops-01, stream `ops`)

Base: `e120c3fdb8b0`, head of `stream/ops`. Mode this cycle: **fix**.

## Assigned board items checked against the current code

### DE-105 — sub-quadratic guard regression test must not depend on the clock

Already implemented and merged before this cycle. `tests/perf-budget.ts:16-48` takes
`opts.clock` (default `performance.now`) and `tests/redaction-corpus-smoke.ts:209-217` drives
check 5 with a deterministic fake clock: the linear and 10x-slower probes pass and the quadratic
probe is rejected. `npm run -s smoke:redaction-corpus` passes 6/6 in ~13 s. The real-timing
checks (check 4, `tests/firewall-gate-smoke.ts`) are unchanged. Re-verified this cycle; no code
change needed.

### DE-106 — cut PR CI wall time; shard coverage and pi-compat

The sharding work is merged: `.github/workflows/ci.yml:62-95` runs `coverage` as a 4-shard
matrix, `:173-210` runs `pi-compat` as a `pi` x `shard` matrix, and `:101-125` merges the raw
reports in `coverage-merge`. `tests/workflow-policy-smoke.ts:202-207` pins both coverage jobs as
measure-only, so `ci-complete` deliberately does not need them.

The literal acceptance wording "a coverage-merge job enforces the existing threshold; ci-complete
needs all of them" cannot be honoured without a threshold, and the repository has none: the
reviewed change `25f9c40e` removed coverage from `ci-complete` as a measure-only job after a slow
runner cancelled it; `packages/core/coverage.ts` compares against no minimum; and
`autonomy/proposals/luna-ops-01-06-coverage-threshold-policy.md` records that the threshold value
is an operator decision. Reversing that reviewed policy in this cycle would be a control change,
not a fix. The 12-minute median is a GitHub-hosted PR measurement; this checkout is offline and
cannot produce it. `npm run -s smoke:workflow-policy` passes 5 checks / 48 mutations.

## New, evidenced defects found this cycle

1. **`check-all --for-changed` under-plans CI policy and core entry-script changes.**
   `packages/core/lib/check-map.ts:40-54` has no rule for `.github/**`, `packages/core/install.ts`
   or `packages/core/coverage.ts`. Evidence:

   ```text
   $ node packages/core/check-all.ts --for-changed=.github/workflows/ci.yml
   check-all: run: test:lint
   check-all: run: test:typecheck
   check-all: run: verify
   check-all: skipped: smoke:release-workflow
   check-all: skipped: smoke:workflow-policy
   ```

   ```text
   $ node packages/core/check-all.ts --for-changed=packages/core/install.ts
   check-all: skipped: smoke:install-filter
   check-all: skipped: smoke:install-marker
   check-all: skipped: smoke:profile-transaction
   ```

   A cycle that edits the CI workflow, the installer or the coverage runner can therefore record
   the check that pins that file as SKIPPED, and only the host gate catches it. This is the exact
   failure mode `--for-changed` exists to prevent (`packages/core/lib/check-map.ts:1-11`).
   `smoke:check-all-npm` is likewise skipped for `packages/core/coverage.ts`, although it tests the
   coverage CLI directly.

2. **`install.ts` accepts an empty value for value flags and builds a broken source.**
   `packages/core/install.ts:106-111` rejects `undefined` and values starting with `--` but not
   `""`, and the later `get()` checks treat `""` as absent. Evidence:

   ```text
   $ node packages/core/install.ts --dry-run --mode git --profile balanced --channel ""
   [install] Luna
     ...
     source:       git:github.com/SATUNIX/luna@v
   ```

   ```text
   $ node packages/core/install.ts --dry-run --profile balanced --git-ref ""
   ... mode: local
   ```

   A script with an unset variable (`--channel "$CHANNEL"`) either registers the malformed tag `v`
   or silently ignores the flag. This is the same user-error class as the bad `--profile` path
   fixed in cycle 07.

## Checked and rejected

- `--profile bogus` stack trace (proposal `luna-ops-01-10`): already fixed; exits 2 with the valid
  profile list and no stack.
- `workflow-resume` checkout-queue flake (proposal `luna-ops-01-08`): already fixed by `348c1b5e`;
  the test now waits for the queued agent to register instead of sleeping 300 ms.
- Coverage threshold: see DE-106 above; operator decision, already proposed.
- `/workflow` vs `/workflows` docs sweep: real but a broad docs-only change, not this cycle's
  minimal item.
- `coverage.ts --report <missing-dir>` raw stack: real but low impact (measure-only CI job); left
  as a candidate for a later cycle to keep this diff small.

## Conclusion

Board items are complete; the cycle takes the two demonstrated defects above under work
precedence 4 (defects), leaving the reviewed coverage policy untouched.
