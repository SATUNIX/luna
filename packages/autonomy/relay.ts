#!/usr/bin/env node
// Inference relay for the autonomy run: the agent container's only route off its internal
// network. Based on packages/core/eval/live/proxy.ts: a fixed upstream, configuration (with the
// real API key) over stdin only, and a small allowlist of inference paths. The agent holds a
// synthetic key. Added here: per-response usage metering to /meter/usage.jsonl, which the
// supervisor sums for the budget, a hard spending stop as a backstop to the supervisor's, and a
// model allowlist that also refuses OpenRouter's web-search features (screen()). The provider is
// configuration, not code: OpenRouter reports cost in every response; any other
// OpenAI-compatible provider is metered from token counts and the contract's price table.
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import { pathToFileURL } from "node:url";

/** A JSON object as it arrived: every value is unchecked. */
export type JsonObject = Record<string, unknown>;
/** The contract's price for one model, in USD per million tokens. */
export interface ModelPrice { inputPerMTok: number; outputPerMTok: number }
export type Pricing = Record<string, ModelPrice>;
/** One metered response: a line of /meter/usage.jsonl (with `at` and `status`). */
export interface UsageRecord { model: unknown; promptTokens: number | null; completionTokens: number | null; costUsd: number | null; unmetered?: true }
export type ScreenResult = { body: JsonObject; error?: never } | { error: string; body?: never };

/** The relay's configuration line on stdin (built by the supervisor, lib/runtime.ts). It holds the real API key. */
export interface RelayConfig {
  upstream: string;
  apiKey: string;
  meterFile?: string;
  maxUsd?: number | null;
  models?: string[];
  provider?: string;
  pricing?: Pricing;
  headers?: Record<string, string>;
}

const isObject = (v: unknown): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Check the stdin config line. Fail-closed: anything missing or of the wrong type stops the relay
 * before it is ready, rather than serving with an undefined key, budget or allowlist.
 */
export function parseRelayConfig(value: unknown): RelayConfig {
  if (!isObject(value)) throw new Error("relay config must be a JSON object");
  const { upstream, apiKey, meterFile, maxUsd, models, provider, pricing, headers } = value;
  if (typeof upstream !== "string" || !upstream) throw new Error("relay config: upstream must be a URL");
  if (typeof apiKey !== "string" || !apiKey) throw new Error("relay config: apiKey must be a non-empty string");
  const config: RelayConfig = { upstream, apiKey };
  if (meterFile !== undefined) { if (typeof meterFile !== "string" || !meterFile) throw new Error("relay config: meterFile must be a path"); config.meterFile = meterFile; }
  if (maxUsd !== undefined) { if (maxUsd !== null && (typeof maxUsd !== "number" || !Number.isFinite(maxUsd) || maxUsd < 0)) throw new Error("relay config: maxUsd must be a non-negative number or null"); config.maxUsd = maxUsd; }
  if (models !== undefined) { if (!Array.isArray(models) || !models.every((m) => typeof m === "string")) throw new Error("relay config: models must be a list of model ids"); config.models = models; }
  if (provider !== undefined) { if (typeof provider !== "string") throw new Error("relay config: provider must be a string"); config.provider = provider; }
  if (pricing !== undefined) {
    if (!isObject(pricing)) throw new Error("relay config: pricing must be an object");
    const checked: Pricing = {};
    for (const [model, price] of Object.entries(pricing)) {
      const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
      if (!isObject(price) || !finite(price.inputPerMTok) || !finite(price.outputPerMTok)) throw new Error(`relay config: pricing.${model} needs non-negative inputPerMTok and outputPerMTok`);
      checked[model] = { inputPerMTok: price.inputPerMTok, outputPerMTok: price.outputPerMTok };
    }
    config.pricing = checked;
  }
  if (headers !== undefined) {
    if (!isObject(headers)) throw new Error("relay config: headers must be an object");
    const checked: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) { if (typeof v !== "string") throw new Error(`relay config: headers.${k} must be a string`); checked[k] = v; }
    config.headers = checked;
  }
  return config;
}

