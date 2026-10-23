#!/usr/bin/env node
// B-027 regression: the memory-mem0 legacy REST path must treat HTTP >= 400 as a failure
// (so the circuit opens after three consecutive failures) instead of resolving every status
// and reporting a 500 body as success / "No results.". Fully hermetic: a local node:http
// server on an ephemeral port; no Docker, no Qdrant, no model.
// ORC-2 regression: the default MCP transport runs the memory server shipped with the kit, never a
// packages/container/mcp-servers/memory-mcp/index.ts planted in the working directory, and a
// relative PI_KIT_MEMORY_MCP_ARGS script or PI_KIT_MEMORY_MCP_COMMAND path is refused.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { isolateKitEnv, loadExtension, fakePi, rmWorkspace, setEnv, textOf, tmpWorkspace } from "../packages/core/eval/harness.ts";

const server = http.createServer((req, res) => {
  requestCount++;
  res.writeHead(mode === "500" ? 500 : 200, { "Content-Type": "application/json" });
  if (mode === "healthy") {
    res.end(JSON.stringify({ results: [{ memory: "the sky is blue" }] }));
  } else if (mode === "misshapen") {
    res.end(JSON.stringify({ results: [null, { memory: 7 }, { memory: "kept" }] }));
  } else if (mode === "not-a-list") {
    res.end(JSON.stringify({ results: "not a list" }));
  } else {
    res.end(JSON.stringify({ detail: "internal server error" }));
  }
});

let mode = "healthy";
let requestCount = 0;

type FakePi = ReturnType<typeof fakePi>;

function listen(): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.ok(address !== null && typeof address === "object", "the server must listen on a TCP port");
      resolve(address.port);
    });
  });
}

async function loadMem0(port: number): Promise<FakePi> {
  const restoreBackend = setEnv("PI_KIT_MEMORY_BACKEND", "mem0");
  const restoreUrl = setEnv("MEM0_API_URL", `http://127.0.0.1:${port}`);
  const restoreKey = setEnv("MEM0_API_KEY", undefined);
  const restoreUser = setEnv("MEM0_USER_ID", undefined);
  try {
    const register = await loadExtension("extensions/memory-mem0/index.ts");
    const pi = fakePi();
    register(pi.api);
    return pi;
  } finally {
    // Module-level MEM0_URL is captured at import, so the env only needs to survive load;
    // restore the caller's values immediately.
    restoreBackend();
    restoreUrl();
    restoreKey();
    restoreUser();
  }
}

async function loadMcp(env: Record<string, string | undefined>): Promise<FakePi> {
  const restores = [setEnv("PI_KIT_MEMORY_BACKEND", undefined), ...Object.entries(env).map(([name, value]) => setEnv(name, value))];
  try {
    const register = await loadExtension("extensions/memory-mem0/index.ts");
    const pi = fakePi();
    register(pi.api);
    return pi;
  } finally {
    for (const restore of restores.reverse()) restore();
  }
}

// A repository that plants the kit's memory-server path and records whether it ever ran.
function plantRepo(): { repo: string; marker: string; script: string } {
  const repo = tmpWorkspace("pi-kit-mem0-repo-");
  const marker = path.join(repo, "PWNED");
  const dir = path.join(repo, "packages", "container", "mcp-servers", "memory-mcp");
  fs.mkdirSync(dir, { recursive: true });
  const script = path.join(dir, "index.ts");
  fs.writeFileSync(script, `import fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(marker)}, "ran");\nconsole.log(JSON.stringify({ planted: true }));\n`);
  return { repo, marker, script };
}

async function inDir<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.cwd();
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(previous);
  }
}

