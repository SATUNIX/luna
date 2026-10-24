// The real runtime of the engine (lib/engine.ts): rootless Podman or Docker. It builds the
// hardened container argument lists (lib/docker.ts), re-checks EVERY `run` against the boundary
// (lib/containment.ts) before executing it, and does the parts that need the container engine:
// the run network, the relay and the egress proxy, run services, the boundary probe, worker
// sessions over pi's RPC channel, the bundle/snapshot/deploy helpers and the acceptance checks.
// The interface it implements is documented at the top of lib/engine.ts; tests use the fake
// runtime in packages/autonomy/tests/fake-runtime.ts instead.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { array, boolean, isRecord, object, parseJsonAs, string, type Schema } from "../../core/lib/guard.ts";
import { meteredUsd, parseRelayConfig, type RelayConfig } from "../relay.ts";
import { PROVIDERS, type AcceptanceCheck, type RunContract, type ServiceSpec } from "./contract.ts";
import { assertRunArgs, limitProblems, type RunFacts } from "./containment.ts";

export { limitProblems };
import * as dk from "./docker.ts";
import type { BoundaryReport, Runtime, StartWorkerOptions, WorkerAgent, WorkerBundle, ZoneContext } from "./engine.ts";
import { parseProxyConfig, proxyConfigFromContract, type ProxyConfig } from "./egress-proxy.ts";
import { readJson, writeJsonAtomic } from "./fsutil.ts";
import { HostRepo } from "./hostrepo.ts";
import type { RunState } from "./lifecycle.ts";
import { openRouterComplete, type Complete } from "./manager.ts";
import { BARE_REPO_CONFIG } from "./mirror.ts";
import { agentModelsJson, modelEntries, plainModelEntries, type ModelEntry, type PlainModelEntry } from "./models.ts";
import type { RunPaths } from "./paths.ts";
import type { RunConfig } from "./runcfg.ts";
import { reviewTask, type TaskReview, type TaskReviewBundle } from "./review.ts";
import { lineParser, missingHarness } from "./rpc.ts";
import type { RunStore } from "./store.ts";

const LIB = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(LIB, "..");
const pad = (n: number): string => String(n).padStart(2, "0");
const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// --- what the runtime returns ------------------------------------------------------------------------

/** A line logger (the engine's, or the CLI's stderr for a standalone probe). */
type LogFn = (line: string) => void;

/** One check of the boundary probe (tests/boundary-probe.ts prints the report as its last stdout line). */
const BoundaryCheckSchema = object({ name: string(), ok: boolean(), detail: string() });
/** The boundary probe's report: produced inside a worker-shaped container, so validated before it is trusted. */
export const BoundaryReportSchema: Schema<BoundaryReport> = object({ pass: boolean(), checks: array(BoundaryCheckSchema) });

/** One acceptance check run in a gate container (or, by the fake, a scrubbed child process). */
export interface CheckOutcome {
  exitCode: number;
  timedOut: boolean;
  seconds: number;
  tail: string;
  /** Per-step timings from the gate's result.json: written in the gate container, so unchecked. */
  steps?: unknown[] | undefined;
}

/** A service health probe's answer. */
export interface HealthOutcome {
  ok: boolean;
  detail: string;
}

// --- the relay's and the proxy's stdin configs ---------------------------------------------------------

/** The relay's config line. Checked with the relay's own parser, so a bad value fails here rather than in the container. */
export function relayConfigFor({ contract, cfg, apiKey, maxUsd }: { contract: RunContract; cfg: RunConfig; apiKey: string; maxUsd: number }): RelayConfig {
  return parseRelayConfig({ upstream: cfg.upstream, apiKey, meterFile: "/meter/usage.jsonl", maxUsd, models: cfg.models, provider: contract.model.provider, pricing: contract.providerSettings.pricing, headers: { "X-Title": `pi-autonomy ${cfg.run}`, ...contract.providerSettings.headers } });
}

/** The egress proxy's config line, checked with the proxy's own parser. */
export function proxyConfigFor(contract: RunContract): ProxyConfig {
  return parseProxyConfig({ ...proxyConfigFromContract(contract), auditFile: "/audit/egress.jsonl" });
}

