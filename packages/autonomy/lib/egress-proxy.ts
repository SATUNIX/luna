#!/usr/bin/env node
// The run's egress proxy: the only way from the internal network to a public host, and only to
// hosts and ports the contract lists (permissions.network.egress). Runs in its own hardened
// container on the run network and the egress network (like the relay); its configuration
// arrives on stdin; every decision is written to an audit log.
//
// What it does
//   - CONNECT host:port  -> a tunnel, if host and port are on the allowlist. TLS is never
//     inspected or terminated; the tunnel is opaque bytes.
//   - GET/HEAD http://host/path (only for entries with plainGet) -> forwarded, redirects are NOT
//     followed (the client re-asks, and every new request is checked again).
//   - anything else -> refused.
//
// How it avoids being a leak
//   - Host names are normalised (case, one trailing dot) and must match an entry exactly. User
//     info, ports in the wrong place, percent-encoding, wildcards, non-ASCII and IPv6 zone ids
//     make the request malformed. IP-literal hosts (in any spelling: 0x7f.1, 2130706433,
//     [::ffff:127.0.0.1]) are refused unless that exact public address is listed.
//   - The proxy resolves DNS ITSELF, validates EVERY address it got (loopback, private,
//     link-local, metadata, multicast, unique-local, IPv4-mapped/compatible, NAT64, 6to4 and
//     other reserved ranges are refused, unless the destination is a declared run service),
//     then connects to the validated IP. It never hands a name to the connect call, so a second
//     lookup cannot return a different answer (DNS rebinding); every new connection resolves and
//     validates again. After connecting it checks the peer address once more.
//   - Caps: concurrent connections (and per client), bytes per connection, idle time, total
//     connection time, header size. Refused and closed connections are audited.
import dns from "node:dns/promises";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import type stream from "node:stream";
import { pathToFileURL } from "node:url";
import { SERVICE_OK_CLASSES, canonicalIp, classifyAddress, isIpLiteral, normaliseHost } from "./netaddr.ts";
import type { AddressClass } from "./netaddr.ts";

/** One allowlisted public destination (from the contract's permissions.network.egress). */
export interface AllowEntry { readonly host: string; readonly ports: readonly number[]; readonly plainGet?: boolean }
/** A declared run service: reachable at private or unique-local addresses only. */
export interface ServiceEntry { readonly host: string; readonly ports: readonly number[] }
/**
 * What the proxy may reach. There is no wildcard: a destination is allowed only when its exact
 * normalised host (or canonical IP) is an entry here, and an absent list is an empty one.
 */
export interface EgressPolicy { readonly allow?: readonly AllowEntry[]; readonly services?: readonly ServiceEntry[] }

/** The proxy's caps; every one is a number, so a missing or garbled cap is refused at start-up. */
export interface EgressLimits {
  maxConnections: number;
  maxPerClient: number;
  maxBytesPerConnection: number;
  connectTimeoutMs: number;
  idleTimeoutMs: number;
  maxConnectionMs: number;
  maxHeaderBytes: number;
  maxAddresses: number;
}

/** One address a resolver returned. */
export interface ResolvedAddress { address: string; family: number }
/** Resolve a host name to its addresses (default: the system resolver, every answer, verbatim). */
export type Resolve = (host: string) => Promise<readonly ResolvedAddress[]>;
/** What dial() is asked to connect to: always a validated IP, never a name. */
export interface DialTarget { address: string; port: number; family: number; timeoutMs: number }
export type Dial = (target: DialTarget) => Promise<net.Socket>;

/** One line of the audit log (egress.jsonl). */
export interface AuditRecord {
  at: string;
  id: number;
  client: string;
  method: string | null;
  target: string | null;
  decision: "allow" | "deny";
  reason?: string;
  host?: string;
  port?: number;
  resolved?: string[];
  connectedTo?: string;
  closed?: string;
  bytesUp?: number;
  bytesDown?: number;
  status?: number | undefined;
  ms?: number;
}
export type Audit = (record: AuditRecord) => void;
/** The audit fields a refusal or a close may add. */
type AuditExtra = Pick<AuditRecord, "host" | "port" | "resolved">;
/** The fields every record of one connection shares, before its decision is known. */
type AuditBase = Omit<AuditRecord, "decision">;

