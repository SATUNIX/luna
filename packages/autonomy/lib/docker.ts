// Container argument builders for the run's containers (rootless podman or docker). Pure:
// lib/runtime.ts executes them (after lib/containment.ts re-checks each one), and the tests
// check the boundary properties (networks, mounts, no credentials, hardening) without Docker.
//
//   <net>     internal network: no route off the host's bridge, no DNS beyond container names
//   <egress>  ordinary bridge network that only the relay and the egress proxy join
//   relay     on both; holds the real API key, received on stdin
//   proxy     on both; the only way to an allowlisted public host (lib/egress-proxy.ts)
//   worker    on <net> only; mounts the run's bare repo (its only git remote), its workspace,
//             its pi state and the sanitised contract read-only; nothing from the operator's home
//   service   run-scoped services (deploy template): hardened, on <net> only, image from the allowlist
//   helpers   --network none: bundle/snapshot the worker's refs, update its bare repo, deploy-sync,
//             run one acceptance check in a clean clone
import path from "node:path";
import { isRecord } from "../../core/lib/guard.ts";
import { randomSuffix } from "./fsutil.ts";
import type { runPaths } from "./paths.ts";
import { PROXY_HOST, PROXY_PORT, RELAY_HOST, RELAY_PORT, envArgs, workerEnv, type EffortSnapshot, type WorkerEnvContract } from "./worker-env.ts";

/** The run directory layout (lib/paths.ts). */
export type RunPaths = ReturnType<typeof runPaths>;

/** A size or count as the engine takes it ("6g", "4", 1024). */
type EngineQuantity = string | number;

/** The part of the runtime configuration (lib/runcfg.ts) the container builders read. */
export interface DockerConfig {
  readonly run: string;
  readonly namePrefix?: string | undefined;
  readonly engine: string;
  readonly image: string;
  readonly branch: string;
  readonly tagPrefix: string;
  readonly contract: WorkerEnvContract;
  readonly container: {
    readonly memory: EngineQuantity;
    readonly cpus: EngineQuantity;
    readonly pids: EngineQuantity;
    readonly tmpSize: EngineQuantity;
    readonly user?: string | number | null | undefined;
  };
  readonly gate: { readonly memory: EngineQuantity; readonly cpus: EngineQuantity };
  readonly gitIdentity: { readonly name: string; readonly email: string };
  readonly references?: Readonly<Record<string, string>> | undefined;
}

/** Container and network names of one run. */
export interface RunNames {
  prefix: string;
  net: string;
  egress: string;
  relay: string;
  proxy: string;
  agent: (n: number, attempt: number | string) => string;
  service: (name: string) => string;
  helper: (what: string) => string;
}

export function names(cfg: Pick<DockerConfig, "run" | "namePrefix">): RunNames {
  const p = cfg.namePrefix ?? `pi-exp-${cfg.run}`;
  return {
    prefix: p,
    net: p,
    egress: `${p}-egress`,
    relay: `${p}-relay`,
    proxy: `${p}-proxy`,
    agent: (n, attempt) => `${p}-agent-${String(n).padStart(2, "0")}-${attempt}`,
    service: (name) => `${p}-svc-${name}`,
    helper: (what) => `${p}-${what}-${Date.now().toString(36)}${randomSuffix(3)}`,
  };
}

/**
 * Whether a container engine runs rootless, from its own `info` output (Podman: host.security.rootless; Docker:
 * SecurityOptions lists "name=rootless"). `runtime.user: "0:0"` (root inside the container) is safe only where
 * that root is mapped to the operator's own user, so it is refused unless the engine says it is rootless.
 */
export function engineIsRootless(info: unknown): boolean {
  if (!isRecord(info)) return false;
  const host = info["host"];
  const security = isRecord(host) ? host["security"] : undefined;
  if (isRecord(security) && security["rootless"] === true) return true;
  const options = info["SecurityOptions"];
  return Array.isArray(options) && options.some((s: unknown) => /(?:^|,)name=rootless(?:,|$)/.test(String(s)));
}

export function userSpec(cfg: { readonly container: Pick<DockerConfig["container"], "user"> }, uid: number = process.getuid?.() ?? 1000, gid: number = process.getgid?.() ?? 1000): string {
  const u = cfg.container.user;
  return !u || u === "host" ? `${uid}:${gid}` : String(u);
}

export interface HardenOptions {
  readonly memory?: EngineQuantity | undefined;
  readonly cpus?: EngineQuantity | undefined;
  readonly tmpSize?: EngineQuantity | undefined;
  readonly role?: string | undefined;
  readonly user?: string | undefined;
}

