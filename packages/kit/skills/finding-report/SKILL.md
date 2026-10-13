---
name: finding-report
category: evidence-reporting
description: Render a validated finding into the house report format — data block, risk statement, background, overview, remediation, evidence. Use when turning a finding-ready observation into the client-facing write-up, so every deliverable reads the same way.
disable-model-invocation: true
triggers: ["finding report", "house format", "report format", "format the finding", "render the finding", "write the finding report"]
---

# Finding Report

The house rendering of a **finding-ready** observation. This skill is about *shape*, not proof:
it composes the discipline of `finding-writing` (every claim traced to evidence) and
`evidence-review` (evidence IDs and hashes). Formatting never upgrades an unproven claim or adds a
statement the evidence does not already support.

## When to use
- Turning a `finding-ready` observation (`hypothesis-lifecycle`) into the client-facing deliverable.
- Re-formatting an existing finding into the house layout for export.

## When not to use
- The observation is not yet `finding-ready` — go to `hypothesis-lifecycle` / `finding-writing`
  first. A nicely formatted finding with no evidence is still not a finding.

## Structure (emit in this order)
1. **Finding data block** — YAML (preferred) or a two-column table, with exactly these keys:
   `Likelihood`, `Impact`, `Access Required`, `CVSS 4.0 Vector`, `MITRE ATT&CK`, `Affected Asset`.
   See `references/field-values.md` for the allowed values and the CVSS 4.0 base vector.
2. **Risk Statement** — one professional paragraph. Say **"threat actor"**, never "attacker" /
   "hacker" / "bad guy". Carry the reader through three beats, in order, using the cue phrases:
   **"Due to"** (the weakness) → **"There is a risk that"** (what a threat actor could do) →
   **"Resulting in"** (the business consequence). One flowing paragraph, not three bullet points.
3. **Background** — high-level, *general* context on the technologies in play, to jog the reader's
   memory (e.g. for a certificate finding: what TLS, certificates and a trusted CA are and why
   validation matters). Reusable across engagements; **no** environment specifics, no numbers, and
   nothing that needs an evidence ID. It educates; it does not accuse.
4. **Overview** — the *specific* issue in this environment, explained clearly: what was found,
   where, and why it is a problem here. This is where the environment specifics and evidence-backed
   detail live (contrast with Background, which stays general).
5. **Remediation** — a numbered list. Each item is a **single imperative sentence**, **single
   level** (no nested bullets, no sub-steps). Specific to the actual sink/config, ordered most to
   least impactful.
6. **Evidence** — reference every supporting artefact by its **Evidence ID** (never paste raw
   secrets or PII). For screenshots and images, give a **caption list**: one concise caption per
   image, in the order they should appear, each naming what the reader is looking at.

## Rules
- Severity reflects **demonstrated** impact × exploitability, not a scanner label (`finding-writing`).
- The data block, risk statement and overview must agree — the same likelihood/impact story in all three.
- Every claim in the Overview and Remediation traces to an Evidence ID; unsupported lines are cut, not hedged.
- Background and Remediation carry no evidence IDs (general knowledge and instructions, respectively).
- Applies to the pentest reporting workflow; use the engagement's own evidence store for the IDs.

## Anti-patterns
- "attacker could potentially…" — wrong noun *and* unproven. Use "threat actor" and only state what evidence supports.
- A Background that describes *this* system (that belongs in Overview) or a risk statement split into three fragments instead of one paragraph.
- Multi-sentence or nested remediation items; generic advice ("sanitise inputs") not tied to the real fix.

## Done
All six sections present and in order; "threat actor" throughout; the risk statement runs Due to →
There is a risk that → Resulting in; remediation is single-sentence single-level; every Overview/
Remediation claim has an Evidence ID and every image has a caption. Then check export readiness with
`report-export-review`.

## References
- `references/format-template.md` — a copy-fill template with a worked certificate example.
- `references/field-values.md` — the CVSS 4.0 base vector, likelihood/impact/access scales, and how to cite ATT&CK.
- Related: `finding-writing`, `evidence-review`, `methodology-mapper`, `report-export-review`.