export interface EgressProxyOptions extends EgressPolicy {
  resolve?: Resolve;
  dial?: Dial;
  audit?: Audit;
  limits?: Partial<EgressLimits>;
  verifyRemote?: boolean;
  now?: () => number;
}

/** The proxy's HTTP server plus a live view of its connection counters. */
export type EgressProxyServer = http.Server & { stats(): { active: number; perClient: Record<string, number> } };

/** The proxy's configuration line on stdin (built by the supervisor, lib/runtime.ts). */
export interface ProxyConfig { allow: AllowEntry[]; services: ServiceEntry[]; auditFile?: string; limits?: Partial<EgressLimits>; port?: number }

/** A refusal decided before any network activity. */
export type DenyReason = "ip_literal_not_listed" | "not_allowlisted" | "port_not_allowed";
export interface AllowedDestination { ok: true; reason?: never; key: string; ipLiteral: boolean; entry: AllowEntry | null; service: ServiceEntry | null }
export type DestinationDecision = AllowedDestination | { ok: false; reason: DenyReason };
export type AddressVerdict = { ok: true; cls: AddressClass; reason?: never } | { ok: false; cls: AddressClass; reason: string };
export type Authority = { host: string; port: number; error?: never } | { error: "malformed"; host?: never; port?: never };

export const DEFAULT_LIMITS: Readonly<EgressLimits> = {
  maxConnections: 64,
  maxPerClient: 32,
  maxBytesPerConnection: 512 * 1024 * 1024,
  connectTimeoutMs: 10_000,
  idleTimeoutMs: 60_000,
  maxConnectionMs: 30 * 60_000,
  maxHeaderBytes: 16 * 1024,
  maxAddresses: 4,
};

const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade"]);

/** Parse the authority of a CONNECT request (`host:port`, `[v6]:port`). Returns { host, port } or { error }. */
export function parseAuthority(text: unknown): Authority {
  // eslint-disable-next-line @typescript-eslint/no-base-to-string -- req.url is a string or undefined; anything else becomes text that fails the pattern below
  const s = String(text ?? "");
  // eslint-disable-next-line no-control-regex -- control characters are exactly what this rejects
  if (!s || s.length > 300 || /[\s\0-\x1f]/.test(s)) return { error: "malformed" };
  const m = s.startsWith("[") ? s.match(/^(\[[^\]]+\]):(\d{1,5})$/) : s.match(/^([^:]+):(\d{1,5})$/);
  if (!m) return { error: "malformed" };
  const [, hostText, portText] = m;
  const host = normaliseHost(hostText);
  const port = Number(portText);
  if (!host || !(port >= 1 && port <= 65535)) return { error: "malformed" };
  return { host, port };
}

/** Decide whether a destination is allowed BEFORE any DNS or network activity. */
export function decideDestination({ allow = [], services = [] }: EgressPolicy, host: string, port: number): DestinationDecision {
  const ipLiteral = isIpLiteral(host);
  const key = ipLiteral ? canonicalIp(host) : host;
  if (key === null) return { ok: false, reason: "ip_literal_not_listed" }; // unreachable: an IP literal always has a canonical form
  const entry = allow.find((e) => e.host === key);
  const service = ipLiteral ? null : services.find((s) => s.host === key);
  const match = entry ?? service;
  if (!match) return { ok: false, reason: ipLiteral ? "ip_literal_not_listed" : "not_allowlisted" };
  if (!match.ports.includes(port)) return { ok: false, reason: "port_not_allowed" };
  return { ok: true, key, ipLiteral, entry: entry ?? null, service: service ?? null };
}

/** Is this address acceptable for a destination that matched `decision`? */
export function addressAllowed(address: string, decision: AllowedDestination): AddressVerdict {
  const cls = classifyAddress(address);
  if (cls === "public") return { ok: true, cls };
  if (decision.service && !decision.entry && SERVICE_OK_CLASSES.has(cls)) return { ok: true, cls };
  return { ok: false, cls, reason: `blocked_address_class:${cls}` };
}

