# memory-mem0

Mem0-compatible memory tools. By default (`PI_KIT_MEMORY_BACKEND` unset or `mcp`) the tools
proxy the kit memory MCP server; with `PI_KIT_MEMORY_BACKEND=mem0` they speak the legacy mem0
REST API directly (`MEM0_API_URL`, optional `MEM0_API_KEY` / `MEM0_USER_ID`).

## Memory MCP server location

The default transport runs `node <kit>/packages/container/mcp-servers/memory-mcp/index.ts --call
<tool> <json>`, with the script path resolved from this extension's own location, never from the
working directory, so a repository cannot supply the server. `PI_KIT_MEMORY_MCP_COMMAND` and
`PI_KIT_MEMORY_MCP_ARGS` (whitespace-separated) override the command line. Every argument that does
not start with `-` must be an absolute path, and a command containing a path separator must be
absolute (a bare name such as `node` is looked up on `PATH`). Anything else is refused with
`memory MCP unavailable: ...` and nothing is started. The memory server is not part of the npm
package, so outside a kit checkout the default transport reports itself unavailable. See
`tests/memory-mem0-smoke.ts`.

## Failure and circuit behaviour (legacy REST path)

An HTTP response with status `>= 400` is treated as a failure, not as a successful response:

- `mem0_search` and `mem0_add` report an error mentioning the HTTP status instead of returning
  `"No results."` or a `mem0 add: <error body>` success line.
- Each failure increments an in-process circuit counter and resets on the next successful (2xx)
  response. After three consecutive failures the circuit opens and subsequent calls return
  `mem0 unavailable: circuit open (3 consecutive failures). Restart session to reset.` without
  contacting the service.

See `tests/memory-mem0-smoke.ts` for the hermetic regression coverage (local `node:http`
server; no Docker/Qdrant).

## What is sent

`mem0_add` passes the memory text through the kit's secret-redaction table (`shared/redact.ts`,
see the "Redaction" section of `docs/security.md`) before either transport stores it, so a
secret-shaped value is stored as `[REDACTED]`. On the REST path `MEM0_API_KEY` is sent only over
`https://` or to a loopback host (`localhost`, `127.x.x.x`, `[::1]`); plain `http://` to any other
host is refused unless `MEM0_ALLOW_INSECURE_HTTP=1` is set. A response larger than 4 MiB is
refused instead of being buffered. `tests/memory-mem0-smoke.ts` pins the REST path's redaction,
the key rule and the size limit; nothing tests the MCP path's redaction separately (it stores the
same redacted text).
