import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import https from "node:https";
import http from "node:http";
import { URL } from "node:url";

interface MemoryEntry {
  id: string;
  text: string;
  tags: string[];
  createdAt: string;
}

type MemoryIndex = Record<string, number[]>;
type EmbedderAdapter = { embed(text: string): Promise<number[]> };

const MEMORY_DIR = process.env.PI_KIT_MEMORY_DIR ?? path.join(os.homedir(), ".pi", "agent", "memory-local");
const MEMORY_FILE = path.join(MEMORY_DIR, "memories.json");
const INDEX_FILE = path.join(MEMORY_DIR, "memory-index.json");
// A non-numeric/zero/negative env value previously parsed to NaN, and `length > NaN`
// is always false, so the cap silently disabled itself (unbounded memory file).
function positiveIntOr(value: string | number | undefined, fallback: number): number {
  const n = typeof value === "number" ? value : parseInt(value ?? "", 10);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
const MAX_ENTRIES = positiveIntOr(process.env.PI_KIT_MEMORY_MAX_ENTRIES, 2000);
export const MAX_QUERY_EMBED_CACHE = 200;
const EMBED_TIMEOUT_MS = 5000;

let cache: MemoryEntry[] | null = null;
let indexCache: MemoryIndex | null = null;
const queryEmbeddingCache = new Map<string, number[]>();

const noopEmbedder: EmbedderAdapter = {
  async embed() {
    return [];
  },
};

function requestJson(urlStr: string, body: unknown, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(urlStr);
    } catch (error) {
      reject(new Error(`invalid embedding endpoint URL: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    const payload = JSON.stringify(body);
    const transport = url.protocol === "https:" ? https : http;
    const req = transport.request(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
    }, (res) => {
      let buf = "";
      res.on("data", (chunk: Buffer) => { buf += chunk.toString(); });
      res.on("end", () => {
        clearTimeout(timer);
        if ((res.statusCode ?? 0) >= 400) {
          reject(new Error(`embedding endpoint returned HTTP ${res.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(buf));
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
    const timer = setTimeout(() => req.destroy(new Error("embedding timeout")), timeoutMs);
    req.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    req.write(payload);
    req.end();
  });
}

function createEmbedder(): EmbedderAdapter {
  const baseUrl = process.env.LMSTUDIO_BASE_URL?.replace(/\/+$/, "");
  const model = process.env.PI_KIT_EMBED_MODEL;
  if (!baseUrl || !model) return noopEmbedder;

  return {
    async embed(text: string) {
      const endpoint = baseUrl.endsWith("/v1") ? `${baseUrl}/embeddings` : `${baseUrl}/v1/embeddings`;
      const response = await requestJson(endpoint, { model, input: text }, EMBED_TIMEOUT_MS);
      const embedding = (response as { data?: { embedding?: unknown }[] }).data?.[0]?.embedding;
      if (!Array.isArray(embedding)) return [];
      return embedding.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    },
  };
}

// Element-level guards: a container check alone let a structurally-plausible but invalid
// element through, which then crashed on use. `[{"id":"m1"}]` (missing text/tags)
// reached scoreEntry -> entry.tags.join (TypeError: undefined.join); `{"m1":null}`
// reached searchMemories -> cosineSimilarity(queryEmbedding, null) -> null.length.
function isMemoryEntry(value: unknown): value is MemoryEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.id === "string"
    && typeof entry.text === "string"
    && typeof entry.createdAt === "string"
    && Array.isArray(entry.tags)
    && entry.tags.every((tag) => typeof tag === "string");
}

function isEmbedding(value: unknown): value is number[] {
  return Array.isArray(value)
    && value.length > 0
    && value.every((v) => typeof v === "number" && Number.isFinite(v));
}

