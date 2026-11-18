#!/usr/bin/env node
/**
 * The reporting line (packages/autonomy/lib/reporting.ts, `pi-autonomy report`) and the relay's
 * key-limit probe (relay.ts probeKeyLimit):
 *   - status.json: per-run state, last cycle, spend today and this month per source, key limits, PRs;
 *   - alerts fire once per condition, again only after it clears; a paused run raises nothing;
 *   - CI red on an autonomy PR and a green release PR alert; the digest goes once a day after its hour;
 *   - ntfy gets one POST per alert with the token as a bearer header; the token is in no file,
 *     log line or return value, and is never sent over plain http to a non-loopback host;
 *   - an alert that was not delivered is tried again on the next tick;
 *   - the key probe keeps only limit, limit_remaining and usage (the reply's label shows part of the key);
 *   - the first tick records existing conditions without sending; a corrupt state file re-sends;
 *   - model-written text is redacted before it reaches the status file or ntfy.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { makeChecker } from "./autonomy-helpers.ts";
import { isolateKitEnv } from "../packages/core/eval/harness.ts";
import { alertsFor, buildStatus, ciFromRollup, dayIn, loopback, plan, prsFromGh, publish, readAlertState, reportTick, type StatusReport } from "../packages/autonomy/lib/reporting.ts";
import { probeKeyLimit } from "../packages/autonomy/relay.ts";
import { main } from "../packages/autonomy/cli.ts";

isolateKitEnv();
const { check, done } = makeChecker("autonomy-reporting-smoke");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "luna-reporting-"));
process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
const TOKEN = "tk_synthetic_reporting_token_0001";
// Assembled at run time so no literal secret-shaped string sits in the repository.
const SECRET = "ghp" + "_" + "c".repeat(36);
const tokenFile = path.join(dir, "ntfy.token");
fs.writeFileSync(tokenFile, `${TOKEN}\n`, { mode: 0o600 });

const NOW = new Date("2026-11-17T10:00:00Z"); // 20:00 in Brisbane
const TZ = "Australia/Brisbane";
const home = path.join(dir, "runs");
function makeRun(run: string, { status = "paused", blocker = null as unknown, provider = "openrouter", upstream = "https://openrouter.ai/api/v1", rows = [] as Array<[string, number]>, key = null as unknown, cycle = null as unknown }): void {
  const d = path.join(home, run);
  fs.mkdirSync(path.join(d, "meter"), { recursive: true });
  fs.writeFileSync(path.join(d, "state.json"), JSON.stringify({ schemaVersion: 1, run, status, step: 3, blocker, outcome: null, usage: { usd: 1.5 }, limits: { budget: { totalUsd: 40 } }, selfImprove: { history: cycle ? [cycle] : [] }, updatedAt: NOW.toISOString() }));
  fs.writeFileSync(path.join(d, "contract.json"), JSON.stringify({ model: { provider }, providerSettings: { upstream } }));
  fs.writeFileSync(path.join(d, "meter", "usage.jsonl"), rows.map(([at, costUsd]) => JSON.stringify({ at, costUsd })).join("\n") + "\nnot json\n");
  if (key) fs.writeFileSync(path.join(d, "meter", "key.json"), JSON.stringify(key));
}
makeRun("core", { rows: [["2026-11-17T01:00:00Z", 0.5], ["2026-11-16T15:00:00Z", 0.25], ["2026-11-03T00:00:00Z", 1], ["2026-10-31T00:00:00Z", 9]], key: { at: "2026-11-17T09:00:00Z", limit: 50, limit_remaining: 12.5, usage: 37.5, label: "sk-or-v1-abc...xyz" }, cycle: { n: 7, outcome: "completed", reason: "report recorded", gate: "green", merged: true } });
makeRun("ux", { status: "blocked", provider: "openai-compatible", upstream: "https://api.anthropic.com/v1", blocker: { kind: "external", question: `provider said 402 for ${SECRET}`, waiting: "waiting_budget" }, rows: [["2026-11-17T02:00:00Z", 2]] });

// A local ntfy: records each POST; replies with the status set in `reply`.
const posts: Array<{ url: string; headers: http.IncomingHttpHeaders; body: string }> = [];
let reply = 200;
const sink = http.createServer((req, res) => { let body = ""; req.on("data", (c: Buffer) => { body += String(c); }); req.on("end", () => { posts.push({ url: req.url ?? "", headers: req.headers, body }); res.writeHead(reply).end("{}"); }); });
await new Promise<void>((r) => sink.listen(0, "127.0.0.1", r));
const ntfyUrl = `http://127.0.0.1:${(sink.address() as AddressInfo).port}/luna-status`;

await check("status: per-run state, last cycle, spend today and this month per source, key limit without the label", () => {
  const s = buildStatus({ home, now: NOW, timeZone: TZ });
  assert.equal(s.schemaVersion, 1);
  assert.deepEqual(s.runs.map((r) => [r.run, r.status, r.source]), [["core", "paused", "openrouter"], ["ux", "blocked", "api.anthropic.com"]]);
  // 2026-11-16T15:00Z is 01:00 on the 17th in Brisbane: today there, not in UTC.
  assert.deepEqual(s.spend.openrouter, { todayUsd: 0.75, monthUsd: 1.75 });
  assert.deepEqual(s.spend["api.anthropic.com"], { todayUsd: 2, monthUsd: 2 });
  assert.deepEqual(s.keys.openrouter, { at: "2026-11-17T09:00:00Z", limit: 50, limit_remaining: 12.5, usage: 37.5 });
  assert.deepEqual(s.runs[0]?.lastCycle, { n: 7, outcome: "completed", reason: "report recorded", gate: "green", merged: true });
  assert.equal(s.openPrs, null, "PRs not asked for are unknown, not none");
});

const prs = prsFromGh([
  { number: 120, title: "integrate: core", headRefName: "integrate/core", baseRefName: "integration/luna", isDraft: true, url: "u120", statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }, { status: "COMPLETED", conclusion: "FAILURE" }] },
  { number: 121, title: "release", headRefName: "integration/luna", baseRefName: "main", isDraft: false, url: "u121", statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }, { state: "SUCCESS" }] },
  { number: 122, title: "a person's branch", headRefName: "claude/x", baseRefName: "integration/luna", isDraft: false, url: "u122", statusCheckRollup: [{ status: "COMPLETED", conclusion: "FAILURE" }] },
]);

await check("pull requests: CI state from the rollup; red autonomy PR and green release PR alert, a person's red PR does not", () => {
  assert.equal(ciFromRollup([{ status: "IN_PROGRESS", conclusion: "" }]), "pending");
  assert.equal(ciFromRollup([]), "none");
  const keys = alertsFor(buildStatus({ home, now: NOW, timeZone: TZ, prs })).map((a) => a.key);
  assert.deepEqual(keys.sort(), ["pr:120:red", "pr:121:release-ready", "run:ux:blocked:waiting_budget"]);
});

await check("alerts: once per condition, again after it clears; key exhausted alerts; paused raises nothing", () => {
  let state = readAlertState(path.join(dir, "none.json"));
  const s1 = buildStatus({ home, now: NOW, timeZone: TZ });
  const first = plan(state, alertsFor(s1), s1, { digestHour: 21 });
  assert.deepEqual(first.send.map((a) => a.key), ["run:ux:blocked:waiting_budget"]);
  state = first.next;
  assert.equal(plan(state, alertsFor(s1), s1, { digestHour: 21 }).send.length, 0, "no repeat while it lasts");
  state = plan(state, [], s1, { digestHour: 21 }).next;
  assert.equal(plan(state, alertsFor(s1), s1, { digestHour: 21 }).send.length, 1, "it comes back, it alerts again");
  const dry: StatusReport = { ...s1, keys: { openrouter: { at: "x", limit: 50, limit_remaining: 0, usage: 50 } } };
  assert.ok(alertsFor(dry).some((a) => a.key === "key:openrouter:exhausted"));
});

await check("digest: once a day at or after its hour", () => {
  const s = buildStatus({ home, now: NOW, timeZone: TZ });
  const empty = { active: [], digestDay: null, lastAlert: null };
  assert.equal(plan(empty, [], s, { digestHour: 21 }).send.length, 0, "before the hour");
  const at20 = plan(empty, [], s, { digestHour: 20 });
  assert.equal(at20.send[0]?.key, "digest");
  assert.match(at20.send[0]?.message ?? "", /core: paused, last cycle 7 completed \(merged\)/);
  assert.match(at20.send[0]?.message ?? "", /openrouter key: \$12\.50 of \$50\.00 left/);
  assert.equal(plan(at20.next, [], s, { digestHour: 20 }).send.length, 0, "not twice a day");
});

await check("tick: one POST per alert with a bearer token; the token is in no file, log or result; a failed send is retried", async () => {
  const out = path.join(dir, "state", "status.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(path.join(dir, "state", "alerts.json"), JSON.stringify({ active: [], digestDay: null, lastAlert: null }));
  const log: string[] = [];
  reply = 500;
  const t1 = await reportTick({ home, now: NOW, timeZone: TZ, prs, out, ntfy: { url: ntfyUrl, tokenFile }, digestHour: 21, log: (l) => { log.push(l); } });
  assert.equal(posts.length, 3);
  assert.ok(t1.sent.every((r) => !r.delivered && r.httpStatus === 500));
  reply = 200;
  const t2 = await reportTick({ home, now: NOW, timeZone: TZ, prs, out, ntfy: { url: ntfyUrl, tokenFile }, digestHour: 21, log: (l) => { log.push(l); } });
  assert.equal(t2.sent.length, 3, "undelivered alerts are sent again");
  assert.ok(t2.sent.every((r) => r.delivered));
  await reportTick({ home, now: NOW, timeZone: TZ, prs, out, ntfy: { url: ntfyUrl, tokenFile }, digestHour: 21 });
  assert.equal(posts.length, 6, "nothing new, nothing sent");
  const p = posts[posts.length - 1];
  assert.equal(p?.url, "/luna-status");
  assert.equal(p?.headers.authorization, `Bearer ${TOKEN}`);
  assert.ok(p?.headers.title && p.headers.priority && p.headers.tags);
  const status = JSON.parse(fs.readFileSync(out, "utf8")) as StatusReport;
  assert.equal(status.lastAlert?.delivered, true);
  for (const text of [fs.readFileSync(out, "utf8"), fs.readFileSync(path.join(dir, "state", "alerts.json"), "utf8"), log.join("\n"), JSON.stringify([t1, t2])]) assert.ok(!text.includes(TOKEN));
  for (const text of [fs.readFileSync(out, "utf8"), ...posts.map((x) => x.body)]) assert.ok(!text.includes(SECRET), "model-written text is redacted");
  assert.equal(fs.statSync(out).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(dir, "state", "alerts.json")).mode & 0o777, 0o600);
});

await check("tick: the first run records what is already true without sending; a later new condition is sent", async () => {
  const out = path.join(dir, "first", "status.json");
  const log: string[] = [];
  const before = posts.length;
  const t1 = await reportTick({ home, now: NOW, timeZone: TZ, prs, out, ntfy: { url: ntfyUrl, tokenFile }, digestHour: 21, log: (l) => { log.push(l); } });
  assert.equal(t1.sent.length, 0);
  assert.equal(posts.length, before);
  assert.match(log.join("\n"), /first run: 3 existing condition/);
  const more = [...prs, ...prsFromGh([{ number: 130, title: "integrate: ops", headRefName: "integrate/ops", baseRefName: "integration/luna", isDraft: true, url: "u130", statusCheckRollup: [{ status: "COMPLETED", conclusion: "FAILURE" }] }])];
  const t2 = await reportTick({ home, now: NOW, timeZone: TZ, prs: more, out, ntfy: { url: ntfyUrl, tokenFile }, digestHour: 21 });
  assert.deepEqual(t2.sent.map((r) => r.title), ["Luna PR #130: CI red"]);
});

await check("tick: a corrupt state file re-sends what is active and says so; without ntfy nothing is marked sent", async () => {
  const out = path.join(dir, "corrupt", "status.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(path.join(dir, "corrupt", "alerts.json"), "{bad");
  const log: string[] = [];
  const quiet = await reportTick({ home, now: NOW, timeZone: TZ, prs, out, ntfy: null, digestHour: 21, log: (l) => { log.push(l); } });
  assert.equal(quiet.sent.length, 0);
  assert.match(log.join("\n"), /alert state unreadable/);
  assert.equal(log.filter((l) => l.startsWith("alert (no ntfy target configured)")).length, 3);
  assert.deepEqual(readAlertState(path.join(dir, "corrupt", "alerts.json")).active, [], "nothing is remembered as sent");
  const sent = await reportTick({ home, now: NOW, timeZone: TZ, prs, out, ntfy: { url: ntfyUrl, tokenFile }, digestHour: 21 });
  assert.equal(sent.sent.length, 3);
});

await check("tick: one failed alert and a failed digest are retried; the delivered ones are not sent again", async () => {
  const out = path.join(dir, "partial", "status.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(path.join(dir, "partial", "alerts.json"), JSON.stringify({ active: [], digestDay: null, lastAlert: null }));
  const failing = new Set(["Luna PR #120: CI red"]);
  const fetchImpl: typeof fetch = async (input, init) => {
    const title = new Headers(init?.headers).get("title") ?? "";
    if (failing.has(title) || title.startsWith("Luna daily digest")) return new Response("no", { status: 503 });
    return fetch(input, init);
  };
  const t1 = await reportTick({ home, now: NOW, timeZone: TZ, prs, out, ntfy: { url: ntfyUrl, tokenFile }, digestHour: 20, fetchImpl });
  assert.deepEqual(t1.sent.filter((r) => !r.delivered).map((r) => r.title).sort(), ["Luna PR #120: CI red", "Luna daily digest 2026-11-17"]);
  failing.clear();
  const t2 = await reportTick({ home, now: NOW, timeZone: TZ, prs, out, ntfy: { url: ntfyUrl, tokenFile }, digestHour: 20, fetchImpl: fetch });
  assert.deepEqual(t2.sent.map((r) => r.title).sort(), ["Luna PR #120: CI red", "Luna daily digest 2026-11-17"]);
  assert.ok(t2.sent.every((r) => r.delivered));
});

await check("time zones: the calendar day and hour follow the zone across a DST change", () => {
  assert.equal(dayIn(new Date("2026-03-08T10:30:00Z"), "America/Los_Angeles").day, "2026-03-08"); // 03:30 PDT, after the skipped hour
  assert.equal(dayIn(new Date("2026-03-08T07:30:00Z"), "America/Los_Angeles").day, "2026-03-07"); // 23:30 PST
  assert.equal(dayIn(new Date("2026-11-30T14:30:00Z"), TZ).month, "2026-12");
});

await check("publish: the token never goes over plain http to a non-loopback host; unreachable is reported, not thrown", async () => {
  const before = posts.length;
  const alert = { key: "k", title: "t", message: "m", priority: 3 as const, tags: [] };
  for (const url of ["http://ntfy.example.invalid/topic", "http://127.0.0.1.evil.example/topic", "http://127.example/topic"]) {
    const r = await publish({ url, tokenFile }, alert);
    assert.equal(r.delivered, false, url);
    assert.match(r.error ?? "", /plain http/, url);
  }
  for (const host of ["localhost", "127.0.0.1", "127.8.9.10", "[::1]"]) assert.ok(loopback(host), host);
  for (const host of ["127.0.0.1.evil.example", "127.example", "1270.0.0.1", "::ffff:8.8.8.8"]) assert.ok(!loopback(host), host);
  const unreadable = await publish({ url: ntfyUrl, tokenFile: path.join(dir, "no-such.token") }, alert);
  assert.equal(unreadable.delivered, false, "a configured token that cannot be read sends nothing");
  assert.match(unreadable.error ?? "", /cannot be read/);
  const down = await publish({ url: "http://127.0.0.1:9/topic", tokenFile }, alert, { timeoutMs: 2000 });
  assert.equal(down.delivered, false);
  assert.equal(down.httpStatus, null);
  assert.equal(posts.length, before);
});

await check("cli: report --test-event sends exactly one labelled event; report --out writes the status", async () => {
  const before = posts.length;
  const out: string[] = [];
  const io = { write: (s: string) => { out.push(s); return true; } };
  const deps = { home, now: () => NOW, stdout: io, stderr: io, isTTY: false };
  assert.equal(await main(["report", "--test-event", "TEST - luna reporting line", "--ntfy-url", ntfyUrl, "--ntfy-token-file", tokenFile], deps), 0);
  assert.equal(posts.length, before + 1);
  assert.equal(posts[posts.length - 1]?.headers.title, "TEST - luna reporting line");
  const statusFile = path.join(dir, "cli", "status.json");
  assert.equal(await main(["report", "--out", statusFile, "--time-zone", TZ, "--json"], deps), 0);
  const s = JSON.parse(fs.readFileSync(statusFile, "utf8")) as StatusReport;
  assert.equal(s.runs.length, 2);
  assert.ok(!out.join("").includes(TOKEN));
  assert.notEqual(await main(["report", "--out", statusFile, "--time-zone", "Not/AZone"], deps), 0);
  assert.notEqual(await main(["report", "--out", statusFile, "--ntfy-token-file", tokenFile], deps), 0, "a token file without a URL is a usage error");
  assert.notEqual(await main(["report", "--out", statusFile, "--digest-hour", "24"], deps), 0);
});

await check("relay key probe: keeps limit, limit_remaining and usage only; other providers and oversized replies write nothing", async () => {
  let seenAuth = "";
  let big = false;
  const or = http.createServer((req, res) => {
    seenAuth = req.headers.authorization ?? "";
    if (req.url !== "/api/v1/key") { res.writeHead(404).end(); return; }
    res.writeHead(200, { "content-type": "application/json" }).end(big ? JSON.stringify({ data: { pad: "x".repeat(70_000) } }) : JSON.stringify({ data: { label: "sk-or-v1-abc...xyz", limit: 50, limit_remaining: 10, usage: 40, is_free_tier: false } }));
  });
  await new Promise<void>((r) => or.listen(0, "127.0.0.1", r));
  const upstream = `http://127.0.0.1:${(or.address() as AddressInfo).port}/api/v1`;
  const keyFile = path.join(dir, "key.json");
  const got = await probeKeyLimit({ upstream, apiKey: "k-synthetic", provider: "openrouter" }, { keyFile, now: () => NOW });
  assert.deepEqual(got, { at: NOW.toISOString(), limit: 50, limit_remaining: 10, usage: 40 });
  assert.equal(seenAuth, "Bearer k-synthetic");
  const written = fs.readFileSync(keyFile, "utf8");
  assert.deepEqual(Object.keys(JSON.parse(written) as object).sort(), ["at", "limit", "limit_remaining", "usage"]);
  assert.ok(!written.includes("sk-or") && !written.includes("k-synthetic"));
  assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp")), [], "no temp file is left behind");
  fs.rmSync(keyFile);
  assert.equal(await probeKeyLimit({ upstream, apiKey: "k", provider: "openai-compatible" }, { keyFile }), null);
  big = true;
  assert.equal(await probeKeyLimit({ upstream, apiKey: "k", provider: "openrouter" }, { keyFile }), null);
  assert.ok(!fs.existsSync(keyFile));
  await new Promise<void>((r) => or.close(() => r()));
});

sink.closeAllConnections();
await new Promise<void>((r) => sink.close(() => r()));
done();
