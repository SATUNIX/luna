// Running the `pi` CLI on behalf of the installer and the uninstaller.
//
// The strings passed to `pi install` and `pi remove` are data: a package source read from settings.json, a state
// marker under the agent directory, an environment variable or a checkout path. None of them may be able to run a
// command, so on POSIX the arguments go to the process as a vector and no shell is involved. On Windows pi is a
// `.cmd` shim that Node will only start through a shell, so an argument with a shell metacharacter is refused
// instead of being quoted and hoped for.
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

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

export interface WarmResult {
  readonly ok: boolean;
  readonly ms: number;
}

/**
 * Load every installed extension once, so pi compiles them now and not on the first `pi` start (pi
 * draws nothing while it does, which looks like a hang). RPC mode loads the extensions without a
 * model or a terminal and exits when its input ends; `get_commands` makes it finish loading first.
 * Offline, so it never waits on a network. A failure is reported, never fatal: the next start just
 * compiles for itself.
 */
export function warmPiExtensions(bin: string, { platform = process.platform, spawn = spawnSync, timeoutMs = 120_000 }: { platform?: NodeJS.Platform; spawn?: typeof spawnSync; timeoutMs?: number } = {}): WarmResult {
  const started = Date.now();
  const windows = platform === "win32";
  const command = windows && /\s/.test(bin) ? `"${bin}"` : bin;
  const r = spawn(command, ["--mode", "rpc"], {
    input: `${JSON.stringify({ type: "get_commands", id: "warm" })}\n`,
    stdio: ["pipe", "ignore", "ignore"],
    timeout: timeoutMs,
    shell: windows,
    windowsHide: true,
    env: { ...process.env, PI_OFFLINE: "1" },
  });
  return { ok: !r.error && r.status === 0, ms: Date.now() - started };
}

export interface PiSpawnPlan {
  command: string;
  args: string[];
}

export interface PiSpawnDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  nodePath?: string;
  readFile?: (file: string) => string | undefined;
}

const readText = (file: string): string | undefined => {
  try { return fs.readFileSync(file, "utf8"); } catch { return undefined; }
};

/**
 * How to start pi for a run that must pass a prompt as one argument. On POSIX that is `bin args`.
 * On Windows pi is an npm `.cmd` shim, which Node refuses to start without a shell, and a shell
 * splits a prompt at its spaces; so the shim is read and pi's own node entry is started directly,
 * with no shell. When the entry cannot be found it returns the reason instead of falling back to a
 * shell, which would split the prompt and read its metacharacters.
 */
export function piSpawnPlan(bin: string, args: readonly string[], { platform = process.platform, env = process.env, nodePath = process.execPath, readFile = readText }: PiSpawnDeps = {}): PiSpawnPlan | string {
  if (platform !== "win32") return { command: bin, args: [...args] };
  const win = path.win32;
  const candidates: string[] = [];
  if (/\.[cm]?js$/i.test(bin)) {
    return { command: nodePath, args: [bin, ...args] };
  }
  const named = /\.(?:cmd|bat)$/i.test(bin) ? [bin] : [`${bin}.cmd`];
  if (/[\\/]/.test(bin)) candidates.push(...named);
  else for (const dir of (env.PATH ?? env.Path ?? "").split(";")) if (dir) for (const n of named) candidates.push(win.join(dir, n));
  for (const shim of candidates) {
    const text = readFile(shim);
    const entry = text === undefined ? undefined : /%dp0%\\([^"\r\n]+?\.[cm]?js)"/i.exec(text)?.[1];
    if (entry) return { command: nodePath, args: [win.resolve(win.dirname(shim), entry), ...args] };
  }
  return `could not find pi's node entry (looked for ${named.join(" or ")} on PATH); pass the path to pi's cli.js as the pi binary`;
}
