# Cycle 20 verify — luna-ops-01 (PG-52 consolidation + clean re-land)

Start `6aeb90441a4b`. Plan derived from the cycle's own diff with
`node packages/core/check-all.ts --for-changed="$(git diff --name-only 6aeb90441a4b..HEAD -- . ':(exclude)autonomy/cycles/luna-ops-01/' ':(exclude)autonomy/runs/luna-ops-01/' | tr '\n' ',')"`.
Changed paths: `docs/ARCHITECTURE.md`, `docs/ci-security.md`,
`packages/autonomy/lib/templates/self-improve.ts`, `packages/autonomy/prompts/cycle.md`,
`packages/core/check-all.ts`, `packages/core/lib/check-map.ts`,
`tests/autonomy-selfimprove-smoke.ts`, `tests/check-all-npm-smoke.ts`.

## RAN (every check the plan named)

- `docs:check` — RAN, PASS. `docs-nav-check: OK`.
- `smoke:autonomy` — RAN, PASS. 32/32.
- `smoke:autonomy-run` — RAN, PASS. `all 15 checks passed`.
- `smoke:autonomy-selfimprove` — RAN, PASS. `all 41 checks passed` (cycle-19 cases plus the new
  copy-pair, changed-test and table-shape cases).
- `smoke:check-all-npm` — RAN, PASS. `check-all npm smoke: OK`.
- `smoke:docs` — RAN, PASS. `14 documented commands validated, 62 relative links resolved`.
- `test:lint` — RAN, PASS (exit 0).
- `test:typecheck` — RAN, PASS (exit 0).
- `verify` — RAN, PASS. `[verify] All checks passed.`

## Manual acceptance fixtures (the cycle-19 gaps)

- `node packages/core/check-all.ts --for-changed=packages/extensions/src/secret-guard/index.ts`
  — RAN, PASS. Plan now includes both `smoke:secret-guard` and `smoke:workflow-notify` (cycle 19
  printed `skipped: smoke:workflow-notify`).
- `node packages/core/check-all.ts --for-changed=packages/autonomy/lib/templates/common.ts`
  — RAN, PASS. Plan includes `smoke:workflow-notify` (the copy-pair source previously unmapped).
- `node packages/core/check-all.ts --for-changed=tests/autonomy-selfimprove-smoke.ts`
  — RAN, PASS. Plan includes `smoke:autonomy-selfimprove` (a changed test file now plans its own
  check).
- `node packages/core/check-all.ts --for-changed=<any>` — RAN, PASS. No
  `check-all: skipping test:security: …` line printed in plan mode; the announce happens once, only
  on a real `runAll`.

## SKIPPED (recorded, not run)

The remaining `knownChecks` (about 210) are SKIPPED: this diff touches no shell/firewall, memory,
web-ui, container, release or unrelated extension path. The exact set is reproducible from the
`--for-changed` command above; it printed `check-all: skipped: <name>` for each (e.g. `smoke:auto-mode`,
`smoke:eval-footprint`, `smoke:subagent-roles-isolation`, `docs:mermaid`, `eval`, `profile:check`,
`test:security`).

## Publication / clean re-land (operator instruction 2026-11-12T03:15Z)

- Rebuilt the promotable line on `origin/stream/ops` (`a7cb461f`) as `pi/luna-ops-01-reland`
  (`15e5068` → cycle-19 commit `03c5305` → cycle-20 commit `b859d1e`). New messages cite only the
  `PG-52` / `PG-60` shapes; no retired single-letter board id appears in any subject or body.
- `node packages/core/prepush-scan.ts range --base a7cb461 a7cb461..b859d1e` — RAN, PASS.
  `6 commit(s) checked, no blocked identifiers or private paths` (exit 0). The blocked
  `3c7c8ae` is not in the range.
- Re-land diff `a7cb461..b859d1e` (excluding lockfile and record files) is 46585 chars, under the
  60000 review budget.
- The separate 2026-11-12T17:02Z failure (`publication blocked: pre-push leak scan could not
  complete; inspect the host mirror and destination`) did **not** recur in this cycle; the local
  scan completed. It remains a distinct defect to record if the host publish reports it again.
- The run branch `pi/luna-ops-01` stays non-promotable; the integrator fast-forwards `stream/ops`
  from `pi/luna-ops-01-reland`.
- The operator's removed hold file: no reason was recorded in the repository; this cycle treats the
  removal as deliberate (it unblocked the only actor able to rebuild the branch) and logs it here
  rather than restoring it.

## Independent review

A reviewer subagent that did not write the change inspected the diff and ran the four manual
fixtures above plus `smoke:autonomy-selfimprove`, `smoke:check-all-npm`, `docs:check`, `test:lint`,
`test:typecheck` (all exit 0). Verdict: **PASS**; no control path, `package.json` script, charter
change, test weakening or fail-closed loosening.

## Gate / budget

Cycle diff (excluding lockfile and record files) is 18154 chars, under the 60000 review budget. No
gate run here (host runs it on the pushed head).
