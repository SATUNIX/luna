// Runs INSIDE a container started with the worker's exact arguments (the supervisor's boundary
// check, before every start and resume). Every way out except the relay's inference paths and the
// declared egress proxy must fail, and no credential may be visible. Prints one JSON line:
// { pass, checks: [{ name, ok, detail }] }.
//
// Environment (set by the supervisor, none of it secret):
//   PI_MODEL                    the run's worker model
//   AUTONOMY_KEY_SHA256         SHA-256 of the real inference key (the only form the probe is given)
//   AUTONOMY_KEY_REGEX          how keys of this provider look, to find candidates in mounted files
//   AUTONOMY_EGRESS_ALLOW       host:port,... the contract lists (empty: no proxy is configured)
//   AUTONOMY_SERVICES           name:port,... run services (informational)
//   AUTONOMY_HOST_CANARY        ip:port,... a listener the supervisor holds on the host; none may connect
//   AUTONOMY_ROOTLESS=1         rootless Docker maps root to the operator; uid 0 is then expected
import dns from "node:dns/promises";
import fs from "node:fs";
import net from "node:net";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

/** One line of the probe's verdict. */
interface Check { name: string; ok: boolean; detail: string }

/** A field of a thrown value (`code`, `message`), if it has one. */
const field = (e: unknown, key: string): unknown => (typeof e === "object" && e !== null && key in e ? (e as Record<string, unknown>)[key] : undefined);
/** Read a nested field of untrusted JSON; undefined when any step is missing or not an object. */
const at = (v: unknown, ...keys: string[]): unknown => {
  let cur = v;
  for (const k of keys) cur = typeof cur === "object" && cur !== null ? field(cur, k) : undefined;
  return cur;
};

const checks: Check[] = [];
const expect = async (name: string, fn: () => unknown): Promise<void> => {
  try { const detail = await fn(); checks.push({ name, ok: true, detail: typeof detail === "string" ? detail : "" }); }
  catch (e) { checks.push({ name, ok: false, detail: String(field(e, "message") ?? e).slice(0, 300) }); }
};
const mustFail = async (promise: Promise<unknown>, what: string): Promise<string> => {
  try { await promise; } catch (e) { return `blocked (${String(field(e, "code") ?? field(e, "message"))})`; }
  throw new Error(`${what} succeeded`);
};
const connect = (host: string, port: number, ms = 4000): Promise<void> => new Promise((resolve, reject) => {
  const s = net.connect({ host, port, timeout: ms });
  s.on("connect", () => { s.destroy(); resolve(); });
  s.on("timeout", () => { s.destroy(); reject(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })); });
  s.on("error", reject);
});
const relay = (path: string, init: RequestInit): Promise<Response> => fetch(`http://inference:8081${path}`, { ...init, signal: AbortSignal.timeout(20_000) });

