#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { loadExtension } from "../packages/core/eval/harness.ts";

interface Model {
  provider: string;
  id: string;
}
interface ToolResult {
  content: Array<{ type?: string; text: string }>;
}
interface Tool {
  name: string;
  execute(id: string, params: Record<string, unknown>): Promise<ToolResult>;
}
type Handler = (event: unknown, ctx?: unknown) => unknown;
interface FakePi {
  api: {
    on(name: string, handler: Handler): void;
    registerTool(tool: Tool): void;
    registerCommand(): void;
    setModel(model: Model): Promise<boolean>;
  };
  handlers: Map<string, Handler>;
  tools: Map<string, Tool>;
  modelSelections: Model[];
}

/** Map lookup that fails the smoke with a clear message instead of calling undefined. */
function mustGet<T>(map: Map<string, T>, key: string): T {
  const value = map.get(key);
  assert.ok(value !== undefined, `not registered: ${key}`);
  return value;
}

function fakePi(): FakePi {
  const handlers = new Map<string, Handler>();
  const tools = new Map<string, Tool>();
  const modelSelections: Model[] = [];
  return {
    api: {
      on(name: string, handler: Handler) {
        handlers.set(name, handler);
      },
      registerTool(tool: Tool) {
        tools.set(tool.name, tool);
      },
      registerCommand() {},
      async setModel(model: Model) {
        modelSelections.push(model);
        return true;
      },
    },
    handlers,
    tools,
    modelSelections,
  };
}

function fakeModelRegistry(models: Model[]) {
  return {
    find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
    getAll: () => models,
  };
}

function setEnv(name: string, value: string | undefined): () => void {
  const previous = process.env[name];
  if (value === undefined) Reflect.deleteProperty(process.env, name);
  else process.env[name] = value;
  return () => {
    if (previous === undefined) Reflect.deleteProperty(process.env, name);
    else process.env[name] = previous;
  };
}

async function smokeContextSieve(): Promise<void> {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-sieve-"));
  const restoreBudget = setEnv("PI_KIT_CTX_BUDGET_TOKENS", "6");
  try {
    const register = await loadExtension("extensions/context-sieve/index.ts");
    const pi = fakePi();
    register(pi.api);
    await mustGet(pi.handlers, "session_start")({}, { cwd: workspace });
    const contribDir = path.join(workspace, ".pi", "ctx-contributions");
    fs.writeFileSync(path.join(contribDir, "a.json"), JSON.stringify({ id: "a", priority: 10, budgetTokens: 10, content: "short" }));
    fs.writeFileSync(path.join(contribDir, "b.json"), JSON.stringify({ id: "b", priority: 1, budgetTokens: 10, content: "this contribution is far too long" }));
    const assembled = (await mustGet(pi.handlers, "before_agent_start")({ systemPrompt: "base" })) as { systemPrompt: string };
    assert.match(assembled.systemPrompt, /short/);
    const budget = JSON.parse(fs.readFileSync(path.join(contribDir, "sieve-budget.json"), "utf8")) as { included: string[]; dropped: string[] };
    assert.deepEqual(budget.included, ["a"]);
    assert.deepEqual(budget.dropped, ["b"]);

    // A continuity contribution must not replace Pi's complete summarization
    // with a lossy transcript prefix. The native compactor keeps its inputs.
    fs.writeFileSync(path.join(workspace, ".pi", "GOAL.yaml"), "goal: keep state\n");
    const compactEvent = {
      preparation: { messagesToSummarize: [], firstKeptEntryId: "entry-5", tokensBefore: 12000 },
    };
    const compactResult = await mustGet(pi.handlers, "session_before_compact")(compactEvent);
    assert.equal(compactResult, undefined, "context-sieve preserves native compaction");
    assert.equal(compactEvent.preparation.firstKeptEntryId, "entry-5");
    assert.equal(compactEvent.preparation.tokensBefore, 12000);
  } finally {
    restoreBudget();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

function startEmbedServer(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += String(chunk); });
    req.on("end", () => {
      // The extension sends the text to embed as a string.
      const { input: text } = JSON.parse(body) as { input?: unknown };
      const input = (typeof text === "string" ? text : "").toLowerCase();
      const embedding = /auth|passkey|authentication/.test(input) ? [1, 0] : [0, 1];
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ embedding }] }));
    });
  });
  return new Promise<http.Server>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function smokeMemoryLocal(): Promise<void> {
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-memory-local-"));
  const server = await startEmbedServer();
  const port = (server.address() as AddressInfo).port; // listening on TCP, so never a pipe path or null
  const restoreDir = setEnv("PI_KIT_MEMORY_DIR", memoryDir);
  const restoreBase = setEnv("LMSTUDIO_BASE_URL", `http://127.0.0.1:${port}/v1`);
  const restoreModel = setEnv("PI_KIT_EMBED_MODEL", "fake-embed");
  try {
    const register = await loadExtension("extensions/memory-local/index.ts");
    const pi = fakePi();
    register(pi.api);
    await mustGet(pi.tools, "memory_store").execute("1", { text: "Admin authentication uses passkeys", tags: ["auth"] });
    await mustGet(pi.tools, "memory_store").execute("2", { text: "Invoices are exported monthly", tags: ["billing"] });
    const result = await mustGet(pi.tools, "memory_search").execute("3", { query: "authentication approach", limit: 1 });
    const [first] = result.content;
    assert.ok(first, "memory_search returned a result");
    assert.match(first.text, /passkeys/);
    assert.ok(fs.existsSync(path.join(memoryDir, "memory-index.json")));
  } finally {
    restoreDir();
    restoreBase();
    restoreModel();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(memoryDir, { recursive: true, force: true });
  }
}

