# Proposal: register the benign-command corpus as its own gate check

**Run/cycle:** luna-guard-01 / 01
**Area:** guard precision (PG-23)
**Target:** `package.json` `scripts` (a control path; the cycle may not change it)

## Need

PG-23 asks for `tests/firewall-benign-corpus-smoke.ts` registered in `package.json`.
`tests/*-smoke.ts` files run in the host gate only when a `package.json` script names them
(`packages/core/lib/wiring.ts`, `findWiringProblems`/`unwired`). This cycle therefore shipped the
corpus as `tests/firewall-benign-corpus.ts`, invoked from the already-wired
`tests/tool-firewall-smoke.ts`. That works but ties the corpus to one smoke file and hides a
failure's identity in `tool-firewall-smoke` output.

## Proposal

Add a script such as `"smoke:firewall-benign-corpus": "node tests/firewall-benign-corpus-smoke.ts"`
(plus the existing security-tier wiring) and rename/move the helper's runner entry point to that
file. Alternatively keep the helper and add a small `tests/firewall-benign-corpus-smoke.ts` that
imports `runFirewallBenignCorpus` and calls it. Register it in the security check list so the gate
runs it directly.

## Why not this cycle

The cycle prompt makes any change to a `package.json` `scripts` section a merge refusal before
review, and `/package.json` is a CODEOWNERS path. The behaviour is already exercised by
`tests/tool-firewall-smoke.ts`; only the standalone registration is missing.

## Acceptance

`node packages/core/check-all.ts --list` names the new check; `npm run smoke:firewall-benign-corpus`
runs exactly the 40-row corpus against the three handlers; `npm run verify` accepts the wiring.
