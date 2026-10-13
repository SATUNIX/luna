// host.ts — find, start, stop and talk to the pi remote host (packages/web-ui/server/remote-host.js).
//
// The host is a separate detached Node process so that it outlives any one pi session and serves
// every terminal that attaches. This module only ever talks to it over its loopback control
// channel, authenticated by the secret in control.json (owner-only, written by the host).
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HELLO_TIMEOUT_MS = 3_000;
const REQUEST_TIMEOUT_MS = 10_000;
const READY_POLLS = 48;
const READY_POLL_MS = 250;
const LOG_ROTATE_BYTES = 1024 * 1024;
const LOG_TAIL_BYTES = 800;

export type Json = Record<string, any>;

export function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

/** Must match stateDir() in packages/web-ui/server/remote/store.js. */
export function stateDir(): string {
  return process.env.PI_REMOTE_STATE_DIR || path.join(agentDir(), "remote-control");
}

export function statePath(name: "control.json" | "host.log" | "tls-key.pem" | "tls-cert.pem" | "devices.json" | "identity.json"): string {
  return path.join(stateDir(), name);
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function readJson(file: string): Json | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Locate `packages/web-ui` (the host ships there, beside pi-console). Same precedence as
 * web-console: PI_KIT_WEBUI_ROOT, then relative to this extension, then the checkout named in the
 * install marker. Returns null rather than guessing.
 */
export function findWebUiRoot(): string | null {
  const hasHost = (dir: string) => isFile(path.join(dir, "server", "remote-host.js"));
  const override = process.env.PI_KIT_WEBUI_ROOT?.trim();
  if (override && hasHost(override)) return override;
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const local = path.resolve(here, "..", "..", "..", "web-ui");
    if (hasHost(local)) return local;
  } catch {
    /* import.meta.url unavailable: fall through */
  }
  const projectMarker = path.join(process.cwd(), ".pi", ".pi-kit.json");
  const marker = readJson(fs.existsSync(projectMarker) ? projectMarker : path.join(agentDir(), ".pi-kit.json"));
  if (marker && typeof marker.kitSource === "string") {
    const fromMarker = path.join(marker.kitSource, "packages", "web-ui");
    if (hasHost(fromMarker)) return fromMarker;
  }
  return null;
}

export class HostError extends Error {
  constructor(
    message: string,
    readonly code: "not_running" | "refused" | "timeout" | "closed" | "start_failed" = "refused",
    readonly status?: number,
  ) {
    super(message);
  }
}

/** A connection to the host's control channel: newline-delimited JSON, split on LF only. */
export class ControlLink {
  private buffer = "";
  private nextId = 1;
  private pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  closed = false;
  onMessage: (msg: Json) => void = () => {};
  onClose: () => void = () => {};

  private constructor(private socket: net.Socket) {}

