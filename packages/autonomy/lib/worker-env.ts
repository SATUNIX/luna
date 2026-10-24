// The environment the supervisor gives a worker container: ONE function, so the worker-side
// consumers (tool-firewall unattended mode, the effort extension, the entrypoint) have exactly
// one contract to read and the tests can pin it.
//
//   PI_KIT_UNATTENDED=1                     only when permissions.unattended.authorised
//   PI_KIT_UNATTENDED_BOUNDARY=container    the boundary is the container, enforced by the supervisor
//   PI_KIT_UNATTENDED_CONTRACT=/run/contract.json   sanitised, read-only copy (lib/contract.ts workerContract)
//   PI_KIT_EFFORT=<tier>  PI_KIT_EFFORT_CAP=<tier>  the effort snapshot; a session may lower its effort, never exceed the cap
//
// No credential ever appears here: the worker's provider key is a placeholder the relay replaces.

export const WORKER_CONTRACT_PATH = "/run/contract.json";
export const PROXY_HOST = "egress-proxy";
export const PROXY_PORT = 3128;
export const RELAY_HOST = "inference";
export const RELAY_PORT = 8081;

/** An effort snapshot: the tier a session starts at and the cap it may never exceed. */
export interface EffortSnapshot {
  readonly tier: string;
  readonly cap: string;
}

/** The fields of the resolved contract (lib/contract.ts) the worker environment is built from. */
export interface WorkerEnvContract {
  readonly run: string;
  readonly model: { readonly worker: string; readonly provider: string };
  readonly effort: EffortSnapshot;
  readonly runtime: { readonly gitIdentity: { readonly name: string; readonly email: string }; readonly user: string };
  readonly permissions: {
    readonly unattended: { readonly authorised?: boolean | undefined };
    readonly network: { readonly services: readonly { readonly name: string }[]; readonly egress: readonly unknown[] };
  };
}

export interface WorkerEnvOptions {
  readonly branch: string;
  readonly reset?: boolean | undefined;
  /**
   * The run's snapshot from state (defaults to the contract's), so a resumed or reconfigured run
   * gives its workers exactly the recorded tier.
   */
  readonly effort?: EffortSnapshot | null | undefined;
}

/** Environment variables for a container, by name. */
export type EnvMap = Record<string, string>;

export function workerEnv(contract: WorkerEnvContract, { branch, reset = false, effort }: WorkerEnvOptions): EnvMap {
  const e = effort ?? contract.effort;
  const unattended = contract.permissions.unattended;
  const services = contract.permissions.network.services.map((s) => s.name);
  const env: EnvMap = {
    RUN_ID: contract.run,
    RUN_BRANCH: branch,
    PI_MODEL: contract.model.worker,
    PI_PROVIDER: contract.model.provider,
    CYCLE_RESET: reset ? "1" : "0",
    GIT_NAME: contract.runtime.gitIdentity.name,
    GIT_EMAIL: contract.runtime.gitIdentity.email,
    PI_KIT_EFFORT: e.tier,
    PI_KIT_EFFORT_CAP: e.cap,
  };
  if (unattended.authorised) {
    env.PI_KIT_UNATTENDED = "1";
    env.PI_KIT_UNATTENDED_BOUNDARY = "container";
    env.PI_KIT_UNATTENDED_CONTRACT = WORKER_CONTRACT_PATH;
  }
  if (contract.permissions.network.egress.length) {
    const proxy = `http://${PROXY_HOST}:${PROXY_PORT}`;
    const noProxy = [RELAY_HOST, PROXY_HOST, "localhost", "127.0.0.1", ...services].join(",");
    Object.assign(env, { AUTONOMY_EGRESS: "1", HTTPS_PROXY: proxy, HTTP_PROXY: proxy, https_proxy: proxy, http_proxy: proxy, NO_PROXY: noProxy, no_proxy: noProxy });
  }
  if (contract.runtime.user === "0:0") env.AUTONOMY_ROOTLESS = "1";
  return env;
}

/** `--env K=V` pairs for a docker run command, in a stable order. */
export const envArgs = (env: Readonly<EnvMap>): string[] => Object.entries(env).flatMap(([k, v]) => ["--env", `${k}=${v}`]);
