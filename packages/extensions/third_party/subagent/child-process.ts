/**
 * Subagent — child process lifecycle.
 *
 * Spawns one `pi` child, streams its JSONL stdout and stderr to callbacks, and enforces the
 * budgets that keep a run bounded: a per-stream byte cap, an idle (no-output) watchdog, and a
 * wall-clock ceiling that a chatty child cannot defeat. It reports *why* it terminated via a
 * `KillReason` so the caller can never confuse an internal limit with a genuine abort.
 *
 * It also emits a periodic heartbeat (elapsed / idle / bytes / turn count) so the parent can
 * show a live "still working" signal instead of a frozen tool call.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { KillReason, SpawnChild } from "./types.ts";

// Runtimes that execute a JS entry file passed as their first argument. Everything else
// (in particular a bun-compiled standalone `pi` binary) already IS the pi executable.
const JS_RUNTIMES = new Set(["node", "nodejs", "bun", "deno"]);

/**
 * Build the argv for spawning a pi child process.
 *
 * When pi runs from source under a JS runtime, `process.execPath` is that runtime and the CLI
 * script must be passed as argv[0]. When pi runs as a compiled standalone binary,
 * `process.execPath` is the pi executable itself, so prepending the CLI script would make pi
 * parse that path as a positional prompt — the child's first user message became the resolved
 * cli.js path (WU-15), leaving it with no instructions. Only a known JS runtime gets the script.
 */
export function piChildArgv(cli: string, args: string[], execPath: string = process.execPath): string[] {
  // Split on both separators so a Windows path is recognized regardless of platform.
  const runtime = execPath.replace(/\\/g, "/").split("/").pop()?.toLowerCase().replace(/\.(?:exe|cmd|bat)$/, "") ?? "";
  return JS_RUNTIMES.has(runtime) ? [cli, ...args] : [...args];
}

export interface ChildHeartbeat {
  elapsedMs: number;
  idleMs: number;
  stdoutBytes: number;
  stderrBytes: number;
}

export interface ChildRunOptions {
  args: string[];
  // Written to the child's stdin and then closed. pi's print mode merges piped stdin into the
  // initial prompt, so the task travels here instead of as one argv string: a single argument
  // is capped at 128 KiB on Linux (MAX_ARG_STRLEN), which a chain's {previous} output exceeds.
  stdin?: string | undefined;
  cwd: string;
  env: Record<string, string | undefined>;
  signal?: AbortSignal | undefined;
  streamCap: number;
  idleTimeoutMs: number;
  // Hard ceiling on total run time. A child that keeps emitting bytes resets the idle
  // watchdog, so this is the only bound that a drip-feeding child cannot escape. 0 disables.
  maxRuntimeMs: number;
  // Liveness tick cadence. 0 disables.
  heartbeatMs: number;
  spawnChild?: SpawnChild | undefined;
  onSpawn?: (handle: { pid?: number | undefined; terminate: () => void }) => void;
  onLine: (line: string) => void;
  onStderr: (text: string) => void;
  onKill: (reason: KillReason) => void;
  onHeartbeat?: (info: ChildHeartbeat) => void;
}

export interface ChildOutcome {
  exitCode: number;
  killReason?: KillReason | undefined;
  spawnFailure?: string | undefined;
}

