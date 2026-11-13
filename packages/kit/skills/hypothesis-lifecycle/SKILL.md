---
name: hypothesis-lifecycle
category: engagement
description: Track assessment observations from candidate hypothesis to finding-ready. Use during security assessment reasoning to keep claims disciplined — every state change needs evidence, a limitation, or an operator decision.
disable-model-invocation: true
triggers: ["hypothesis", "finding-ready"]
---

# Hypothesis Lifecycle

Assessment claims must earn each step toward becoming a finding. Track state explicitly so
nothing reaches a report on a hunch.

## When to use
- Any assessment reasoning where observations may become findings.

## States
- `candidate` — plausible observation, not tested.
- `testing` — approved validation planned or underway.
- `validated` — evidence supports the claim.
- `rejected` — evidence disproves the claim.
- `inconclusive` — evidence insufficient or blocked by ROE.
- `finding-ready` — validated, impact understood, evidence IDs recorded.

## Transition rule
**Every transition needs one of:** supporting/disproving **evidence**, a stated
**limitation**, or an **operator decision**. No transition on reasoning alone.

## Procedure
1. Record the observation as `candidate`.
2. To move to `testing`, confirm the validation is in scope and approved
   (`scope-roe-governance`, `action-card-builder`).
3. Record evidence with IDs/hashes (`evidence-review`); move to `validated` / `rejected` /
   `inconclusive` based on what it shows.
4. Only `validated` observations with understood impact and recorded evidence become
   `finding-ready` (`finding-writing`).

## Anti-patterns
- Promoting a claim without evidence.
- Skipping `inconclusive` when ROE blocks validation (don't overclaim).
- Carrying rejected hypotheses into a report.

## Done
Each observation has an explicit state with a justified last transition; only evidence-
backed, impact-understood claims are `finding-ready`.