export function hardened(cfg: DockerConfig, { memory = cfg.container.memory, cpus = cfg.container.cpus, tmpSize = cfg.container.tmpSize, role = "helper", user }: HardenOptions = {}): string[] {
  return [
    // Rootless podman: map the operator's uid to itself inside the container (every other id
    // in the container is an unprivileged sub-id on the host).
    ...(cfg.engine === "podman" ? ["--userns=keep-id"] : []),
    "--user", user ?? userSpec(cfg), "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
    "--pids-limit", String(cfg.container.pids), "--memory", String(memory), "--cpus", String(cpus),
    "--tmpfs", `/tmp:rw,nosuid,size=${String(tmpSize)}`, "--no-healthcheck",
    "--label", `pi-autonomy.run=${cfg.run}`, "--label", `pi-autonomy.role=${role}`,
  ];
}

const bind = (src: string, dest: string, readOnly = false): string[] => ["--mount", `type=bind,source=${src},target=${dest}${readOnly ? ",readonly" : ""}`];

/** The relay idles in its container; the server is started by `docker exec -i` (config on stdin). */
export function relayRunArgs(cfg: DockerConfig, p: Pick<RunPaths, "meter">, relayScript: string): string[] {
  return ["run", "-d", "--name", names(cfg).relay, ...hardened(cfg, { memory: "256m", cpus: "1", tmpSize: "16m", role: "relay" }),
    "--network", names(cfg).egress, ...bind(relayScript, "/relay.ts", true), ...bind(p.meter, "/meter"),
    "--entrypoint", "node", cfg.image, "-e", "setInterval(() => {}, 1 << 30)"];
}

export function relayExecArgs(cfg: DockerConfig): string[] {
  return ["exec", "-i", names(cfg).relay, "node", "/relay.ts"];
}

/** The egress proxy: same shape as the relay. Its allowlist arrives on stdin; its audit log is /audit. */
export function proxyRunArgs(cfg: DockerConfig, p: Pick<RunPaths, "egress">, { script, netaddr }: { script: string; netaddr: string }): string[] {
  return ["run", "-d", "--name", names(cfg).proxy, ...hardened(cfg, { memory: "256m", cpus: "1", tmpSize: "16m", role: "proxy" }),
    "--network", names(cfg).egress, ...bind(script, "/proxy/egress-proxy.ts", true), ...bind(netaddr, "/proxy/netaddr.ts", true), ...bind(p.egress, "/audit"),
    "--entrypoint", "node", cfg.image, "-e", "setInterval(() => {}, 1 << 30)"];
}

export function proxyExecArgs(cfg: DockerConfig): string[] {
  return ["exec", "-i", names(cfg).proxy, "node", "/proxy/egress-proxy.ts"];
}

/** The worker: pi in RPC mode, driven over stdin/stdout. `reset` discards uncommitted work first. */
export interface AgentRunOptions {
  readonly n: number;
  readonly attempt: number | string;
  readonly reset?: boolean | undefined;
  readonly effort?: EffortSnapshot | null | undefined;
}

export function agentRunArgs(cfg: DockerConfig, p: Pick<RunPaths, "remote" | "work" | "agentState" | "public" | "references">, { n, attempt, reset, effort }: AgentRunOptions): string[] {
  return ["run", "-i", "--rm", "--name", names(cfg).agent(n, attempt), ...hardened(cfg, { role: "worker" }), "--network", names(cfg).net,
    ...bind(p.remote, "/git/remote.git"), ...bind(p.work, "/work"), ...bind(p.agentState, "/state"), ...bind(p.public, "/run", true),
    ...Object.keys(cfg.references ?? {}).flatMap((name) => bind(`${p.references}/${name}`, `/reference/${name}`, true)),
    ...envArgs(workerEnv(cfg.contract, { branch: cfg.branch, reset, effort })),
    cfg.image, "agent"];
}

/** Bundle the worker's branch out of its bare repo (read-only), for the host to fetch as data. */
export function bundleRunArgs(cfg: DockerConfig, p: Pick<RunPaths, "remote" | "bundles">): string[] {
  return ["run", "--rm", "--name", names(cfg).helper("bundle"), ...hardened(cfg, { memory: "512m", cpus: "1", tmpSize: "64m" }), "--network", "none",
    ...bind(p.remote, "/git/remote.git", true), ...bind(p.bundles, "/out"), cfg.image, "bundle", cfg.branch];
}

