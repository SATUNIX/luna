# engagement-governance

Engagement-specific governance domain layer. Composes after `tool-firewall` with scope/ROE enforcement, MCP-only operation, action-card approval, protected engagement paths, and SHA256-chained audit.

The general allow/ask/deny policy gate belongs to `tool-firewall`; this extension handles engagement domain semantics.

Tools outside the pre-approved list go through an approval step and may take a little time. Do not route around a denial with another tool; adapt the approach instead. If genuinely blocked after scouting, use `ask_human` with concrete options where possible.

MCP-only mode (which routes `write`/`edit`/`bash` through the audited governance MCP path) is
active by default only once a real engagement is configured (both `scope.yaml` and `roe.yaml`
present and complete) — see `docs/security.md`. Without one, this extension still enforces
protected-path checks, destructive-bash denial, and audit logging, but does not itself gate
direct tools. Override with `PI_ALLOW_DIRECT_TOOLS=1`/`=0`. Luna's own first-party tools
(`todo`, `subagent`, `task_*`, `record_verdict`, `verdict_status`, `memory_*`, `mem0_*`,
`skill_*`, `branch_*`) are always exempt from MCP-only mode.

Inputs:

- `engagement/scope.yaml` or `engagement/scope.example.yaml`
- `engagement/roe.yaml` or `engagement/roe.example.yaml`
- optional `engagement/tool-policy.json` metadata for risk/action labels

Commands:

- `/engagement:status`
- `/engagement:actions`
- `/engagement:reload-policy`
