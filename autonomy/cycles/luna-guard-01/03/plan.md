# Cycle 03 plan — luna-guard-01 (guard stream)

## Goal

Restore a green gate on the carried-over PG-24 work and close its remaining evidence gap, then
merge the cycle only after the targeted checks and an independent review pass.

## Items

### Item 1 (priority 0): fix `smoke:extension-manifest-hooks`

- Justification: charter priority 0 (red gate); the cycle-02 host gate failed on this check and the
  cycle never diagnosed it.
- Change: add `node:crypto` to `packages/extensions/src/secret-guard/extension.json` →
  `runtime.nodeBuiltins`, matching what `shared/refusal-record.ts` imports (the tool-firewall
  manifest already declares it). Keep generated shared copies unchanged.
- Proof: `npm run smoke:extension-manifest-hooks` (regression that currently fails); `npm run
  verify` re-checks manifest/code consistency.

### Item 2 (PG-24 carry-over): pin the secret-content refusal record

- Justification: PG-24 acceptance requires a refused call to append one JSON record with cause and
  matched token and no full command; cycle 02 proved that for path and shell refusals but not for
  the content classifier. Reviewer REJECT named this gap.
- Change: add a case to `tests/firewall-refusal-record.ts` that sends `write` with a
  private-key/AWS-key payload (no secret path) and asserts `tool_refused` has
  `cause: "secret-content"`, `matched` equal to the pattern label, and neither the secret value
  nor the payload appears in the record. If the assertion exposes a leak, fix `blocked()` so
  `matched` is the label only (it already is by construction). Update the secret-guard README
  record description if needed.
- Proof: `node tests/firewall-refusal-record.ts` (new case), `npm run smoke:firewall-outcomes`,
  `npm run smoke:secret-guard`, `npm run test:typecheck`, `npm run test:lint`.

### Item 3: carry over, verify and record cycle-02 code

- The five sound cycle-02 commits are cherry-picked on this branch (refusal helper + generated
  copies, both guards' `blocked()`, fence sync, docs). No new behaviour beyond items 1–2.
- Proof: the `--for-changed` plan in `verify.md`, including `smoke:workflow-notify`,
  `smoke:new-extension`, `docs:check`, `smoke:docs`, `verify`, and `gen-shared --check`.

## Out of scope / proposals

- Register `smoke:firewall-refusal-record` in `package.json` (control path): existing proposal
  `autonomy/proposals/luna-guard-01-02-register-refusal-record-script.md`.
- `luna-metrics.py` should read `tool_refused` instead of scraping session JSONL: next cycle.
- Cycle 01 proposals stay open.

## Diff budget

Carried-over diff measured at 55982 characters before the two small additions (limit 30000 for new
items; hard review limit 60000). This cycle adds only the manifest line, one test case and docs, so
no new board items are taken.

## Checks

```
node packages/core/check-all.ts --for-changed="$(git diff --name-only e52f4362f991..HEAD | tr '\n' ',')"
```

plus the standalone refusal suite and the direct manifest-hooks smoke. Never `npm test` or
`npm run check:all` in this session; the host gate runs them.
