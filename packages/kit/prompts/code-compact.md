---
argument-hint: "[focus]"
mode: compact
token_budget: small
requires_mcp_tool: pi_system_governance.state_summary
output_block: task_state
---

# Code Compact

Summarize coding task state for continuation.

Focus: ${@:-the whole current task}

If the `pi_system_governance` MCP server is available, first read compact durable state through `pi_system_governance.state_summary` with `max_items` no higher than 5. Without it, work from the conversation and any checkpoint already in context. Do not dump raw logs or full diffs.

Preserve:

- Objective and non-goals
- Current plan
- Files read and why
- Files changed
- Commands run and outcomes
- Current failure or blocker
- Verification status
- Unresolved risks
- Exact next action

Exclude secrets and sensitive data.

Return this stable block:

```text
task_state:
  objective:
  non_goals:
  active_step:
  files_read:
  files_changed:
  commands_run:
  validation:
  blocker:
  risks:
  next_action:
```
