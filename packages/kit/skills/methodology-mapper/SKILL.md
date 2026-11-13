---
name: methodology-mapper
category: engagement
description: Map observations and hypotheses to methodology coverage (OWASP/WSTG/PTES). Use when tracking assessment coverage or checking which methodology areas remain untested — methodology guidance never changes scope, ROE, approval, or evidence thresholds.
disable-model-invocation: true
triggers: ["owasp", "wstg", "ptes", "methodology coverage"]
---

# Methodology Mapper

Map what you've observed to a recognised methodology so coverage and gaps are visible —
without letting the methodology loosen any control.

## When to use
- Tracking assessment coverage, or checking which methodology areas remain untested.

## Procedure
1. For each observation/hypothesis, map it to the relevant coverage item(s)
   (OWASP Top 10 / WSTG, PTES phase, etc.).
2. Mark each coverage item as tested / partially tested / not tested, with the linked
   evidence or hypothesis IDs.
3. Surface **gaps** (untested in-scope areas) as candidate next steps — subject to
   scope/ROE.

## Hard rule
Methodology guidance is **advisory only**. It cannot change scope, ROE, approval
requirements, or evidence thresholds. A methodology "expects" a test does not authorize it
— `scope-roe-governance` and `action-card-builder` still gate every active action.

## Done
Coverage is mapped with evidence links, gaps are visible as candidates, and no methodology
mapping has overridden a governance control.

## References
- `references/coverage-map.md` — WSTG areas, OWASP API Top 10, PTES phases, coverage states,
  and how to report gaps.
