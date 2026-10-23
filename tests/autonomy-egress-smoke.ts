#!/usr/bin/env node
/**
 * Offline checks for the egress proxy (packages/autonomy/lib/egress-proxy.ts), in-process,
 * against a local fake upstream and a fake resolver: the allowlist, tricky host spellings,
 * address classes, DNS rebinding, redirects, caps and the audit log. The dial function is
 * injected and records the ADDRESS it is asked to connect to, which proves the proxy connects
 * to the validated IP and never hands a name to the connect call. No Docker, no real network.
 */
import http from "node:http";
import net from "node:net";
import { assert, implementRaw, makeChecker, testEffort } from "./autonomy-helpers.ts";
import { createEgressProxy, decideDestination, parseAuthority, proxyConfigFromContract } from "../packages/autonomy/lib/egress-proxy.ts";
import { resolveContract } from "../packages/autonomy/lib/contract.ts";

/** One record of the proxy's audit log (only the fields these checks read). */
interface AuditRecord { decision: string; host?: string; reason?: string; connectedTo?: string; bytesUp?: number; resolved?: string[]; closed?: string; at?: string; id?: number }
type EgressServer = ReturnType<typeof createEgressProxy> & { stats(): { active: number } };
type ProxyOptions = NonNullable<Parameters<typeof createEgressProxy>[0]>;
interface Proxy { server: EgressServer; port: number; auditLog: AuditRecord[]; resolveCalls: string[] }
interface ConnectResult { status: number; head: string; rest: string; socket: net.Socket }
interface HttpResult { status: number | undefined; headers: http.IncomingHttpHeaders; body: string }
interface EgressPolicy { allow?: { host: string; ports: number[]; plainGet?: boolean }[]; services?: { host: string; ports: number[] }[] }
// Typed view: the policy parameter is destructured with `[]` defaults and no JSDoc, so its inferred type is `never[]`.
const decide = decideDestination as (policy: EgressPolicy, host: string, port: number) => ReturnType<typeof decideDestination>;

/** The port a listening server is bound to. */
function portOf(server: net.Server): number {
  const address = server.address();
  assert.ok(address && typeof address === "object", "listening on a TCP port");
  return address.port;
}

const { check, done } = makeChecker("autonomy-egress-smoke");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- fake upstreams -------------------------------------------------------------------------
const echo = net.createServer((s) => { s.write("hello\n"); s.on("data", (d) => s.write(d)); s.on("error", () => {}); });
const httpHits: { url: string | undefined; host: string | undefined; proxyAuth: string | undefined }[] = [];
const web = http.createServer((req, res) => {
  httpHits.push({ url: req.url, host: req.headers.host, proxyAuth: req.headers["proxy-authorization"] });
  if (req.url === "/redirect") { res.writeHead(302, { location: "http://evil.example.org/" }); res.end(); return; }
  res.writeHead(200, { "content-type": "text/plain", "x-hop": "up" }); res.end("plain-ok");
});
await new Promise<void>((r) => echo.listen(0, "127.0.0.1", r));
await new Promise<void>((r) => web.listen(0, "127.0.0.1", r));
const echoPort = portOf(echo);
const webPort = portOf(web);

