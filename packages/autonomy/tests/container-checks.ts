// Facts gathered from INSIDE a hardened container, for tests/autonomy-container-smoke.ts.
// The test pipes this file to `node -` in a container started with the worker's exact
// arguments, and asserts on the single JSON line it prints. It asserts nothing itself, so a
// failed assertion names the fact, not a stack trace from a container.
//
//   MODE=props    kernel-level properties, and every way out of the internal network
//   MODE=proxy    CONNECT through the egress proxy to each AUTHORITIES entry (+ TLS to TLS_HOST)
//   MODE=infer    a chat completion and the model list through the inference relay
//   MODE=http     GET URL (an in-zone service)
import dns from "node:dns/promises";
import fs from "node:fs";
import net from "node:net";
import tls from "node:tls";

/** The outcome of one attempt, as the smoke test reads it. */
type Attempt<T> = { ok: true; value: T } | { ok: false; error: string };

const env = process.env;
const out: Record<string, unknown> = { mode: env.MODE };

/** A field of a thrown value (`code`, `message`), if it has one. */
const field = (e: unknown, key: string): unknown => (typeof e === "object" && e !== null && key in e ? (e as Record<string, unknown>)[key] : undefined);
const attempt = <T>(fn: () => Promise<T>): Promise<Attempt<T>> => fn().then((value): Attempt<T> => ({ ok: true, value }), (e: unknown): Attempt<T> => ({ ok: false, error: String(field(e, "code") ?? field(e, "message") ?? e) }));
const connect = (host: string, port: number, ms = 4000): Promise<string> => new Promise((resolve, reject) => {
  const s = net.connect({ host, port, timeout: ms });
  s.on("connect", () => { s.destroy(); resolve("connected"); });
  s.on("timeout", () => { s.destroy(); reject(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })); });
  s.on("error", reject);
});
const canWrite = (file: string): boolean => { try { fs.writeFileSync(file, "x"); fs.rmSync(file, { force: true }); return true; } catch { return false; } };

if (env.MODE === "props") {
  const names: Record<string, Attempt<unknown>> = {};
  const gateways: Record<string, Attempt<string>> = {};
  const status: Record<string, string> = Object.fromEntries(fs.readFileSync("/proc/self/status", "utf8").split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 1).trim()]));
  Object.assign(out, {
    uid: process.getuid?.(), gid: process.getgid?.(),
    capEff: status.CapEff, capPrm: status.CapPrm, capBnd: status.CapBnd, capInh: status.CapInh, noNewPrivs: status.NoNewPrivs,
    writable: Object.fromEntries(["/usr/x", "/etc/x", "/x", "/run/x", "/tmp/x", "/work/x", "/state/x"].map((f) => [f, canWrite(f)])),
    sockets: ["/var/run/docker.sock", "/run/docker.sock", "/run/podman/podman.sock"].filter((p) => fs.existsSync(p)),
    mountinfo: fs.readFileSync("/proc/self/mountinfo", "utf8"), // the kernel's own mount table, for the firewall's provenance parser
    homes: fs.existsSync("/home") ? fs.readdirSync("/home") : [],
    procNet: fs.readFileSync("/proc/net/route", "utf8").trim().split("\n").slice(1).map((l) => l.split("\t")).map(([iface, dest]) => ({ iface, dest })),
    dnsPublic: await attempt(() => dns.lookup("example.com")),
    tcpPublic: await attempt(() => connect("1.1.1.1", 443)),
    tcpPublicDns: await attempt(() => connect("8.8.8.8", 53)),
    names,
    gateways,
  });
  for (const name of (env.NAMES ?? "").split(",").filter(Boolean)) names[name] = await attempt(() => dns.lookup(name));
  for (const target of (env.HOST_TARGETS ?? "").split(",").filter(Boolean)) {
    const [host = "", port] = target.split(":");
    gateways[target] = await attempt(() => connect(host, Number(port)));
  }
} else if (env.MODE === "proxy") {
  const viaProxy = (authority: string): Promise<{ status: number; socket: net.Socket }> => new Promise((resolve, reject) => {
    const s = net.connect({ host: "egress-proxy", port: 3128, timeout: 15_000 });
    let buf = "";
    s.on("error", reject);
    s.on("timeout", () => { s.destroy(); reject(new Error("proxy timeout")); });
    s.on("data", (d: Buffer) => {
      buf += String(d);
      if (buf.includes("\r\n\r\n")) { s.removeAllListeners("data"); resolve({ status: Number(buf.slice(9, 12)), socket: s }); }
    });
    s.on("connect", () => s.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`));
  });
  const results: Record<string, { status: number } | { error: string }> = {};
  out.results = results;
  for (const authority of (env.AUTHORITIES ?? "").split(",").filter(Boolean)) {
    const r = await attempt(async () => { const { status, socket } = await viaProxy(authority); socket.destroy(); return status; });
    results[authority] = r.ok ? { status: r.value } : { error: r.error };
  }
  const tlsHost = env.TLS_HOST;
  if (tlsHost) {
    out.tls = await attempt(async () => {
      const { status, socket } = await viaProxy(`${tlsHost}:443`);
      if (status !== 200) throw new Error(`CONNECT answered ${status}`);
      return new Promise<{ authorized: boolean; authorizationError: string | null; protocol: string | null; subject: string | string[] }>((resolve, reject) => {
        // Verification is reported, not enforced: a network that intercepts TLS presents its own CA's certificate, and the tunnel itself is what is under test.
        const t = tls.connect({ socket, servername: tlsHost, rejectUnauthorized: false, timeout: 15_000 }, () => { const r = { authorized: t.authorized, authorizationError: t.authorizationError ? String(t.authorizationError) : null, protocol: t.getProtocol(), subject: t.getPeerCertificate()?.subject?.CN ?? "" }; t.destroy(); resolve(r); });
        t.on("error", reject);
        t.on("timeout", () => { t.destroy(); reject(new Error("tls timeout")); });
      });
    });
  }
} else if (env.MODE === "infer") {
  const post = (body: unknown, headers: Record<string, string> = {}): Promise<Response> => fetch("http://inference:8081/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
  const chat = await attempt(async () => { const r = await post({ model: env.MODEL, messages: [{ role: "user", content: "hello" }], max_tokens: 5 }, { authorization: "Bearer worker-placeholder" }); return { status: r.status, body: await r.text() }; });
  const other = await attempt(async () => (await post({ model: "some/other-model", messages: [], max_tokens: 1 })).status);
  const models = await attempt(async () => (await fetch("http://inference:8081/v1/models", { signal: AbortSignal.timeout(20_000) })).status);
  const keys = await attempt(async () => (await fetch("http://inference:8081/v1/keys", { signal: AbortSignal.timeout(20_000) })).status);
  Object.assign(out, { chat, other, models, keys });
} else if (env.MODE === "http") {
  const url = env.URL;
  out.get = await attempt(async () => { if (url === undefined) throw new TypeError("URL is not set"); const r = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(10_000) }); return { status: r.status, body: (await r.text()).slice(0, 2000) }; });
} else {
  out.error = `unknown MODE ${String(env.MODE)}`;
}
console.log(JSON.stringify(out));