/** The inference key for a run: the operator's environment first, then pi's login file for providers that use one. Never written anywhere. */
export function providerKey(contract: RunContract, env: NodeJS.ProcessEnv = process.env): string {
  const s = contract.providerSettings;
  const fromEnv = s.apiKeyEnv ? env[s.apiKeyEnv] : undefined;
  if (fromEnv) return fromEnv;
  if (s.authName) {
    const dir = env["PI_CODING_AGENT_DIR"] || path.join(os.homedir(), ".pi", "agent");
    const auth = readJson(path.join(dir, "auth.json"), {});
    const entry = isRecord(auth) ? auth[s.authName] : undefined;
    const key = typeof entry === "string" ? entry : isRecord(entry) ? entry["key"] : undefined;
    if (typeof key === "string" && key) return key;
  }
  throw new Error(`No inference key for provider ${contract.model.provider}: set ${s.apiKeyEnv ?? "the provider's key variable"} in the supervisor's environment${s.authName ? ` or log in to ${s.authName} in pi (auth.json)` : ""}. It is handed to the relay on stdin and never enters a worker container.`);
}

interface CliOptions {
  timeoutMs?: number;
  input?: string;
  env?: NodeJS.ProcessEnv;
}

interface HelperResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

interface CheckedOptions {
  networks?: readonly string[];
  role: string;
  secretEnvNames?: readonly string[];
}

interface ServerOptions {
  removeName: string;
  runArgs: string[];
  connect: string[];
  execArgs: string[];
  config: RelayConfig | ProxyConfig;
  readyText: string;
  log: LogFn;
  label: string;
  role: string;
}

/** The path and status a service health probe asks for. */
interface HealthTarget {
  path?: string | undefined;
  expectStatus?: number | undefined;
}

export interface DockerRuntimeOptions {
  contract: RunContract;
  cfg: RunConfig;
  store: RunStore;
  env?: NodeJS.ProcessEnv | undefined;
}

export class DockerRuntime implements Runtime {
  readonly contract: RunContract;
  readonly cfg: RunConfig;
  readonly store: RunStore;
  readonly env: NodeJS.ProcessEnv;
  readonly p: RunPaths;
  readonly bin: string;
  readonly names: dk.RunNames;
  readonly repo: HostRepo;
  readonly tickMs: number;
  /** The inference key, read by preflight(); held in memory only. */
  apiKey: string | null;
  relay: ChildProcess | null;
  proxy: ChildProcess | null;
  harnessFailure: string | null;
  harnessOk: boolean;
  /** The directories bind-mount sources must be inside. */
  readonly roots: string[];

  constructor({ contract, cfg, store, env = process.env }: DockerRuntimeOptions) {
    this.contract = contract;
    this.cfg = cfg;
    this.store = store;
    this.env = env;
    this.p = store.p;
    this.bin = cfg.engine;
    this.names = dk.names(cfg);
    this.repo = new HostRepo({ gitDir: this.p.mirror, cfg });
    this.tickMs = cfg.mirrorSeconds * 1000;
    this.apiKey = null;
    this.relay = null;
    this.proxy = null;
    this.harnessFailure = null;
    this.harnessOk = false;
    this.roots = [this.p.root, PKG];
  }

  now(): number { return Date.now(); }
  sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
  log(line: string): void { console.log(`${new Date().toISOString()} ${line}`); }
  workerProblem(): string | null { return this.harnessFailure; }

  /** The inference key; preflight() reads it before anything needs it. */
  key(): string {
    if (this.apiKey === null) throw new Error("the inference key has not been read (preflight has not run)");
    return this.apiKey;
  }

  /** The run's state; it exists from createRun on, before any runtime is made. */
  state(): RunState {
    const state = this.store.readState();
    if (!state) throw new Error(`run ${this.cfg.run} has no state.json`);
    return state;
  }

  // --- engine calls ---------------------------------------------------------------------------------
  cli(args: readonly string[], opts?: CliOptions & { allowFail?: false }): string;
  cli(args: readonly string[], opts: CliOptions & { allowFail: boolean }): string | null;
  cli(args: readonly string[], { timeoutMs = 120_000, input, allowFail = false, env }: CliOptions & { allowFail?: boolean } = {}): string | null {
    const r = spawnSync(this.bin, args, { encoding: "utf8", timeout: timeoutMs, ...(input === undefined ? {} : { input }), maxBuffer: 32 * 1024 * 1024, env: env ?? process.env });
    if (r.error || r.status !== 0) {
      if (allowFail) return null;
      const err = r.error?.message ?? r.stderr.trim();
      throw new Error(`${this.bin} ${args[0]} failed: ${/permission denied.*docker/i.test(err) ? `${err} (use "runtime.engine": "podman", or give your user Docker access; see docs/autonomy.md)` : err}`);
    }
    return r.stdout.trim();
  }

