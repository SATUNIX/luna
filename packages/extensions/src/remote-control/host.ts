// host.ts — find, start, stop and talk to the pi remote host (packages/web-ui/server/remote-host.ts).
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
import { trustedMarkerKitRoot } from "./shared/kit-source.ts";
import { nodeRuntime } from "./shared/node-runtime.ts";

const HELLO_TIMEOUT_MS = 3_000;
const REQUEST_TIMEOUT_MS = 10_000;
const READY_POLLS = 48;
const READY_POLL_MS = 250;
const LOG_ROTATE_BYTES = 1024 * 1024;
const LOG_TAIL_BYTES = 800;

/** A JSON object from the host (or about to go to it). Its fields are unchecked until read. */
export type Json = Record<string, unknown>;

/** A host field as a template literal shows it (the host sends strings; anything else shows as it always has). */
export function show(value: unknown): string {
  return String(value);
}

/** Whether a parsed value is a JSON object (not null, not an array). */
export function isJson(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

/** Must match stateDir() in packages/web-ui/server/remote/store.ts. */
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
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return isJson(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The web UI's `server/<stem>` entry point: `.ts` in a checkout or git-delivered install, `.js` in
 * the compiled npm artefact (internal/docs/adr/0001). Null when neither exists.
 */
function webUiEntry(webUiRoot: string, stem: string): string | null {
  for (const ext of [".ts", ".js"]) {
    const file = path.join(webUiRoot, "server", `${stem}${ext}`);
    if (isFile(file)) return file;
  }
  return null;
}

/**
 * Locate `packages/web-ui` (the host ships there, beside pi-console). Same precedence as
 * web-console: PI_KIT_WEBUI_ROOT, then relative to this extension, then the checkout named in the
 * install marker, only when trustedMarkerKitRoot (./shared/kit-source.ts) accepts it: absolute,
 * outside the workspace of `cwd` through any links, and the kit by package name. A project marker
 * is repository content, so any other kitSource is ignored and reported through `warn`. Returns
 * null rather than guessing.
 */
export function findWebUiRoot(cwd: string = process.cwd(), warn?: (message: string) => void): string | null {
  const hasHost = (dir: string) => webUiEntry(dir, "remote-host") !== null;
  const override = process.env.PI_KIT_WEBUI_ROOT?.trim();
  if (override && hasHost(override)) return override;
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const local = path.resolve(here, "..", "..", "..", "web-ui");
    if (hasHost(local)) return local;
  } catch {
    /* import.meta.url unavailable: fall through */
  }
  const projectMarker = path.join(cwd, ".pi", ".pi-kit.json");
  const marker = readJson(fs.existsSync(projectMarker) ? projectMarker : path.join(agentDir(), ".pi-kit.json"));
  if (marker && typeof marker.kitSource === "string") {
    const trusted = trustedMarkerKitRoot(marker.kitSource, cwd, (dir) => hasHost(path.join(dir, "packages", "web-ui")));
    if (trusted && "root" in trusted) return path.join(trusted.root, "packages", "web-ui");
    if (trusted) warn?.(`ignored ${trusted.ignored}; an install marker never chooses the host that runs.`);
  }
  return null;
}

export class HostError extends Error {
  readonly code: "not_running" | "refused" | "timeout" | "closed" | "start_failed";
  readonly status: number | undefined;
  constructor(message: string, code: HostError["code"] = "refused", status?: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** A connection to the host's control channel: newline-delimited JSON, split on LF only. */
export class ControlLink {
  private buffer = "";
  private nextId = 1;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  closed = false;
  onMessage: (msg: Json) => void = () => {};
  onClose: () => void = () => {};

  private readonly socket: net.Socket;

  private constructor(socket: net.Socket) {
    this.socket = socket;
  }

  /** Connect and authenticate. Throws HostError("not_running") when no host answers. */
  static open(role: "admin" | "bridge", timeoutMs = HELLO_TIMEOUT_MS): Promise<ControlLink> {
    const control = readJson(statePath("control.json"));
    const port = control?.port;
    const secret = control?.secret;
    if (typeof port !== "number" || !Number.isInteger(port) || typeof secret !== "string") {
      return Promise.reject(new HostError("the remote host is not running", "not_running"));
    }
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: "127.0.0.1", port });
      const link = new ControlLink(socket);
      let greeted = false;
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new HostError("the remote host did not answer", "timeout"));
      }, timeoutMs);
      socket.setNoDelay(true);
      socket.setEncoding("utf8");
      socket.on("connect", () => {
        socket.write(`${JSON.stringify({ t: "hello", secret, role, pid: process.pid })}\n`);
      });
      socket.on("data", (chunk: string) => {
        link.buffer += chunk;
        let nl;
        while ((nl = link.buffer.indexOf("\n")) !== -1) {
          const line = link.buffer.slice(0, nl).replace(/\r$/, "");
          link.buffer = link.buffer.slice(nl + 1);
          if (!line.trim()) continue;
          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch {
            continue;
          }
          // A record that is not an object (`null`, a number) has no fields. Reading one as if it had
          // threw here, inside the socket's data listener, where nothing catches it and pi exits.
          const msg: Json = isJson(parsed) ? parsed : {};
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
    const entry = msg.t === "res" && typeof msg.id === "string" ? this.pending.get(msg.id) : undefined;
    if (entry && typeof msg.id === "string") {
      this.pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.ok) entry.resolve(msg.data);
      else entry.reject(new HostError(show(msg.error || "the remote host refused the request"), "refused", typeof msg.status === "number" ? msg.status : undefined));
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

  /** An admin request; resolves with the reply's data, unchecked. */
  request(op: string, args: Json = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
    if (this.closed) return Promise.reject(new HostError("the control connection is closed", "closed"));
    const id = `r${this.nextId++}`;
    return new Promise<unknown>((resolve, reject) => {
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
export async function adminRequest(op: string, args: Json = {}): Promise<unknown> {
  const link = await ControlLink.open("admin");
  try {
    return await link.request(op, args);
  } finally {
    link.close();
  }
}

export async function hostStatus(): Promise<Json | null> {
  let data: unknown;
  try {
    data = await adminRequest("status");
  } catch (error) {
    if (error instanceof HostError && (error.code === "not_running" || error.code === "timeout")) return null;
    throw error;
  }
  // No data reads as no host, as it always has; data that is not an object is a host fault, not a status.
  if (!data) return null;
  if (!isJson(data)) throw new HostError("the remote host sent a malformed status", "refused");
  return data;
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

  const ignored: string[] = [];
  const root = findWebUiRoot(process.cwd(), (message) => ignored.push(message));
  if (!root) {
    throw new HostError(
      `could not locate packages/web-ui (the remote host ships there). Run pi from the pi-system checkout, or set PI_KIT_WEBUI_ROOT=/path/to/packages/web-ui.${ignored.map((m) => ` (${m})`).join("")}`,
      "start_failed",
    );
  }
  // The host is a Node script. Under a compiled pi, process.execPath is pi itself, and
  // `pi remote-host.ts` would run an agent turn with the path as its prompt (./shared/node-runtime.ts).
  const runtime = nodeRuntime();
  if (!runtime.ok) throw new HostError(`the remote host needs Node.js to run: ${runtime.reason}.`, "start_failed");
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
  let exited: { code: number | null; error?: string } | null = null;
  try {
    const child = spawn(runtime.command, [webUiEntry(root, "remote-host") ?? path.join(root, "server", "remote-host.ts")], {
      cwd: root,
      detached: true,
      stdio: ["ignore", out, out],
      env: process.env,
      windowsHide: true,
    });
    child.once("exit", (code) => {
      exited = { code };
    });
    // A runtime that cannot be started emits "error" (and "close"), never "exit".
    child.once("error", (error) => {
      exited = { code: null, error: `${runtime.command}: ${error.message}` };
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
    const ended = exited as { code: number | null; error?: string } | null;
    if (ended?.error) throw new HostError(`the remote host could not be started: ${ended.error}`, "start_failed");
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