/**
 * Commit whatever the worker left uncommitted in /work and push it to the bare repo, so work
 * counts even if the session ended without a commit. Runs with no network; .pi/ and
 * node_modules/ are never committed.
 */
export function snapshotRunArgs(cfg: DockerConfig, p: Pick<RunPaths, "remote" | "work">, { message }: { message: string }): string[] {
  return ["run", "--rm", "--name", names(cfg).helper("snapshot"), ...hardened(cfg, { memory: "512m", cpus: "1", tmpSize: "64m" }), "--network", "none",
    ...bind(p.remote, "/git/remote.git"), ...bind(p.work, "/work"), "--env", `GIT_NAME=${cfg.gitIdentity.name}`, "--env", `GIT_EMAIL=${cfg.gitIdentity.email}`,
    cfg.image, "snapshot", cfg.branch, message];
}

/** Point the worker's bare repo at a sha the host holds (a reset, or a new cycle), from a bundle. */
export function setAgentRefRunArgs(cfg: DockerConfig, p: Pick<RunPaths, "remote">, { bundleFile, sha }: { bundleFile: string; sha: string }): string[] {
  return ["run", "--rm", "--name", names(cfg).helper("setref"), ...hardened(cfg, { memory: "512m", cpus: "1", tmpSize: "64m" }), "--network", "none",
    ...bind(p.remote, "/git/remote.git"), ...bind(bundleFile, "/in/branch.bundle", true), cfg.image, "setref", cfg.branch, sha, `refs/tags/${cfg.tagPrefix}*`, `refs/heads/attempts/${cfg.run}/*`];
}

/**
 * One acceptance check: a clean clone of the accepted head, the check definition from the
 * run directory (read-only), the overlay of held-out files (read-only), no network at all. The
 * container's exit status is the verdict. The runner script comes from the supervisor's checkout.
 */
export interface CheckRunOptions {
  readonly bundleFile: string;
  readonly sha: string;
  readonly checkId: string;
  readonly runnerScript: string;
  readonly hasOverlay?: boolean | undefined;
}

export function checkRunArgs(cfg: DockerConfig, p: Pick<RunPaths, "checks" | "gateWork" | "overlay">, { bundleFile, sha, checkId, runnerScript, hasOverlay }: CheckRunOptions): string[] {
  return ["run", "--rm", "--name", names(cfg).helper("check"), ...hardened(cfg, { memory: cfg.gate.memory, cpus: cfg.gate.cpus, role: "check" }), "--network", "none",
    ...bind(bundleFile, "/in/branch.bundle", true), ...bind(p.checks, "/run/checks.json", true), ...bind(p.gateWork, "/gate"), ...bind(runnerScript, "/check-runner.ts", true),
    ...(hasOverlay ? bind(p.overlay, "/overlay", true) : []),
    "--env", `CHECK_ID=${checkId}`, "--env", `CHECK_SHA=${sha}`, "--env", `CHECK_BRANCH=${cfg.branch}`, "--env", "CI=1",
    "--entrypoint", "node", cfg.image, "/check-runner.ts"];
}

/** Probe a run service's HTTP endpoint from inside the run network, from a throwaway container. */
export function healthProbeRunArgs(cfg: DockerConfig, _p: unknown, { url, expectStatus, timeoutSeconds = 5 }: { url: string; expectStatus: number; timeoutSeconds?: number | undefined }): string[] {
  const script = "const [url, want, secs] = process.argv.slice(1); fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(Number(secs) * 1000) }).then((r) => { console.log(r.status); process.exit(r.status === Number(want) ? 0 : 1); }, (e) => { console.log(String(e.cause?.code ?? e.message)); process.exit(2); });";
  return ["run", "--rm", "--name", names(cfg).helper("probe"), ...hardened(cfg, { memory: "128m", cpus: "0.5", tmpSize: "8m", role: "probe" }), "--network", names(cfg).net,
    "--entrypoint", "node", cfg.image, "-e", script, url, String(expectStatus), String(timeoutSeconds)];
}

/** Where a service's workspace mount is staged on the host (host-owned, never the worker's own directory). */
export const deployDir = (p: Pick<RunPaths, "deploy">, service: string, index: number): string => path.join(p.deploy, service, String(index));

/**
 * Copy a directory of the worker's workspace into a host-owned staging directory that a
 * service mounts read-only. The copy runs in a network-less container, so a symlink the worker
 * planted is resolved inside that container's filesystem, never on the host.
 */