async function checkMcpTransport(): Promise<void> {
  const { repo, marker, script } = plantRepo();
  const data = tmpWorkspace("pi-kit-mem0-data-");
  try {
    // (d) Default transport from inside the planted repository: the kit's own server answers.
    {
      const pi = await loadMcp({ PI_KIT_MEMORY_MCP_COMMAND: undefined, PI_KIT_MEMORY_MCP_ARGS: undefined });
      const restoreData = setEnv("PI_KIT_MEMORY_MCP_DATA_ROOT", data);
      try {
        const out = await inDir(repo, () => search(pi, "anything"));
        assert.ok(!fs.existsSync(marker), "the default MCP transport must not run the working directory's memory-mcp script");
        assert.doesNotMatch(out, /planted/, `the answer must come from the kit's memory server (got ${out})`);
        assert.doesNotMatch(out, /memory MCP unavailable/, `the kit's own memory server must answer (got ${out})`);
      } finally {
        restoreData();
      }
    }

    // (e) A relative script argument or command path is refused before anything is spawned.
    for (const env of [
      { PI_KIT_MEMORY_MCP_ARGS: "packages/container/mcp-servers/memory-mcp/index.ts" },
      { PI_KIT_MEMORY_MCP_COMMAND: "./node_modules/.bin/memory-mcp", PI_KIT_MEMORY_MCP_ARGS: "" },
    ]) {
      const pi = await loadMcp(env);
      const out = await inDir(repo, () => search(pi, "anything"));
      assert.match(out, /memory MCP unavailable: .*(not an absolute path|is a relative path)/, `a relative MCP target must be refused (got ${out})`);
      assert.ok(!fs.existsSync(marker), "a refused MCP target must not run");
    }

    // (f) An operator-set absolute script path is still honoured.
    {
      const pi = await loadMcp({ PI_KIT_MEMORY_MCP_ARGS: script });
      const out = await inDir(repo, () => search(pi, "anything"));
      assert.match(out, /planted/, `an absolute PI_KIT_MEMORY_MCP_ARGS script must run (got ${out})`);
      assert.ok(fs.existsSync(marker), "the absolute operator-configured script must have run");
    }
  } finally {
    rmWorkspace(repo);
    rmWorkspace(data);
  }
}

async function search(pi: FakePi, query: string): Promise<string> {
  const tool = pi.tools.get("mem0_search");
  return textOf(await tool.execute("s", { query }));
}

async function add(pi: FakePi, text: string): Promise<string> {
  const tool = pi.tools.get("mem0_add");
  return textOf(await tool.execute("a", { text }));
}

async function run(): Promise<void> {
  const restoreIsolation = isolateKitEnv();
  const home = tmpWorkspace("pi-kit-mem0-home-");
  const restoreHome = setEnv("HOME", home);
  const restoreAgentDir = setEnv("PI_CODING_AGENT_DIR", path.join(home, ".pi", "agent"));
  const port = await listen();
  try {
    // (a) A persistent 500 must surface as an error, not a false success or empty match.
    mode = "500";
    requestCount = 0;
    {
      const pi = await loadMem0(port);
      const searchText = await search(pi, "anything");
      assert.notEqual(searchText, "No results.", "an HTTP 500 must not look like an empty match");
      assert.match(searchText, /error/i, "mem0_search must report an error");
      assert.match(searchText, /500/, "the error must mention the HTTP status");

      const addText = await add(pi, "a memory");
      assert.ok(!addText.startsWith("mem0 add:"), `an HTTP 500 must not report a successful add (got ${addText})`);
      assert.match(addText, /error/i, "mem0_add must report an error");
      assert.match(addText, /500/, "the add error must mention the HTTP status");
    }

    // (b) Three consecutive failures open the circuit; the fourth call is degraded and never
    // reaches the server, so its request counter stays at 3.
    mode = "500";
    requestCount = 0;
    {
      const pi = await loadMem0(port);
      for (let i = 0; i < 3; i++) {
        assert.match(await search(pi, `q${i}`), /error/i, `failure ${i + 1} must report an error`);
      }
      assert.equal(requestCount, 3, "the first three calls must reach the server");
      const degraded = await search(pi, "q3");
      assert.match(degraded, /circuit open/i, "the fourth call must report the circuit open");
      assert.equal(requestCount, 3, "an open circuit must not send another request");
    }

    // (c) A healthy 200 still returns the memory text unchanged.
    mode = "healthy";
    requestCount = 0;
    {
      const pi = await loadMem0(port);
      assert.match(await search(pi, "sky"), /the sky is blue/, "a healthy response must return the memory text");
      assert.equal(requestCount, 1, "the healthy call must reach the server once");
    }

    // (c2) ORC-10: the search response is unknown. A null entry, a non-string memory or a
    // non-list results field is shown or skipped, never dereferenced into a TypeError.
    mode = "misshapen";
    {
      const pi = await loadMem0(port);
      const text = await search(pi, "sky");
      assert.match(text, /^1\. null\n2\. \{"memory":7\}\n3\. kept$/, `misshapen entries are shown as JSON (got ${text})`);
    }
    mode = "not-a-list";
    {
      const pi = await loadMem0(port);
      assert.equal(await search(pi, "sky"), "No results.", "a non-list results field is no results");
    }

    await checkMcpTransport();

    console.log("[test:smoke memory-mem0] OK");
  } finally {
    restoreAgentDir();
    restoreHome();
    rmWorkspace(home);
    restoreIsolation();
  }
}

try {
  await run();
} catch (error) {
  console.error(`[memory-mem0-smoke] FAILED: ${error instanceof Error ? error.stack || error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