const DNS: Record<string, string[] | undefined> = {
  "registry.example.org": ["93.184.216.34"],
  "plain.example.org": ["93.184.216.35"],
  "v6.example.org": ["2606:4700:4700::1111"],
  "loop.example.org": ["127.0.0.1"],
  "mixed.example.org": ["93.184.216.34", "10.0.0.5"],
  "meta.example.org": ["169.254.169.254"],
  "mapped.example.org": ["::ffff:127.0.0.1"],
  "ula.example.org": ["fd00::5"],
  "db.svc": ["172.20.0.5"],
  "private.example.org": ["192.168.1.10"],
};
let rebindCalls = 0;
const dialled: { address: string; port: number }[] = [];
function makeProxy(over: Partial<ProxyOptions> = {}): Promise<Proxy> {
  const auditLog: AuditRecord[] = [];
  const resolveCalls: string[] = [];
  const server = createEgressProxy({
    allow: [
      { host: "registry.example.org", ports: [443], plainGet: false },
      { host: "plain.example.org", ports: [80], plainGet: true },
      { host: "v6.example.org", ports: [443] },
      { host: "loop.example.org", ports: [443] }, { host: "mixed.example.org", ports: [443] }, { host: "meta.example.org", ports: [443] }, { host: "mapped.example.org", ports: [443] }, { host: "ula.example.org", ports: [443] },
      { host: "private.example.org", ports: [443] }, { host: "rebind.example.org", ports: [443] }, { host: "93.184.216.36", ports: [443] },
    ],
    services: [{ host: "db.svc", ports: [5432] }],
    resolve: async (host: string) => {
      resolveCalls.push(host);
      if (host === "rebind.example.org") { rebindCalls++; return [{ address: rebindCalls === 1 ? "93.184.216.34" : "127.0.0.1", family: 4 }]; }
      const list = DNS[host];
      if (!list) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
      return list.map((address: string) => ({ address, family: address.includes(":") ? 6 : 4 }));
    },
    dial: async ({ address, port }: { address: string; port: number }) => {
      dialled.push({ address, port });
      const target = port === 80 ? webPort : echoPort;
      return new Promise<net.Socket>((resolve, reject) => { const s = net.connect({ host: "127.0.0.1", port: target }); s.once("connect", () => resolve(s)); s.once("error", reject); });
    },
    audit: (rec: AuditRecord) => auditLog.push(rec),
    verifyRemote: false,
    ...over,
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: portOf(server), auditLog, resolveCalls })));
}

