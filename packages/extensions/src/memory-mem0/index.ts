import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import https from "node:https";
import http from "node:http";
import path from "node:path";
import { URL, fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

// Wraps the mem0 REST API. Requires MEM0_API_URL (e.g. http://localhost:8000) and optionally MEM0_API_KEY.
// See packages/container/mcp-servers/memory-mcp/README.md for Docker setup. Status experimental: needs the mem0/Qdrant service running,
// so it ships only in the experimental self-improving profile — the implementation itself is real, not a stub.

const MEM0_URL = process.env.MEM0_API_URL ?? "";
const MEM0_KEY = process.env.MEM0_API_KEY ?? "";
const MEM0_USER = process.env.MEM0_USER_ID ?? "pi-agent";
const MEMORY_BACKEND = process.env.PI_KIT_MEMORY_BACKEND ?? "mcp";
const MCP_COMMAND = process.env.PI_KIT_MEMORY_MCP_COMMAND ?? "node";
// The default memory server is the one shipped beside this extension, resolved from this file,
// never from the working directory: a cwd-relative script would let any opened repository plant
// packages/container/mcp-servers/memory-mcp/index.ts and have an auto-allowed tool run it (ORC-2).
const DEFAULT_MCP_SCRIPT = fileURLToPath(new URL("../../../container/mcp-servers/memory-mcp/index.ts", import.meta.url));
const MCP_ARGS = process.env.PI_KIT_MEMORY_MCP_ARGS === undefined ? [DEFAULT_MCP_SCRIPT] : process.env.PI_KIT_MEMORY_MCP_ARGS.split(/\s+/).filter(Boolean);

/**
 * Why the configured MCP command line would resolve code against the working directory, or null
 * when it does not. A command with a path separator must be absolute (a bare name is looked up on
 * PATH), and every non-flag argument, the script path included, must be an absolute path.
 */
function cwdRelativeMcpTarget(command: string, args: readonly string[]): string | null {
  if (/[\\/]/.test(command) && !path.isAbsolute(command)) {
    return `PI_KIT_MEMORY_MCP_COMMAND "${command}" is a relative path; set an absolute path`;
  }
  for (const arg of args) {
    if (!arg.startsWith("-") && !path.isAbsolute(arg)) {
      return `PI_KIT_MEMORY_MCP_ARGS argument "${arg}" is not an absolute path; script arguments must be absolute so a repository cannot supply the script`;
    }
  }
  return null;
}

const CIRCUIT_THRESHOLD = 3;
const REQUEST_TIMEOUT_MS = 5000;
const execFileAsync = promisify(execFile);

let circuitFailures = 0;
let circuitOpen = false;

// Future transport swap point
type MemMcpTransport = { post(path: string, body: unknown): Promise<{ status: number; data: unknown }> };

const memoryMcpTransport: MemMcpTransport = {
  async post(toolPath: string, body: unknown) {
    const toolName = toolPath.replace(/^\/+/, "");
    const refused = cwdRelativeMcpTarget(MCP_COMMAND, MCP_ARGS);
    if (refused) throw new Error(refused);
    const { stdout } = await execFileAsync(MCP_COMMAND, [...MCP_ARGS, "--call", toolName, JSON.stringify(body)], {
      timeout: REQUEST_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    try {
      return { status: 200, data: JSON.parse(stdout) };
    } catch {
      // A broken child or a bad --call can print non-JSON. Mirror the HTTP transport below and
      // hand back the raw text instead of throwing out of the transport layer.
      return { status: 200, data: stdout };
    }
  },
};

function request(method: string, urlStr: string, body?: unknown): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    // A malformed MEM0_API_URL should reject with a clear reason rather than a raw TypeError
    // escaping the executor.
    let url: URL;
    try {
      url = new URL(urlStr);
    } catch {
      reject(new Error(`mem0: invalid URL "${urlStr}"`));
      return;
    }
    const payload = body ? JSON.stringify(body) : undefined;
    const opts = {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(MEM0_KEY ? { Authorization: `Token ${MEM0_KEY}` } : {}),
        ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
      },
    };
    const transport = url.protocol === "https:" ? https : http;
    const req = transport.request(url, opts, (res) => {
      let buf = "";
      res.on("data", (c: Buffer) => { buf += c.toString(); });
      res.on("end", () => {
        clearTimeout(timer);
        // An HTTP error is a failure, not a successful response: resolve only 2xx so
        // safeRequest's catch increments the circuit counter. Mirrors memory-local.
        const status = res.statusCode ?? 0;
        if (status >= 400) {
          reject(new Error(`mem0: HTTP ${status}`));
          return;
        }
        try { resolve({ status, data: JSON.parse(buf) }); }
        catch { resolve({ status, data: buf }); }
      });
    });
    const timer = setTimeout(() => {
      req.destroy(new Error("timeout"));
    }, REQUEST_TIMEOUT_MS);
    req.on("error", (e) => { clearTimeout(timer); reject(e); });
    if (payload) req.write(payload);
    req.end();
  });
}