export const ALLOWED: ReadonlyMap<string, string> = new Map([
  ["POST /v1/chat/completions", "/chat/completions"],
  ["GET /v1/models", "/models"],
]);

export function route(method: string | undefined, url: string | undefined): string | null {
  const [path = ""] = (url ?? "").split("?");
  return ALLOWED.get(`${method} ${path}`) ?? null;
}

/** Ask OpenRouter to report usage (tokens and cost) on every response, streaming included. */
export function withUsage(body: JsonObject): JsonObject {
  const usage = typeof body.usage === "object" && body.usage !== null ? body.usage : {};
  return { ...body, usage: { ...usage, include: true } };
}

/**
 * Screen a chat request. OpenRouter can turn a completion into web access (the `plugins` web
 * plugin, `web_search_options`, `:online` model variants); none of that is inference the run
 * needs, so it is refused or removed. With an allowlist, only the run's models are served.
 * Returns { body } or { error }.
 */
export function screen(body: unknown, models: readonly string[] = [], { provider = "openrouter" }: { provider?: string } = {}): ScreenResult {
  if (!isObject(body)) return { error: "Request body must be a JSON object" };
  // eslint-disable-next-line @typescript-eslint/no-base-to-string -- the model id is untrusted JSON; whatever it is, its text is what the allowlist compares
  const model = String(body.model ?? "");
  if (/:online\b/i.test(model)) return { error: "Online model variants are not allowed" };
  if (models.length && !models.includes(model)) return { error: `Model ${JSON.stringify(model)} is not allowed for this run` };
  const { plugins, web_search_options: _web, ...rest } = body;
  const kept = Array.isArray(plugins) ? plugins.filter((p: unknown) => Boolean(p) && !(typeof p === "object" && p !== null && "id" in p && p.id === "web")) : undefined;
  const cleaned: JsonObject = kept?.length ? { ...rest, plugins: kept } : rest;
  if (provider === "openrouter") return { body: withUsage(cleaned) };
  // Other OpenAI-compatible providers report token counts (streaming ones only when asked).
  const streamOptions = typeof cleaned.stream_options === "object" && cleaned.stream_options !== null ? cleaned.stream_options : {};
  return { body: cleaned.stream ? { ...cleaned, stream_options: { ...streamOptions, include_usage: true } } : cleaned };
}

