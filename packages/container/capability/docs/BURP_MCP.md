# Burp MCP Setup

This capability does not bundle or run a Burp MCP server. It provides Pi MCP client capability through `pi-mcp-adapter@2.8.0` and uses `host.docker.internal` so a Burp MCP bridge running on the host can be reached from the container.

## Expected Topology

```text
Pi inside container
  -> pi-mcp-adapter proxy tool
  -> pentest governance extension
  -> local pi_system_governance MCP server for evidence/state writes
  -> Burp MCP endpoint on host.docker.internal
  -> Burp Suite
```

## Example `.pi/mcp.json`

Copy this into a Pi System overlay or project-local MCP config when the Burp MCP bridge is available:

```json
{
  "settings": {
    "toolPrefix": "server",
    "directTools": false,
    "sampling": false,
    "samplingAutoApprove": false,
    "autoAuth": false,
    "elicitationAutoOpenUrls": false
  },
  "mcpServers": {
    "pi_system_governance": {
      "command": "node",
      "args": ["/workspace/.pi/mcp-servers/governance/index.ts"],
      "lifecycle": "lazy",
      "directTools": false,
      "sampling": false,
      "samplingAutoApprove": false
    },
    "burp": {
      "url": "http://host.docker.internal:9876/mcp",
      "lifecycle": "lazy",
      "directTools": false,
      "debug": false
    }
  }
}
```

If your Burp MCP server uses stdio instead of HTTP, use a stdio config in the container and ensure the command is installed in the image or mounted in by policy.

## Tool Policy

Classify Burp tools locally before allowing use. Example mappings are in:

```text
engagement/tool-policy.example.yaml
engagement/tool-policy.json
```

Keep read-only history/sitemap tools as `read_only`. Classify request-sending tools as `low_risk_active_validation` or higher and require exact local classification plus hash-bound approval before execution. The approval card should include the server, tool name, target, exact parameters, expected side effects, risk class, and expected evidence.

## First Workflow

1. Start Burp Suite on the host.
2. Start the Burp MCP bridge on a host port reachable as `host.docker.internal`.
3. Deploy or restart this capability.
4. Run `pi-pentest`.
5. Use `/mcp` to inspect adapter status.
6. Search or describe tools through the MCP proxy.
7. Update local tool policy before active use.
8. Let the governance extension produce approval prompts for non-read-only actions.
9. Append evidence through `pi_system_governance.evidence_append`.