function notConfigured() {
  return {
    content: [{ type: "text" as const, text: "mem0 not configured. Set MEM0_API_URL and start the mem0 service (see packages/container/mcp-servers/memory-mcp/)." }],
    details: undefined,
  };
}

function mcpNotConfigured(err: unknown) {
  return {
    content: [{ type: "text" as const, text: `memory MCP unavailable: ${err instanceof Error ? err.message : String(err)}` }],
    details: undefined,
  };
}

function circuitDegraded() {
  return {
    content: [{ type: "text" as const, text: "mem0 unavailable: circuit open (3 consecutive failures). Restart session to reset." }],
    details: undefined,
  };
}

async function safeRequest(method: string, urlStr: string, body?: unknown): Promise<{ ok: true; status: number; data: unknown } | { ok: false; err: unknown }> {
  try {
    const res = await request(method, urlStr, body);
    circuitFailures = 0;
    return { ok: true, ...res };
  } catch (err) {
    circuitFailures++;
    if (circuitFailures >= CIRCUIT_THRESHOLD) circuitOpen = true;
    return { ok: false, err };
  }
}

export default function (_pi: ExtensionAPI) {
  _pi.registerTool({
    name: "mem0_add",
    label: "Mem0: add memory",
    description: "Add a memory to the mem0 service. Requires MEM0_API_URL env var and a running mem0 instance.",
    parameters: Type.Object({
      text: Type.String({ description: "Memory text to store" }),
    }),
    async execute(_id, params) {
      if (MEMORY_BACKEND !== "mem0") {
        try {
          const result = await memoryMcpTransport.post("memory_store", { topic: "mem0_add", content: params.text, tags: ["mem0-compatible"] });
          return { content: [{ type: "text" as const, text: `memory MCP add: ${JSON.stringify(result.data)}` }], details: undefined };
        } catch (err) {
          return mcpNotConfigured(err);
        }
      }
      if (!MEM0_URL) return notConfigured();
      if (circuitOpen) return circuitDegraded();
      const result = await safeRequest("POST", `${MEM0_URL}/memories/`, { messages: [{ role: "user", content: params.text }], user_id: MEM0_USER });
      if (!result.ok) return { content: [{ type: "text" as const, text: `mem0 error: ${String(result.err)}` }], details: undefined };
      return { content: [{ type: "text" as const, text: `mem0 add: ${JSON.stringify(result.data)}` }], details: undefined };
    },
  });

  _pi.registerTool({
    name: "mem0_search",
    label: "Mem0: search memory",
    description: "Search memories in the mem0 service. Requires MEM0_API_URL env var.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      limit: Type.Optional(Type.Number({ description: "Max results (default 5)" })),
    }),
    async execute(_id, params) {
      if (MEMORY_BACKEND !== "mem0") {
        try {
          const result = await memoryMcpTransport.post("memory_search", { query: params.query, limit: params.limit ?? 5 });
          return { content: [{ type: "text" as const, text: JSON.stringify(result.data, null, 2) }], details: undefined };
        } catch (err) {
          return mcpNotConfigured(err);
        }
      }
      if (!MEM0_URL) return notConfigured();
      if (circuitOpen) return circuitDegraded();
      const limit = params.limit ?? 5;
      const result = await safeRequest("POST", `${MEM0_URL}/memories/search/`, { query: params.query, user_id: MEM0_USER, limit });
      if (!result.ok) return { content: [{ type: "text" as const, text: `mem0 error: ${String(result.err)}` }], details: undefined };
      // The response is unknown: a non-list results field is no results, and an entry without a
      // string memory is shown as JSON rather than dereferenced.
      const data: unknown = result.data;
      const listed: unknown = Array.isArray(data) ? data : typeof data === "object" && data !== null ? Reflect.get(data, "results") : undefined;
      const results: unknown[] = Array.isArray(listed) ? listed : [];
      const text = results.map((r, i) => {
        const memory: unknown = typeof r === "object" && r !== null ? Reflect.get(r, "memory") : undefined;
        return `${i + 1}. ${typeof memory === "string" ? memory : JSON.stringify(r)}`;
      }).join("\n");
      return { content: [{ type: "text" as const, text: text || "No results." }], details: undefined };
    },
  });
}
