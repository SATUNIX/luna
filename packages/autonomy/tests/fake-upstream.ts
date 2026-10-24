// A fake model provider for tests/autonomy-container-smoke.ts, run as its OWN process (the test
// uses synchronous engine calls, which would stall a server living in the test's event loop).
//   node fake-upstream.ts <log.jsonl> <model-id> <cost-usd> [port]
// Serves GET .../models (an OpenRouter-shaped list with one model) and answers every POST with a
// canned chat completion carrying usage and a cost. Each request is appended to the log as one
// JSON line { method, url, authorization, body }; the first stdout line is { port }. Without a port
// argument it listens on an ephemeral one.
import fs from "node:fs";
import http from "node:http";

const [logFile, model, cost, portArg] = process.argv.slice(2);
if (logFile === undefined || model === undefined || cost === undefined) throw new Error("usage: node fake-upstream.ts <log.jsonl> <model-id> <cost-usd> [port]");
const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => { chunks.push(c); });
  req.on("end", () => {
    fs.appendFileSync(logFile, `${JSON.stringify({ method: req.method, url: req.url, authorization: req.headers.authorization ?? null, body: Buffer.concat(chunks).toString() })}\n`);
    res.setHeader("content-type", "application/json");
    if (req.method === "GET") res.end(JSON.stringify({ data: [{ id: model, name: "Test model", context_length: 32000, top_provider: { max_completion_tokens: 4096 }, pricing: { prompt: "0.000001", completion: "0.000002" }, supported_parameters: [] }] }));
    else res.end(JSON.stringify({ id: "gen-1", model, choices: [{ index: 0, message: { role: "assistant", content: "fake answer" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2, cost: Number(cost) } }));
  });
});
server.listen(Number(portArg ?? 0), "0.0.0.0", () => {
  const address = server.address();
  console.log(JSON.stringify({ port: typeof address === "object" && address ? address.port : null }));
});
