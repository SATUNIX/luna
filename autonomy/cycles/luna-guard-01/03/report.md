Outcome: successful
Mode: fix

Board: PG-24 done - both guards now append one structured `tool_refused` record per refusal (cause, guard, matched token/rule, command digest, session id, no command text), the manifest gate is green, and the secret-content label guarantee is pinned by a two-sided test.

Item: Carry over the cycle-02 refusal-record helper and both guards' `blocked()` wiring - 1b216ca - `node tests/firewall-refusal-record.ts` (5 checks) and `npm run smoke:firewall-outcomes` (14 checks).
Item: Restore the audit table row and bound the refusal log with rotation - 08ceb2d - `node tests/firewall-refusal-record.ts` rotation case and `npm run smoke:firewall-outcomes`.
Item: Rename the refusal suite to satisfy the wiring gate and keep it reachable through the wired suite - 87e50a8 - `npm run smoke:firewall-outcomes` imports and awaits `checkRefusalRecords()`.
Item: Correct the refusal header and proposal path in the guard docs - 0d1a677 - `npm run smoke:docs` and `npm run verify`.
Item: Sync the subagent fence with the secret-read rule - ae85343 - `npm run smoke:workflow-notify` (10 checks) and `npm run smoke:subagent-roles-isolation` (7 checks).
Item: Declare `node:crypto` in the secret-guard manifest to clear the red gate - 52ca07c - `npm run smoke:extension-manifest-hooks` (8 checks, exit 0).
Item: Pin the secret-content refusal record (label, not content) and document it - 7df2593 - `node tests/firewall-refusal-record.ts` "a secret-content refusal names the pattern label and never the content".
Item: Re-indent the PG-24 refusal-record call into its try block - a54463f - `npm run smoke:firewall-outcomes` (whitespace only).

## What changed

- Priority-0 red gate: `packages/extensions/src/secret-guard/extension.json` now declares
  `node:crypto`, matching the generated `shared/refusal-record.ts` import. Cycle 02's host gate
  failed on this and the cycle never diagnosed it; `smoke:extension-manifest-hooks` exits 0 now.
- PG-24 evidence gap: `tests/firewall-refusal-record.ts` gains a secret-content case that builds a
  fake provider-key-shaped value in-test (no secret path) and asserts exactly one new
  `tool_refused` with `guard: "secret-guard"`, `cause: "secret-content"`, `matched` equal to the
  pattern label `provider API key (sk-)`, no `commandDigest`, and no secret content anywhere in the
  serialized record. The secret-guard README states that `matched` is the label for content
  refusals.
- Carried-over cycle-02 code (five commits) is on this branch: shared helper plus generated copies,
  both guards' records, rotation, fence sync, docs.

## Acceptance

- Red gate repaired: `npm run smoke:extension-manifest-hooks` exit 0.
- PG-24 acceptance artifact: the spec named `tests/firewall-refusal-record-smoke.ts`; that name is
  not usable because `packages/core/lib/wiring.ts` treats every `*-smoke.ts` as a suite requiring a
  `package.json` script, and a manifest `scripts` change is refused this cycle. The suite lives at
  `tests/firewall-refusal-record.ts`, is imported and awaited by the wired
  `tests/firewall-outcomes-smoke.ts`, and the operator registration is filed as proposal
  `autonomy/proposals/luna-guard-01-02-register-refusal-record-script.md`.
- Independent reviewer verdict: PASS (see `verify.md`).
- Diff against base `e52f4362f991`: 58,006 characters excluding lockfile and cycle/run records,
  under the 60,000 review limit. The cycle added only the manifest line, one test case, one README
  sentence and a whitespace re-indent on top of the carried-over code.

## Left over (proposals, not defects in this cycle's grant)

- `autonomy/proposals/luna-guard-01-02-register-refusal-record-script.md`: register the standalone
  refusal suite in `package.json` (control path, operator).
- `luna-ops/luna-metrics.py` still scrapes session JSONL; it should consume `tool_refused` next
  cycle.
- Cycle 01 proposals stay open: quoted search token command scan, `glob` adapter coverage,
  standalone benign-corpus script registration.
