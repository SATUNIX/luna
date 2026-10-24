// Where a run lives. Everything is under one directory, $PI_AUTONOMY_HOME/<run> (default
// ~/.local/state/pi-autonomy/<run>); nothing is written to ~/.pi.
import os from "node:os";
import path from "node:path";

export function stateHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.PI_AUTONOMY_HOME || path.join(env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "pi-autonomy");
}

/** Every path of a run directory, by role (see runPaths). */
export interface RunPaths {
  root: string; contract: string; state: string; log: string; lock: string; control: string;
  checks: string; overlay: string; public: string; mirror: string; steps: string; egress: string; deploy: string; meter: string; results: string;
  remote: string; work: string; agentState: string; bundles: string; gateWork: string; tmp: string; references: string;
  boundary: string; services: string; notebook: string;
}

/**
 * The run directory layout.
 *
 * Supervisor-held (the worker never mounts these writable, and most it never sees):
 *   contract.json, state.json, supervisor.lock, control/, checks.json, overlay/, public/ (mounted
 *   read-only at /run), mirror.git, steps/, egress/, deploy/, meter/, results/, supervisor.log,
 *   notebook.json (the generations notebook, lib/notebook.ts)
 * Worker side (written by containers): remote.git, work/, agent-state/
 */
export function runPaths(run: string, home: string = stateHome()): RunPaths {
  const root = path.join(home, run);
  const p = (...parts: string[]): string => path.join(root, ...parts);
  return {
    root, contract: p("contract.json"), state: p("state.json"), log: p("supervisor.log"), lock: p("supervisor.lock"), control: p("control"),
    checks: p("checks.json"), overlay: p("overlay"), public: p("public"), mirror: p("mirror.git"), steps: p("steps"), egress: p("egress"), deploy: p("deploy"), meter: p("meter"), results: p("results"),
    remote: p("remote.git"), work: p("work"), agentState: p("agent-state"), bundles: p("bundles"), gateWork: p("gate-work"), tmp: p("tmp"), references: p("references"),
    boundary: p("boundary.json"), services: p("services"), notebook: p("notebook.json"),
  };
}

/** The directories a container may bind-mount from: the run directory and the supervisor's own scripts. */
export const mountRoots = (p: Pick<RunPaths, "root">, extra: readonly string[] = []): string[] => [p.root, ...extra];
