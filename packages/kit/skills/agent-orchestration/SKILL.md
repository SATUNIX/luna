---
name: agent-orchestration
category: orchestration-recovery
description: Delegate non-trivial work to scout/planner/implementer/reviewer subagents with exactly the context each needs, or run a saved workflow. Use when a task is large, multi-file or unfamiliar enough to warrant isolated specialists, or when the orchestrator flags a task for delegation.
disable-model-invocation: true
triggers: ["delegate this", "delegate to", "use subagents", "use sub-agents", "spin up agents", "spawn agents", "in parallel with agents", "planner agent", "implementer agent", "reviewer agent", "scout agent", "/workflow", "run a workflow", "run the workflow", "pi workflow", "use of subagents", "leverage subagents", "using subagents", "heavy use of subagents"]
---

# Agent Orchestration

For non-trivial work, don't do everything in the main context. Delegate through the
`subagent` tool so each specialist works in its own context window. You orchestrate and keep
your own context lean.

## Roles (built in; add your own in ~/.pi/agent/agents)
- **scout**: fast, cheap recon on large or unfamiliar code.
- **planner**: investigates and writes a concrete plan. Read-only.
- **implementer**: executes one scoped unit. Run several in parallel (`tasks`) only when
  their files don't overlap.
- **reviewer**: validates the result. It's the final gate (Verdict PASS/FAIL).
- **delegator**: fans a broad task out to other roles (may nest once).

## Standard flow
1. (optional) scout → 2. planner → 3. implementer(s) → 4. reviewer. On FAIL, loop back to an
   implementer with the must-fix list. **Don't report done until the reviewer passes.**
2. Linear shortcut: `subagent({ chain: [{agent:"planner",task:"…"}, {agent:"implementer",task:"{previous}"}, {agent:"reviewer",task:"{previous}"}] })`.
3. For a repeatable multi-step flow, prefer a **workflow** (`workflow_run`, `/workflow list`).
   Workflows run steps deterministically, hand files between steps, loop on review gates and
   can resume after an interruption.
4. When the control flow itself matters (fan-out over a discovered list, adversarial verify,
   loops until nothing new turns up), use a **script workflow** through the `workflow` tool,
   or a kit built-in (`understand`, `review-changes`, `design-panel`, `research-sweep`,
   `migrate`). Load the `workflow-authoring` skill before writing a script.

## Context budget per role
A subagent can't see this conversation. Give it the **minimum sufficient** context:
- **scout**: the goal, the symptom, the acceptance check, where to look. Not your
  hypotheses: its independence is the value.
- **planner**: the goal plus the scout's distilled findings.
- **implementer**: the approach, the **target files** and the **verification**. No
  transcript, no rejected alternatives.
- **reviewer**: the change plus the acceptance criteria.

Ask for a **distilled result** back (the answer, file:line, decision, verdict), never raw
output.

## Control
- Esc cancels running subagents. `background: true` detaches long single/parallel work;
  you're notified when it finishes.
- `/subagents` shows runs; `subagent_status id=<run>` tails a log; `/subagent-stop` stops.

## When NOT to delegate
Trivial, single-file or read-only questions: answer directly. Delegation has overhead. Use it
when plan → implement → validate actually earns its keep.