for (const host of ["example.com", "registry.npmjs.org", "github.com", "gitlab.com", "pypi.org", "openrouter.ai"]) {
  await expect(`dns ${host} fails`, () => mustFail(dns.lookup(host), `resolving ${host}`));
}
for (const [host, port] of [["1.1.1.1", 443], ["8.8.8.8", 53], ["172.17.0.1", 22], ["172.17.0.1", 2375], ["169.254.169.254", 80], ["192.168.1.1", 443]] as const) {
  await expect(`tcp ${host}:${port} fails`, () => mustFail(connect(host, port), `connecting to ${host}:${port}`));
}
// The host itself: Docker's internal networks stop forwarding, not the host answering on the bridge's own
// address. The supervisor runs a canary listener on every host interface and names the addresses to try
// (the zone's own first address, each bridge gateway); none may connect.
const canaries = (process.env.AUTONOMY_HOST_CANARY ?? "").split(",").filter(Boolean);
if (canaries.length) {
  await expect(`host services are not reachable (${canaries.length} canary address(es))`, async () => {
    const reached: string[] = [];
    for (const target of canaries) {
      const [host = "", port] = target.split(":");
      try { await connect(host, Number(port), 3000); reached.push(target); } catch { /* blocked, as it must be */ }
    }
    if (reached.length) throw new Error(`the host answered at ${reached.join(", ")}`);
    return "no canary connected";
  });
} else checks.push({ name: "host services are not reachable", ok: false, detail: "the supervisor gave the probe no canary addresses" });
await expect("relay refuses non-inference paths", async () => {
  for (const [method, path] of [["GET", "/v1/keys"], ["GET", "/api/v1/credits"], ["POST", "/v1/embeddings"], ["GET", "/"]] as const) {
    const r = await relay(path, { method });
    if (r.status !== 403) throw new Error(`${method} ${path} -> ${r.status}`);
  }
  return "403 on all";
});
await expect("relay refuses other models and web search", async () => {
  const post = (body: unknown): Promise<Response> => relay("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const other = await post({ model: "not-this-runs-model/other", messages: [{ role: "user", content: "hi" }], max_tokens: 1 });
  const online = await post({ model: `${process.env.PI_MODEL}:online`, messages: [{ role: "user", content: "hi" }], max_tokens: 1 });
  if (other.status !== 403 || online.status !== 403) throw new Error(`other ${other.status}, online ${online.status}`);
  return "403";
});
await expect("relay serves the model list (inference path works)", async () => {
  const r = await relay("/v1/models", { method: "GET" });
  if (r.status !== 200) throw new Error(`status ${r.status}`);
  return "200";
});

// The egress proxy, when the contract declares egress: what it must REFUSE is checkable from here
// (what it allows depends on the internet). No proxy is declared: the proxy name must not resolve.
const allow = (process.env.AUTONOMY_EGRESS_ALLOW ?? "").split(",").filter(Boolean);
if (allow.length) {
  const viaProxy = (authority: string): Promise<number> => new Promise((resolve, reject) => {
    const s = net.connect({ host: "egress-proxy", port: 3128, timeout: 8000 });
    let buf = "";
    s.on("error", reject);
    s.on("timeout", () => { s.destroy(); reject(new Error("proxy timeout")); });
    s.on("data", (d: Buffer) => { buf += String(d); const end = buf.indexOf("\r\n\r\n"); if (end >= 0) { s.destroy(); resolve(Number(buf.slice(9, 12))); } });
    s.on("connect", () => s.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`));
  });
  const [first = ""] = allow;
  const [listedHost = ""] = first.split(":");
  for (const authority of ["unlisted.example.invalid:443", "127.0.0.1:443", "0x7f.1:443", "[::1]:443", "[::ffff:127.0.0.1]:443", "169.254.169.254:80", "10.0.0.1:443", `${listedHost}:22`, `${listedHost}@127.0.0.1:443`, "localhost:80"]) {
    await expect(`egress proxy refuses ${authority}`, async () => {
      const status = await viaProxy(authority);
      if (status === 200) throw new Error("the proxy tunnelled it");
      return `refused (${status})`;
    });
  }
} else {
  await expect("no egress proxy without declared egress", () => mustFail(dns.lookup("egress-proxy"), "resolving egress-proxy"));
}

const uid = process.getuid?.() ?? -1;
await expect("no credentials in the environment", () => {
  const ok = new Set(["AUTONOMY_KEY_SHA256", "AUTONOMY_KEY_REGEX", "PI_KIT_UNATTENDED_CONTRACT", "PI_KIT_UNATTENDED_BOUNDARY", "PI_KIT_UNATTENDED"]);
  // The probe's own parameters (a key HASH, and the shape of keys, which itself contains "sk-or-") are not credentials.
  const bad = Object.entries(process.env).filter(([k]) => !ok.has(k)).filter(([k, v]) => /key|token|secret|passw|auth|credential/i.test(k) || /sk-or-|sk-ant-|glpat-|ghp_|github_pat_|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY/.test(v ?? ""));
  if (bad.length) throw new Error(`found ${bad.map(([k]) => k).join(", ")}`);
});
// The repository itself may hold synthetic keys (test fixtures), so key shapes alone prove nothing.
// The supervisor passes only the SHA-256 of the real key; every key-shaped token in the mounts is
// hashed and compared.
await expect("the real API key is in no mounted file", () => {
  const want = process.env.AUTONOMY_KEY_SHA256;
  if (!/^[0-9a-f]{64}$/.test(want ?? "")) throw new Error("no key hash given to the probe");
  const pattern = process.env.AUTONOMY_KEY_REGEX || "[A-Za-z0-9_.-]{24,200}";
  const out = execFileSync("sh", ["-c", `find /state /git /work /reference /run -xdev -type f -size -2000k -not -path '*/node_modules/*' -not -path '*/.git/objects/*' 2>/dev/null | head -50000 | xargs -r grep -IhoE '${pattern.replace(/'/g, "")}' 2>/dev/null | sort -u | head -20000 || true`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const tokens = out.split("\n").filter(Boolean);
  if (tokens.some((t) => createHash("sha256").update(t).digest("hex") === want)) throw new Error("the relay's key is readable in a mount");
  return `${tokens.length} key-shaped token(s) checked, none is the real key`;
});
await expect("no git credential helpers or remotes beyond the bare repo", () => {
  const helpers = execFileSync("sh", ["-c", "git config --show-origin --get-all credential.helper || true"], { encoding: "utf8" }).trim();
  if (helpers) throw new Error(`credential.helper: ${helpers}`);
  if (fs.existsSync("/work/.git")) {
    const remotes = execFileSync("git", ["-c", "safe.directory=*", "-C", "/work", "remote", "-v"], { encoding: "utf8" }).trim();
    if (remotes && !/^origin\s+\/git\/remote\.git/.test(remotes)) throw new Error(remotes);
  }
});
await expect("no container engine socket, no host home", () => {
  const sockets = ["/var/run/docker.sock", "/run/docker.sock", "/run/podman/podman.sock", `/run/user/${uid}/podman/podman.sock`, `/run/user/${uid}/docker.sock`];
  for (const p of [...sockets, "/root/.ssh"]) if (fs.existsSync(p)) throw new Error(`${p} exists`);
  const homes = fs.existsSync("/home") ? fs.readdirSync("/home").filter((h) => h !== "node") : []; // node: the base image's own user
  if (homes.length) throw new Error(`/home has ${homes.join(", ")}`);
});
await expect("root filesystem read-only, not root user", () => {
  try { fs.writeFileSync("/usr/probe", "x"); throw new Error("wrote to /usr"); } catch (e) { if (e instanceof Error && e.message === "wrote to /usr") throw e; }
  if (uid === 0 && process.env.AUTONOMY_ROOTLESS !== "1") throw new Error("running as uid 0");
  return `uid ${uid}`;
});
await expect("the run contract is read-only, sanitised, and matches the unattended and effort environment", () => {
  const file = process.env.PI_KIT_UNATTENDED_CONTRACT || "/run/contract.json";
  if (!fs.existsSync(file)) { if (process.env.PI_KIT_UNATTENDED === "1") throw new Error(`${file} is missing but unattended mode is on`); return "no contract mounted (attended)"; }
  const text = fs.readFileSync(file, "utf8");
  const c: unknown = JSON.parse(text);
  if (at(c, "sanitised") !== true) throw new Error("the mounted contract is not the sanitised copy");
  if (/authorisation|providerSettings|apiKeyEnv|sk-or-|glpat-|ghp_|BEGIN [A-Z ]*PRIVATE KEY/.test(text)) throw new Error("the mounted contract carries supervisor-only or credential-shaped content");
  try { fs.writeFileSync(file, "x"); throw new Error("wrote the contract"); } catch (e) { if (e instanceof Error && e.message === "wrote the contract") throw e; }
  try { fs.writeFileSync("/run/probe", "x"); throw new Error("wrote /run"); } catch (e) { if (e instanceof Error && e.message === "wrote /run") throw e; }
  if (process.env.PI_KIT_UNATTENDED === "1") {
    // The worker's firewall enters unattended mode only when the contract's provenance is one an agent cannot fake:
    // a read-only mount in the kernel's own table (tool-firewall unattended.ts, contractProvenance). Check the same fact.
    const real = fs.realpathSync(file);
    let held: { point: string; ro: boolean } | null = null;
    for (const line of fs.readFileSync("/proc/self/mountinfo", "utf8").split("\n")) {
      const parts = line.split(" ");
      const dash = parts.indexOf("-");
      if (dash < 6) continue;
      const point = (parts[4] ?? "").replace(/\\([0-7]{3})/g, (_: string, o: string) => String.fromCharCode(parseInt(o, 8)));
      if (real !== point && !real.startsWith(point.endsWith("/") ? point : `${point}/`)) continue;
      if (!held || point.length >= held.point.length) held = { point, ro: (parts[5] ?? "").split(",").includes("ro") || (parts[dash + 3] ?? "").split(",").includes("ro") };
    }
    if (!held?.ro) throw new Error(`${real} is not on a read-only mount (mount ${held?.point ?? "unknown"}), so the worker's firewall would refuse the contract`);
    // ...and only in the user and mount namespaces of the container's PID 1 (contractProvenance).
    for (const ns of ["user", "mnt"]) {
      if (fs.readlinkSync(`/proc/self/ns/${ns}`) !== fs.readlinkSync(`/proc/1/ns/${ns}`)) throw new Error(`the worker is not in PID 1's ${ns} namespace, so its firewall would refuse the contract`);
    }
    if (!at(c, "permissions", "unattended", "authorised")) throw new Error("PI_KIT_UNATTENDED=1 but the contract does not authorise unattended operation");
    if (process.env.PI_KIT_UNATTENDED_BOUNDARY !== "container") throw new Error("PI_KIT_UNATTENDED_BOUNDARY is not container");
  } else if (at(c, "permissions", "unattended", "authorised")) throw new Error("the contract authorises unattended operation but PI_KIT_UNATTENDED is not set");
  const tier = at(c, "effort", "tier");
  const cap = at(c, "effort", "cap");
  if (process.env.PI_KIT_EFFORT !== tier || process.env.PI_KIT_EFFORT_CAP !== cap) throw new Error(`effort environment ${String(process.env.PI_KIT_EFFORT)}/${String(process.env.PI_KIT_EFFORT_CAP)} differs from the contract ${String(tier)}/${String(cap)}`);
  const effort = at(c, "effort");
  if (typeof effort !== "object" || effort === null) throw new Error("the contract has no effort"); // as before: no effort object is a failed check, never a pass
  return `run ${String(at(c, "run"))}, effort ${String(tier)}`;
});

console.log(JSON.stringify({ pass: checks.every((c) => c.ok), checks }));
