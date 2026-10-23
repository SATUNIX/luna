// Minimal ambient types for @modelcontextprotocol/sdk.
//
// This file mirrors @modelcontextprotocol/sdk 1.29.0 (the version pinned in
// governance/package.json and memory-mcp/package.json) and MUST be updated when that pin
// changes. The SDK is installed only inside the container image (/opt/pi-agent/mcp-servers),
// not in the repo, so the type-check needs these declarations. They declare only the surface
// the governance and memory-mcp servers and the governance smoke use, copied from the
// published dist/esm/*.d.ts with the zod-v3 branches dropped (both servers use zod 4).

declare module "@modelcontextprotocol/sdk/shared/transport.js" {
  /** A JSON-RPC 2.0 message; the SDK's union of request, notification, result and error. */
  export interface JSONRPCMessage {
    jsonrpc: "2.0";
    [key: string]: unknown;
  }

  export interface Transport {
    start(): Promise<void>;
    send(message: JSONRPCMessage): Promise<void>;
    close(): Promise<void>;
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: JSONRPCMessage) => void;
  }
}

declare module "@modelcontextprotocol/sdk/types.js" {
  /** Server or client identity sent during initialisation (ImplementationSchema). */
  export interface Implementation {
    name: string;
    version: string;
    title?: string;
    description?: string;
    websiteUrl?: string;
  }

  export interface TextContent {
    type: "text";
    text: string;
    _meta?: Record<string, unknown>;
  }

  /** Result of a tools/call request (CallToolResultSchema, a loose object). */
  export interface CallToolResult {
    content: TextContent[];
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
    _meta?: Record<string, unknown>;
    [key: string]: unknown;
  }

  export interface Tool {
    name: string;
    title?: string;
    description?: string;
    inputSchema: { type: "object"; properties?: Record<string, object>; required?: string[]; [key: string]: unknown };
    [key: string]: unknown;
  }
}

declare module "@modelcontextprotocol/sdk/server/mcp.js" {
  import type * as z4 from "zod/v4/core";
  import type { CallToolResult, Implementation } from "@modelcontextprotocol/sdk/types.js";
  import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

  // server/zod-compat.d.ts (zod 4 branch only).
  export type AnySchema = z4.$ZodType;
  export type ZodRawShapeCompat = Record<string, AnySchema>;
  export type SchemaOutput<S> = S extends z4.$ZodType ? z4.output<S> : never;
  export type ShapeOutput<Shape extends ZodRawShapeCompat> = {
    [K in keyof Shape]: SchemaOutput<Shape[K]>;
  };

  /** The per-request context the SDK passes as the handler's last argument (RequestHandlerExtra). */
  export interface RequestHandlerExtra {
    signal: AbortSignal;
    sessionId?: string;
    [key: string]: unknown;
  }

  export type ToolCallback<Args extends undefined | ZodRawShapeCompat | AnySchema = undefined> =
    Args extends ZodRawShapeCompat
      ? (args: ShapeOutput<Args>, extra: RequestHandlerExtra) => CallToolResult | Promise<CallToolResult>
      : Args extends AnySchema
        ? (args: SchemaOutput<Args>, extra: RequestHandlerExtra) => CallToolResult | Promise<CallToolResult>
        : (extra: RequestHandlerExtra) => CallToolResult | Promise<CallToolResult>;

  export interface ToolAnnotations {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  }

  export interface RegisteredTool {
    enabled: boolean;
    enable(): void;
    disable(): void;
    remove(): void;
  }

  export interface ServerOptions {
    instructions?: string;
  }

  export class McpServer {
    constructor(serverInfo: Implementation, options?: ServerOptions);
    connect(transport: Transport): Promise<void>;
    close(): Promise<void>;
    // 1.29.0 also has an OutputArgs type parameter for outputSchema; it is unused here.
    registerTool<InputArgs extends undefined | ZodRawShapeCompat | AnySchema = undefined>(
      name: string,
      config: {
        title?: string;
        description?: string;
        inputSchema?: InputArgs;
        outputSchema?: ZodRawShapeCompat | AnySchema;
        annotations?: ToolAnnotations;
        _meta?: Record<string, unknown>;
      },
      cb: ToolCallback<InputArgs>
    ): RegisteredTool;
  }
}

declare module "@modelcontextprotocol/sdk/server/stdio.js" {
  import type { Readable, Writable } from "node:stream";
  import type { JSONRPCMessage, Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

  export class StdioServerTransport implements Transport {
    constructor(stdin?: Readable, stdout?: Writable);
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: JSONRPCMessage) => void;
    start(): Promise<void>;
    send(message: JSONRPCMessage): Promise<void>;
    close(): Promise<void>;
  }
}

declare module "@modelcontextprotocol/sdk/client/index.js" {
  import type { CallToolResult, Implementation, Tool } from "@modelcontextprotocol/sdk/types.js";
  import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

  export class Client {
    constructor(clientInfo: Implementation);
    connect(transport: Transport): Promise<void>;
    close(): Promise<void>;
    listTools(): Promise<{ tools: Tool[]; [key: string]: unknown }>;
    callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<CallToolResult>;
  }
}

declare module "@modelcontextprotocol/sdk/client/stdio.js" {
  import type { JSONRPCMessage, Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

  export interface StdioServerParameters {
    command: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
  }

  export class StdioClientTransport implements Transport {
    constructor(server: StdioServerParameters);
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: JSONRPCMessage) => void;
    start(): Promise<void>;
    send(message: JSONRPCMessage): Promise<void>;
    close(): Promise<void>;
  }
}