  /** The containment check every `run` passes before it executes, plus positive resource limits (see limitProblems). */
  checked(args: readonly string[], { networks = [], role, secretEnvNames = [] }: CheckedOptions): RunFacts {
    const facts = assertRunArgs(args, { roots: this.roots, networks, role, secretEnvNames, allowRoot: this.contract.runtime.user === "0:0" });
    const problems = limitProblems(facts);
    if (problems.length) throw new Error(`refusing to start ${role}: ${problems.join("; ")}`);
    return facts;
  }

  /** Run a helper container to completion. Resolves { code, stdout, stderr, timedOut }. */
  helper(args: readonly string[], { role, networks = [], timeoutMs, secretEnv = {} }: { role: string; networks?: readonly string[]; timeoutMs: number; secretEnv?: Record<string, string> }): Promise<HelperResult> {
    this.checked(args, { networks, role, secretEnvNames: Object.keys(secretEnv) });
    return new Promise((resolve) => {
      const child = spawn(this.bin, args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...secretEnv } });
      let stdout = ""; let stderr = ""; let timedOut = false;
      child.stdout.on("data", (c: Buffer) => { if (stdout.length < 4e6) stdout += c.toString(); });
      child.stderr.on("data", (c: Buffer) => { if (stderr.length < 4e6) stderr += c.toString(); });
      const name = args[args.indexOf("--name") + 1];
      const timer = setTimeout(() => { timedOut = true; if (name !== undefined) spawnSync(this.bin, ["rm", "-f", name], { stdio: "ignore", timeout: 30_000 }); }, timeoutMs);
      child.on("close", (code: number | null) => { clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr, timedOut }); });
      child.on("error", (e: Error) => { clearTimeout(timer); resolve({ code: 1, stdout, stderr: String(e), timedOut }); });
    });
  }

  // --- the zone ---------------------------------------------------------------------------------------
  async preflight(): Promise<void> {
    this.cli(["version"]);
    this.cli(["image", "inspect", this.cfg.image, "--format", "{{.Id}}"]);
    const user = dk.userSpec(this.cfg);
    if (user.split(":")[0] === "0" && this.contract.runtime.user !== "0:0") throw new Error('the supervisor runs as root, so runtime.user "host" would run containers as root, which is never allowed. Run it as your own user, or set runtime.user to a non-root "uid:gid" (rootless Docker or Podman: "0:0", explicitly).');
    if (this.contract.runtime.user.split(":")[0] === "0") {
      // Root inside the container is the operator's own user only under a rootless engine; on a rootful one it is host uid 0.
      let info: unknown = null;
      try { info = JSON.parse(this.cli(["info", "--format", this.cfg.engine === "podman" ? "json" : "{{json .}}"], { timeoutMs: 30_000 })) as unknown; } catch { /* unreadable: refuse below */ }
      if (!dk.engineIsRootless(info)) throw new Error(`runtime.user "${this.contract.runtime.user}" (root inside the container) is accepted only when the engine is rootless, and ${this.cfg.engine} does not report that it is: on a rootful engine that root is host uid 0. Use rootless Podman or Docker, or set runtime.user to "host" or a non-zero "uid:gid".`);
    }
    this.apiKey = providerKey(this.contract, this.env);
  }

  async prepare({ log }: ZoneContext): Promise<{ baseSha: string }> {
    const { cfg, p } = this;
    this.repo.init();
    const baseSha = this.repo.seedBase();
    this.snapshotReferences(log);
    spawnSync("git", ["init", "--quiet", "--bare", p.remote]);
    for (const [k, v] of BARE_REPO_CONFIG) spawnSync("git", ["--git-dir", p.remote, "config", k, v]);
    // remote.git is created while it is still pristine; once a worker runs, the host only reaches it through containers.
    const pushed = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "--git-dir", p.mirror, "push", "--quiet", p.remote, `refs/heads/${cfg.branch}:refs/heads/${cfg.branch}`], { encoding: "utf8" });
    if (pushed.status !== 0) throw new Error(`seeding the worker's repository failed: ${pushed.stderr}`);
    return { baseSha };
  }

  /** Reference repos: tracked files at HEAD only, so no .git internals or untracked local files (credentials, .env) reach a container. */
  snapshotReferences(log: LogFn = () => {}): void {
    for (const [name, src] of Object.entries(this.cfg.references)) {
      const dest = path.join(this.p.references, name);
      fs.mkdirSync(dest, { recursive: true });
      let repoDir = src;
      let tmp: string | null = null;
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(src) || /^[^/\s]+@[^/\s]+:/.test(src)) {
        tmp = fs.mkdtempSync(path.join(this.p.tmp, "ref-"));
        const clone = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "clone", "--quiet", "--depth", "1", src, tmp], { encoding: "utf8" });
        if (clone.status !== 0) throw new Error(`reference ${name}: cannot fetch ${src}: ${clone.stderr.trim().slice(0, 200)}`);
        repoDir = tmp;
      }
      const archive = spawnSync("git", ["-C", repoDir, "archive", "--format=tar", "HEAD"], { maxBuffer: 512 * 1024 * 1024 });
      if (archive.status !== 0) throw new Error(`reference ${name}: git archive failed in ${src}`);
      const untar = spawnSync("tar", ["-x", "-C", dest], { input: archive.stdout });
      if (untar.status !== 0) throw new Error(`reference ${name}: extract failed`);
      const sha = spawnSync("git", ["-C", repoDir, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
      if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
      log(`reference ${name}: ${src} at ${sha.slice(0, 12)} -> /reference/${name} (read-only)`);
    }
  }

  // --- bring up the zone: networks, relay, proxy, services, probe -------------------------------------
  async bringUp({ log }: ZoneContext): Promise<BoundaryReport> {
    this.networks();
    await this.writeModelSpecs(log);
    await this.startRelay(log);
    if (this.contract.permissions.network.egress.length) await this.startProxy(log);
    await this.startServices(log);
    return this.probe(log);
  }

  networks(): void {
    for (const args of dk.networkCreateArgs(this.cfg)) {
      if (this.cli(["network", "inspect", args.at(-1) ?? ""], { allowFail: true }) === null) this.cli(args);
    }
    if (this.cli(["network", "inspect", this.names.net, "--format", "{{.Internal}}"]) !== "true") throw new Error(`network ${this.names.net} exists but is not internal; remove it and resume`);
    if (this.bin === "docker" && this.cli(["network", "inspect", this.names.net, "--format", `{{index .Options "${dk.HOSTLESS_OPTION}"}}`]) !== "true") throw new Error(`network ${this.names.net} exists without ${dk.HOSTLESS_OPTION}=true, so the host would be reachable from the zone through the bridge address; remove it and resume`);
  }

  /** The IPv4 addresses on the run's networks that the host itself could answer on (subnet first host, gateways): what a worker must not be able to reach. */
  zoneHostAddresses(): string[] {
    const found = new Set(["172.17.0.1"]); // the engine's default bridge gateway
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) { for (const x of v as unknown[]) walk(x); }
      else if (v && typeof v === "object") {
        for (const [k, x] of Object.entries(v)) {
          if (typeof x === "string" && /^gateway$/i.test(k) && /^\d+\.\d+\.\d+\.\d+$/.test(x)) found.add(x);
          else if (typeof x === "string" && /^subnet$/i.test(k) && /^\d+\.\d+\.\d+\.\d+\/\d+$/.test(x)) {
            const [a = 0, b = 0, c = 0, d = 0] = (x.split("/")[0] ?? "").split(".").map(Number);
            found.add(`${a}.${b}.${c}.${d + 1}`);
          } else walk(x);
        }
      }
    };
    for (const network of [this.names.net, this.names.egress]) {
      const raw = this.cli(["network", "inspect", network], { allowFail: true });
      try { walk(JSON.parse(raw ?? "[]") as unknown); } catch { /* an unreadable network adds nothing to try */ }
    }
    return [...found];
  }

  async writeModelSpecs(log: LogFn): Promise<void> {
    const { contract, cfg, p } = this;
    let entries: Array<ModelEntry | PlainModelEntry> = [];
    if (contract.model.provider === "openrouter") {
      try {
        const res = await fetch(`${cfg.upstream.replace(/\/$/, "")}/models`, { headers: { authorization: `Bearer ${this.key()}` }, signal: AbortSignal.timeout(30_000) });
        const body: unknown = await res.json();
        if (body === null) throw new Error("the model list is null");
        entries = modelEntries(isRecord(body) ? body["data"] : undefined, cfg.models);
      } catch (e) { log(`model specs unavailable (${errorMessage(e)}); pi falls back to its defaults`); }
      const missing = cfg.models.filter((id) => !entries.some((m) => m.id === id));
      if (missing.length) log(`model specs: ${missing.join(", ")} not in the upstream list`);
    } else entries = plainModelEntries(cfg.models, contract.providerSettings.pricing);
    fs.mkdirSync(p.agentState, { recursive: true });
    writeJsonAtomic(path.join(p.agentState, "run-models.json"), agentModelsJson(entries, contract.model.provider));
    for (const m of entries) if ("contextWindow" in m && m.contextWindow) log(`model ${m.id}: context ${m.contextWindow}, max output ${m.maxTokens}`);
  }

  /** Start a long-lived hardened container that idles, then run a server in it with its config on stdin (the key never touches an argument list or a file). */
  async startServer({ removeName, runArgs, connect, execArgs, config, readyText, log, label, role }: ServerOptions): Promise<ChildProcess> {
    this.cli(["rm", "-f", removeName], { allowFail: true });
    this.checked(runArgs, { networks: [this.names.egress], role });
    this.cli(runArgs);
    this.cli(connect);
    const child = spawn(this.bin, execArgs, { stdio: ["pipe", "pipe", "pipe"] });
    child.stderr.on("data", (c: Buffer) => { fs.appendFileSync(path.join(this.p.meter, `${label}.log`), c); });
    child.stdin.end(`${JSON.stringify(config)}\n`);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error(`${label} did not start within 20s`)); }, 20_000);
      child.stdout.on("data", (c: Buffer) => { if (String(c).includes(readyText)) { clearTimeout(timer); resolve(); } });
      child.on("exit", (code: number | null) => { clearTimeout(timer); reject(new Error(`${label} exited (${String(code)})`)); });
    });
    child.removeAllListeners("exit");
    child.on("exit", (code: number | null) => { log(`${label} exited (${String(code)})`); });
    log(`${label} ready`);
    return child;
  }

  async startRelay(log: LogFn): Promise<void> {
    const { contract, cfg, p, names } = this;
    fs.mkdirSync(p.meter, { recursive: true });
    const state = this.state();
    this.relay?.kill();
    this.relay = await this.startServer({
      removeName: names.relay, runArgs: dk.relayRunArgs(cfg, p, path.join(PKG, "relay.ts")), connect: ["network", "connect", "--alias", dk.RELAY_HOST, names.net, names.relay], execArgs: dk.relayExecArgs(cfg),
      config: relayConfigFor({ contract, cfg, apiKey: this.key(), maxUsd: state.limits.budget.totalUsd }),
      readyText: "ready", log, label: "relay", role: "relay",
    });
  }

  async startProxy(log: LogFn): Promise<void> {
    const { cfg, p, names } = this;
    fs.mkdirSync(p.egress, { recursive: true });
    this.proxy?.kill();
    this.proxy = await this.startServer({
      removeName: names.proxy, runArgs: dk.proxyRunArgs(cfg, p, { script: path.join(LIB, "egress-proxy.ts"), netaddr: path.join(LIB, "netaddr.ts") }), connect: ["network", "connect", "--alias", dk.PROXY_HOST, names.net, names.proxy], execArgs: dk.proxyExecArgs(cfg),
      config: proxyConfigFor(this.contract), readyText: "ready", log, label: "egress-proxy", role: "proxy",
    });
  }

  async startServices(log: LogFn): Promise<void> {
    const { contract, cfg, p, names } = this;
    for (const svc of contract.permissions.network.services) {
      this.cli(["rm", "-f", names.service(svc.name)], { allowFail: true });
      svc.workspaceMounts.forEach((_m, i) => fs.mkdirSync(dk.deployDir(p, svc.name, i), { recursive: true }));
      const { args, secretEnv } = dk.serviceRunArgs(cfg, p, svc);
      const values: Record<string, string> = {};
      for (const [envName, credName] of Object.entries(secretEnv)) {
        const value = this.env[credName];
        if (!value) throw new Error(`service ${svc.name} needs credential ${credName} from the supervisor's environment, and it is not set`);
        values[envName] = value;
      }
      this.checked(args, { networks: [names.net], role: "service", secretEnvNames: Object.keys(values) });
      const r = spawnSync(this.bin, args, { encoding: "utf8", env: { ...process.env, ...values }, timeout: 120_000 });
      if (r.status !== 0) throw new Error(`starting service ${svc.name} failed: ${r.stderr.trim().slice(0, 300)}`);
      log(`service ${svc.name} started (${svc.image})`);
    }
    // Services that serve nothing from the workspace should be healthy now; the others get their content after the first deploy.
    for (const svc of contract.permissions.network.services.filter((s) => !s.workspaceMounts.length)) {
      const ok = await this.waitHealthy(svc, { path: svc.health.path, expectStatus: svc.health.expectStatus });
      if (!ok.ok) throw new Error(`service ${svc.name} is not healthy after ${svc.health.retries} checks: ${ok.detail}`);
      log(`service ${svc.name} healthy`);
    }
  }

  async probeService(svc: ServiceSpec, { path: urlPath, expectStatus }: HealthTarget): Promise<HealthOutcome> {
    if (svc.health.cmd) {
      const r = spawnSync(this.bin, ["exec", this.names.service(svc.name), ...svc.health.cmd], { encoding: "utf8", timeout: (svc.health.timeoutSeconds + 5) * 1000 });
      return { ok: r.status === 0, detail: r.status === 0 ? "health command succeeded" : `health command exited ${String(r.status)}` };
    }
    const args = dk.healthProbeRunArgs(this.cfg, this.p, { url: `http://${svc.name}:${svc.port}${urlPath ?? "/"}`, expectStatus: expectStatus ?? 200, timeoutSeconds: svc.health.timeoutSeconds });
    const r = await this.helper(args, { role: "probe", networks: [this.names.net], timeoutMs: (svc.health.timeoutSeconds + 20) * 1000 });
    return { ok: r.code === 0, detail: `${svc.name}${urlPath ?? "/"} answered ${r.stdout.trim() || r.stderr.trim().slice(-100) || "nothing"}` };
  }

  async waitHealthy(svc: ServiceSpec, opts: HealthTarget): Promise<HealthOutcome> {
    let last: HealthOutcome = { ok: false, detail: "not checked" };
    for (let i = 0; i < svc.health.retries; i++) {
      last = await this.probeService(svc, opts);
      if (last.ok) return last;
      await this.sleep(svc.health.intervalSeconds * 1000);
    }
    return last;
  }

  async serviceHealth({ check }: { check: AcceptanceCheck }): Promise<HealthOutcome> {
    const svc = this.contract.permissions.network.services.find((s) => s.name === check.service);
    if (!svc) return { ok: false, detail: `no service ${check.service}` };
    return this.waitHealthy(svc, { path: check.path, expectStatus: check.expectStatus });
  }

  /** The boundary probe in a container started with the worker's exact arguments, with the effort snapshot and unattended environment. */
  async probe(log: LogFn): Promise<BoundaryReport> {
    const { cfg, p, contract } = this;
    const state = this.state();
    const args = dk.agentRunArgs(cfg, p, { n: 0, attempt: "probe", reset: false, effort: state.effort }).filter((a) => a !== "-i");
    const at = args.lastIndexOf(cfg.image);
    const keyHash = createHash("sha256").update(this.key()).digest("hex");
    const keyRegex = contract.model.provider === "openrouter" ? "sk-or-v1-[0-9a-f]{32,}" : "[A-Za-z0-9_.-]{24,200}";
    const allow = contract.permissions.network.egress.map((e) => `${e.host}:${String(e.ports[0])}`).join(",");
    const services = contract.permissions.network.services.map((s) => `${s.name}:${s.port}`).join(",");
    // A canary listener on the host, on every interface: the zone must not reach it at any address the host holds on the run's networks.
    const canary = net.createServer((s) => s.destroy());
    await new Promise<void>((resolve) => { canary.listen(0, "0.0.0.0", resolve); });
    const address = canary.address();
    if (address === null || typeof address === "string") { canary.close(); throw new Error("the host canary listener has no TCP port"); }
    const canaryPort = address.port;
    const hostTargets = this.zoneHostAddresses().map((ip) => `${ip}:${canaryPort}`).join(",");
    const probeArgs = [...args.slice(0, at), "--env", `AUTONOMY_KEY_SHA256=${keyHash}`, "--env", `AUTONOMY_KEY_REGEX=${keyRegex}`, "--env", `AUTONOMY_EGRESS_ALLOW=${allow}`, "--env", `AUTONOMY_SERVICES=${services}`, "--env", `AUTONOMY_HOST_CANARY=${hostTargets}`,
      "--mount", `type=bind,source=${path.join(PKG, "tests", "boundary-probe.ts")},target=/probe.ts,readonly`, "--entrypoint", "node", cfg.image, "/probe.ts"];
    let r: HelperResult;
    try { r = await this.helper(probeArgs, { role: "worker", networks: [this.names.net], timeoutMs: 180_000 }); } finally { canary.close(); }
    let report: BoundaryReport;
    try { report = parseJsonAs(BoundaryReportSchema, r.stdout.trim().split("\n").at(-1) ?? "", "boundary report"); } catch { throw new Error(`boundary probe gave no report (exit ${r.code}): ${r.stderr.trim().slice(-500)}`); }
    fs.writeFileSync(p.boundary, `${JSON.stringify({ at: new Date().toISOString(), ...report }, null, 2)}\n`);
    for (const c of report.checks) if (!c.ok) log(`boundary FAIL ${c.name}: ${c.detail}`);
    log(`boundary probe: ${report.checks.filter((c) => c.ok).length} of ${report.checks.length} checks passed`);
    return report;
  }

  async tearDown(): Promise<void> {
    this.relay?.kill(); this.relay = null;
    this.proxy?.kill(); this.proxy = null;
    const n = this.names;
    for (const svc of this.contract.permissions.network.services) this.cli(["rm", "-f", n.service(svc.name)], { allowFail: true });
    for (const name of [n.relay, n.proxy]) this.cli(["rm", "-f", name], { allowFail: true });
    for (const net of [n.net, n.egress]) this.cli(["network", "rm", net], { allowFail: true });
  }

  /** After a crash: everything the run labelled is removed, so a resumed run never meets a stray worker, relay or service. */
  async cleanupOrphans(): Promise<string[]> {
    const listed = this.cli(dk.listRunContainersArgs(this.cfg), { allowFail: true });
    const names = listed ? listed.split("\n").filter(Boolean) : [];
    for (const name of names) this.cli(["rm", "-f", name], { allowFail: true });
    return names;
  }

  // --- the worker -------------------------------------------------------------------------------------
  startWorker({ step, attempt, resetWorkspace, effort, onEvent }: StartWorkerOptions): WorkerAgent {
    const { cfg, p, names } = this;
    const dir = path.join(p.steps, pad(step));
    fs.mkdirSync(dir, { recursive: true });
    const args = dk.agentRunArgs(cfg, p, { n: step, attempt, reset: resetWorkspace, effort });
    this.checked(args, { networks: [names.net], role: "worker" });
    const events = fs.createWriteStream(path.join(dir, `events-${attempt}.jsonl`), { flags: "a" });
    const stderr = fs.createWriteStream(path.join(dir, `agent-${attempt}.log`), { flags: "a" });
    const child = spawn(this.bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    child.stderr.pipe(stderr);
    child.stdin.on("error", () => {});
    child.stdout.on("data", lineParser((msg) => {
      if (msg.type === "response" && msg.id === "harness-check") {
        const missing = missingHarness(msg);
        if (missing.length) { this.harnessFailure = `the kit harness did not load (missing commands: ${missing.join(", ")}); see ${path.join(dir, `agent-${attempt}.log`)}`; this.log(`HARNESS FAIL: ${this.harnessFailure}`); }
        else if (!this.harnessOk) { this.harnessOk = true; this.log("harness verified: kit commands registered"); }
        return;
      }
      // Streaming deltas and partial tool output are most of the volume and none of the signal.
      if (msg.type !== "message_update" && msg.type !== "tool_execution_update") events.write(`${JSON.stringify({ at: new Date().toISOString(), ...msg })}\n`);
      onEvent(msg);
    }, (bad) => { stderr.write(`[non-json stdout] ${bad.slice(0, 500)}\n`); }));
    const exited = new Promise<{ code: number }>((resolve) => { child.on("close", (code: number | null) => { events.end(); resolve({ code: code ?? 1 }); }); });
    child.stdin.write(`${JSON.stringify({ id: "harness-check", type: "get_commands" })}\n`); // pi answers commands in order
    const name = names.agent(step, attempt);
    return {
      name,
      send: (msg) => { if (child.stdin.writable) child.stdin.write(`${JSON.stringify(msg)}\n`); },
      exited,
      stop: async () => {
        if (child.exitCode !== null) return;
        if (child.stdin.writable) { child.stdin.write(`${JSON.stringify({ type: "abort" })}\n`); child.stdin.end(); }
        const done = await Promise.race([exited, new Promise<null>((r) => { setTimeout(() => { r(null); }, 30_000); })]);
        if (!done) { this.cli(["rm", "-f", name], { allowFail: true }); await exited; }
      },
    };
  }

  async snapshotWork({ message }: { message: string }): Promise<void> {
    const r = await this.helper(dk.snapshotRunArgs(this.cfg, this.p, { message }), { role: "snapshot", timeoutMs: 120_000 });
    if (r.code !== 0) throw new Error(`snapshot failed: ${r.stderr.trim().slice(-300)}`);
  }

  async fetchWorkerBundle(): Promise<WorkerBundle> {
    const bundle = path.join(this.p.bundles, "agent.bundle");
    fs.mkdirSync(this.p.bundles, { recursive: true });
    fs.rmSync(bundle, { force: true });
    const r = await this.helper(dk.bundleRunArgs(this.cfg, this.p), { role: "bundle", timeoutMs: 120_000 });
    if (r.code !== 0 || !fs.existsSync(bundle)) return { error: `bundle failed: ${r.stderr.trim().slice(-300)}` };
    return { bundle };
  }

  /** Point the worker's repository at the mirror's working branch; unmerged cycles' tags travel along as attempts/<run>/cycle-NN. */
  async setWorkerBranch(_sha: string, extraRefs: readonly string[] = []): Promise<void> {
    const bundle = this.repo.bundleBranch(path.join(this.p.bundles, "setref.bundle"), extraRefs);
    const r = await this.helper(dk.setAgentRefRunArgs(this.cfg, this.p, { bundleFile: bundle, sha: this.repo.head() }), { role: "setref", timeoutMs: 120_000 });
    if (r.code !== 0) throw new Error(`setting the worker's branch failed: ${r.stderr.trim().slice(-300)}`);
  }

  /** Refresh each service's staged copy of its workspace mounts (in a network-less container), and restart services that read their code at start. */
  async deploy({ sha }: { sha: string }): Promise<void> {
    for (const svc of this.contract.permissions.network.services) {
      if (!svc.workspaceMounts.length) continue;
      for (const [i, m] of svc.workspaceMounts.entries()) {
        fs.mkdirSync(dk.deployDir(this.p, svc.name, i), { recursive: true });
        const r = await this.helper(dk.deploySyncRunArgs(this.cfg, this.p, { service: svc.name, index: i, source: m.source }), { role: "deploy-sync", timeoutMs: 120_000 });
        if (r.code !== 0) throw new Error(`deploying ${m.source} to ${svc.name} failed: ${r.stderr.trim().slice(-300)}`);
      }
      if (svc.restartOnDeploy) this.cli(["restart", this.names.service(svc.name)], { allowFail: true });
    }
    this.log(`deployed ${sha.slice(0, 12)} into the run's services`);
  }

  // --- trusted checks ----------------------------------------------------------------------------------
  async runCheck({ check, sha }: { check: AcceptanceCheck; sha: string }): Promise<CheckOutcome> {
    const { p } = this;
    const bundle = path.join(p.bundles, `check-${check.id}.bundle`);
    this.repo.bundleBranch(bundle);
    fs.rmSync(p.gateWork, { recursive: true, force: true });
    fs.mkdirSync(p.gateWork, { recursive: true });
    const hasOverlay = fs.existsSync(p.overlay) && fs.readdirSync(p.overlay).length > 0;
    const started = Date.now();
    const r = await this.helper(dk.checkRunArgs(this.cfg, p, { bundleFile: bundle, sha, checkId: check.id, runnerScript: path.join(LIB, "check-runner.ts"), hasOverlay }), { role: "check", timeoutMs: (check.timeoutMinutes + 2) * 60_000 });
    fs.rmSync(bundle, { force: true });
    const read = (f: string): string => { try { return fs.readFileSync(path.join(p.gateWork, f), "utf8").slice(-4000); } catch { return ""; } };
    const detail = readJson(path.join(p.gateWork, "result.json"), null);
    const steps = isRecord(detail) ? detail["steps"] : undefined;
    return { exitCode: r.code, timedOut: r.timedOut || r.code === 124, seconds: Math.round((Date.now() - started) / 1000), tail: read("gate.log") || read("check.log") || r.stderr.trim().slice(-2000), steps: Array.isArray(steps) ? steps as unknown[] : undefined };
  }

  // --- money and models ---------------------------------------------------------------------------------
  usageUsd(): number {
    const read = (f: string): number => { try { return meteredUsd(fs.readFileSync(path.join(this.p.meter, f), "utf8")); } catch { return 0; } };
    return read("usage.jsonl") + read("manager.jsonl");
  }

  /** A host-side chat-completions call (manager, merge review, task review); its spend is metered with the run's. */
  complete(model: string, { timeoutMs }: { timeoutMs?: number } = {}): Complete {
    const { contract, cfg, p } = this;
    const meterFile = path.join(p.meter, "manager.jsonl");
    const pricing = contract.providerSettings.pricing[model];
    return openRouterComplete({
      apiKey: this.key(), model, upstream: cfg.upstream, timeoutMs, usageInclude: PROVIDERS[contract.model.provider]?.reportsCost ?? false,
      onUsage: (u) => {
        const computed = pricing ? ((u.prompt_tokens ?? 0) * pricing.inputPerMTok + (u.completion_tokens ?? 0) * pricing.outputPerMTok) / 1e6 : 0;
        fs.mkdirSync(p.meter, { recursive: true });
        fs.appendFileSync(meterFile, `${JSON.stringify({ at: new Date().toISOString(), model, costUsd: u.cost ?? computed })}\n`);
      },
    });
  }

  review(bundle: TaskReviewBundle): Promise<TaskReview> {
    return reviewTask(bundle, this.complete(this.contract.model.review, { timeoutMs: 300_000 }), { sleep: (ms) => this.sleep(ms) });
  }
}
