#!/usr/bin/env node
/**
 * OPTIONAL: the container boundary on a REAL engine (Docker, or Podman with
 * PI_AUTONOMY_TEST_ENGINE=podman). With no reachable engine it prints a SKIPPED line and exits 0,
 * so the offline suites stay the gate and this one adds evidence where an engine exists.
 *
 * It drives the real DockerRuntime (lib/runtime.ts), so every container goes through the same
 * builders and the same containment validator as a run. Nothing is mocked except the model
 * provider: the relay talks to a fake provider in a container on the run's outward network, as it
 * would to a real one (no real model, no paid inference), and the "worker" is an idle container
 * started with the worker's exact arguments that the test execs facts and git commands into (pi
 * itself is not in the test image).
 *
 * What it proves, from inside and outside the containers:
 *   - the run network is internal (no DNS, no route to a public host, no route to the host);
 *   - workers run non-root, read-only, with no capabilities, no-new-privileges and no engine socket;
 *   - `docker inspect` agrees: mounts only under the run directory, no host namespaces, no
 *     published ports, the key in no environment or argument list, and only the relay and the
 *     egress proxy (besides the test's fake provider) on the outward network;
 *   - a listener on the host is unreachable from the zone at every host address; where a host
 *     firewall already drops all container-to-host traffic, the control that shows this check
 *     can fail is reported as inconclusive rather than passed;
 *   - the relay injects the key (which the worker never had), refuses other paths and models,
 *     and meters spend; the boundary probe passes in the real containers;
 *   - the egress proxy allows a listed host (a TLS handshake through it, when the host has
 *     outbound access) and refuses unlisted hosts, wrong ports and private, loopback, link-local
 *     and odd-spelled addresses, and audits both;
 *   - the git plumbing (snapshot, bundle, ingest, reset) works with no network, and acceptance
 *     checks run in clean network-less containers with the held-out overlay applied;
 *   - a run service serves a host-staged copy of the worker's files, read-only, and a planted
 *     symlink resolves inside the service, not on the host;
 *   - cleanup removes every container and network it made.
 *
 * Environment: PI_AUTONOMY_TEST_ENGINE (docker), PI_AUTONOMY_TEST_IMAGE (a prebuilt image with
 * node, git, tini and image/entrypoint.sh; default: built here from node:22-bookworm-slim, which
 * needs network access for the base image and apt), PI_AUTONOMY_TEST_KEEP_IMAGE=1 to keep the
 * built image. Everything it creates is named pi-autonomy-test-*.
 */
import { spawn, spawnSync, type SpawnSyncOptions } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, makeChecker, testEffort } from "./autonomy-helpers.ts";
import { loadModule } from "../packages/core/eval/harness.ts";
import { array, boolean, nullable, number, object, optional, parseJsonAs, record, string, unknownValue, type Schema } from "../packages/core/lib/guard.ts";
import type * as UnattendedModule from "../packages/extensions/src/tool-firewall/unattended.ts";
import type { DockerRuntime as DockerRuntimeClass } from "../packages/autonomy/lib/runtime.ts";
import type { runtimeConfig as runtimeConfigFn } from "../packages/autonomy/lib/runcfg.ts";
import type { RunStore } from "../packages/autonomy/lib/store.ts";
import type { AcceptanceCheck } from "../packages/autonomy/lib/contract.ts";
import type { ZoneContext } from "../packages/autonomy/lib/engine.ts";
import type { RunState } from "../packages/autonomy/lib/lifecycle.ts";

interface EngineResult { code: number | null; stdout: string; stderr: string }
/** One step of container-checks.ts: `value` when it worked, `error` when it did not (a failed step has no value). */
const attemptOf = <T>(value: Schema<T>) => object({ ok: boolean(), value: optional(value), error: optional(string()) });
const HttpReply = object({ status: number(), body: string() });
/** The JSON line tests/container-checks.ts prints, one schema per MODE. */
const PropsFacts = object({
  uid: optional(number()), capEff: optional(string()), capPrm: optional(string()), capBnd: optional(string()), capInh: optional(string()), noNewPrivs: optional(string()), mountinfo: string(),
  writable: record(boolean()), sockets: array(string()), homes: array(string()), procNet: array(object({ iface: optional(string()), dest: optional(string()) })),
  dnsPublic: attemptOf(unknownValue()), tcpPublic: attemptOf(string()), tcpPublicDns: attemptOf(string()), names: record(attemptOf(unknownValue())), gateways: record(attemptOf(string())),
});
const ProxyFacts = object({
  results: record(object({ status: optional(nullable(number())), error: optional(string()) })), // a garbled status line is NaN, which JSON writes as null
  tls: optional(attemptOf(object({ authorized: boolean(), authorizationError: nullable(string()), protocol: nullable(string()) }))),
});
const InferFacts = object({ chat: attemptOf(HttpReply), other: attemptOf(number()), models: attemptOf(number()), keys: attemptOf(number()) });
const HttpFacts = object({ get: attemptOf(HttpReply) });
/** The parts of `docker inspect <container>` these checks read. */
const ContainerInspect = object({
  HostConfig: object({
    ReadonlyRootfs: boolean(), Privileged: boolean(), CapDrop: nullable(array(string())), CapAdd: optional(nullable(array(string()))), SecurityOpt: optional(nullable(array(string()))),
    PidMode: optional(string()), UsernsMode: optional(string()), IpcMode: optional(string()), NetworkMode: optional(string()), Devices: optional(nullable(array(unknownValue()))),
    PortBindings: optional(nullable(record(unknownValue()))), PidsLimit: optional(nullable(number())), Memory: optional(nullable(number())), NanoCpus: optional(nullable(number())),
  }),
  Config: object({ User: string(), Env: optional(nullable(array(string()))), Hostname: string() }),
  Mounts: array(object({ Type: string(), Source: string(), Destination: string(), RW: boolean() })),
  NetworkSettings: object({ Networks: record(unknownValue()) }),
});
/** A request the fake upstream logged (it writes a missing authorization header as null). */
const ProviderRequest = object({ method: string(), url: optional(string()), authorization: optional(nullable(string())), body: string() });
interface ProbeCheck { name: string; ok: boolean; detail: string }
type Canary = Awaited<ReturnType<typeof startHostCanary>>;
type RunConfig = ReturnType<typeof runtimeConfigFn>;
/** DockerRuntime as constructed: its constructor `Object.assign`s these, which inference cannot see. */
type Runtime = DockerRuntimeClass & { cfg: RunConfig; store: RunStore };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.join(HERE, "..", "packages", "autonomy");
const ENGINE = process.env.PI_AUTONOMY_TEST_ENGINE || "docker";
const LABEL = "autonomy-container-smoke";
const skip = (why: string): never => { console.log(`[${LABEL}] SKIPPED: ${why}`); process.exit(0); };