export async function runChildProcess(options: ChildRunOptions): Promise<ChildOutcome> {
  const { args, stdin, cwd, env, signal, streamCap, idleTimeoutMs, maxRuntimeMs, heartbeatMs, onLine, onStderr, onKill, onSpawn, onHeartbeat } = options;
  const spawnChild = options.spawnChild ?? spawn;

  let killReason: KillReason | undefined;
  let spawnFailure: string | undefined;

  const exitCode = await new Promise<number>((resolve) => {
    const cli = fileURLToPath(new URL("./cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
    const proc = spawnChild(process.execPath, piChildArgv(cli, args), {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      env,
    });
    if (stdin !== undefined && proc.stdin) {
      // A child that exits before reading its prompt raises EPIPE on the pipe; that is reported
      // through the normal exit path, never as an uncaught exception.
      proc.stdin.on("error", () => {});
      proc.stdin.end(stdin);
    }
    // Decode as a stream so a multi-byte UTF-8 character split across two chunks is not
    // turned into U+FFFD replacement characters (per-chunk Buffer#toString did exactly that).
    // stdout/stderr are always "pipe" above; the non-null view keeps that explicit for TS now
    // that stdin's mode varies.
    const stdout = proc.stdout as NonNullable<typeof proc.stdout>;
    const stderr = proc.stderr as NonNullable<typeof proc.stderr>;
    stdout.setEncoding?.("utf8");
    stderr.setEncoding?.("utf8");

    let buffer = "";
    // Counted separately so a chatty stderr (npm warnings, deprecation notices) can't burn
    // through the budget meant for the real stdout JSONL protocol stream, and vice versa.
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let exited = false;
    const startedAt = Date.now();
    let lastActivityAt = startedAt;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let wallTimer: ReturnType<typeof setTimeout> | undefined;
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

    const clearIdle = () => {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = undefined;
      }
    };
    const kill = (reason: KillReason) => {
      if (exited || killReason) return;
      killReason = reason;
      clearIdle();
      onKill(reason);
      proc.kill("SIGTERM");
      escalation = setTimeout(() => {
        if (!exited) proc.kill("SIGKILL");
      }, 5000);
      escalation.unref();
    };
    const armIdle = () => {
      if (idleTimeoutMs <= 0 || exited) return;
      clearIdle();
      idleTimer = setTimeout(() => kill("timeout"), idleTimeoutMs);
      idleTimer.unref();
    };
    const onSignalAbort = () => kill("signal");
    onSpawn?.({ pid: proc.pid ?? undefined, terminate: () => kill("stopped") });
    const cleanup = () => {
      exited = true;
      clearIdle();
      if (escalation) clearTimeout(escalation);
      if (wallTimer) clearTimeout(wallTimer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      signal?.removeEventListener("abort", onSignalAbort);
    };

    // A consumer-thrown exception inside the data handler would otherwise escape as an
    // uncaught exception and can break the stream reader; contain it per line.
    const emitLine = (line: string) => {
      try {
        onLine(line);
      } catch {
        /* a listener error must not tear down the child reader */
      }
    };

    stdout.on("data", (data: Buffer | string) => {
      lastActivityAt = Date.now();
      armIdle();
      stdoutBytes += typeof data === "string" ? Buffer.byteLength(data, "utf8") : data.length;
      if (stdoutBytes > streamCap) {
        kill("stream-cap");
        return;
      }
      buffer += typeof data === "string" ? data : data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) emitLine(line);
    });
    stderr.on("data", (data: Buffer | string) => {
      lastActivityAt = Date.now();
      armIdle();
      stderrBytes += typeof data === "string" ? Buffer.byteLength(data, "utf8") : data.length;
      if (stderrBytes > streamCap) {
        kill("stream-cap");
        return;
      }
      onStderr(data.toString());
    });
    proc.on("close", (code) => {
      cleanup();
      if (buffer.trim()) emitLine(buffer);
      resolve(code ?? 1);
    });
    proc.on("error", (error) => {
      spawnFailure = String(error?.message || error);
      cleanup();
      resolve(1);
    });

    if (signal) {
      if (signal.aborted) kill("signal");
      else signal.addEventListener("abort", onSignalAbort, { once: true });
    }
    armIdle();

    // Wall-clock backstop: independent of stdout/stderr activity.
    if (maxRuntimeMs > 0) {
      wallTimer = setTimeout(() => kill("wall-clock"), maxRuntimeMs);
      wallTimer.unref();
    }
    // Heartbeat: report liveness even while the child is silent (e.g. a long tool call).
    if (heartbeatMs > 0 && onHeartbeat) {
      heartbeatTimer = setInterval(() => {
        if (exited) return;
        onHeartbeat({
          elapsedMs: Date.now() - startedAt,
          idleMs: Date.now() - lastActivityAt,
          stdoutBytes,
          stderrBytes,
        });
      }, heartbeatMs);
      heartbeatTimer.unref?.();
    }
  });

  return { exitCode, killReason, spawnFailure };
}