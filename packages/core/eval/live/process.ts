// Bound the host CLI too: a failed container stop must not leave the case promise pending.
import { spawn, spawnSync, type SpawnSyncReturns, type StdioOptions } from "node:child_process";

export interface BoundedProcessOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly stdio: StdioOptions;
  readonly timeoutMs: number;
  /** Stops the work behind the process (e.g. removes its container) before it is killed. */
  readonly stop: () => void;
}

export interface BoundedProcessResult {
  /** The exit code, or null when a signal ended the process. */
  exitCode: number | null;
  timedOut: boolean;
}

export async function runBoundedProcess({ command, args, stdio, timeoutMs, stop }: BoundedProcessOptions): Promise<BoundedProcessResult> {
  const child = spawn(command, args, { stdio });
  let timedOut = false;
  const completed = new Promise<number | null>((resolve, reject) => { child.once("exit", (code) => { resolve(code); }); child.once("error", reject); });
  const timer = setTimeout(() => {
    timedOut = true;
    try { stop(); }
    catch { /* The owning runner retains exact container names for cleanup. */ }
    finally { child.kill("SIGKILL"); }
  }, timeoutMs);
  try { return { exitCode: await completed, timedOut }; }
  finally { clearTimeout(timer); }
}

export interface NamedValidationOptions {
  /** The exact container name, removed afterwards whatever happened. */
  readonly name: string;
  readonly args: readonly string[];
  readonly timeoutMs?: number;
}

export function runNamedValidation({ name, args, timeoutMs = 30_000 }: NamedValidationOptions): SpawnSyncReturns<string> {
  try {
    return spawnSync("docker", ["run", "--rm", "--name", name, ...args], { encoding: "utf8", timeout: timeoutMs });
  } finally {
    spawnSync("docker", ["rm", "-f", name], { timeout: 10_000, stdio: "ignore" });
  }
}