export function deploySyncRunArgs(cfg: DockerConfig, p: Pick<RunPaths, "work" | "deploy">, { service, index, source }: { service: string; index: number; source: string }): string[] {
  const script = 'set -eu; find /out -mindepth 1 -maxdepth 1 -exec rm -rf {} +; if [ -d "/work/$DEPLOY_SRC" ] && [ ! -L "/work/$DEPLOY_SRC" ]; then tar -C "/work/$DEPLOY_SRC" -cf - . | tar -C /out -xf -; fi';
  return ["run", "--rm", "--name", names(cfg).helper("deploy"), ...hardened(cfg, { memory: "512m", cpus: "1", tmpSize: "64m" }), "--network", "none",
    ...bind(p.work, "/work", true), ...bind(deployDir(p, service, index), "/out"), "--env", `DEPLOY_SRC=${source}`, "--entrypoint", "sh", cfg.image, "-c", script];
}

/**
 * A run-scoped service. Returns { args, secretEnv }: secretEnv maps an environment variable in
 * the service to the NAME of a credential in the supervisor's own environment; the value is
 * injected into the engine client's process environment (`--env NAME` inherits it), so it is
 * never in an argument list, a log or `inspect`-able command line.
 */
/** A run service from the contract (permissions.network.services[]), as the builder reads it. */
export interface ServiceSpec {
  readonly name: string;
  readonly image: string;
  readonly memory?: EngineQuantity | undefined;
  readonly cpus?: EngineQuantity | undefined;
  readonly user?: string | undefined;
  readonly workspaceMounts?: readonly { readonly target: string }[] | undefined;
  readonly tmpfs?: readonly string[] | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly credentialEnv?: Readonly<Record<string, string>> | undefined;
  readonly command?: readonly string[] | undefined;
}

export function serviceRunArgs(cfg: DockerConfig, p: Pick<RunPaths, "deploy">, svc: ServiceSpec): { args: string[]; secretEnv: Record<string, string> } {
  const n = names(cfg);
  const [entrypoint, ...commandArgs] = svc.command ?? [];
  // An empty command used to put `--entrypoint` with no value in the arguments, which the boundary check refuses.
  if (svc.command && entrypoint === undefined) throw new Error(`service ${svc.name}: command is empty`);
  const args = ["run", "-d", "--name", n.service(svc.name), ...hardened(cfg, { memory: svc.memory ?? "1g", cpus: svc.cpus ?? "1", role: "service", user: svc.user }),
    "--network", n.net, "--network-alias", svc.name,
    ...(svc.workspaceMounts ?? []).flatMap((m, i) => bind(deployDir(p, svc.name, i), m.target, true)),
    ...(svc.tmpfs ?? []).flatMap((t) => ["--tmpfs", `${t}:rw,nosuid,size=${String(cfg.container.tmpSize)}`]),
    ...Object.entries(svc.env ?? {}).flatMap(([k, v]) => ["--env", `${k}=${v}`]),
    ...Object.keys(svc.credentialEnv ?? {}).flatMap((k) => ["--env", k]),
    ...(entrypoint === undefined ? [] : ["--entrypoint", entrypoint]),
    svc.image, ...commandArgs];
  return { args, secretEnv: { ...(svc.credentialEnv ?? {}) } };
}

/**
 * Network creation: the run network must be internal. On Docker that is not enough: an internal
 * network stops FORWARDING off the bridge, but the host itself still answers on the bridge's own
 * address (that is INPUT, not FORWARD), so any service the host listens on 0.0.0.0 (a database, sshd,
 * an engine API on TCP) would be reachable from the zone. Docker's `inhibit_ipv4` leaves the bridge
 * with no address, so there is no host on the network to reach. (Verified on a real engine by
 * tests/autonomy-container-smoke.ts, and re-verified before every start by the boundary probe's
 * canary; Podman's internal networks are checked by the same canary, not assumed.)
 */
export const HOSTLESS_OPTION = "com.docker.network.bridge.inhibit_ipv4";

export function networkCreateArgs(cfg: Pick<DockerConfig, "engine" | "run" | "namePrefix">): string[][] {
  const hostless = cfg.engine === "docker" ? ["--opt", `${HOSTLESS_OPTION}=true`] : [];
  return [["network", "create", "--internal", ...hostless, names(cfg).net], ["network", "create", names(cfg).egress]];
}

/** Listing and removal of everything a run created, by label (orphan cleanup after a crash). */
export const listRunContainersArgs = (cfg: Pick<DockerConfig, "run">): string[] => ["ps", "-a", "--filter", `label=pi-autonomy.run=${cfg.run}`, "--format", "{{.Names}}"];

export { PROXY_HOST, PROXY_PORT, RELAY_HOST, RELAY_PORT };
