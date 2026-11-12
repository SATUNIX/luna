# Proposal: register the refusal-record smoke as its own check

Cycle: `luna-guard-01/02`. Status: open for the operator (a `package.json` `scripts` change is a
control-path change refused before review).

## What

`tests/firewall-refusal-record.ts` is a standalone, self-contained smoke
(`node tests/firewall-refusal-record.ts` passes on its own). `tests/firewall-outcomes-smoke.ts`
imports `checkRefusalRecords()` and awaits it, so the check runs inside `npm run smoke:firewall-outcomes`
(and `npm run test:security`) without touching `package.json`. The file deliberately does not use
the `-smoke` suffix: `packages/core/lib/wiring.ts` treats every `*-smoke.ts` as a suite that a manifest script
must name, and the manifest is a control path this cycle may not change.

## Suggested change

Add one script, so the check can be selected directly and appears by name in `check-all --list`:

```json
"smoke:firewall-refusal-record": "node tests/firewall-refusal-record.ts"
```

`check-all.ts` enumerates `smoke:*` / `test:*` scripts from the manifest, so the script is then a
first-class check selectable by name; `test:security` already reaches the same checks through
`firewall-outcomes-smoke.ts`, and `coveredAggregates` keeps a standalone script from
double-counting it. No source change is needed beyond the manifest line.

## Why not now

The cycle rules refuse a merge that changes any `package.json` `scripts` entry. The acceptance file
exists, runs, and is wired through the existing security suite; only direct selection by name is
missing.

## Out of scope here (recorded, not done)

- Quoted search-token roles in the secret-guard shell parser (cycle 01 proposal).
- The `glob` adapter's input shape (cycle 01 proposal).
- The shared refusal helper duplicates tool-firewall's audit append; rotation and path options are
  kept in sync deliberately (a comment in `packages/core/shared/refusal-record.ts` names the
  firewall as the source). A future refactor could expose one append function from the firewall,
  but self-containment forbids the firewall import in secret-guard.
