// Running the `pi` CLI on behalf of the installer and the uninstaller.
//
// The strings passed to `pi install` and `pi remove` are data: a package source read from settings.json, a state
// marker under the agent directory, an environment variable or a checkout path. None of them may be able to run a
// command, so on POSIX the arguments go to the process as a vector and no shell is involved. On Windows pi is a
// `.cmd` shim that Node will only start through a shell, so an argument with a shell metacharacter is refused
// instead of being quoted and hoped for.
import { spawnSync, type SpawnSyncReturns } from "node:child_process";

const CONTROL = /[\0\r\n]/;
const WINDOWS_UNSAFE = /["&|<>^%!`]/;

/** The command as shown to the operator (display only; never executed). */
export const displayCommand = (args: readonly string[]): string => `pi ${args.map((a) => (/^[\w@:/.+=~-]+$/.test(a) ? a : JSON.stringify(a))).join(" ")}`;

/** pi started but exited non-zero (or was killed): its status and captured stderr, as `execSync` reported them. */
export class PiExitError extends Error {
  readonly status: number | null;
  readonly stderr: string | Buffer | null;
  constructor(message: string, status: number | null, stderr: string | Buffer | null) {
    super(message);
    this.status = status;
    this.stderr = stderr;
  }
}

export interface RunPiOptions {
  stdio?: "inherit" | "pipe";
  platform?: NodeJS.Platform;
  /** Injected for tests; defaults to `spawnSync`. */
  spawn?: typeof spawnSync;
  /** Variables added to the inherited environment for this child (for example npm_config_ignore_scripts). */
  env?: Readonly<Record<string, string>>;
}

/**
 * Run `bin args...` and throw when it fails to start or exits non-zero, as `execSync` did.
 * `bin` is the pi executable (a path, or "pi" to look it up on PATH).
 */
export function runPi(bin: string, args: readonly string[], { stdio = "inherit", platform = process.platform, spawn = spawnSync, env }: RunPiOptions = {}): SpawnSyncReturns<string | Buffer> {
  // Checked as unknown: callers pass strings read from files, and a non-string must never reach the process.
  const values: readonly unknown[] = args;
  for (const a of values) {
    if (typeof a !== "string") throw new Error("refusing to pass a non-string argument to pi");
    if (CONTROL.test(a)) throw new Error(`refusing to pass an argument with a control character to pi: ${JSON.stringify(a.slice(0, 80))}`);
  }
  const windows = platform === "win32";
  if (windows) for (const a of args) if (WINDOWS_UNSAFE.test(a)) throw new Error(`refusing to pass ${JSON.stringify(a.slice(0, 80))} to pi on Windows: it contains a shell metacharacter`);
  const command = windows && /\s/.test(bin) ? `"${bin}"` : bin;
  const r = spawn(command, args, { stdio, shell: windows, windowsHide: true, ...(env ? { env: { ...process.env, ...env } } : {}) });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new PiExitError(`pi ${args[0] ?? ""} exited with ${r.status ?? r.signal}`.trim(), r.status, r.stderr);
  }
  return r;
}
