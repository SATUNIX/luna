# Proposal: cover the `glob` adapter shape in tool-firewall

**Run/cycle:** luna-guard-01 / 01
**Area:** guard precision (same incomplete-adapter family as F-12)
**Evidence:** `packages/extensions/src/tool-firewall/classify.ts` `adapterCovered`, the `shapes`
table (~line 2623-2637), lists `bash`, `powershell`, `read`, `write`, `edit`, `grep`, `find`,
`ls`, `read_symbol` and `tool_search`. `glob` is in `ADAPTER_TOOLS` and in the shipped policy as
a read-only tool, but has no shape entry, so `adapterCovered` returns false and every `glob` call
gets HIGH `incomplete_adapter` and `needsOperator`. That is the same card-wait class F-12 fixed
for null-valued edit keys.

## Proposed change

Add `glob: { pattern: "string", path: "string" }` (check the actual pi schema before finalising),
including any other optional fields the adapter accepts. Add a two-sided test in
`tests/firewall-shell-smoke.ts`: a normal `glob` call is low; an extra non-null field, a missing
pattern and a malformed path stay high. Measure the card frequency for `glob` before and after,
so the change has a baseline in the style of PG-23.

## Out of scope for cycle 01

The cycle's board items were F-12 and PG-23; this is a second adapter gap found during review and
needs its own measurement and tests.
