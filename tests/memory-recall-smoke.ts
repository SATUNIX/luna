#!/usr/bin/env node
/**
 * AG-08 regression coverage (partial): memory-local must automatically recall relevant
 * memories into context on non-trivial input, not rely solely on the model remembering
 * to call memory_search itself. Fully offline — no live model, keyword-fallback search
 * only (no embedder configured).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { loadExtension, loadModule, fakePi, tmpWorkspace, rmWorkspace, setEnv, textOf } from "../packages/core/eval/harness.ts";
import { object, parseJsonAs, string } from "../packages/core/lib/guard.ts";
import type * as MemoryLocal from "../packages/extensions/src/memory-local/index.ts";

type FakePi = ReturnType<typeof fakePi>;

interface MockEmbedder {
  server: http.Server;
  state: { count: number };
  port: number;
}

async function loadMemory(_memoryDir: string): Promise<FakePi> {
  const register = await loadExtension("extensions/memory-local/index.ts");
  const pi = fakePi();
  register(pi.api);
  return pi;
}

async function testAutomaticRecallOnRelevantInput(): Promise<void> {
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-memrecall-"));
  const ws = tmpWorkspace("pi-kit-memrecall-ws-");
  const restore = setEnv("PI_KIT_MEMORY_DIR", memoryDir);
  try {
    const pi = await loadMemory(memoryDir);
    const ctx = { cwd: ws, ui: { notify() {} } };
    await pi.handlers.get("session_start")({}, ctx);
    await pi.tools.get("memory_store").execute("c", { text: "The staging DB uses a read-replica for reporting queries.", tags: ["db"] }, undefined, undefined, ctx);

    await pi.handlers.get("input")({ source: "interactive", text: "why are reporting queries slow against staging?" }, ctx);

    const contrib = path.join(ws, ".pi", "ctx-contributions", "memory-local.json");
    assert.ok(fs.existsSync(contrib), "a relevant memory must be automatically recalled into context");
    const { content } = parseJsonAs(object({ content: string() }), fs.readFileSync(contrib, "utf8"));
    assert.match(content, /read-replica/);
  } finally {
    restore();
    rmWorkspace(ws);
    fs.rmSync(memoryDir, { recursive: true, force: true });
  }
}

async function testNoRecallForTrivialOrCommandInput(): Promise<void> {
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-memrecall-triv-"));
  const ws = tmpWorkspace("pi-kit-memrecall-triv-ws-");
  const restore = setEnv("PI_KIT_MEMORY_DIR", memoryDir);
  try {
    const pi = await loadMemory(memoryDir);
    const ctx = { cwd: ws, ui: { notify() {} } };
    await pi.handlers.get("session_start")({}, ctx);
    await pi.tools.get("memory_store").execute("c", { text: "staging DB read-replica note", tags: ["db"] }, undefined, undefined, ctx);

    await pi.handlers.get("input")({ source: "interactive", text: "hi" }, ctx);
    const contrib = path.join(ws, ".pi", "ctx-contributions", "memory-local.json");
    assert.ok(!fs.existsSync(contrib), "a trivial input must not trigger a recall search");

    await pi.handlers.get("input")({ source: "interactive", text: "/status" }, ctx);
    assert.ok(!fs.existsSync(contrib), "a slash command must not trigger a recall search");
  } finally {
    restore();
    rmWorkspace(ws);
    fs.rmSync(memoryDir, { recursive: true, force: true });
  }
}

async function testStaleRecallClearedWhenNothingMatches(): Promise<void> {
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-memrecall-stale-"));
  const ws = tmpWorkspace("pi-kit-memrecall-stale-ws-");
  const restore = setEnv("PI_KIT_MEMORY_DIR", memoryDir);
  try {
    const pi = await loadMemory(memoryDir);
    const ctx = { cwd: ws, ui: { notify() {} } };
    await pi.handlers.get("session_start")({}, ctx);
    await pi.tools.get("memory_store").execute("c", { text: "The staging DB uses a read-replica for reporting.", tags: ["db"] }, undefined, undefined, ctx);

    await pi.handlers.get("input")({ source: "interactive", text: "why are reporting queries slow?" }, ctx);
    const contrib = path.join(ws, ".pi", "ctx-contributions", "memory-local.json");
    assert.ok(fs.existsSync(contrib), "precondition: a relevant recall must have fired first");

    // No overlapping words with the stored memory text at all (the simple keyword
    // scorer matches on any shared word, including common ones, so this must be chosen
    // to share nothing with "The staging DB uses a read-replica for reporting.").
    await pi.handlers.get("input")({ source: "interactive", text: "please colorize icons inside settings dropdown widget" }, ctx);
    assert.ok(!fs.existsSync(contrib), "a stale recall from a prior turn must be cleared when the new input matches nothing");
  } finally {
    restore();
    rmWorkspace(ws);
    fs.rmSync(memoryDir, { recursive: true, force: true });
  }
}

// A bad PI_KIT_MEMORY_MAX_ENTRIES previously parsed to NaN, and `length > NaN` is
// always false, so the cap silently disabled itself. Writes must also be atomic (temp
// file + rename), leaving no partial file or temp leftover behind.
async function testInvalidMaxEntriesFallsBackAndWritesAreAtomic(): Promise<void> {
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-memrecall-cap-"));
  const ws = tmpWorkspace("pi-kit-memrecall-cap-ws-");
  const restoreDir = setEnv("PI_KIT_MEMORY_DIR", memoryDir);
  const restoreMax = setEnv("PI_KIT_MEMORY_MAX_ENTRIES", "not-a-number");
  try {
    const pi = await loadMemory(memoryDir);
    const ctx = { cwd: ws, ui: { notify() {} } };
    await pi.handlers.get("session_start")({}, ctx);
    await pi.tools.get("memory_store").execute("c", { text: "cap fallback note", tags: [] }, undefined, undefined, ctx);
    const stats = await pi.tools.get("memory_stats").execute("s", {}, undefined, undefined, ctx);
    assert.match(textOf(stats), /count: 1\/2000/, "an invalid max-entries env must fall back to the positive default, not NaN");
    assert.ok(fs.existsSync(path.join(memoryDir, "memories.json")) && fs.existsSync(path.join(memoryDir, "memory-index.json")), "both stores must exist");
    assert.deepEqual(fs.readdirSync(memoryDir).filter((f) => f.endsWith(".tmp")), [], "atomic writes must not leave temp files behind");
  } finally {
    restoreMax();
    restoreDir();
    rmWorkspace(ws);
    fs.rmSync(memoryDir, { recursive: true, force: true });
  }
}

// B-041: the per-query embedding cache must be bounded and cleared per session, so a
// long-lived process cannot grow it without limit. A local mock embedder counts requests
// so cache hits (no request) are observable. LMSTUDIO_BASE_URL/PI_KIT_EMBED_MODEL must be
// set before loadExtension, since the embedder is built at register time.
async function startMockEmbedder(options: { emptyFirst?: number } = {}): Promise<MockEmbedder> {
  const { emptyFirst = 0 } = options;
  const state = { count: 0 };
  const server = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      state.count++;
      if (state.count <= emptyFirst) {
        // A 200 with no usable vector: `embedder.embed` resolves to [] rather than throwing.
        // This is the failure shape that was wrongly cached as an empty query embedding.
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: [] }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ embedding: [1, 0, 0] }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === "object", "the mock embedder must listen on a TCP port");
  return { server, state, port: address.port };
}

async function testQueryEmbeddingCacheIsBoundedAndCleared(): Promise<void> {
  const { MAX_QUERY_EMBED_CACHE } = await loadModule<typeof MemoryLocal>("extensions/memory-local/index.ts");
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-memrecall-embcache-"));
  const ws = tmpWorkspace("pi-kit-memrecall-embcache-ws-");
  const { server, state, port } = await startMockEmbedder();
  const restoreDir = setEnv("PI_KIT_MEMORY_DIR", memoryDir);
  const restoreBase = setEnv("LMSTUDIO_BASE_URL", `http://127.0.0.1:${port}`);
  const restoreModel = setEnv("PI_KIT_EMBED_MODEL", "mock-embed-model");
  try {
    const pi = await loadMemory(memoryDir);
    const ctx = { cwd: ws, ui: { notify() {} } };
    await pi.handlers.get("session_start")({}, ctx);
    const fire = (text: string) => pi.handlers.get("input")({ source: "interactive", text }, ctx);

    const q1 = "cache probe alpha one";
    await fire(q1);
    await fire("cache probe alpha two");
    await fire("cache probe alpha three");
    assert.equal(state.count, 3, "three distinct queries must each reach the embedder");
    await fire(q1);
    assert.equal(state.count, 3, "re-firing the first query must be served from cache");

    // 3 already cached + (cap + 2) new = cap + 5 distinct keys, over the cap, so the
    // oldest (q1) must have been evicted while the newest is still cached.
    for (let i = 0; i < MAX_QUERY_EMBED_CACHE + 2; i++) await fire(`cache probe new query number ${i}`);
    const beforeEvicted = state.count;
    await fire(q1);
    assert.equal(state.count, beforeEvicted + 1, "the oldest query must have been evicted at the cap");

    const newest = `cache probe new query number ${MAX_QUERY_EMBED_CACHE + 1}`;
    const beforeNewest = state.count;
    await fire(newest);
    assert.equal(state.count, beforeNewest, "the newest query must still be cached");

    await pi.handlers.get("session_start")({}, ctx);
    const beforeClear = state.count;
    await fire(newest);
    assert.equal(state.count, beforeClear + 1, "session_start must clear the query embedding cache");
  } finally {
    restoreModel();
    restoreBase();
    restoreDir();
    await new Promise((resolve) => server.close(resolve));
    rmWorkspace(ws);
    fs.rmSync(memoryDir, { recursive: true, force: true });
  }
}

// Regression: an empty/unusable embedding (e.g. LM-Studio briefly answering with no vector)
// was cached under the query key, so every later search for that query hit the cached empty
// vector and never retried. A failed embedding must not be cached; only a non-empty vector
// may be, and the B-041 cap eviction must only run when a successful vector is actually inserted.
// NOTE: a *thrown* embedder error was already safe pre-fix (queryEmbeddingCache.set sits inside
// the try, so the catch skips it); the observable bug is the non-throwing empty vector, which is
// what this mock reproduces.
async function testFailedEmbeddingIsNotCachedAndNextSearchRetries(): Promise<void> {
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-memrecall-embfail-"));
  const ws = tmpWorkspace("pi-kit-memrecall-embfail-ws-");
  const { server, state, port } = await startMockEmbedder({ emptyFirst: 1 });
  const restoreDir = setEnv("PI_KIT_MEMORY_DIR", memoryDir);
  const restoreBase = setEnv("LMSTUDIO_BASE_URL", `http://127.0.0.1:${port}`);
  const restoreModel = setEnv("PI_KIT_EMBED_MODEL", "mock-embed-model");
  try {
    // Seed a memory whose embedding matches the mock vector exactly, but whose text shares
    // no words with the query, so a result can only come from semantic (vector) recall.
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(
      path.join(memoryDir, "memories.json"),
      JSON.stringify([{ id: "m1", text: "quantum entanglement reservoir calibration", tags: [], createdAt: new Date().toISOString() }]),
    );
    fs.writeFileSync(path.join(memoryDir, "memory-index.json"), JSON.stringify({ m1: [1, 0, 0] }));

    const pi = await loadMemory(memoryDir);
    const ctx = { cwd: ws, ui: { notify() {} } };
    await pi.handlers.get("session_start")({}, ctx);
    const query = "zzz semantic probe alpha";
    const fire = () => pi.handlers.get("input")({ source: "interactive", text: query }, ctx);
    const contrib = path.join(ws, ".pi", "ctx-contributions", "memory-local.json");

    // Search 1: the embedder returns an empty vector. The failure must not be cached.
    await fire();
    assert.equal(state.count, 1, "the first search must reach the (empty-returning) embedder");
    assert.ok(!fs.existsSync(contrib), "a failed embedding cannot produce a semantic recall");

    // Search 2: must retry the embedder and now succeed semantically.
    await fire();
    assert.equal(state.count, 2, "a failed embedding must not be cached: the next search must retry the embedder");
    assert.ok(fs.existsSync(contrib), "the retried search must return semantic recall");
    assert.match(fs.readFileSync(contrib, "utf8"), /quantum entanglement reservoir/);

    // Search 3: the successful vector is cached, so no further embedder request.
    const beforeThird = state.count;
    await fire();
    assert.equal(state.count, beforeThird, "a successful embedding must be cached");

    // memory_search must not keep reporting the embedder as unavailable after recovery.
    const result = await pi.tools.get("memory_search").execute("s", { query }, undefined, undefined, ctx);
    assert.match(textOf(result), /quantum entanglement reservoir/);
    assert.ok(!textOf(result).includes("[embedder unavailable]"), "a recovered embedder must not be reported as unavailable");
  } finally {
    restoreModel();
    restoreBase();
    restoreDir();
    await new Promise((resolve) => server.close(resolve));
    rmWorkspace(ws);
    fs.rmSync(memoryDir, { recursive: true, force: true });
  }
}

// Wrong-shape, valid-JSON stores were returned as-is: memories.json `{}`/`null` made
// entries.push/map/length throw a TypeError, and memory-index.json `[]` made
// Object.entries/Object.keys throw. The guard must fall back to the empty store while
// warning exactly once, matching branch-lab's readLeases shape validation.
async function testWrongShapeStoreIsTreatedAsEmpty(): Promise<void> {
  const cases = [
    { name: "memories.json = {}", memories: "{}", index: undefined, expectedCount: 0 },
    { name: "memories.json = null", memories: "null", index: undefined, expectedCount: 0 },
    { name: "memory-index.json = []", memories: JSON.stringify([{ id: "m1", text: "seeded note", tags: [], createdAt: new Date().toISOString() }]), index: "[]", expectedCount: 1 },
    { name: "memories.json = [{id}] (missing fields)", memories: JSON.stringify([{ id: "m1" }]), index: undefined, expectedCount: 0, expectedWarning: "invalid entries" },
    { name: "memory-index.json = {m1:null}", memories: JSON.stringify([{ id: "m1", text: "seeded note", tags: [], createdAt: new Date().toISOString() }]), index: JSON.stringify({ m1: null }), expectedCount: 1, expectedWarning: "invalid embeddings" },
  ];

  for (const c of cases) {
    const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-memrecall-shape-"));
    const ws = tmpWorkspace("pi-kit-memrecall-shape-ws-");
    const restore = setEnv("PI_KIT_MEMORY_DIR", memoryDir);
    const warnings: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: string | Uint8Array, ...rest: unknown[]) => { warnings.push(String(chunk)); return origWrite.apply(process.stderr, [chunk, ...rest] as Parameters<typeof origWrite>); };
    try {
      fs.mkdirSync(memoryDir, { recursive: true });
      fs.writeFileSync(path.join(memoryDir, "memories.json"), c.memories);
      if (c.index !== undefined) fs.writeFileSync(path.join(memoryDir, "memory-index.json"), c.index);

      const pi = await loadMemory(memoryDir);
      const ctx = { cwd: ws, ui: { notify() {} } };
      await pi.handlers.get("session_start")({}, ctx);

      // A wrong-shape file must read as empty, not crash on entries.length / Object.keys(index).
      const statsBefore = await pi.tools.get("memory_stats").execute("s", {}, undefined, undefined, ctx);
      assert.match(textOf(statsBefore), new RegExp(`count: ${c.expectedCount}/`), `${c.name}: wrong-shape store must read as empty, got: ${textOf(statsBefore)}`);
      // Second load must still not throw (a null cache would keep re-reading and crash).
      await pi.tools.get("memory_stats").execute("s2", {}, undefined, undefined, ctx);

      // Container-level cases warn once with `wrong-shape`; element-level cases instead
      // warn once with their own `invalid entries`/`invalid embeddings` message. The two
      // messages must stay disjoint so neither is double-counted.
      const expectedWarning = c.expectedWarning ?? "wrong-shape";
      assert.equal(warnings.filter((w) => w.includes(expectedWarning)).length, 1, `${c.name}: exactly one ${expectedWarning} warning line must be written`);
      if (expectedWarning !== "wrong-shape") {
        assert.equal(warnings.filter((w) => w.includes("wrong-shape")).length, 0, `${c.name}: element-level rejection must not emit a wrong-shape warning`);
      }

      // Search, store, and automatic recall must all tolerate the recovered store.
      const search = await pi.tools.get("memory_search").execute("q", { query: "anything at all" }, undefined, undefined, ctx);
      assert.ok(typeof textOf(search) === "string", `${c.name}: memory_search must not throw on a wrong-shape store`);

      const store = await pi.tools.get("memory_store").execute("c", { text: `recovered note for ${c.name}`, tags: [] }, undefined, undefined, ctx);
      assert.match(textOf(store), /^Stored memory /, `${c.name}: memory_store must recover the empty store`);

      const statsAfter = await pi.tools.get("memory_stats").execute("s3", {}, undefined, undefined, ctx);
      assert.match(textOf(statsAfter), new RegExp(`count: ${c.expectedCount + 1}/`), `${c.name}: store must append to the recovered store`);

      await pi.handlers.get("input")({ source: "interactive", text: `recall probe for ${c.name} with enough words` }, ctx);
    } finally {
      process.stderr.write = origWrite;
      restore();
      rmWorkspace(ws);
      fs.rmSync(memoryDir, { recursive: true, force: true });
    }
  }
}

const tests: Array<[name: string, fn: () => Promise<void>]> = [
  ["a relevant memory is automatically recalled into context", testAutomaticRecallOnRelevantInput],
  ["trivial input and slash commands do not trigger a recall search", testNoRecallForTrivialOrCommandInput],
  ["a stale recall is cleared when the next input matches nothing", testStaleRecallClearedWhenNothingMatches],
  ["an invalid entry cap falls back to the default and writes are atomic", testInvalidMaxEntriesFallsBackAndWritesAreAtomic],
  ["the query embedding cache is bounded and cleared per session", testQueryEmbeddingCacheIsBoundedAndCleared],
  ["a failed embedding is not cached and the next search retries", testFailedEmbeddingIsNotCachedAndNextSearchRetries],
  ["wrong-shape stores are treated as empty without throwing", testWrongShapeStoreIsTreatedAsEmpty],
];

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`  OK: ${name}`);
  } catch (error) {
    failed++;
    console.error(`  FAIL: ${name}`);
    console.error(`    ${error instanceof Error ? error.stack || error.message : String(error)}`);
  }
}

if (failed > 0) {
  console.error(`\n[memory-recall-smoke] ${failed}/${tests.length} FAILED`);
  process.exit(1);
}
console.log(`\n[memory-recall-smoke] all ${tests.length} checks passed`);