  /** Connect and authenticate. Throws HostError("not_running") when no host answers. */
  static open(role: "admin" | "bridge", timeoutMs = HELLO_TIMEOUT_MS): Promise<ControlLink> {
    const control = readJson(statePath("control.json"));
    if (!control || !Number.isInteger(control.port) || typeof control.secret !== "string") {
      return Promise.reject(new HostError("the remote host is not running", "not_running"));
    }
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: "127.0.0.1", port: control.port });
      const link = new ControlLink(socket);
      let greeted = false;
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new HostError("the remote host did not answer", "timeout"));
      }, timeoutMs);
      socket.setNoDelay(true);
      socket.setEncoding("utf8");
      socket.on("connect", () => {
        socket.write(`${JSON.stringify({ t: "hello", secret: control.secret, role, pid: process.pid })}\n`);
      });
      socket.on("data", (chunk: string) => {
        link.buffer += chunk;
        let nl;
        while ((nl = link.buffer.indexOf("\n")) !== -1) {
          const line = link.buffer.slice(0, nl).replace(/\r$/, "");
          link.buffer = link.buffer.slice(nl + 1);
          if (!line.trim()) continue;
          let msg: Json;
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }
          if (!greeted) {
            clearTimeout(timer);
            if (msg.t === "hello" && msg.ok === true) {
              greeted = true;
              resolve(link);
            } else {
              socket.destroy();
              reject(new HostError("the remote host refused this connection", "refused"));
            }
            continue;
          }
          link.dispatch(msg);
        }
      });
      socket.on("error", (error: NodeJS.ErrnoException) => {
        if (!greeted) {
          clearTimeout(timer);
          reject(new HostError(error.code === "ECONNREFUSED" ? "the remote host is not running" : `control channel: ${error.message}`, error.code === "ECONNREFUSED" ? "not_running" : "refused"));
        }
      });
      socket.on("close", () => {
        link.closed = true;
        for (const entry of link.pending.values()) {
          clearTimeout(entry.timer);
          entry.reject(new HostError("the remote host closed the connection", "closed"));
        }
        link.pending.clear();
        if (greeted) link.onClose();
      });
    });
  }

  private dispatch(msg: Json): void {
    if (msg.t === "res" && typeof msg.id === "string" && this.pending.has(msg.id)) {
      const entry = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.ok) entry.resolve(msg.data);
      else entry.reject(new HostError(String(msg.error || "the remote host refused the request"), "refused", msg.status));
      return;
    }
    try {
      this.onMessage(msg);
    } catch {
      /* a handler error must not break the channel */
    }
  }

  send(obj: Json): boolean {
    if (this.closed) return false;
    try {
      return this.socket.write(`${JSON.stringify(obj)}\n`);
    } catch {
      return false;
    }
  }

  /** An admin request; resolves with the reply's data. */
  request<T = Json>(op: string, args: Json = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    if (this.closed) return Promise.reject(new HostError("the control connection is closed", "closed"));
    const id = `r${this.nextId++}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HostError(`the remote host did not answer (${op})`, "timeout"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ t: "req", id, op, ...args });
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.destroy();
  }
}

/** One admin round trip: open, ask, close. */
export async function adminRequest<T = Json>(op: string, args: Json = {}): Promise<T> {
  const link = await ControlLink.open("admin");
  try {
    return await link.request<T>(op, args);
  } finally {
    link.close();
  }
}

export async function hostStatus(): Promise<Json | null> {
  try {
    return await adminRequest("status");
  } catch (error) {
    if (error instanceof HostError && (error.code === "not_running" || error.code === "timeout")) return null;
    throw error;
  }
}

function tailLog(): string {
  try {
    const file = statePath("host.log");
    const fd = fs.openSync(file, "r");
    try {
      // fstat the open descriptor, not the path, so there is no stat/open race (CodeQL js/file-system-race).
      const size = fs.fstatSync(fd).size;
      const length = Math.min(size, LOG_TAIL_BYTES);
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, size - length);
      return buf.toString("utf8").trim();
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface EnsureResult {
  started: boolean;
  status: Json;
}

/** Return the running host's status, starting the host first when none answers. */
export async function ensureHost(): Promise<EnsureResult> {
  const running = await hostStatus();
  if (running) return { started: false, status: running };

  const root = findWebUiRoot();
  if (!root) {
    throw new HostError(
      "could not locate packages/web-ui (the remote host ships there). Run pi from the pi-system checkout, or set PI_KIT_WEBUI_ROOT=/path/to/packages/web-ui.",
      "start_failed",
    );
  }
  const dir = stateDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    /* best effort; the host tightens it too */
  }
  const logFile = statePath("host.log");
  try {
    if (fs.statSync(logFile).size > LOG_ROTATE_BYTES) fs.renameSync(logFile, `${logFile}.1`);
  } catch {
    /* no log yet */
  }
  const out = fs.openSync(logFile, "a", 0o600);
  let exited: { code: number | null } | null = null;
  try {
    const child = spawn(process.execPath, [path.join(root, "server", "remote-host.js")], {
      cwd: root,
      detached: true,
      stdio: ["ignore", out, out],
      env: process.env,
    });
    child.once("exit", (code) => {
      exited = { code };
    });
    child.unref();
  } finally {
    fs.closeSync(out);
  }

  for (let i = 0; i < READY_POLLS; i++) {
    await sleep(READY_POLL_MS);
    const status = await hostStatus().catch(() => null);
    if (status) return { started: true, status };
    // Exit code 3 means another host won a start race; keep polling for it.
    const ended = exited as { code: number | null } | null;
    if (ended && ended.code !== 3) {
      const tail = tailLog();
      throw new HostError(`the remote host exited (code ${ended.code})${tail ? `:\n${tail}` : ""}`, "start_failed");
    }
  }
  const tail = tailLog();
  throw new HostError(`the remote host did not become ready${tail ? `:\n${tail}` : ""}`, "start_failed");
}

/** Ask the host to stop; resolves false when none was running. */
export async function stopHost(): Promise<boolean> {
  try {
    await adminRequest("shutdown");
  } catch (error) {
    if (error instanceof HostError && error.code === "not_running") return false;
    throw error;
  }
  for (let i = 0; i < 40; i++) {
    if (!fs.existsSync(statePath("control.json"))) return true;
    await sleep(100);
  }
  return true;
}

/**
 * Forget the host's identity: its TLS key and certificate (which phones pin), its server id and
 * every linked device. The audit log is kept. The host must be stopped first.
 */
export function resetIdentity(): string[] {
  const removed: string[] = [];
  for (const name of ["tls-key.pem", "tls-cert.pem", "identity.json", "devices.json"] as const) {
    const file = statePath(name);
    if (fs.existsSync(file)) {
      fs.rmSync(file, { force: true });
      removed.push(name);
    }
  }
  return removed;
}
