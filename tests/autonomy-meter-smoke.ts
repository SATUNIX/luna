#!/usr/bin/env node
/**
 * Attribution and the budget ledger (packages/autonomy/relay.ts, lib/rpc.ts): every row the relay
 * meters carries the run, cycle and role the supervisor named, and a request that ends in an error,
 * an abort, a non-200 reply or a reply without usage is an unresolved liability, never a silent
 * gap. A restarted relay starts from the ledger on disk; the host's own spend counts toward its
 * stop. A provider refusal (402, 403, 429) parks with an explicit waiting reason; the relay's own
 * refusals are not mistaken for the provider's. Served over real sockets on loopback, no container.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createRelayHandler, readAttribution, summariseMeter, type JsonObject } from "../packages/autonomy/relay.ts";
import { providerBlocker, providerLimitError, type ProviderLimitWatch } from "../packages/autonomy/lib/rpc.ts";
import { isolateKitEnv } from "../packages/core/eval/harness.ts";

isolateKitEnv();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "luna-meter-"));
const meter = path.join(dir, "usage.jsonl");
const rows = (): JsonObject[] => (fs.existsSync(meter) ? fs.readFileSync(meter, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as JsonObject) : []);

// A provider whose reply is chosen by the request's model name.
const provider = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c: Buffer) => { body += String(c); });
  req.on("end", () => {
    const model = (JSON.parse(body) as { model: string }).model;
    if (model === "ok") { res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ model, usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.25 } })); return; }
    if (model === "no-usage") { res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ model, choices: [] })); return; }
    if (model === "limited") { res.writeHead(402, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "requires more credits" } })); return; }
    if (model === "cut") { res.writeHead(200, { "content-type": "application/json", "content-length": "1000" }); res.write("{\"partial\":"); setTimeout(() => res.socket?.destroy(), 20); return; }
    if (model === "reset") { req.socket.destroy(); return; }
    res.writeHead(500).end("boom");
  });
});
await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
const upstream = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;

const serve = async (maxUsd: number | null) => {
  const handle = createRelayHandler({ upstream, apiKey: "k", meterFile: meter, maxUsd, models: ["ok", "no-usage", "limited", "cut", "reset", "boom"] });
  const server = http.createServer((req, res) => { void handle(req, res); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const call = (model: string, { abort = false }: { abort?: boolean } = {}): Promise<number> => new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/v1/chat/completions", method: "POST", headers: { "content-type": "application/json" } }, (res) => {
      res.on("data", () => { if (abort) req.destroy(); });
      res.on("end", () => resolve(res.statusCode ?? 0));
      res.on("error", () => resolve(res.statusCode ?? 0));
      res.on("close", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", () => resolve(0));
    req.end(JSON.stringify({ model }));
  });
  return { call, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
};
const settle = (ms = 150): Promise<void> => new Promise((r) => setTimeout(r, ms));

// --- attribution: the supervisor names who is spending; absent means "unattributed", never a guess -------------------
assert.deepEqual(readAttribution(path.join(dir, "attribution.json")), { run: null, cycle: null, role: "unattributed" });
fs.writeFileSync(path.join(dir, "attribution.json"), JSON.stringify({ run: "r1", cycle: 4, role: "worker" }));
assert.deepEqual(readAttribution(path.join(dir, "attribution.json")), { run: "r1", cycle: 4, role: "worker" });

let relay = await serve(null);
assert.equal(await relay.call("ok"), 200);
assert.equal(await relay.call("limited"), 402);
assert.equal(await relay.call("boom"), 500);
assert.equal(await relay.call("no-usage"), 200);
await relay.call("reset");
await relay.call("cut");
assert.equal(await relay.call("not-in-the-allowlist"), 403);
await settle();
const byModel = (m: string): JsonObject | undefined => rows().find((r) => r.model === m);
assert.deepEqual([byModel("ok")?.run, byModel("ok")?.cycle, byModel("ok")?.role, byModel("ok")?.outcome, byModel("ok")?.costUsd], ["r1", 4, "worker", "ok", 0.25], "a billed reply carries run, cycle and role");
for (const [model, outcome] of [["limited", "non-200"], ["boom", "non-200"], ["no-usage", "unmetered"], ["reset", "error"]] as const) {
  const row = byModel(model);
  assert.deepEqual([row?.outcome, row?.unresolved, row?.costUsd, row?.run, row?.cycle, row?.role], [outcome, true, null, "r1", 4, "worker"], `${model}: an unresolved liability, attributed`);
}
const cut = byModel("cut");
assert.ok(cut?.unresolved === true && (cut.outcome === "aborted" || cut.outcome === "error"), `a cut-off reply is a liability (${String(cut?.outcome)})`);
assert.deepEqual([byModel("not-in-the-allowlist")?.outcome, byModel("not-in-the-allowlist")?.unresolved], ["refused", undefined], "a refusal never reached the provider: recorded, not a liability");
const summary = summariseMeter(fs.readFileSync(meter, "utf8"), 4);
assert.equal(summary.byRole.worker, 0.25);
assert.equal(summary.unresolved, 5, "limited, boom, no-usage, reset and cut are unresolved");
assert.equal(summariseMeter(fs.readFileSync(meter, "utf8"), 5).rows, 0, "another cycle sees none of these rows");
assert.equal(summariseMeter("not json\n{\"costUsd\":1}\n").unreadable, 1, "an unreadable row is counted, not dropped silently");

// --- the ledger survives a restart, and the host's own spend counts toward the stop -----------------------------
await relay.close();
relay = await serve(0.3);
assert.equal(await relay.call("ok"), 200, "0.25 spent of 0.30: still under");
await settle();
assert.equal(await relay.call("ok"), 429, "the restarted relay started from the ledger on disk, not from zero");
await relay.close();
fs.rmSync(path.join(dir, "manager.jsonl"), { force: true });
fs.writeFileSync(meter, "");
relay = await serve(0.3);
fs.writeFileSync(path.join(dir, "manager.jsonl"), `${JSON.stringify({ costUsd: 0.5, role: "manager", cycle: 4 })}\n`);
assert.equal(await relay.call("ok"), 429, "manager and review spend count toward the relay's stop");
await relay.close();
// A raised cap is live: the supervisor rewrites limit.json and the same relay serves again, no restart.
fs.rmSync(path.join(dir, "manager.jsonl"), { force: true });
fs.writeFileSync(meter, "");
relay = await serve(0.3);
assert.equal(await relay.call("ok"), 200);
await settle();
assert.equal(await relay.call("ok"), 200);
await settle();
assert.equal(await relay.call("ok"), 429, "0.50 spent passes the 0.30 cap");
fs.writeFileSync(path.join(dir, "limit.json"), JSON.stringify({ maxUsd: 5 }));
assert.equal(await relay.call("ok"), 200, "a raised cap takes effect on the running relay");
fs.writeFileSync(path.join(dir, "limit.json"), JSON.stringify({ maxUsd: 0.1 }));
assert.equal(await relay.call("ok"), 429, "a lowered cap does too");
await relay.close();
await new Promise<void>((r) => provider.close(() => r()));

// --- provider refusals park with an explicit waiting reason -----------------------------------------------------------------
const fail = (errorMessage: string, watch?: ProviderLimitWatch): string | null => providerLimitError({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage } }, watch);
assert.equal(providerBlocker(fail("402 requires more credits") ?? "").waiting, "waiting_budget");
assert.match(providerBlocker("402 requires more credits").question, /^\[waiting_budget\]/);
assert.equal(providerBlocker(fail("429 Run budget exhausted") ?? "").waiting, "waiting_budget", "the relay's own spending stop is the budget, not a rate limit");
const watch: ProviderLimitWatch = { clamped: 0 };
assert.equal(fail("429 Too Many Requests", watch), null, "one rate limit is left to the retry");
assert.equal(fail("429 Too Many Requests", watch), null, "two are a short burst, not a wait");
for (let i = 0; i < 2; i++) fail("429 Too Many Requests", watch);
const second = fail("429 Too Many Requests", watch);
assert.ok(second, "a long run of them in a row parks");
assert.equal(providerBlocker(second).waiting, "waiting_provider");
const w403: ProviderLimitWatch = { clamped: 0 };
assert.equal(fail("403 Forbidden: key disabled", w403), null);
assert.equal(providerBlocker(fail("403 Forbidden: key disabled", w403) ?? "").waiting, "waiting_provider");
assert.equal(fail("403 Model \"x\" is not allowed for this run", { clamped: 0, refused: 5 }), null, "the relay's own refusal is not the provider's");
assert.equal(fail("403 Only inference requests are allowed", { clamped: 0, refused: 5 }), null);
const recovered: ProviderLimitWatch = { clamped: 0 };
fail("429 Too Many Requests", recovered);
providerLimitError({ type: "message_end", message: { role: "assistant", stopReason: "stop" } }, recovered);
assert.equal(fail("429 Too Many Requests", recovered), null, "a reply that succeeds in between starts the count again");
assert.match(providerLimitError({ type: "auto_retry_end", success: false, finalError: "429 rate limited" }) ?? "", /rate limited/, "a retry that gave up parks at once");
assert.equal(providerLimitError({ type: "message_update", message: { role: "assistant", stopReason: "error", errorMessage: "429 Too Many Requests" } }, { clamped: 0 }), null, "an update does not count twice with its end");

fs.rmSync(dir, { recursive: true, force: true });
console.log("autonomy meter smoke ok");