// H-03/AG-01 fix verification: provider-router must actually call the documented
// pi.setModel() imperative API from before_agent_start (a real pre-inference decision
// point) rather than returning a value from the notification-only model_select event,
// which Pi never reads (see extensions/provider-router/index.ts's header comment for the
// SDK source evidence). The task-type signal now comes from orchestrator's
// .pi/task-classification.json, not goal-core.json (which never had a task_type field).
async function smokeProviderRouter(): Promise<void> {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-router-"));
  const policy = path.join(workspace, "policy.json");
  fs.writeFileSync(policy, JSON.stringify({
    hot_path_model: "ollama/small",
    strong_model: "ollama/strong",
    trigger_task_types: ["complex"]
  }));
  const restorePolicy = setEnv("PI_KIT_ROUTING_POLICY", policy);
  const registry = fakeModelRegistry([
    { provider: "ollama", id: "small" },
    { provider: "ollama", id: "strong" },
  ]);
  try {
    const register = await loadExtension("extensions/provider-router/index.ts");
    const pi = fakePi();
    register(pi.api);
    await mustGet(pi.handlers, "session_start")({}, { cwd: workspace, ui: { notify() {} } });

    // No classification yet -> hot path.
    await mustGet(pi.handlers, "before_agent_start")({}, { cwd: workspace, modelRegistry: registry, ui: { notify() {} } });
    assert.equal(pi.modelSelections.at(-1)?.id, "small", "with no classification, must route to the hot-path model");

    // orchestrator writes a "complex" classification (the real producer this extension
    // now reads, replacing the never-populated goal-core.json task_type).
    fs.mkdirSync(path.join(workspace, ".pi"), { recursive: true });
    fs.writeFileSync(path.join(workspace, ".pi", "task-classification.json"), JSON.stringify({ score: 5, taskType: "complex" }));
    await mustGet(pi.handlers, "before_agent_start")({}, { cwd: workspace, modelRegistry: registry, ui: { notify() {} } });
    assert.equal(pi.modelSelections.at(-1)?.id, "strong", "a 'complex' classification must route to the strong model via pi.setModel()");
  } finally {
    restorePolicy();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

// Regression: without an explicit PI_KIT_ROUTING_POLICY, provider-router must never
// call pi.setModel() at all, even if the operator happens to have a model in their
// registry whose id collides with a name this extension might otherwise hardcode as a
// default. It previously defaulted to "gemma4:latest"/"qwen2.5-coder:32b" unconfigured,
// which silently overrode whatever model the operator had already configured whenever
// those names happened to resolve.
async function smokeProviderRouterUnconfiguredIsNoop(): Promise<void> {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-router-unconfigured-"));
  const restorePolicy = setEnv("PI_KIT_ROUTING_POLICY", undefined);
  const registry = fakeModelRegistry([{ provider: "ollama", id: "gemma4:latest" }]);
  try {
    const register = await loadExtension("extensions/provider-router/index.ts");
    const pi = fakePi();
    register(pi.api);
    await mustGet(pi.handlers, "session_start")({}, { cwd: workspace, ui: { notify() {} } });
    await mustGet(pi.handlers, "before_agent_start")({}, { cwd: workspace, modelRegistry: registry, ui: { notify() {} } });
    assert.equal(pi.modelSelections.length, 0, "unconfigured routing must never call setModel, even if a same-named model exists in the registry");
  } finally {
    restorePolicy();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

// B-042: provider-router must not silently switch provider when a provider-qualified
// model misses. Previously resolveModel() fell through to an id-only getAll() lookup that
// ignored the provider, so a policy naming "alpha/small" could route to "beta/small".
async function smokeProviderRouterProviderQualifiedMiss(): Promise<void> {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-router-qualified-"));
  const policyPath = path.join(workspace, "policy.json");
  const restorePolicy = setEnv("PI_KIT_ROUTING_POLICY", policyPath);
  const betaRegistry = fakeModelRegistry([
    { provider: "beta", id: "small" },
    { provider: "beta", id: "strong" },
  ]);
  const alphaRegistry = fakeModelRegistry([{ provider: "alpha", id: "small" }]);
  try {
    const register = await loadExtension("extensions/provider-router/index.ts");
    const pi = fakePi();
    register(pi.api);

    // (a) provider-qualified miss must not cross providers via the id-only fallback.
    fs.writeFileSync(policyPath, JSON.stringify({
      hot_path_model: "alpha/small",
      strong_model: "alpha/strong",
      trigger_task_types: ["complex"],
    }));
    await mustGet(pi.handlers, "session_start")({}, { cwd: workspace, ui: { notify() {} } });
    const notices: string[] = [];
    await mustGet(pi.handlers, "before_agent_start")({}, {
      cwd: workspace,
      modelRegistry: betaRegistry,
      ui: { notify: (message: string) => notices.push(message) },
    });
    assert.equal(pi.modelSelections.length, 0, "provider-qualified miss must not select a same-id model on another provider");
    assert.ok(notices.some((n) => /not found/i.test(n) && n.includes("alpha/small")), "must notify that the provider-qualified target was not found");

    // (b) positive control: unqualified names still use the id-only fallback.
    fs.writeFileSync(policyPath, JSON.stringify({
      hot_path_model: "small",
      strong_model: "strong",
      trigger_task_types: ["complex"],
    }));
    await mustGet(pi.handlers, "session_start")({}, { cwd: workspace, ui: { notify() {} } });
    await mustGet(pi.handlers, "before_agent_start")({}, { cwd: workspace, modelRegistry: betaRegistry, ui: { notify() {} } });
    assert.equal(pi.modelSelections.at(-1)?.id, "small", "unqualified name must still resolve via id-only fallback");
    assert.equal(pi.modelSelections.at(-1)?.provider, "beta", "unqualified name must select the beta provider's same-id model");

    // (c) positive control: provider-qualified name that resolves in its provider.
    fs.writeFileSync(policyPath, JSON.stringify({
      hot_path_model: "alpha/small",
      strong_model: "alpha/strong",
      trigger_task_types: ["complex"],
    }));
    await mustGet(pi.handlers, "session_start")({}, { cwd: workspace, ui: { notify() {} } });
    await mustGet(pi.handlers, "before_agent_start")({}, { cwd: workspace, modelRegistry: alphaRegistry, ui: { notify() {} } });
    assert.equal(pi.modelSelections.at(-1)?.id, "small", "provider-qualified name present in its provider must resolve");
    assert.equal(pi.modelSelections.at(-1)?.provider, "alpha", "provider-qualified resolution must select the alpha provider, not a stale beta selection");
  } finally {
    restorePolicy();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

await smokeContextSieve();
await smokeMemoryLocal();
await smokeProviderRouter();
await smokeProviderRouterUnconfiguredIsNoop();
await smokeProviderRouterProviderQualifiedMiss();
console.log("[smoke:epic2] OK");
