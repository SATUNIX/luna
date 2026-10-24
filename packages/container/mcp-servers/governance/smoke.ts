#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
process.env.PI_KIT_PATH ||= path.resolve(here, "../../../pi-system");
process.env.PI_KIT_MEMORY_MCP_ARGS ||= path.resolve(here, "../memory-mcp/index.ts");

const transport = new StdioClientTransport({
  command: "node",
  args: ["./index.ts"],
  // process.env's type allows undefined values; the SDK's env is Record<string, string>.
  env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
});

const client = new Client({
  name: "pi-system-governance-smoke",
  version: "0.1.0"
});

await client.connect(transport);
try {
  const listed = await client.listTools();
  const toolNames = new Set(listed.tools.map((tool) => tool.name));
  for (const required of [
    "evidence_append",
    "note_append",
    "checkpoint_append",
    "task_state_read",
    "task_state_update",
    "memory_append",
    "verification_append",
    "state_summary"
  ]) {
    if (!toolNames.has(required)) {
      throw new Error(`missing MCP tool: ${required}`);
    }
  }

  await client.callTool({
    name: "note_append",
    arguments: {
      note: "governance MCP smoke test",
      category: "validation"
    }
  });

  await client.callTool({
    name: "task_state_update",
    arguments: {
      task_id: "smoke-task",
      title: "Governance MCP smoke",
      status: "active",
      active_step: "Validate state summary",
      next_step: "Finish smoke test"
    }
  });

  await client.callTool({
    name: "state_summary",
    arguments: {
      max_items: 3
    }
  });
} finally {
  await client.close();
}

console.error("Governance MCP smoke checks passed");
