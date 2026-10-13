---
name: finding-writing
category: evidence-reporting
description: Write evidence-backed, professional pentest findings. Use when turning a validated observation into a report finding — every claim traced to evidence, with impact, reproduction, severity rationale, remediation, and limitations.
disable-model-invocation: true
triggers: ["write a finding", "write the finding", "write up the finding", "pentest report", "finding write-up"]
---

# Finding Writing

A finding is a claim you can defend. Every statement traces to validated evidence; anything
you can't support is removed, not softened.

## When to use
- Turning a `finding-ready` observation (`hypothesis-lifecycle`) into a written finding.

## Required elements
1. **Title** — specific and neutral (what, where).
2. **Impact** — the concrete business/security consequence, tied to evidence.
3. **Affected assets** — exact in-scope hosts/endpoints/objects.
4. **Reproduction** — precise, minimal steps another tester can follow.
5. **Exploitability constraints** — preconditions, required privileges, what limits it.
6. **Severity rationale** — why this rating (impact × likelihood/constraints), not just a
   number.
7. **Remediation** — actionable and specific to the code/config, not generic advice.
8. **Limitations** — what you tested and deliberately did not; scope/ROE boundaries.
9. **False-positive check** — how you confirmed it's real.
10. **Evidence IDs/hashes** for every claim (`evidence-review`).

## Rules
- **Only validated evidence.** No unproven claims, no speculation dressed as fact.
- **Remove, don't hedge.** If you can't support it, cut it.
- **No raw sensitive data** in the finding — reference by evidence ID.
- Match the severity rationale to actual, demonstrated impact — don't inflate.

## Anti-patterns
- "Could potentially allow…" with no validation.
- Generic remediation ("sanitize inputs") not tied to the actual sink.
- Severity driven by a scanner label rather than demonstrated impact.

## Done
Every element is present, each claim has an evidence ID, severity is justified, and nothing
unsupported remains. Check readiness with `report-export-review` before export.

## References
- `references/severity-and-template.md` — severity rubric (impact × exploitability), CVSS
  note, a copy-fill finding template, and the pre-export writing checklist.
- `finding-report` — render the validated finding into the house deliverable format (data block,
  risk statement, background, overview, remediation, evidence).