// --- is there an engine, and git? -------------------------------------------------------------------
const engine = (args: string[], { input, timeout = 60_000, allowFail = false }: { input?: string | undefined; timeout?: number; allowFail?: boolean } = {}): EngineResult => {
  const r = spawnSync(ENGINE, args, { encoding: "utf8", input, timeout, maxBuffer: 64 * 1024 * 1024 });
  if (!allowFail && (r.error || r.status !== 0)) throw new Error(`${ENGINE} ${args.slice(0, 3).join(" ")} failed: ${(r.error?.message ?? r.stderr).trim().slice(0, 500)}`);
  return { code: r.status, stdout: (r.stdout ?? "").trim(), stderr: (r.stderr ?? "").trim() };
};
if (!["docker", "podman"].includes(ENGINE)) skip(`PI_AUTONOMY_TEST_ENGINE must be docker or podman (got ${ENGINE})`);
const version = engine(["version", "--format", ENGINE === "docker" ? "{{.Server.Version}}" : "{{.Version}}"], { allowFail: true, timeout: 20_000 });
if (version.code !== 0 || !version.stdout) skip(`no reachable ${ENGINE} engine (${((version.stderr || "not installed").split("\n")[0] ?? "").slice(0, 120)}); the offline suites cover the argument builders and the containment validator`);
if (spawnSync("git", ["--version"]).status !== 0) skip("git is not installed on the host");

// Modules are loaded after the skip decision, so a host without an engine needs nothing else.
const { resolveContract } = await import("../packages/autonomy/lib/contract.ts");
const { createRun } = await import("../packages/autonomy/lib/rundir.ts");
const { boundaryDigest } = await import("../packages/autonomy/lib/boundary.ts");
const { runtimeConfig } = await import("../packages/autonomy/lib/runcfg.ts");
const { DockerRuntime } = await import("../packages/autonomy/lib/runtime.ts");
const dk = await import("../packages/autonomy/lib/docker.ts");

const { check, done } = makeChecker(LABEL);
const isRoot = process.getuid?.() === 0;
// A root-run test makes every directory it creates world-writable, so the non-root container user
// (10001) can write the bind-mounted run directories, as the operator's own uid can in real use.
if (isRoot) process.umask(0);

const suffix = crypto.randomBytes(3).toString("hex");
const PREFIX = `pi-autonomy-test-${suffix}`;
const RUN = `ctr-${suffix}`;
const KEY = `sk-or-v1-${crypto.randomBytes(24).toString("hex")}`; // synthetic; nothing real is used
const MODEL = "test/model-a";
const COST = 0.0123;
const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-autonomy-test-home-"));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pi-autonomy-test-ctx-"));
const log: string[] = [];
const note = (line: string) => log.push(line);
const own: { image: string | null; builtImage: boolean; canary: Canary | null; rt: Runtime | null; cfg: RunConfig | null } = { image: null, builtImage: false, canary: null, rt: null, cfg: null };

// --- the test image ---------------------------------------------------------------------------------
const BASE = process.env.PI_AUTONOMY_TEST_BASE_IMAGE || "node:22-bookworm-slim";
async function testImage(): Promise<string> {
  if (process.env.PI_AUTONOMY_TEST_IMAGE) {
    if (engine(["image", "inspect", process.env.PI_AUTONOMY_TEST_IMAGE, "--format", "{{.Id}}"], { allowFail: true }).code !== 0) skip(`PI_AUTONOMY_TEST_IMAGE ${process.env.PI_AUTONOMY_TEST_IMAGE} is not present on the engine`);
    return process.env.PI_AUTONOMY_TEST_IMAGE;
  }
  // The real image minus pi and the kit: node, git, tini and the real entrypoint (roles bundle, snapshot, setref).
  const dockerfile = `FROM ${BASE}\nRUN apt-get update && apt-get install -y --no-install-recommends bash git tini ca-certificates && rm -rf /var/lib/apt/lists/*\nCOPY entrypoint.sh /opt/autonomy/entrypoint.sh\nRUN chmod 0555 /opt/autonomy/entrypoint.sh\nUSER 10001:10001\nENTRYPOINT ["/usr/bin/tini", "--", "/opt/autonomy/entrypoint.sh"]\nCMD ["agent"]\n`;
  const entry = fs.readFileSync(path.join(PKG, "image", "entrypoint.sh"));
  const tag = `pi-autonomy-test-image:${crypto.createHash("sha256").update(dockerfile).update(entry).digest("hex").slice(0, 12)}`;
  if (engine(["image", "inspect", tag, "--format", "{{.Id}}"], { allowFail: true }).code === 0) return tag;
  const ctx = path.join(scratch, "image");
  fs.mkdirSync(ctx, { recursive: true });
  fs.writeFileSync(path.join(ctx, "Dockerfile"), dockerfile);
  fs.writeFileSync(path.join(ctx, "entrypoint.sh"), entry);
  const built = engine(["build", "-q", "-t", tag, ctx], { allowFail: true, timeout: 600_000 });
  if (built.code !== 0) skip(`cannot build the test image from ${BASE} (${(built.stderr.split("\n").at(-1) ?? "").slice(0, 160)}); the container legs need the base image and apt, or PI_AUTONOMY_TEST_IMAGE`);
  own.builtImage = true;
  return tag;
}

