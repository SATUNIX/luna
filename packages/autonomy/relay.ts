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
import path from "node:path";
import { pathToFileURL } from "node:url";

/** A JSON object as it arrived: every value is unchecked. */
export type JsonObject = Record<string, unknown>;
/** The contract's price for one model, in USD per million tokens. */
export interface ModelPrice { inputPerMTok: number; outputPerMTok: number }
export type Pricing = Record<string, ModelPrice>;
/** One metered response: a line of /meter/usage.jsonl (with `at` and `status`). */
export interface UsageRecord { model: unknown; promptTokens: number | null; completionTokens: number | null; costUsd: number | null; unmetered?: true }
/** Who a metered row belongs to: written by the supervisor to attribution.json beside the meter file and read on every request. */
export interface Attribution { run: string | null; cycle: number | null; role: string }
/** How a request ended. `ok` is billed from usage; `refused` never reached the provider; the rest are unresolved liabilities (cost unknown). */
export type RowOutcome = "ok" | "refused" | "error" | "aborted" | "non-200" | "unmetered";
export type ScreenResult = { body: JsonObject; error?: never } | { error: string; body?: never };

/** The relay's configuration line on stdin (built by the supervisor, lib/runtime.ts). It holds the real API key. */
export interface RelayConfig {
  upstream: string;
  /** Where attribution.json (run, cycle, role) is read from; default: beside the meter file. */
  attributionFile?: string;
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
  const { upstream, apiKey, meterFile, maxUsd, models, provider, pricing, headers, attributionFile } = value;
  if (typeof upstream !== "string" || !upstream) throw new Error("relay config: upstream must be a URL");
  if (typeof apiKey !== "string" || !apiKey) throw new Error("relay config: apiKey must be a non-empty string");
  const config: RelayConfig = { upstream, apiKey };
  if (meterFile !== undefined) { if (typeof meterFile !== "string" || !meterFile) throw new Error("relay config: meterFile must be a path"); config.meterFile = meterFile; }
  if (attributionFile !== undefined) { if (typeof attributionFile !== "string" || !attributionFile) throw new Error("relay config: attributionFile must be a path"); config.attributionFile = attributionFile; }
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

/** The run, cycle and role the supervisor says are active; an unreadable or absent file is "unattributed", never a guess. */
export function readAttribution(file: string): Attribution {
  try {
    const v: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (isObject(v)) return { run: typeof v.run === "string" ? v.run : null, cycle: typeof v.cycle === "number" && Number.isInteger(v.cycle) ? v.cycle : null, role: typeof v.role === "string" && v.role ? v.role : "worker" };
  } catch { /* absent or unreadable */ }
  return { run: null, cycle: null, role: "unattributed" };
}

/** One /meter row for a request that did not produce a usable usage record. Without a cost it is a liability, not a price. */
export function liabilityRow(at: string, who: Attribution, model: unknown, status: number | null, outcome: Exclude<RowOutcome, "ok">, detail?: string): JsonObject {
  return { at, status, ...who, model: model ?? null, promptTokens: null, completionTokens: null, costUsd: null, outcome, ...(outcome === "refused" ? {} : { unresolved: true }), ...(detail ? { detail: detail.slice(0, 200) } : {}) };
}

/** What a meter says: spend and token counts by role, unresolved liabilities, and rows that could not be read. `cycle` limits it to one cycle. */
export interface MeterSummary { usd: number; byRole: Record<string, number>; rows: number; unresolved: number; unreadable: number }
export function summariseMeter(meterText: string | null | undefined, cycle?: number): MeterSummary {
  const out: MeterSummary = { usd: 0, byRole: {}, rows: 0, unresolved: 0, unreadable: 0 };
  for (const line of (meterText ?? "").split("\n")) {
    if (!line.trim()) continue;
    let record: unknown;
    try { record = JSON.parse(line); } catch { out.unreadable++; continue; }
    if (!isObject(record)) { out.unreadable++; continue; }
    if (cycle !== undefined && record.cycle !== cycle) continue;
    out.rows++;
    const cost = typeof record.costUsd === "number" ? record.costUsd : 0;
    const role = typeof record.role === "string" ? record.role : "unattributed";
    out.usd += cost;
    out.byRole[role] = (out.byRole[role] ?? 0) + cost;
    if (record.unresolved === true || record.unmetered === true) out.unresolved++;
  }
  return out;
}

/** A handler for one relay: the supervisor-built config in, an http request listener out (main() serves it; tests serve it on any port). */
export function createRelayHandler(config: RelayConfig): (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void> {
  const upstream = config.upstream.replace(/\/$/, "");
  const meterFile = config.meterFile ?? "/meter/usage.jsonl";
  const attributionFile = config.attributionFile ?? path.join(path.dirname(meterFile), "attribution.json");
  const hostMeter = path.join(path.dirname(meterFile), "manager.jsonl");
  const provider = config.provider ?? "openrouter";
  const pricing = config.pricing ?? {};
  const readText = (f: string): string => { try { return fs.readFileSync(f, "utf8"); } catch { return ""; } };
  // Spend starts from the ledgers on disk, so a relay restart never resets it; the host's own calls (manager, review) count too.
  let spent = meteredUsd(readText(meterFile));
  const total = (): number => spent + meteredUsd(readText(hostMeter));
  const append = (row: JsonObject): void => { try { fs.appendFileSync(meterFile, JSON.stringify(row) + "\n"); } catch { /* a full disk must not take inference down; the supervisor sees the gap */ } };

  return async (req, res) => {
    const target = route(req.method, req.url);
    const who = readAttribution(attributionFile);
    let model: unknown = null;
    const refuse = (status: number, message: string): void => { res.writeHead(status).end(message); append(liabilityRow(new Date().toISOString(), who, model, status, "refused", message)); };
    if (!target) { refuse(403, "Only inference requests are allowed"); return; }
    if (config.maxUsd && total() >= config.maxUsd) { refuse(429, "Run budget exhausted"); return; }
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of req as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > 16 * 1024 * 1024) { refuse(413, "Request too large"); return; }
      chunks.push(chunk);
    }
    let body = Buffer.concat(chunks);
    if (req.method === "POST") {
      let parsed: unknown;
      try { parsed = JSON.parse(body.toString()); } catch { refuse(400, "Request body must be JSON"); return; }
      if (isObject(parsed)) model = parsed.model ?? null;
      const screened = screen(parsed, config.models ?? [], { provider });
      if (screened.error !== undefined) { refuse(403, screened.error); return; }
      body = Buffer.from(JSON.stringify(screened.body));
    }
    const destination = new URL(upstream + target);
    const transport = destination.protocol === "https:" ? https : http;
    const headers: http.OutgoingHttpHeaders = { "content-type": "application/json", authorization: `Bearer ${config.apiKey}`, ...(config.headers ?? {}) };
    // Exactly one outcome is written per forwarded request: a reply that billed, or a liability row saying how it ended.
    let settled = false;
    const settle = (write: () => void): void => { if (!settled) { settled = true; write(); } };
    const liability = (status: number | null, outcome: Exclude<RowOutcome, "ok" | "refused">, detail?: string): void => settle(() => append(liabilityRow(new Date().toISOString(), who, model, status, outcome, detail)));
    // The caller going away mid-reply does not stop the provider billing: the reply is still read to its usage, and without one the row is an unresolved "aborted".
    let callerGone = false;
    res.on("close", () => { if (!res.writableFinished) callerGone = true; });
    const upstreamReq = transport.request(destination, { method: req.method, headers, timeout: 600_000 }, (reply) => {
      const status = reply.statusCode ?? 502;
      res.writeHead(status, { "content-type": reply.headers["content-type"] || "application/json" });
      let seen = "";
      reply.on("data", (c: Buffer) => { res.write(c); if (seen.length < 8 * 1024 * 1024) seen += String(c); });
      reply.on("aborted", () => { liability(status, "aborted", "the provider's reply was cut off"); res.destroy(); });
      reply.on("error", () => { liability(status, "error", "the provider's reply failed"); res.destroy(); });
      reply.on("end", () => {
        res.end();
        const usage = usageFrom(seen, pricing);
        settle(() => {
          if (!usage.length) { append(liabilityRow(new Date().toISOString(), who, model, status, callerGone ? "aborted" : status === 200 ? "unmetered" : "non-200", callerGone ? "the caller closed the connection before the reply finished" : status === 200 ? "no usage in a 200 reply" : seen)); return; }
          for (const u of usage) {
            spent += u.costUsd ?? 0;
            // A non-200 reply that still carries usage is billed; one without a cost stays unresolved.
            append({ at: new Date().toISOString(), status, ...who, outcome: status === 200 ? "ok" : "non-200", ...u, ...(u.costUsd === null ? { unresolved: true } : {}) });
          }
        });
      });
    });
    upstreamReq.on("timeout", () => upstreamReq.destroy(new Error("Inference timeout")));
    upstreamReq.on("error", (e: Error) => { liability(null, /timeout/i.test(e.message) ? "aborted" : "error", e.message); if (!res.headersSent) res.writeHead(502); res.end("Inference upstream unavailable"); });
    upstreamReq.end(body);
  };
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
  const handle = createRelayHandler(config);
  const server = http.createServer((req, res) => { void handle(req, res); });
  server.listen(8081, "0.0.0.0", () => console.log("inference relay ready"));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