/** Usage records from a response body: SSE `data:` lines or one JSON document. */
export function usageFrom(text: unknown, pricing: Pricing = {}): UsageRecord[] {
  const found: UsageRecord[] = [];
  const take = (obj: unknown): void => {
    if (isObject(obj) && isObject(obj.usage)) {
      const u = obj.usage;
      // Spend only ever grows: a negative count or cost is not usage, so it never lowers the total.
      const promptTokens = amount(u.prompt_tokens);
      const completionTokens = amount(u.completion_tokens);
      // Own keys only: an inherited name ("constructor", "toString") is not a price, and would make the cost NaN.
      const modelKey = String(obj.model);
      const price: ModelPrice | undefined = Object.hasOwn(pricing, modelKey) ? pricing[modelKey] : undefined;
      // Reported cost wins; otherwise tokens times the contract's price. Neither: unmetered, and it says so.
      const computed = price && promptTokens !== null && completionTokens !== null ? (promptTokens * price.inputPerMTok + completionTokens * price.outputPerMTok) / 1e6 : null;
      const costUsd = amount(u.cost) ?? computed;
      found.push({ model: obj.model ?? null, promptTokens, completionTokens, costUsd, ...(costUsd === null ? { unmetered: true } : {}) });
    }
  };
  // eslint-disable-next-line @typescript-eslint/no-base-to-string -- callers pass the response text; anything else is read as its text
  const s = String(text ?? "");
  if (/^\s*data:/m.test(s)) {
    for (const line of s.split("\n")) {
      const m = line.match(/^data:\s*(\{.*\})\s*$/);
      if (m?.[1]) { try { take(JSON.parse(m[1])); } catch { /* partial or non-JSON line */ } }
    }
  } else {
    try { take(JSON.parse(s)); } catch { /* not JSON */ }
  }
  return found;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const amount = (v: unknown): number | null => { const n = num(v); return n !== null && n >= 0 ? n : null; };

/** Total metered spend so far. */
export function meteredUsd(meterText: string | null | undefined): number {
  let total = 0;
  for (const line of (meterText ?? "").split("\n")) {
    if (!line.trim()) continue;
    try {
      const record: unknown = JSON.parse(line);
      // Only a number counts (the relay writes a number or null); anything else is skipped, never concatenated.
      if (isObject(record) && typeof record.costUsd === "number") total += record.costUsd;
    } catch { /* skip */ }
  }
  return total;
}

async function main(): Promise<void> {
  const configText = await new Promise<string>((resolve) => {
    let input = "";
    process.stdin.on("data", (chunk: Buffer | string) => {
      input += String(chunk);
      if (input.includes("\n")) { process.stdin.pause(); resolve(input.slice(0, input.indexOf("\n"))); }
    });
  });
  const config = parseRelayConfig(JSON.parse(configText));
  const upstream = config.upstream.replace(/\/$/, "");
  const meterFile = config.meterFile ?? "/meter/usage.jsonl";
  const provider = config.provider ?? "openrouter";
  const pricing = config.pricing ?? {};
  let spent = fs.existsSync(meterFile) ? meteredUsd(fs.readFileSync(meterFile, "utf8")) : 0;

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const target = route(req.method, req.url);
    if (!target) { res.writeHead(403).end("Only inference requests are allowed"); return; }
    if (config.maxUsd && spent >= config.maxUsd) { res.writeHead(429).end("Run budget exhausted"); return; }
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of req as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > 16 * 1024 * 1024) { res.writeHead(413).end(); return; }
      chunks.push(chunk);
    }
    let body = Buffer.concat(chunks);
    if (req.method === "POST") {
      let parsed: unknown;
      try { parsed = JSON.parse(body.toString()); } catch { res.writeHead(400).end("Request body must be JSON"); return; }
      const screened = screen(parsed, config.models ?? [], { provider });
      if (screened.error !== undefined) { res.writeHead(403).end(screened.error); return; }
      body = Buffer.from(JSON.stringify(screened.body));
    }
    const destination = new URL(upstream + target);
    const transport = destination.protocol === "https:" ? https : http;
    const headers: http.OutgoingHttpHeaders = { "content-type": "application/json", authorization: `Bearer ${config.apiKey}`, ...(config.headers ?? {}) };
    const upstreamReq = transport.request(destination, { method: req.method, headers, timeout: 600_000 }, (reply) => {
      res.writeHead(reply.statusCode ?? 502, { "content-type": reply.headers["content-type"] || "application/json" });
      let seen = "";
      reply.on("data", (c: Buffer) => { res.write(c); if (seen.length < 8 * 1024 * 1024) seen += String(c); });
      reply.on("end", () => {
        res.end();
        for (const u of usageFrom(seen, pricing)) {
          spent += u.costUsd ?? 0;
          fs.appendFileSync(meterFile, JSON.stringify({ at: new Date().toISOString(), status: reply.statusCode, ...u }) + "\n");
        }
      });
    });
    upstreamReq.on("timeout", () => upstreamReq.destroy(new Error("Inference timeout")));
    upstreamReq.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end("Inference upstream unavailable"); });
    upstreamReq.end(body);
  };
  const server = http.createServer((req, res) => { void handle(req, res); });
  server.listen(8081, "0.0.0.0", () => console.log("inference relay ready"));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