/** Send a CONNECT and read the response head. */
function connect(port: number, authority: string, { extra = "" }: { extra?: string } = {}): Promise<ConnectResult> {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: "127.0.0.1", port });
    let buf = "";
    s.on("error", reject);
    s.on("data", (d) => {
      buf += d.toString("latin1");
      const end = buf.indexOf("\r\n\r\n");
      if (end >= 0) { s.removeAllListeners("data"); resolve({ status: Number(buf.slice(9, 12)), head: buf.slice(0, end), rest: buf.slice(end + 4), socket: s }); }
    });
    s.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${extra}\r\n`);
  });
}
const closeAll = async (...proxies: Proxy[]) => { for (const p of proxies) await new Promise<void>((r) => { p.server.closeAllConnections?.(); p.server.close(() => r()); }); };
const get = (port: number, url: string, { method = "GET", headers = {} }: { method?: string; headers?: http.OutgoingHttpHeaders } = {}) => new Promise<HttpResult>((resolve, reject) => {
  const req = http.request({ host: "127.0.0.1", port, method, path: url, headers }, (res) => { let body = ""; res.on("data", (c) => { body += String(c); }); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body })); });
  req.on("error", reject); req.end();
});

await check("parseAuthority and decideDestination: normalised, exact-match, port-checked before any network activity", () => {
  assert.deepEqual(parseAuthority("Registry.Example.ORG.:443"), { host: "registry.example.org", port: 443 });
  assert.deepEqual(parseAuthority("[::FFFF:127.0.0.1]:443"), { host: "::ffff:127.0.0.1", port: 443 });
  for (const bad of ["registry.example.org", "registry.example.org:0", "registry.example.org:99999", "a@b.example.org:443", "x:1:2", "", "a b:443", "reg%69.example.org:443", "host..:443"]) assert.ok(parseAuthority(bad).error, JSON.stringify(bad));
  const policy: EgressPolicy = { allow: [{ host: "registry.example.org", ports: [443] }, { host: "93.184.216.36", ports: [443] }], services: [{ host: "db.svc", ports: [5432] }] };
  assert.equal(decide(policy, "registry.example.org", 443).ok, true);
  assert.equal(decide(policy, "registry.example.org", 80).reason, "port_not_allowed");
  assert.equal(decide(policy, "localhost.evil", 443).reason, "not_allowlisted");
  assert.equal(decide(policy, "0x7f.1", 443).reason, "ip_literal_not_listed");
  assert.equal(decide(policy, "::ffff:127.0.0.1", 443).reason, "ip_literal_not_listed");
  assert.equal(decide(policy, "0x5d.0xb8.0xd8.0x24", 443).ok, true, "a listed IP in another spelling is the same address");
  assert.equal(decide(policy, "db.svc", 5432).ok, true);
});

const main = await makeProxy();

await check("an allowlisted CONNECT tunnels bytes to the RESOLVED, validated address; the audit log records it", async () => {
  dialled.length = 0;
  const r = await connect(main.port, "Registry.Example.ORG.:443");
  assert.equal(r.status, 200);
  const hello = r.rest || await new Promise<string>((res) => r.socket.once("data", (d) => res(d.toString())));
  assert.match(hello, /hello/);
  const echoed = new Promise<string>((res) => r.socket.once("data", (d) => res(d.toString())));
  r.socket.write("ping");
  assert.equal(await echoed, "ping");
  r.socket.end();
  await sleep(50);
  assert.deepEqual(dialled, [{ address: "93.184.216.34", port: 443 }], "connected to the validated IP, not the name");
  const rec = main.auditLog.find((a) => a.decision === "allow" && a.host === "registry.example.org");
  assert.ok(rec?.connectedTo === "93.184.216.34" && rec.bytesUp === 4, JSON.stringify(rec));
  assert.deepEqual(rec.resolved, ["93.184.216.34"]);
  const v6 = await connect(main.port, "v6.example.org:443");
  assert.equal(v6.status, 200, "a public IPv6 address is fine");
  v6.socket.destroy();
});

await check("tricky inputs are refused before any connection is made", async () => {
  const cases: [name: string, authority: string, status: number, reason: string][] = [
    ["userinfo trick", "registry.example.org@evil.example.org:443", 400, "malformed_authority"],
    ["unlisted host", "evil.example.org:443", 403, "not_allowlisted"],
    ["localhost.evil", "localhost.evil:443", 403, "not_allowlisted"],
    ["localhost", "localhost:443", 403, "not_allowlisted"],
    ["legacy hex IPv4", "0x7f.1:443", 403, "ip_literal_not_listed"],
    ["decimal IPv4", "2130706433:443", 403, "ip_literal_not_listed"],
    ["octal IPv4", "0177.0.0.1:443", 403, "ip_literal_not_listed"],
    ["dotted loopback", "127.0.0.1:443", 403, "ip_literal_not_listed"],
    ["private literal", "10.0.0.1:443", 403, "ip_literal_not_listed"],
    ["metadata literal", "169.254.169.254:80", 403, "ip_literal_not_listed"],
    ["IPv6 loopback", "[::1]:443", 403, "ip_literal_not_listed"],
    ["IPv4-mapped loopback", "[::ffff:127.0.0.1]:443", 403, "ip_literal_not_listed"],
    ["IPv4-mapped hex", "[::ffff:7f00:1]:443", 403, "ip_literal_not_listed"],
    ["unique-local literal", "[fd00::5]:443", 403, "ip_literal_not_listed"],
    ["listed host, other port", "registry.example.org:8443", 403, "port_not_allowed"],
    ["listed host, ssh port", "registry.example.org:22", 403, "port_not_allowed"],
    ["double trailing dot", "registry.example.org..:443", 400, "malformed_authority"],
    ["no port", "registry.example.org", 400, "malformed_authority"],
    ["port zero", "registry.example.org:0", 400, "malformed_authority"],
    ["port too large", "registry.example.org:70000", 400, "malformed_authority"],
    ["percent-encoding", "reg%69stry.example.org:443", 400, "malformed_authority"],
    ["unicode look-alike", "regıstry.example.org:443", 400, "client_error:HPE_INVALID_URL"], // refused by the HTTP parser itself
    ["wildcard", "*.example.org:443", 400, "malformed_authority"],
    ["listed name resolving to loopback", "loop.example.org:443", 403, "blocked_address_class:loopback"],
    ["listed name resolving to private", "private.example.org:443", 403, "blocked_address_class:private"],
    ["listed name resolving to metadata", "meta.example.org:443", 403, "blocked_address_class:metadata"],
    ["listed name resolving to a mapped address", "mapped.example.org:443", 403, "blocked_address_class:ipv4-mapped-loopback"],
    ["listed name resolving to unique-local", "ula.example.org:443", 403, "blocked_address_class:unique-local"],
    ["one bad record among good ones", "mixed.example.org:443", 403, "blocked_address_class:private"],
    ["a service name is not reachable on another port", "db.svc:22", 403, "port_not_allowed"],
  ];
  dialled.length = 0;
  for (const [name, authority, status, reason] of cases) {
    const before = main.auditLog.length;
    const r = await connect(main.port, authority);
    r.socket.destroy();
    assert.equal(r.status, status, `${name}: status ${r.status}`);
    const rec = main.auditLog.slice(before).find((a) => a.decision === "deny");
    assert.ok(rec, `${name}: no audit record`);
    assert.equal(rec.reason, reason, name);
  }
  assert.equal(dialled.length, 0, "not one connection was attempted");
});

await check("DNS rebinding: every connection resolves and validates again, and connects to the address it validated", async () => {
  rebindCalls = 0; dialled.length = 0;
  const first = await connect(main.port, "rebind.example.org:443");
  assert.equal(first.status, 200);
  first.socket.destroy();
  const second = await connect(main.port, "rebind.example.org:443");
  assert.equal(second.status, 403, "the second lookup answers 127.0.0.1");
  second.socket.destroy();
  assert.deepEqual(dialled, [{ address: "93.184.216.34", port: 443 }]);
  assert.equal(rebindCalls, 2);
});

await check("IP literals: refused unless that exact public address is listed; other spellings of a listed address are the same address", async () => {
  dialled.length = 0;
  const listed = await connect(main.port, "93.184.216.36:443");
  assert.equal(listed.status, 200);
  listed.socket.destroy();
  const spelled = await connect(main.port, "0x5d.0xb8.0xd8.0x24:443");
  assert.equal(spelled.status, 200);
  spelled.socket.destroy();
  const mapped = await connect(main.port, "[::ffff:93.184.216.36]:443");
  assert.equal(mapped.status, 403, "an IPv4-mapped spelling is a different address class and is not listed");
  mapped.socket.destroy();
  assert.deepEqual(dialled.map((d) => d.address), ["93.184.216.36", "93.184.216.36"]);
});

await check("run services may resolve to private addresses, only on their declared port; a public entry never can", async () => {
  dialled.length = 0;
  const svc = await connect(main.port, "db.svc:5432");
  assert.equal(svc.status, 200);
  svc.socket.destroy();
  assert.deepEqual(dialled, [{ address: "172.20.0.5", port: 5432 }]);
  const both = await makeProxy({ allow: [{ host: "db.svc", ports: [5432] }] });
  const r = await connect(both.port, "db.svc:5432");
  assert.equal(r.status, 403, "listed as egress (not as a service), the same private answer is refused");
  r.socket.destroy();
  await closeAll(both);
});

await check("plain HTTP: GET only, only for plainGet entries, redirects are not followed, hop-by-hop headers and user info are dropped", async () => {
  httpHits.length = 0; dialled.length = 0;
  const ok = await get(main.port, "http://plain.example.org/ok", { headers: { host: "plain.example.org", "proxy-authorization": "x", connection: "keep-alive" } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body, "plain-ok");
  const [hit] = httpHits;
  assert.ok(hit, "the plain GET reached the upstream");
  assert.equal(hit.proxyAuth, undefined, "hop-by-hop headers are not forwarded");
  assert.equal(hit.host, "plain.example.org");
  assert.deepEqual(dialled, [{ address: "93.184.216.35", port: 80 }]);
  const redirect = await get(main.port, "http://plain.example.org/redirect", { headers: { host: "plain.example.org" } });
  assert.equal(redirect.status, 302, "the 302 is passed to the client");
  assert.equal(httpHits.filter((h) => h.url === "/redirect").length, 1);
  assert.equal(httpHits.filter((h) => h.host === "evil.example.org").length, 0, "the Location was not followed");
  const noPlain = await get(main.port, "http://registry.example.org/", { headers: { host: "registry.example.org" } });
  assert.equal(noPlain.status, 403);
  assert.match(noPlain.body, /not_allowlisted|port_not_allowed|plain_http/);
  assert.equal((await get(main.port, "http://plain.example.org/x", { method: "POST", headers: { host: "plain.example.org" } })).status, 405);
  assert.equal((await get(main.port, "http://plain.example.org@evil.example.org/", { headers: { host: "evil.example.org" } })).status, 400, "user info in the URL");
  assert.equal((await get(main.port, "http://plain.example.org/", { headers: { host: "evil.example.org" } })).status, 400, "Host header must match the URL");
  assert.equal((await get(main.port, "https://plain.example.org/", { headers: { host: "plain.example.org" } })).status, 400);
  assert.equal((await get(main.port, "/relative", { headers: { host: "plain.example.org" } })).status, 400);
  assert.equal((await get(main.port, "http://127.0.0.1/", { headers: { host: "127.0.0.1" } })).status, 403);
  assert.equal(httpHits.length, 2, "only the two allowed requests reached the upstream");
});

await check("caps: concurrent connections, per-client connections, bytes and idle time", async () => {
  const p = await makeProxy({ limits: { maxConnections: 2, maxPerClient: 5, maxBytesPerConnection: 64, idleTimeoutMs: 300 } });
  const a = await connect(p.port, "registry.example.org:443");
  const b = await connect(p.port, "registry.example.org:443");
  assert.deepEqual([a.status, b.status], [200, 200]);
  const c = await connect(p.port, "registry.example.org:443");
  assert.equal(c.status, 503);
  assert.equal(p.auditLog.at(-1)?.reason, "too_many_connections");
  c.socket.destroy();
  a.socket.write("x".repeat(200));
  await sleep(150);
  assert.ok(p.auditLog.some((r) => r.closed === "byte_cap"), "the byte cap closed the tunnel");
  await sleep(500);
  assert.ok(p.auditLog.some((r) => r.closed === "idle_timeout"), "an idle tunnel is closed");
  assert.equal(p.server.stats().active, 0, "slots are released");
  a.socket.destroy(); b.socket.destroy();
  await closeAll(p);
  const q = await makeProxy({ limits: { maxPerClient: 1 } });
  const first = await connect(q.port, "registry.example.org:443");
  const second = await connect(q.port, "registry.example.org:443");
  assert.deepEqual([first.status, second.status], [200, 503]);
  assert.equal(q.auditLog.at(-1)?.reason, "too_many_connections_for_client");
  first.socket.destroy(); second.socket.destroy();
  await closeAll(q);
});

await check("defence in depth: the connected peer is validated again; oversized headers are refused", async () => {
  const strict = await makeProxy({ verifyRemote: true }); // the fake dial returns a loopback socket
  const r = await connect(strict.port, "registry.example.org:443");
  assert.equal(r.status, 403);
  assert.match(strict.auditLog.at(-1)?.reason ?? "", /^peer_blocked_address_class:loopback/);
  r.socket.destroy();
  await closeAll(strict);
  const big = await new Promise<string>((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port: main.port });
    let buf = ""; s.on("data", (d) => { buf += String(d); }); s.on("close", () => resolve(buf)); s.on("error", () => resolve(buf));
    s.write(`CONNECT registry.example.org:443 HTTP/1.1\r\nX-Big: ${"a".repeat(40_000)}\r\n\r\n`);
  });
  assert.doesNotMatch(big, /200 Connection Established/);
});

await check("every decision is audited (allowed and refused); resolution failure is a refusal", async () => {
  const before = main.auditLog.length;
  const nx = await connect(main.port, "registry.example.org:443");
  nx.socket.destroy();
  const dnsFail = await makeProxy({ allow: [{ host: "nx.example.org", ports: [443] }] });
  const r = await connect(dnsFail.port, "nx.example.org:443");
  assert.equal(r.status, 403);
  assert.match(dnsFail.auditLog.at(-1)?.reason ?? "", /^dns_failed/);
  r.socket.destroy();
  await closeAll(dnsFail);
  assert.ok(main.auditLog.length > before);
  assert.ok(main.auditLog.every((a) => a.at && a.id && a.decision), "each record has a time, an id and a decision");
  assert.ok(main.auditLog.filter((a) => a.decision === "deny").length >= 25);
});

await check("the proxy's allowlist comes from the contract's network.egress entries only", () => {
  const r = resolveContract(implementRaw({ permissions: { network: { egress: [{ host: "Registry.NPMJS.org", ports: [443] }, { host: "files.example.org", ports: [80, 443], plainGet: true }] } } }), { effort: testEffort });
  assert.equal(r.ok, true);
  assert.ok(r.contract, "resolved");
  assert.deepEqual(proxyConfigFromContract(r.contract), { allow: [{ host: "registry.npmjs.org", ports: [443], plainGet: false }, { host: "files.example.org", ports: [80, 443], plainGet: true }], services: [] });
  const none = resolveContract(implementRaw(), { effort: testEffort }).contract;
  assert.ok(none, "resolved");
  assert.deepEqual(proxyConfigFromContract(none), { allow: [], services: [] }, "no egress declared: an empty allowlist, nothing is tunnelled");
});

await closeAll(main);
echo.close(); web.close();
done();
