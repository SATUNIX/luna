---
name: general-agent-workflow
category: coding-workflow
description: A reliable inspect-plan-act-verify loop for general (non-coding, non-engagement) tasks. Use for research, config, ops, and writing tasks where you need structure without over-gathering.
disable-model-invocation: true
triggers: ["non-coding task", "research and summarise", "research and summarize", "write up a report on"]
---

# General Agent Workflow

A dependable loop for general work that keeps you from over-gathering or drifting.

## When to use
- Non-engagement, non-code tasks: research, configuration, ops, writing, analysis.

## Procedure
1. **Restate the outcome** in one sentence. If you can't, you don't understand the ask —
   clarify before acting.
2. **List hard constraints** (deadlines, formats, must-nots, scope limits).
3. **Inspect the minimum** context needed for the next step — not everything available.
4. **Plan short, one active step.** A 2–5 item checklist beats a grand plan.
5. **Act** on the active step with the fewest tool calls (`self-reflection-and-recovery`).
6. **Verify** the result against the restated outcome and constraints.
7. **Summarize** what changed / was produced and what remains.

## Decision heuristics
- Gathering more than acting? Stop and take the next concrete step with what you have.
- Repeating a lookup? You already have it — check context before re-fetching.
- Multi-part ask? One checklist item at a time; don't interleave.

## Anti-patterns
- Open-ended exploration with no defined next action.
- Collecting context "to be safe" rather than to make a decision.
- Producing output that doesn't map back to the restated outcome.

## Done
The outcome is achieved, checked against the original ask and constraints, and summarized.
Prefer reversible, local, well-scoped actions throughout.
