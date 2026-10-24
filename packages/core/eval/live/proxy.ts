// Fixed-upstream inference relay. Configuration arrives over stdin, never argv,
// Docker environment metadata, or an agent-readable credential file.
// Bind-mounted into the relay container as a single file: node:* imports only.
import http from "node:http";
import https from "node:https";
import fs from "node:fs";

interface RelayConfig {
  baseUrl: string;
  apiKey: string | undefined;
  headers: Record<string, string>;
}

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** The host's relay config, checked before any request is relayed: a malformed config stops the relay. */
function parseRelayConfig(text: string): RelayConfig {
  const value = JSON.parse(text) as unknown;
  if (!isObject(value) || typeof value.baseUrl !== "string") throw new Error("relay config needs a baseUrl string");
  const { apiKey, headers } = value;
  // Falsy credentials mean "none" (the host passes unresolved empty values through).
  if (apiKey && typeof apiKey !== "string") throw new Error("relay apiKey must be a string");
  if (headers !== undefined && headers !== null && !isObject(headers)) throw new Error("relay headers must be an object");
  const checkedHeaders: Record<string, string> = {};
  for (const [name, header] of Object.entries(headers ?? {})) {
    if (typeof header !== "string") throw new Error("relay header values must be strings");
    checkedHeaders[name] = header;
  }
  return { baseUrl: value.baseUrl, apiKey: typeof apiKey === "string" && apiKey ? apiKey : undefined, headers: checkedHeaders };
}

// The credential-bearing line is parsed straight away and never kept in a variable.
const config = parseRelayConfig(await new Promise<string>((resolve) => {
  let input = "";
  process.stdin.on("data", (chunk) => {
    input += String(chunk);
    if (input.includes("\n")) { process.stdin.pause(); resolve(input.slice(0, input.indexOf("\n"))); }
  });
}));
const upstream = new URL(config.baseUrl);
let requests = 0;
const allowed = new Set(["/v1/responses", "/v1/chat/completions", "/v1/models"]);
async function relay(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = req.url ?? "";
  if (!allowed.has(url) || !["GET", "POST"].includes(req.method ?? "")) {
    res.writeHead(403).end("Only inference requests are allowed"); return;
  }
  if (++requests > 100) { res.writeHead(429).end("Evaluation request budget exhausted"); return; }
  const chunks: Buffer[] = []; let size = 0;
  for await (const received of req) {
    const chunk: unknown = received;
    // A request stream without an encoding yields Buffers; anything else is refused.
    if (!Buffer.isBuffer(chunk)) { res.writeHead(400).end(); return; }
    size += chunk.length;
    if (size > 4 * 1024 * 1024) { res.writeHead(413).end(); return; }
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);
  let logged: unknown = null;
  if (body.length) {
    // Inference requests are JSON. Anything else is refused here rather than relayed unlogged.
    try { logged = JSON.parse(body.toString()) as unknown; } catch { res.writeHead(400).end("Request body must be JSON"); return; }
  }
  fs.appendFileSync("/logs/requests.jsonl", JSON.stringify({ at: new Date().toISOString(), path: url, body: logged }) + "\n");
  const destination = new URL(upstream.href.replace(/\/$/, "") + url.slice(3));
  const transport = destination.protocol === "https:" ? https : http;
  const headers: Record<string, string> = { "content-type": "application/json", ...config.headers };
  if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
  const request = transport.request(destination, { method: req.method, headers, timeout: 180_000 }, (reply) => {
    res.writeHead(reply.statusCode ?? 502, { "content-type": reply.headers["content-type"] || "application/json" });
    reply.pipe(res);
  });
  request.on("timeout", () => request.destroy(new Error("Inference timeout")));
  request.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end("Inference upstream unavailable"); });
  request.end(body);
}
// One failed request (an aborted stream, an unwritable log) must not stop the relay for the
// rest of the run: answer it with 500 and keep serving.
const server = http.createServer((req, res) => {
  relay(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); });
});
server.listen(8081, "0.0.0.0", () => { console.log("inference relay ready"); });