function loadMemories(): MemoryEntry[] {
  if (cache !== null) return cache;
  if (!fs.existsSync(MEMORY_FILE)) { cache = []; return cache; }
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(MEMORY_FILE, "utf8"));
    // Valid JSON but wrong shape (e.g. `{}` or `null`) previously leaked straight to
    // callers as-is, so entries.push/map/length threw a TypeError. Fail safe like the
    // sibling stores (branch-lab/verifier-board/task-graph): keep only a real array,
    // otherwise report once and treat the store as empty. Missing files are the normal
    // empty state and stay silent (handled above).
    if (!Array.isArray(parsed)) {
      process.stderr.write(`memory-local: ignoring wrong-shape memory file ${MEMORY_FILE}: expected a JSON array\n`);
      cache = [];
      return cache;
    }
    const valid = parsed.filter(isMemoryEntry);
    if (valid.length !== parsed.length) {
      process.stderr.write(`memory-local: ignoring ${parsed.length - valid.length} invalid entries in ${MEMORY_FILE}\n`);
    }
    cache = valid;
  } catch {
    cache = [];
  }
  return cache;
}

function loadIndex(): MemoryIndex {
  if (indexCache !== null) return indexCache;
  if (!fs.existsSync(INDEX_FILE)) { indexCache = {}; return indexCache; }
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(INDEX_FILE, "utf8"));
    // Keep only a non-null, non-array object: `[]`/`null` previously became the index
    // and Object.entries/Object.keys blew up, or worse corrupt embeddings silently.
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      process.stderr.write(`memory-local: ignoring wrong-shape index file ${INDEX_FILE}: expected a JSON object\n`);
      indexCache = {};
      return indexCache;
    }
    const entries = Object.entries(parsed as Record<string, unknown>);
    const valid: MemoryIndex = Object.fromEntries(entries.filter((entry): entry is [string, number[]] => isEmbedding(entry[1])));
    if (Object.keys(valid).length !== entries.length) {
      process.stderr.write(`memory-local: ignoring ${entries.length - Object.keys(valid).length} invalid embeddings in ${INDEX_FILE}\n`);
    }
    indexCache = valid;
  } catch {
    indexCache = {};
  }
  return indexCache;
}

// Atomic write: temp file + rename (same pattern as verify-gate/verifier-board/task-graph),
// so a crash mid-write cannot truncate memories.json/memory-index.json and lose all memory.
function writeFileAtomic(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, file);
}

function saveAll(entries: MemoryEntry[], index: MemoryIndex): void {
  let retained = entries;
  if (entries.length > MAX_ENTRIES) {
    retained = entries
      .slice()
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(entries.length - MAX_ENTRIES);
  }
  const retainedIds = new Set(retained.map(entry => entry.id));
  const retainedIndex = Object.fromEntries(Object.entries(index).filter(([id]) => retainedIds.has(id)));

  cache = retained;
  indexCache = retainedIndex;
  writeFileAtomic(MEMORY_FILE, JSON.stringify(retained, null, 2));
  writeFileAtomic(INDEX_FILE, JSON.stringify(retainedIndex, null, 2));
}

function scoreEntry(entry: MemoryEntry, query: string): number {
  const q = query.toLowerCase();
  const haystack = `${entry.text} ${entry.tags.join(" ")}`.toLowerCase();
  let score = 0;
  for (const word of q.split(/\s+/).filter(Boolean)) {
    if (haystack.includes(word)) score++;
  }
  return score;
}

function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || right.length === 0 || left.length !== right.length) return 0;
  let dot = 0;
  let leftMag = 0;
  let rightMag = 0;
  for (let i = 0; i < left.length; i++) {
    // Both vectors are dense and the same length (checked above), so neither read misses.
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    dot += l * r;
    leftMag += l * l;
    rightMag += r * r;
  }
  if (leftMag === 0 || rightMag === 0) return 0;
  return dot / (Math.sqrt(leftMag) * Math.sqrt(rightMag));
}

function formatEntries(entries: MemoryEntry[]): string {
  return entries
    .map(e => `[${e.id}] ${e.text}${e.tags.length ? ` (tags: ${e.tags.join(", ")})` : ""}`)
    .join("\n");
}