// --- a listener on the host: the canary the zone must not reach -----------------------------------------
// A separate process: this test makes synchronous engine calls, which would stall a server in its own event loop.
async function startHostCanary() {
  const child = spawn(process.execPath, [path.join(PKG, "tests", "fake-upstream.ts"), path.join(scratch, "canary.jsonl"), MODEL, String(COST)], { stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise<number>((resolve, reject) => {
    child.stdout.once("data", (d) => {
      try { resolve(parseJsonAs(object({ port: number() }), String(d).split("\n")[0] ?? "", "fake upstream").port); } catch (e) { reject(toError(e)); }
    });
    child.on("error", reject);
    child.on("exit", (code) => reject(new Error(`fake upstream exited (${code})`)));
  });
  child.removeAllListeners("exit");
  return { child, port, close: () => child.kill() };
}

// --- a fake model provider on the run's outward network -----------------------------------------------
// It stands in for the internet: the relay reaches it over its outward network, as it reaches a real
// provider. A provider on the host would need container-to-host traffic, which a host firewall with a
// default-drop input policy (ufw's default) silently discards, so the relay's requests would time out.
const PROVIDER = `${PREFIX}-provider`;
const PROVIDER_PORT = 8080;
const providerDir = path.join(scratch, "provider");
const upstreamLog = path.join(providerDir, "upstream.jsonl");
async function startProvider(image: string, network: string): Promise<string> {
  fs.mkdirSync(providerDir, { recursive: true });
  // It writes its request log to the host through this mount, so it runs as the user the run's containers use.
  const user = isRoot ? "10001:10001" : `${process.getuid?.() ?? 10001}:${process.getgid?.() ?? 10001}`;
  if (isRoot) spawnSync("chown", ["-R", user, providerDir]);
  engine(["run", "-d", "--name", PROVIDER, "--network", network, "--user", user,
    "--mount", `type=bind,source=${path.join(PKG, "tests")},target=/fixtures,readonly`,
    "--mount", `type=bind,source=${providerDir},target=/log`,
    "--entrypoint", "node", image, "/fixtures/fake-upstream.ts", "/log/upstream.jsonl", MODEL, String(COST), String(PROVIDER_PORT)]);
  const logs = () => engine(["logs", PROVIDER], { allowFail: true });
  for (let i = 0; i < 100 && !logs().stdout.includes('"port"'); i++) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.match(logs().stdout, new RegExp(`"port":${PROVIDER_PORT}`), `the fake provider is listening: ${logs().stderr.slice(-300)}`);
  const ip = engine(["inspect", PROVIDER, "--format", `{{(index .NetworkSettings.Networks "${network}").IPAddress}}`]).stdout;
  assert.match(ip, /^\d+\.\d+\.\d+\.\d+$/, `the fake provider has an address on ${network}`);
  return ip;
}
/** What the provider received, as the fake logged it. */
const seenByProvider = () => {
  let text: string;
  try { text = fs.readFileSync(upstreamLog, "utf8"); } catch { return []; }
  return text.trim().split("\n").filter(Boolean).map((l) => parseJsonAs(ProviderRequest, l, "upstream.jsonl"));
};

// --- helpers ----------------------------------------------------------------------------------------------
const gitHost = (args: string[], opts: Omit<SpawnSyncOptions, "encoding"> = {}) => spawnSync("git", ["-c", "safe.directory=*", ...args], { encoding: "utf8", ...opts });
const execIn = (name: string, args: string[], { env = {}, input, timeout = 120_000 }: { env?: Record<string, string>; input?: string; timeout?: number } = {}) => engine(["exec", ...(input === undefined ? [] : ["-i"]), ...Object.entries(env).flatMap(([k, v]) => ["--env", `${k}=${v}`]), name, ...args], { input, timeout, allowFail: true });
const facts = <T>(name: string, mode: string, schema: Schema<T>, env: Record<string, string> = {}): T => {
  const r = execIn(name, ["node", "-"], { env: { MODE: mode, ...env }, input: fs.readFileSync(path.join(PKG, "tests", "container-checks.ts"), "utf8") });
  assert.equal(r.code, 0, `container-checks ${mode} exited ${r.code}: ${r.stderr}`);
  return parseJsonAs(schema, r.stdout.trim().split("\n").at(-1) ?? "", `container-checks ${mode}`);
};
/** `docker inspect` of one container: its raw JSON (for the key search) and the parts the checks read. */
const inspectRaw = (name: string): string => engine(["inspect", name]).stdout;
const inspect = (name: string) => {
  const [first] = parseJsonAs(array(ContainerInspect), inspectRaw(name), `inspect ${name}`);
  assert.ok(first, `${ENGINE} inspect ${name} returned no container`);
  return first;
};
const gatewayOf = (net: string) => engine(["network", "inspect", net, "--format", "{{range .IPAM.Config}}{{.Gateway}} {{end}}"]).stdout.split(/\s+/).find((g) => /^\d+\.\d+\.\d+\.\d+$/.test(g));
/** The run's recorded state, which a created run always has. */
const stateOf = (store: RunStore): RunState => { const s = store.readState(); assert.ok(s, "the run has a state.json"); return s; };
const workerShaped = (rt: Runtime) => {
  const args = dk.agentRunArgs(rt.cfg, rt.p, { n: 0, attempt: "shape", reset: false, effort: stateOf(rt.store).effort });
  const at = args.lastIndexOf(rt.cfg.image);
  return ["run", "-d", ...args.slice(1, at).filter((a) => a !== "-i" && a !== "--rm"), "--entrypoint", "node", rt.cfg.image, "-e", "setInterval(() => {}, 1 << 30)"];
};
const isUnder = (file: string, roots: string[]) => roots.some((r) => file === r || file.startsWith(`${r}${path.sep}`));
const zeros = /^0+$/;
const ownedNames = (kind: "container" | "network") => engine(kind === "container" ? ["ps", "-a", "--format", "{{.Names}}", "--filter", `name=${PREFIX}`] : ["network", "ls", "--format", "{{.Name}}", "--filter", `name=${PREFIX}`], { allowFail: true }).stdout.split("\n").filter((n) => n.startsWith(PREFIX));

function cleanup() {
  const names = ownedNames("container");
  for (const n of names) engine(["rm", "-f", n], { allowFail: true });
  for (const n of ownedNames("network")) engine(["network", "rm", n], { allowFail: true });
  if (own.builtImage && !process.env.PI_AUTONOMY_TEST_KEEP_IMAGE && own.image) engine(["rmi", "-f", own.image], { allowFail: true });
  own.canary?.close();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(scratch, { recursive: true, force: true });
  return names.length;
}

let failed: unknown = null;
try {
  own.image = await testImage();
  const image = own.image;
  own.canary = await startHostCanary();
  const canaryPort = own.canary.port;

  // --- the run: a deploy contract exercising every container role -------------------------------------
  const SERVER = 'const http=require("http"),fs=require("fs");http.createServer((q,r)=>{fs.readFile("/site"+decodeURIComponent(q.url.split("?")[0]),(e,d)=>{r.writeHead(e?404:200);r.end(e?"no":d);});}).listen(8080,"0.0.0.0");';
  const overlaySource = path.join(scratch, "held-out.txt");
  fs.writeFileSync(overlaySource, "held out of the worker's sight\n");
  const NO_NET = "const s=require('net').connect({host:'1.1.1.1',port:443,timeout:3000});s.on('connect',()=>process.exit(1));s.on('error',()=>process.exit(0));s.on('timeout',()=>process.exit(0));";
  const raw = {
    schemaVersion: 1, run: RUN, template: "deploy",
    objective: { title: "Container boundary test", spec: "Exercise the container boundary.", backlog: [] },
    inputs: { repository: null },
    acceptance: {
      checks: [
        { id: "answer", run: ["sh", "-c", 'test "$(cat answer.txt)" = 42'], timeoutMinutes: 2, required: true },
        { id: "overlay", run: ["sh", "-c", "test -f held-out.txt"], timeoutMinutes: 2, required: true },
        { id: "offline", run: ["node", "-e", NO_NET], timeoutMinutes: 2, required: true },
        { id: "sealed", run: ["sh", "-c", 'if touch /etc/x 2>/dev/null || test -e /work || test -e /var/run/docker.sock || test "$(id -u)" = 0; then exit 1; fi'], timeoutMinutes: 2, required: true },
        { id: "clean-env", run: ["sh", "-c", "if env | grep -qiE 'sk-or|api_key|token|secret'; then exit 1; fi"], timeoutMinutes: 2, required: true },
        { id: "fails", run: ["sh", "-c", "echo the check output; exit 3"], timeoutMinutes: 2, required: false },
        { id: "web-up", type: "service-health", service: "web", path: "/index.html", expectStatus: 200, required: true },
      ],
      overlay: [{ source: overlaySource, target: "held-out.txt" }],
      review: false,
    },
    permissions: {
      writeAreas: ["**"],
      network: {
        egress: [{ host: "example.com", ports: [443] }],
        serviceImages: [own.image],
        services: [{ name: "web", image: own.image, port: 8080, command: ["node", "-e", SERVER], workspaceMounts: [{ source: "site", target: "/site" }], health: { path: "/index.html", expectStatus: 200, intervalSeconds: 1, retries: 30 } }],
      },
      unattended: { authorised: true, autoApprove: true },
    },
    model: { provider: "openrouter", worker: MODEL },
    effort: "standard",
    budget: { totalUsd: 5, perStepUsd: 1, maxSteps: 5, maxMinutes: 60 },
    promotion: { policy: "none" },
    runtime: { engine: ENGINE, image: own.image, user: isRoot ? "10001:10001" : "host", memory: "1g", cpus: "2", mirrorSeconds: 1 },
  };
  const resolved = resolveContract(raw, { effort: testEffort });
  assert.equal(resolved.ok, true, JSON.stringify(resolved.problems));
  const contract = resolved.contract;
  assert.ok(contract, "the deploy contract resolved");
  const acceptanceChecks: AcceptanceCheck[] = contract.acceptance.checks;
  const store = createRun({ contract, authorisation: { boundaryDigest: boundaryDigest(contract), by: "container-smoke", at: new Date().toISOString(), via: "test" }, home });
  const cfg = runtimeConfig(contract, { namePrefix: PREFIX });
  const rt = new DockerRuntime({ contract, cfg, store, env: { ...process.env, OPENROUTER_API_KEY: KEY } }) as Runtime;
  own.rt = rt; own.cfg = cfg;
  const p = store.p;
  const N = dk.names(cfg);
  /** What the runtime's zone steps (prepare, bringUp) are handed. */
  const zone = (): ZoneContext => ({ contract, cfg, state: stateOf(store), log: note });
  /** The contract's acceptance check with this id. */
  const checkOf = (id: string): AcceptanceCheck => { const c = acceptanceChecks.find((x) => x.id === id); assert.ok(c, `the contract has check ${id}`); return c; };
  const roots = [p.root, PKG];

  // In real use the supervisor and the containers share a uid (runtime.user "host", or rootless mapping). A root-run test
  // cannot, so it hands the directories a container writes to over to the container user, as that shared uid would own them.
  const adopt = (...dirs: string[]) => { if (isRoot) spawnSync("chown", ["-R", dk.userSpec(cfg), ...dirs.filter((d) => fs.existsSync(d))]); };
  await rt.preflight();
  const { baseSha } = await rt.prepare(zone());
  adopt(p.remote, p.work, p.agentState, p.meter, p.egress, p.bundles, p.gateWork);
  rt.networks();
  const egressGw = gatewayOf(N.egress);
  assert.ok(egressGw, "the outward network has a gateway: a host address the zone must not reach");
  const providerIp = await startProvider(image, N.egress);
  // Every address the host could answer on from the zone's point of view: the first host of each run subnet, the gateways, the engine's default bridge.
  const subnetsOf = (network: string) => engine(["network", "inspect", network, "--format", "{{range .IPAM.Config}}{{.Subnet}} {{end}}"]).stdout.split(/\s+/).filter((x) => /^\d+\.\d+\.\d+\.\d+\/\d+$/.test(x));
  const firstHost = (cidr: string) => {
    const [a, b, c, d] = (cidr.split("/")[0] ?? "").split(".").map(Number);
    assert.ok(a !== undefined && b !== undefined && c !== undefined && d !== undefined, `not an IPv4 subnet: ${cidr}`);
    return `${a}.${b}.${c}.${d + 1}`;
  };
  const zoneAddrs = [...new Set([...subnetsOf(N.net).map(firstHost), ...subnetsOf(N.egress).map(firstHost), egressGw, "172.17.0.1"])];
  cfg.upstream = `http://${providerIp}:${PROVIDER_PORT}`; // the relay over the outward network; the supervisor on the host reaches the bridge directly

  await check("bring-up: networks, relay, egress proxy, a run service and the boundary probe all pass on the real engine", async () => {
    const report = await rt.bringUp(zone());
    const failedChecks = report.checks.filter((c: ProbeCheck) => !c.ok).map((c: ProbeCheck) => `${c.name}: ${c.detail}`);
    assert.deepEqual(failedChecks, [], "the probe's own checks, run inside a container started with the worker's exact arguments");
    assert.ok(report.checks.length >= 30, `${report.checks.length} probe checks ran`);
    for (const wanted of ["dns example.com fails", "tcp 1.1.1.1:443 fails", "relay refuses non-inference paths", "egress proxy refuses 127.0.0.1:443", "the real API key is in no mounted file", "the run contract is read-only, sanitised, and matches the unattended and effort environment"]) assert.ok(report.checks.some((c: ProbeCheck) => c.name === wanted), wanted);
    assert.equal(engine(["network", "inspect", N.net, "--format", "{{.Internal}}"]).stdout, "true");
    assert.equal(engine(["network", "inspect", N.egress, "--format", "{{.Internal}}"]).stdout, "false");
    assert.equal(parseJsonAs(object({ pass: unknownValue() }), fs.readFileSync(p.boundary, "utf8"), "boundary report").pass, true, "the probe report is recorded in the run directory");
  });

  // A worker-shaped container: the worker's exact run arguments, idling, so facts and git commands can be exec'd into it.
  const shapeArgs = workerShaped(rt);
  rt.checked(shapeArgs, { networks: [N.net], role: "worker" });
  const shape = shapeArgs[shapeArgs.indexOf("--name") + 1];
  assert.ok(shape, "the worker-shaped container is started with --name");
  engine(shapeArgs);
  // The worker's own git identity, as the entrypoint sets it (the agent role itself needs pi, which the test image lacks).
  const workerEnv = { HOME: "/tmp" };
  const workerSetup = "git config --global user.name w && git config --global user.email w@example.org";
  const workerExec = (script: string) => execIn(shape, ["sh", "-c", `${workerSetup} && ${script}`], { env: workerEnv });

  await check("the containers on the engine match the boundary: hardened, mounts only under the run, no host namespaces, no key anywhere, and only the relay and proxy face outward", async () => {
    const service = N.service("web");
    const everything = [];
    for (const [name, nets] of [[N.relay, [N.net, N.egress]], [N.proxy, [N.net, N.egress]], [service, [N.net]], [shape, [N.net]]] satisfies Array<[string, string[]]>) {
      const c = inspect(name);
      everything.push(inspectRaw(name));
      const h = c.HostConfig;
      assert.equal(h.ReadonlyRootfs, true, `${name} read-only rootfs`);
      assert.equal(h.Privileged, false, `${name} not privileged`);
      assert.deepEqual(h.CapDrop, ["ALL"], `${name} drops all capabilities`);
      assert.ok(!h.CapAdd?.length, `${name} adds none back`);
      assert.ok(h.SecurityOpt?.some((s) => /no-new-privileges/.test(s)), `${name} no-new-privileges`);
      assert.ok(!h.PidMode && !h.UsernsMode && h.IpcMode !== "host" && h.NetworkMode !== "host", `${name} no host namespaces`);
      assert.ok(!h.Devices?.length, `${name} no devices`);
      assert.deepEqual(Object.keys(h.PortBindings ?? {}), [], `${name} publishes no ports`);
      assert.ok((h.PidsLimit ?? 0) > 0 && (h.Memory ?? 0) > 0 && (h.NanoCpus ?? 0) > 0, `${name} has pids, memory and cpu limits`);
      assert.notEqual(c.Config.User.split(":")[0], "0", `${name} runs as a non-root user`);
      assert.equal(c.Config.User, dk.userSpec(cfg), `${name} runs as the contract's user`);
      for (const m of c.Mounts) {
        if (m.Type === "bind") assert.ok(isUnder(m.Source, roots), `${name} mounts ${m.Source}, which is outside the run directory and the package`);
        assert.ok(!/docker\.sock|podman\.sock|\.ssh|\.aws|\.config|\.pi\b/.test(m.Source), `${name} mounts no socket or credential store: ${m.Source}`);
      }
      assert.deepEqual(Object.keys(c.NetworkSettings.Networks).sort(), [...nets].sort(), `${name} is on exactly its networks`);
      const env = (c.Config.Env ?? []).join("\n");
      assert.doesNotMatch(env, /sk-or-v1|^[A-Z0-9_]*(API_?KEY|_KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*=/im, `${name} carries no credential in its environment`);
    }
    const publicMount = inspect(shape).Mounts.find((m) => m.Destination === "/run");
    assert.equal(publicMount?.RW, false, "/run (the sanitised contract) is read-only");
    assert.ok(!everything.join("\n").includes(KEY), "the inference key appears in no container's configuration");
    const ps = spawnSync("ps", ["-eo", "args"], { encoding: "utf8" }).stdout;
    assert.ok(!ps.includes(KEY), "the inference key is on no process command line (it went to the relay on stdin)");
    const outward = parseJsonAs(record(object({ Name: string() })), engine(["network", "inspect", N.egress, "--format", "{{json .Containers}}"]).stdout || "{}", "outward network containers");
    // The fake provider is the test's stand-in for the internet, not part of the run.
    assert.deepEqual(Object.values(outward).map((c) => c.Name).filter((n) => n !== PROVIDER).sort(), [N.proxy, N.relay].sort(), "only the relay and the egress proxy join the outward network");
    assert.equal(fs.existsSync(p.contract) && (fs.statSync(p.contract).mode & 0o222), 0, "the contract file is not writable");
  });

  await check("inside a worker: non-root, no capabilities, no-new-privileges, read-only root, no engine socket, and no way out of the internal network", async () => {
    // The canary listens on every host interface: a worker must not be able to reach it.
    const hostTargets = zoneAddrs.map((ip) => `${ip}:${canaryPort}`);
    const f = facts(shape, "props", PropsFacts, { NAMES: "inference,egress-proxy,web", HOST_TARGETS: hostTargets.join(",") });
    assert.equal(f.uid, Number(dk.userSpec(cfg).split(":")[0]));
    assert.notEqual(f.uid, 0);
    // The worker's firewall enters unattended mode only when the contract sits on a read-only mount in the kernel's own table.
    // Parse this real container's table with the firewall's real parser: /run is read-only, the worker's own space is not.
    const { mountHolding } = await loadModule<typeof UnattendedModule>("extensions/tool-firewall/unattended.ts");
    assert.equal(mountHolding("/run/contract.json", f.mountinfo)?.ro, true, `/run/contract.json is on a read-only mount in the real engine's table: ${JSON.stringify(mountHolding("/run/contract.json", f.mountinfo))}`);
    for (const rw of ["/work/file", "/state/file", "/tmp/file"]) assert.equal(mountHolding(rw, f.mountinfo)?.ro, false, `${rw} is on a writable mount, so a contract written there would be refused`);
    for (const k of ["capEff", "capPrm", "capBnd", "capInh"] as const) assert.match(f[k] ?? "", zeros, `${k} is empty`);
    assert.equal(f.noNewPrivs, "1");
    for (const file of ["/usr/x", "/etc/x", "/x", "/run/x"]) assert.equal(f.writable[file], false, `${file} is not writable`);
    for (const file of ["/tmp/x", "/work/x", "/state/x"]) assert.equal(f.writable[file], true, `${file} is the worker's own space`);
    assert.deepEqual(f.sockets, [], "no container engine socket");
    assert.deepEqual(f.homes.filter((h) => h !== "node"), [], "no host home directories");
    assert.equal(f.dnsPublic.ok, false, "a public name does not resolve");
    assert.equal(f.tcpPublic.ok, false, "a public address (1.1.1.1:443) is not reachable");
    assert.equal(f.tcpPublicDns.ok, false, "nor 8.8.8.8:53");
    assert.ok(f.procNet.every((r) => r.dest !== "00000000"), `no default route: ${JSON.stringify(f.procNet)}`);
    for (const name of ["inference", "egress-proxy", "web"]) assert.equal(f.names[name]?.ok, true, `${name} resolves by name on the internal network`);
    assert.ok(Object.keys(f.gateways).length >= 3, "several host addresses were tried");
    for (const [target, r] of Object.entries(f.gateways)) assert.equal(r.ok, false, `the host's own listener ${target} is not reachable from the zone`);
    if (ENGINE === "docker") assert.equal(engine(["network", "inspect", N.net, "--format", `{{index .Options "${dk.HOSTLESS_OPTION}"}}`]).stdout, "true", "the run network is created without a host address on it");
  });

  // Control: the check above must be able to fail. On Docker, a plain internal network leaks the host, so the same canary
  // is reachable from it; the hostless option is what closes it. If even the default bridge, which has a route to the host,
  // cannot reach the canary, a host firewall drops all container-to-host traffic (ufw's default input policy does), and
  // the worker check above proves nothing about the boundary on this host. That is reported, not passed.
  const controlProbe = () => {
    const control = `${PREFIX}-control`;
    engine(["network", "create", "--internal", control]);
    const [subnet] = subnetsOf(control);
    assert.ok(subnet, `${control} has a subnet`);
    const probe = (target: string) => `const s=require('net').connect({host:'${target}',port:${canaryPort},timeout:3000});s.on('connect',()=>{console.log('reachable');process.exit(0)});s.on('error',(e)=>{console.log('blocked '+e.code);process.exit(0)});s.on('timeout',()=>{console.log('blocked timeout');process.exit(0)});`;
    const internal = engine(["run", "--rm", "--name", `${PREFIX}-control-probe`, "--network", control, "--entrypoint", "node", image, "-e", probe(firstHost(subnet))], { allowFail: true });
    engine(["network", "rm", control], { allowFail: true });
    if (ENGINE !== "docker" || internal.stdout === "reachable") return { internal, viaBridge: null };
    const bridgeGw = gatewayOf("bridge");
    const viaBridge = bridgeGw ? engine(["run", "--rm", "--name", `${PREFIX}-control-bridge`, "--network", "bridge", "--entrypoint", "node", image, "-e", probe(bridgeGw)], { allowFail: true }).stdout : "no default bridge";
    return { internal, viaBridge };
  };
  const control = controlProbe();
  if (control.viaBridge !== null && control.viaBridge !== "reachable") {
    await check(`control INCONCLUSIVE on this host: no container reaches the host's canary, not even from the default bridge (${control.viaBridge}); a host firewall drops container-to-host traffic, so the worker check above could not have failed here`, () => undefined);
  } else {
    await check("control: on a plain internal network the same canary IS reachable (so the check above can fail, and the hostless option is what closes it)", () => {
      if (ENGINE === "docker") assert.equal(control.internal.stdout, "reachable", `Docker's plain internal network was expected to leak the host (${control.internal.stdout} ${control.internal.stderr}); if a newer engine closed this, the hostless option is harmless and this control can go`);
      else console.log(`  NOTE: control on ${ENGINE}: ${control.internal.stdout || control.internal.stderr}`);
    });
  }

  await check("the relay: it holds the key, the worker never does; other paths and models are refused; spend is metered from the upstream's cost", async () => {
    const f = facts(shape, "infer", InferFacts, { MODEL });
    const seen = seenByProvider();
    const relayLog = () => { try { return fs.readFileSync(path.join(p.meter, "relay.log"), "utf8").slice(-800); } catch { return "(no relay log)"; } };
    assert.equal(f.chat.ok && f.chat.value?.status, 200, `${JSON.stringify(f.chat)}; the provider saw ${JSON.stringify(seen.map((x) => `${x.method} ${x.url}`))}; relay log: ${relayLog()}`);
    assert.match(f.chat.value?.body ?? "", /fake answer/);
    assert.equal(f.other.value, 403, "another model is refused");
    assert.equal(f.models.value, 200, "the model list is served");
    assert.equal(f.keys.value, 403, "the key-management path is refused");
    assert.ok(seen.some((x) => x.method === "POST" && x.url === "/chat/completions"), "the chat request reached the provider");
    for (const x of seen) assert.equal(x.authorization, `Bearer ${KEY}`, "the relay, not the worker, supplied the credential");
    assert.ok(!seen.some((x) => /worker-placeholder/.test(String(x.authorization))), "the worker's placeholder never reached the provider");
    assert.ok(!seen.some((x) => x.url?.includes("keys")), "the refused path never reached the provider");
    assert.ok(!seen.some((x) => /some\/other-model/.test(x.body)), "the refused model never reached the provider");
    let usd = 0;
    for (let i = 0; i < 25 && usd < COST; i++) { usd = rt.usageUsd(); if (usd < COST) await rt.sleep(200); }
    assert.ok(Math.abs(usd - COST) < 1e-9, `metered ${usd}, wanted ${COST}`);
  });

  await check("the egress proxy end to end: a listed host is tunnelled (TLS through it, when the host has outbound access); everything else is refused and audited", async () => {
    const reach = execIn(N.proxy, ["node", "-e", "const s=require('net').connect({host:'example.com',port:443,timeout:8000});s.on('connect',()=>{console.log('yes');process.exit(0)});s.on('error',()=>{console.log('no');process.exit(0)});s.on('timeout',()=>{console.log('no');process.exit(0)})"]);
    const outbound = reach.stdout.trim() === "yes";
    const refused = ["example.org:443", "example.com:22", "example.com:8443", "127.0.0.1:443", "0x7f.1:443", "[::1]:443", "[::ffff:127.0.0.1]:443", "169.254.169.254:80", "10.0.0.1:443", "localhost:80", "example.com@127.0.0.1:443", `${egressGw}:${canaryPort}`];
    const f = facts(shape, "proxy", ProxyFacts, { AUTHORITIES: [...refused, "example.com:443"].join(","), ...(outbound ? { TLS_HOST: "example.com" } : {}) });
    for (const authority of refused) {
      const r = f.results[authority];
      assert.ok(r?.status !== undefined && r.status !== 200, `${authority} must not be tunnelled: ${JSON.stringify(r)}`);
      assert.ok([400, 403, 404, 405].includes(r.status ?? Number.NaN), `${authority} is refused by policy, not by luck (${r.status})`);
    }
    const audit = fs.readFileSync(path.join(p.egress, "egress.jsonl"), "utf8").trim().split("\n").map((l) => parseJsonAs(object({ target: unknownValue(), decision: unknownValue() }), l, "egress.jsonl"));
    for (const authority of refused) assert.ok(audit.some((a) => a.target === authority && a.decision === "deny"), `${authority} is in the audit log as denied`);
    assert.ok(audit.every((a) => a.decision === "allow" || a.decision === "deny"));
    if (outbound) {
      assert.equal(f.results["example.com:443"]?.status, 200, "the listed host and port is tunnelled");
      const tls = f.tls?.value;
      assert.ok(f.tls?.ok === true && tls, JSON.stringify(f.tls));
      assert.match(tls.protocol ?? "", /^TLSv1\.[23]$/, "a TLS handshake with the real host completes through the proxy");
      if (!tls.authorized) console.log(`  NOTE: the handshake completed but the certificate did not verify (${tls.authorizationError}); this network intercepts TLS with its own CA, which the test image does not trust`);
      assert.ok(audit.some((a) => a.target === "example.com:443" && a.decision === "allow"), "the allowed tunnel is audited");
    } else console.log("  NOTE: the engine's containers have no outbound access, so the allowed leg (a tunnel to example.com) was not exercised; the refusals were");
  });

  let head = baseSha;
  await check("git plumbing with no network: a worker's commits and uncommitted files are snapshotted, bundled, ingested by the host, and a reset takes its branch back", async () => {
    const clone = workerExec(`git clone --quiet --branch ${cfg.branch} /git/remote.git /work`);
    assert.equal(clone.code, 0, clone.stderr);
    const write = workerExec(`cd /work && mkdir -p site && echo 42 > answer.txt && echo '<h1>zone</h1>' > site/index.html && ln -s /etc/hostname site/leak && git add -A && git commit --quiet -m "answer and site" && echo later > later.txt`);
    assert.equal(write.code, 0, write.stderr);
    await rt.snapshotWork({ message: "checkpoint" }); // the role that commits what the worker left uncommitted, and pushes it, with no network
    const remoteHead = gitHost(["--git-dir", p.remote, "rev-parse", `refs/heads/${cfg.branch}`]).stdout.trim();
    assert.notEqual(remoteHead, baseSha);
    assert.match(gitHost(["--git-dir", p.remote, "ls-tree", "-r", "--name-only", remoteHead]).stdout, /later\.txt/, "the uncommitted file was committed by the snapshot");
    const fetched = await rt.fetchWorkerBundle();
    assert.ok(fetched.bundle && fs.existsSync(fetched.bundle), fetched.error ?? "");
    const ingested = rt.repo.ingest(fetched.bundle, { areas: ["**"] });
    assert.equal(ingested.moved, true, JSON.stringify(ingested));
    head = rt.repo.head();
    assert.equal(head, remoteHead);
    const tree = gitHost(["--git-dir", p.mirror, "ls-tree", "-r", "--name-only", head]).stdout.split("\n");
    for (const f of ["answer.txt", "later.txt", "site/index.html", "site/leak"]) assert.ok(tree.includes(f), f);
    // The worker keeps going, then the host resets its branch to the accepted head (a rejected or discarded step).
    const junk = workerExec(`cd /work && echo junk > junk.txt && git add -A && git commit --quiet -m junk && git push --quiet origin HEAD:refs/heads/${cfg.branch}`);
    assert.equal(junk.code, 0, junk.stderr);
    assert.notEqual(gitHost(["--git-dir", p.remote, "rev-parse", `refs/heads/${cfg.branch}`]).stdout.trim(), head);
    await rt.setWorkerBranch(head);
    assert.equal(gitHost(["--git-dir", p.remote, "rev-parse", `refs/heads/${cfg.branch}`]).stdout.trim(), head, "the worker's branch is back at the accepted head");
  });

  await check("acceptance checks run in clean, network-less containers from the accepted head, with the held-out overlay, and a failing check is reported as failing", async () => {
    const run = (id: string) => rt.runCheck({ check: checkOf(id), sha: head });
    for (const id of ["answer", "overlay", "offline", "sealed", "clean-env"]) {
      const r = await run(id);
      assert.equal(r.exitCode, 0, `${id} should pass: ${r.tail}`);
      assert.equal(r.timedOut, false);
    }
    assert.ok(!gitHost(["--git-dir", p.mirror, "ls-tree", "-r", "--name-only", head]).stdout.includes("held-out.txt"), "the overlay file is not in the worker's history");
    const bad = await run("fails");
    assert.notEqual(bad.exitCode, 0);
    assert.match(bad.tail, /the check output/, "the check's own output is the evidence");
    const result = parseJsonAs(object({ id: unknownValue() }), fs.readFileSync(path.join(p.gateWork, "check-result.json"), "utf8"), "check-result.json");
    assert.equal(result.id, "fails");
    assert.deepEqual(ownedNames("container").filter((n) => n.includes("-check-")), [], "check containers are removed when they finish");
  });

  await check("a run service serves a host-staged copy of the worker's files, read-only; a planted symlink resolves inside the service, never on the host", async () => {
    adopt(p.deploy);
    await rt.deploy({ sha: head });
    const health = await rt.serviceHealth({ check: checkOf("web-up") });
    assert.equal(health.ok, true, health.detail);
    const page = facts(shape, "http", HttpFacts, { URL: "http://web:8080/index.html" }).get.value;
    assert.ok(page, "the worker reaches the service by name");
    assert.match(page.body, /<h1>zone<\/h1>/, "the worker reaches the service by name and sees the deployed page");
    assert.equal(page.status, 200);
    const service = N.service("web");
    const staged = path.join(dk.deployDir(p, "web", 0), "leak");
    assert.equal(fs.lstatSync(staged).isSymbolicLink(), true, "the staging copy holds the symlink as a link, not what it points at");
    const leak = facts(shape, "http", HttpFacts, { URL: "http://web:8080/leak" }).get.value;
    assert.ok(leak, "the service answers for the planted link");
    const serviceHostname = inspect(service).Config.Hostname;
    assert.equal(leak.body.trim(), serviceHostname, "the link resolved to the service container's own file");
    assert.notEqual(leak.body.trim(), os.hostname(), "and not to the host's");
    const write = execIn(service, ["sh", "-c", "touch /site/x 2>/dev/null && echo wrote || echo denied"]);
    assert.equal(write.stdout.trim(), "denied", "the service cannot write its staged content");
    assert.equal(facts(shape, "http", HttpFacts, { URL: "http://web:8080/nothing-here" }).get.value?.status, 404);
    const offline = facts(shape, "props", PropsFacts, {});
    assert.equal(offline.tcpPublic.ok, false, "still no way out after the service is up");
  });

  await check("teardown: orphan cleanup removes every labelled container, tear-down removes both networks, and nothing named pi-autonomy-test-* is left", async () => {
    engine(["rm", "-f", PROVIDER], { allowFail: true }); // the test's fake provider is not part of the run; it leaves first so the outward network can go
    const removed = await rt.cleanupOrphans();
    for (const name of [N.relay, N.proxy, N.service("web"), shape]) assert.ok(removed.includes(name), `${name} was found by its run label`);
    await rt.tearDown();
    assert.deepEqual(ownedNames("container"), []);
    assert.deepEqual(ownedNames("network"), []);
  });
} catch (e) {
  failed = e;
} finally {
  try { await own.rt?.tearDown(); } catch { /* the sweep below removes what is left */ }
  const swept = cleanup();
  if (swept) console.log(`  (cleanup removed ${swept} leftover container(s))`);
}
/** The thrown value as an Error: a non-Error is wrapped with its string form. */
function toError(thrown: unknown): Error {
  return thrown instanceof Error ? thrown : new Error(String(thrown));
}
if (failed) {
  const err = toError(failed);
  console.error(`\n[${LABEL}] FAILED: ${err.message}`);
  if (log.length) console.error(`runtime log (last 25 lines):\n${log.slice(-25).join("\n")}`);
  if (err.stack) console.error(err.stack.split("\n").slice(1, 5).join("\n"));
  process.exit(1);
}
console.log(`  engine: ${ENGINE} ${version.stdout}, image ${own.image}`);
done();