const defaultResolve: Resolve = async (host) => (await dns.lookup(host, { all: true, order: "verbatim" })).map((a) => ({ address: a.address, family: a.family }));
const defaultDial: Dial = ({ address, port, family, timeoutMs }) => new Promise((resolve, reject) => {
  const socket = net.connect({ host: address, port, family, timeout: timeoutMs });
  socket.once("connect", () => { socket.setTimeout(0); resolve(socket); });
  socket.once("timeout", () => { socket.destroy(); reject(Object.assign(new Error("connect timeout"), { code: "ETIMEDOUT" })); });
  socket.once("error", reject);
});

/** The error code of a thrown value (`ENOTFOUND`, `ETIMEDOUT`, ...), or the fallback. */
function errorCode(error: unknown, fallback: string): string {
  if (typeof error === "object" && error !== null && "code" in error && (typeof error.code === "string" || typeof error.code === "number")) return String(error.code);
  return fallback;
}
const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** A proxy server, not listening yet. */
export function createEgressProxy({ allow = [], services = [], resolve = defaultResolve, dial = defaultDial, audit = () => {}, limits = {}, verifyRemote = true, now = Date.now }: EgressProxyOptions = {}): EgressProxyServer {
  const L: EgressLimits = { ...DEFAULT_LIMITS, ...limits };
  const policy: EgressPolicy = { allow, services };
  let active = 0;
  const perClient = new Map<string, number>();
  let seq = 0;

  const server: EgressProxyServer = Object.assign(
    http.createServer({ maxHeaderSize: L.maxHeaderBytes, requestTimeout: 30_000, headersTimeout: 15_000, keepAliveTimeout: 1000 }),
    { stats: () => ({ active, perClient: Object.fromEntries(perClient) }) },
  );

  const admit = (client: string): string | null => {
    if (active >= L.maxConnections) return "too_many_connections";
    if ((perClient.get(client) ?? 0) >= L.maxPerClient) return "too_many_connections_for_client";
    active++; perClient.set(client, (perClient.get(client) ?? 0) + 1);
    return null;
  };
  const release = (client: string): void => {
    active = Math.max(0, active - 1);
    const n = (perClient.get(client) ?? 1) - 1;
    if (n <= 0) perClient.delete(client); else perClient.set(client, n);
  };

  /** Resolve, validate every address, connect to a validated IP. Returns { socket, address, resolved } or { deny }. */
  type Reached = { socket: net.Socket; address: string; resolved: string[]; deny?: never } | { deny: string; resolved: string[] };
  async function reach(host: string, port: number, decision: AllowedDestination): Promise<Reached> {
    let candidates: readonly ResolvedAddress[];
    if (decision.ipLiteral) candidates = [{ address: decision.key, family: net.isIPv6(decision.key) ? 6 : 4 }];
    else {
      try { candidates = await resolve(host); } catch (e) { return { deny: `dns_failed:${errorCode(e, "error")}`, resolved: [] }; }
      if (!candidates.length) return { deny: "dns_no_answer", resolved: [] };
    }
    const resolved = candidates.slice(0, L.maxAddresses).map((c) => c.address);
    for (const c of candidates.slice(0, L.maxAddresses)) {
      const verdict = addressAllowed(c.address, decision);
      if (!verdict.ok) return { deny: verdict.reason, resolved };
    }
    let lastError = "connect_failed";
    for (const c of candidates.slice(0, L.maxAddresses)) {
      try {
        const socket = await dial({ address: c.address, port, family: c.family, timeoutMs: L.connectTimeoutMs });
        if (verifyRemote && socket.remoteAddress) {
          const verdict = addressAllowed(socket.remoteAddress, decision);
          if (!verdict.ok) { socket.destroy(); return { deny: `peer_${verdict.reason}`, resolved }; }
        }
        return { socket, address: c.address, resolved };
      } catch (e) { lastError = `connect_failed:${errorCode(e, "error")}`; }
    }
    return { deny: lastError, resolved };
  }

  const finish = (rec: AuditRecord, started: number): void => { audit({ ...rec, ms: now() - started }); };

  // --- CONNECT ---
  const onConnect = async (req: http.IncomingMessage, clientSocket: net.Socket, head: Buffer): Promise<void> => {
    const started = now();
    const id = ++seq;
    const client = clientSocket.remoteAddress ?? "unknown";
    const base: AuditBase = { at: new Date(started).toISOString(), id, client, method: "CONNECT", target: String(req.url).slice(0, 300) };
    const refuse = (status: number, text: string, reason: string, extra: AuditExtra = {}): void => {
      if (clientSocket.writable) clientSocket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      finish({ ...base, decision: "deny", reason, ...extra }, started);
    };
    clientSocket.on("error", () => {});
    const auth = parseAuthority(req.url);
    if (auth.error !== undefined) { refuse(400, "Bad Request", "malformed_authority"); return; }
    const decision = decideDestination(policy, auth.host, auth.port);
    if (!decision.ok) { refuse(403, "Forbidden", decision.reason, { host: auth.host, port: auth.port }); return; }
    const busy = admit(client);
    if (busy) { refuse(503, "Service Unavailable", busy, { host: auth.host, port: auth.port }); return; }
    let upstream: net.Socket | null = null;
    let closed = false;
    let released = false;
    const rel = () => { if (!released) { released = true; release(client); } };
    let bytesUp = 0; let bytesDown = 0;
    const done = (reason: string, extra: AuditExtra = {}): void => {
      if (closed) return;
      closed = true;
      rel();
      upstream?.destroy(); clientSocket.destroy();
      finish({ ...base, host: auth.host, port: auth.port, decision: "allow", closed: reason, bytesUp, bytesDown, ...extra }, started);
    };
    clientSocket.on("close", () => done("client_closed"));
    try {
      const r = await reach(auth.host, auth.port, decision);
      if (r.deny !== undefined) { closed = true; rel(); refuse(403, "Forbidden", r.deny, { host: auth.host, port: auth.port, resolved: r.resolved }); return; }
      upstream = r.socket;
      base.resolved = r.resolved; base.connectedTo = r.address;
    } catch (e) { closed = true; rel(); refuse(502, "Bad Gateway", `error:${errorMessage(e)}`, { host: auth.host, port: auth.port }); return; }
    // The client may have gone while reach() was awaiting (done() then ran from the close handler).
    if (closed) { upstream.destroy(); return; }
    upstream.on("error", () => done("upstream_error"));
    upstream.on("close", () => done("upstream_closed"));
    const total = () => bytesUp + bytesDown;
    const count = (dir: "up" | "down", n: number): void => { if (dir === "up") bytesUp += n; else bytesDown += n; if (total() > L.maxBytesPerConnection) done("byte_cap"); };
    upstream.on("data", (c: Buffer) => { count("down", c.length); });
    clientSocket.on("data", (c: Buffer) => { count("up", c.length); });
    clientSocket.setTimeout(L.idleTimeoutMs, () => done("idle_timeout"));
    upstream.setTimeout(L.idleTimeoutMs, () => done("idle_timeout"));
    const life = setTimeout(() => { done("max_duration"); }, L.maxConnectionMs); life.unref();
    clientSocket.on("close", () => clearTimeout(life));
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) upstream.write(head);
    clientSocket.pipe(upstream);
    upstream.pipe(clientSocket);
  };
  server.on("connect", (req: http.IncomingMessage, clientSocket: net.Socket, head: Buffer) => { void onConnect(req, clientSocket, head); });

  // --- plain HTTP GET/HEAD ---
  const onRequest = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const started = now();
    const id = ++seq;
    const client = req.socket.remoteAddress ?? "unknown";
    const base: AuditBase = { at: new Date(started).toISOString(), id, client, method: req.method ?? null, target: String(req.url).slice(0, 300) };
    const refuse = (status: number, reason: string, extra: AuditExtra = {}): void => {
      if (!res.headersSent) res.writeHead(status, { "content-type": "text/plain", connection: "close" });
      res.end(`refused: ${reason}\n`);
      finish({ ...base, decision: "deny", reason, ...extra }, started);
    };
    if (req.method !== "GET" && req.method !== "HEAD") { refuse(405, "method_not_allowed"); return; }
    const rawUrl = req.url ?? "";
    let url: URL;
    try { url = new URL(rawUrl); } catch { refuse(400, "malformed_url"); return; }
    if (url.protocol !== "http:") { refuse(400, "only_http_absolute_urls"); return; }
    if (url.username || url.password) { refuse(400, "userinfo_in_url"); return; }
    if (/%/.test(url.hostname) || /[\s]/.test(rawUrl)) { refuse(400, "malformed_url"); return; }
    const host = normaliseHost(url.hostname.startsWith("[") ? url.hostname : url.hostname);
    const port = url.port ? Number(url.port) : 80;
    if (!host) { refuse(400, "malformed_host"); return; }
    const headerHost = (req.headers.host ?? "").toLowerCase().replace(/\.$/, "");
    if (headerHost && headerHost !== `${host}${url.port ? `:${url.port}` : ""}` && headerHost !== host) { refuse(400, "host_header_mismatch", { host, port }); return; }
    const decision = decideDestination(policy, host, port);
    if (!decision.ok) { refuse(403, decision.reason, { host, port }); return; }
    if (!decision.entry?.plainGet && !decision.service) { refuse(403, "plain_http_not_allowed", { host, port }); return; }
    const busy = admit(client);
    if (busy) { refuse(503, busy, { host, port }); return; }
    let released = false;
    const end = (rec: Omit<AuditRecord, "at" | "id" | "client" | "method" | "target">): void => { if (!released) { released = true; release(client); finish({ ...base, host, port, ...rec }, started); } };
    try {
      const r = await reach(host, port, decision);
      if (r.deny !== undefined) { released = true; release(client); refuse(403, r.deny, { host, port, resolved: r.resolved }); return; }
      const socket = r.socket;
      const headers: http.OutgoingHttpHeaders = {};
      for (const [k, v] of Object.entries(req.headers)) if (!HOP_BY_HOP.has(k) && k !== "host") headers[k] = v;
      headers.host = url.host;
      headers.connection = "close";
      // The request goes over the connection reach() already made and validated: a one-shot agent hands it out.
      const agent = new http.Agent({ keepAlive: false });
      agent.createConnection = (_options, cb) => { cb?.(null, socket); return undefined; };
      const upstreamReq = http.request({ agent, host: r.address, port, method: req.method, path: `${url.pathname}${url.search}`, headers, timeout: L.idleTimeoutMs }, (up) => {
        const out: http.OutgoingHttpHeaders = {};
        for (const [k, v] of Object.entries(up.headers)) if (!HOP_BY_HOP.has(k)) out[k] = v;
        res.writeHead(up.statusCode ?? 502, out); // a 3xx is passed through, never followed
        let bytes = 0;
        up.on("data", (c: Buffer) => { bytes += c.length; if (bytes > L.maxBytesPerConnection) { up.destroy(); res.destroy(); } else res.write(c); });
        up.on("end", () => { res.end(); end({ decision: "allow", status: up.statusCode, bytesDown: bytes, resolved: r.resolved, connectedTo: r.address }); });
        up.on("error", () => { res.destroy(); end({ decision: "allow", closed: "upstream_error", resolved: r.resolved }); });
      });
      upstreamReq.on("timeout", () => upstreamReq.destroy(new Error("timeout")));
      upstreamReq.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); end({ decision: "allow", closed: "upstream_error", resolved: r.resolved }); });
      upstreamReq.end();
    } catch (e) { released = true; release(client); refuse(502, `error:${errorMessage(e)}`, { host, port }); }
  };
  server.on("request", (req: http.IncomingMessage, res: http.ServerResponse) => { void onRequest(req, res); });

  server.on("clientError", (e: Error, socket: stream.Duplex & { remoteAddress?: string }) => {
    // Unparseable requests (oversized headers, bytes that are not HTTP, a host the parser rejects) are refused and audited too.
    audit({ at: new Date(now()).toISOString(), id: ++seq, client: socket.remoteAddress ?? "unknown", method: null, target: null, decision: "deny", reason: `client_error:${errorCode(e, "parse")}` });
    if (socket.writable) socket.end(`HTTP/1.1 ${errorCode(e, "") === "HPE_HEADER_OVERFLOW" ? "431 Request Header Fields Too Large" : "400 Bad Request"}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  });
  return server;
}

/** Build the proxy's allowlist from the resolved contract (supervisor side). */
export interface ContractEgressView { readonly permissions: { readonly network: { readonly egress: readonly { readonly host: string; readonly ports: readonly number[]; readonly plainGet: boolean }[] } } }
export function proxyConfigFromContract(contract: ContractEgressView): { allow: AllowEntry[]; services: ServiceEntry[] } {
  const p = contract.permissions.network;
  return {
    allow: p.egress.map((e) => ({ host: e.host, ports: e.ports, plainGet: e.plainGet })),
    services: [],
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isPort = (v: unknown): v is number => Number.isInteger(v) && typeof v === "number" && v >= 1 && v <= 65535;

/** One allowlist or service entry of the config line; anything else stops the proxy from starting. */
function parseEntry(v: unknown, where: string, withPlainGet: boolean): AllowEntry {
  if (!isRecord(v)) throw new Error(`${where} must be an object`);
  for (const k of Object.keys(v)) if (k !== "host" && k !== "ports" && !(withPlainGet && k === "plainGet")) throw new Error(`${where}.${k} is not a known field`);
  const { host, ports, plainGet } = v;
  if (typeof host !== "string" || !host) throw new Error(`${where}.host must be a non-empty string`);
  if (!Array.isArray(ports) || !ports.every(isPort)) throw new Error(`${where}.ports must be a list of TCP ports`);
  if (plainGet !== undefined && typeof plainGet !== "boolean") throw new Error(`${where}.plainGet must be true or false`);
  return { host, ports, ...(plainGet === undefined ? {} : { plainGet }) };
}

/**
 * Check the stdin config line. Fail-closed: a malformed field stops the proxy (the supervisor then
 * sees no "ready") instead of being coerced into a looser allowlist.
 */
export function parseProxyConfig(value: unknown): ProxyConfig {
  if (!isRecord(value)) throw new Error("egress proxy config must be a JSON object");
  const { allow = [], services = [], auditFile, limits, port } = value;
  if (!Array.isArray(allow)) throw new Error("egress proxy config: allow must be a list");
  if (!Array.isArray(services)) throw new Error("egress proxy config: services must be a list");
  const config: ProxyConfig = {
    allow: allow.map((e: unknown, i) => parseEntry(e, `egress proxy config: allow[${i}]`, true)),
    services: services.map((e: unknown, i) => { const { host, ports } = parseEntry(e, `egress proxy config: services[${i}]`, false); return { host, ports }; }),
  };
  if (auditFile !== undefined) {
    if (typeof auditFile !== "string" || !auditFile) throw new Error("egress proxy config: auditFile must be a path");
    config.auditFile = auditFile;
  }
  if (port !== undefined) {
    if (!isPort(port)) throw new Error("egress proxy config: port must be a TCP port");
    config.port = port;
  }
  if (limits !== undefined) {
    if (!isRecord(limits)) throw new Error("egress proxy config: limits must be an object");
    const checked: Partial<EgressLimits> = {};
    for (const [k, v] of Object.entries(limits)) {
      if (!Object.hasOwn(DEFAULT_LIMITS, k)) throw new Error(`egress proxy config: limits.${k} is not a known limit`);
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new Error(`egress proxy config: limits.${k} must be a non-negative number`);
      checked[k as keyof EgressLimits] = v; // k was just checked against DEFAULT_LIMITS' own keys
    }
    config.limits = checked;
  }
  return config;
}

async function main(): Promise<void> {
  const line = await new Promise<string>((resolve) => {
    let input = "";
    process.stdin.on("data", (chunk: Buffer | string) => { input += String(chunk); if (input.includes("\n")) { process.stdin.pause(); resolve(input.slice(0, input.indexOf("\n"))); } });
  });
  const config = parseProxyConfig(JSON.parse(line));
  const auditFile = config.auditFile ?? "/audit/egress.jsonl";
  const server = createEgressProxy({ allow: config.allow, services: config.services, limits: config.limits ?? {}, audit: (rec) => { try { fs.appendFileSync(auditFile, `${JSON.stringify(rec)}\n`); } catch { /* audit is best effort, never a reason to open a connection */ } } });
  server.listen(config.port ?? 3128, "0.0.0.0", () => console.log("egress proxy ready"));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
