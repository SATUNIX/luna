---
name: engagement-conductor
category: orchestration-recovery
description: Drive durable Conductor engagement lifecycles across sessions. Use when a security engagement or large coding project needs multi-phase coordination and resumption, not for a single quick delegated task.
disable-model-invocation: true
triggers: ["security engagement", "/engagement", "engagement conductor", "conductor engagement", "conductor phase"]
---

# Engagement conductor

Use `/engagement start` to create the durable record, `/engagement status` to resume its phase and
gates, and `/engagement phase <name>` to advance it. Drive the lifecycle in order: intake,
authorisation, scoping, recon-planning, execution, evidence, independent-validation, reporting, and
close-out.

## Phase gates

Advancement is fail-closed: `verifier-board` verdicts must pass and Conductor must have no pending
validator findings. Resolve the recorded verifier or validator issue before trying to advance again;
do not treat a phase change as a substitute for evidence.

## Relationship to task orchestration

This composes the existing `agent-orchestration` flow above it. Use that skill for individual
planner/implementer/reviewer tasks; use Conductor to persist and govern the larger engagement. For
security work, read-only recon, planning, coding, and reporting can proceed autonomously, while
active target actions remain human-gated by `engagement-governance`.