async function embedOrEmpty(embedder: EmbedderAdapter, text: string, cacheKey?: string): Promise<number[]> {
  if (cacheKey && queryEmbeddingCache.has(cacheKey)) return queryEmbeddingCache.get(cacheKey) ?? [];
  try {
    const embedding = await embedder.embed(text);
    // Only cache a successful, non-empty vector: caching an empty failure would poison the
    // query key so later calls hit the cache and never retry a recovered embedder (B-041).
    if (cacheKey && embedding.length > 0) {
      if (queryEmbeddingCache.size >= MAX_QUERY_EMBED_CACHE) {
        const oldest = queryEmbeddingCache.keys().next().value;
        if (oldest !== undefined) queryEmbeddingCache.delete(oldest);
      }
      queryEmbeddingCache.set(cacheKey, embedding);
    }
    return embedding;
  } catch {
    return [];
  }
}

// Shared by the memory_search tool and the automatic recall hook below (AG-08).
async function searchMemories(embedder: EmbedderAdapter, query: string, limit: number): Promise<MemoryEntry[]> {
  const entries = loadMemories();
  const index = loadIndex();
  const queryEmbedding = await embedOrEmpty(embedder, query, query);

  if (queryEmbedding.length > 0) {
    const byId = new Map(entries.map(entry => [entry.id, entry]));
    const scored = Object.entries(index)
      .map(([id, embedding]) => ({ entry: byId.get(id), score: cosineSimilarity(queryEmbedding, embedding) }))
      .filter((item): item is { entry: MemoryEntry; score: number } => Boolean(item.entry) && item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(item => item.entry);
    if (scored.length > 0) return scored;
  }

  return entries
    .map(e => ({ e, score: scoreEntry(e, query) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(x => x.e);
}

// AG-08 fix (partial): memory-local was previously a purely manually-invoked tool - the
// model had to remember to call memory_search itself, so stored notes never
// automatically compounded into later sessions' context. Recall the most relevant
// memories for each non-trivial user input and inject them via a context-sieve
// contribution (context-sieve is the sole injection authority; this never returns a
// systemPrompt directly), the same task-scoped-recall pattern orchestrator/progress-
// guard already use for their own signals.
// B-005: contribution files are scoped per session so concurrent sessions sharing a cwd
// (child agents do) cannot overwrite each other. The resolver is duplicated in each producer
// (not imported) because every extension must stay independently extractable
// (packages/core/verify.ts self-containment lint).
const SESSION_ID_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
let currentSessionId: string | undefined;

function isSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID_RE.test(value);
}

function resolveSessionId(sessionManager?: unknown): string | undefined {
  try {
    const id = (sessionManager as { getSessionId?: () => unknown } | undefined)?.getSessionId?.();
    return isSessionId(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

function contribDir(cwd: string, sessionId: string | undefined = currentSessionId): string {
  const base = path.join(cwd, ".pi", "ctx-contributions");
  return isSessionId(sessionId) ? path.join(base, "sessions", sessionId) : base;
}

function memoryContribPath(cwd: string): string {
  return path.join(contribDir(cwd), "memory-local.json");
}

function writeRecallContribution(cwd: string, entries: MemoryEntry[]): void {
  try {
    const dir = path.dirname(memoryContribPath(cwd));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      memoryContribPath(cwd),
      JSON.stringify({
        id: "memory-local",
        priority: 60,
        budgetTokens: 400,
        content: `## Recalled memory\n${formatEntries(entries)}`,
      }),
      "utf8",
    );
  } catch {
    /* best effort */
  }
}

function clearRecallContribution(cwd: string): void {
  try { fs.rmSync(memoryContribPath(cwd), { force: true }); } catch { /* ignore */ }
}

export default function (pi: ExtensionAPI) {
  const embedder = createEmbedder();

  pi.on("session_start", async (_event, ctx) => {
    currentSessionId = resolveSessionId(ctx.sessionManager);
    queryEmbeddingCache.clear();
    clearRecallContribution(ctx.cwd);
  });

  // AG-08: automatic task-scoped recall — leave commands, skill invocations, and
  // trivial inputs alone (same threshold convention orchestrator uses), search on
  // everything else, and clear the contribution when nothing relevant is found so a
  // stale recall from a prior turn doesn't linger.
  pi.on("input", async (event, ctx) => {
    if (event.source !== "interactive") return;
    const text = event.text?.trim() ?? "";
    if (text.startsWith("/") || text.length < 12) return;
    try {
      const results = await searchMemories(embedder, text, 3);
      if (results.length > 0) writeRecallContribution(ctx.cwd, results);
      else clearRecallContribution(ctx.cwd);
    } catch {
      /* best effort - recall must never block input handling */
    }
  });

  pi.registerTool({
    name: "memory_store",
    label: "Memory: store",
    description: "Save a note to persistent local memory. Use for facts, decisions, or context that should survive across sessions.",
    parameters: Type.Object({
      text: Type.String({ description: "The memory text to store" }),
      tags: Type.Optional(Type.Array(Type.String(), { description: "Optional tags for retrieval" })),
    }),
    async execute(_id, params) {
      const entries = loadMemories();
      const index = loadIndex();
      const entry: MemoryEntry = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        text: params.text,
        tags: params.tags ?? [],
        createdAt: new Date().toISOString(),
      };
      const embedding = await embedOrEmpty(embedder, `${entry.text}\n${entry.tags.join(" ")}`);
      if (embedding.length > 0) index[entry.id] = embedding;
      entries.push(entry);
      saveAll(entries, index);
      return {
        content: [{ type: "text" as const, text: `Stored memory ${entry.id}${embedding.length ? "" : " (keyword index only)"}` }],
        details: undefined,
      };
    },
  });

  pi.registerTool({
    name: "memory_search",
    label: "Memory: search",
    description: "Search persistent local memory by semantic vector when configured, otherwise by keyword.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      limit: Type.Optional(Type.Number({ description: "Max results (default 5)" })),
    }),
    async execute(_id, params) {
      const limit = params.limit ?? 5;
      const scored = await searchMemories(embedder, params.query, limit);
      if (scored.length === 0) {
        const hasEmbedder = (await embedOrEmpty(embedder, params.query, params.query)).length > 0;
        const suffix = !hasEmbedder && process.env.LMSTUDIO_BASE_URL ? " [embedder unavailable]" : "";
        return { content: [{ type: "text" as const, text: `No memories matched.${suffix}` }], details: undefined };
      }
      return { content: [{ type: "text" as const, text: formatEntries(scored) }], details: undefined };
    },
  });

  pi.registerTool({
    name: "memory_delete",
    label: "Memory: delete",
    description: "Delete a memory entry by ID.",
    parameters: Type.Object({
      id: Type.String({ description: "Memory ID to delete" }),
    }),
    async execute(_callId, params) {
      const entries = loadMemories();
      const index = loadIndex();
      const before = entries.length;
      const remaining = entries.filter(e => e.id !== params.id);
      if (remaining.length === before) {
        return { content: [{ type: "text" as const, text: `No memory with id ${params.id}` }], details: undefined };
      }
      Reflect.deleteProperty(index, params.id);
      saveAll(remaining, index);
      return { content: [{ type: "text" as const, text: `Deleted ${params.id}` }], details: undefined };
    },
  });

  pi.registerTool({
    name: "memory_stats",
    label: "Memory: stats",
    description: "Return count and date range of stored memories.",
    parameters: Type.Object({}),
    async execute() {
      const entries = loadMemories();
      const index = loadIndex();
      const oldest = entries.length ? entries.reduce((a, b) => a.createdAt < b.createdAt ? a : b).createdAt : null;
      const newest = entries.length ? entries.reduce((a, b) => a.createdAt > b.createdAt ? a : b).createdAt : null;
      return {
        content: [{ type: "text" as const, text: `count: ${entries.length}/${MAX_ENTRIES}, indexed: ${Object.keys(index).length}, oldest: ${oldest}, newest: ${newest}` }],
        details: undefined,
      };
    },
  });
}
