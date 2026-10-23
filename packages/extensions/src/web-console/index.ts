import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// web-console adds `/console` (alias `/webui`): start, stop, and check the bundled
// Pi Console web UI that ships in packages/web-ui of this repo.
//
// It does exactly one thing: launch the existing zero-dependency server
// (`packages/web-ui/server/server.ts`) as a detached Node process and report the URL.
// It never proxies sessions itself, never writes Pi session files, and does not
// change any other extension's behaviour. The server binds loopback by default and requires
// a per-start access token; see packages/web-ui/README.md for the security posture.
//
// Access token hand-off: the console can drive agents with shell access, so it is not
// started without a secret. `/console start` generates 256 random bits, writes them to
// `<webUiRoot>/.runtime/console.token` (mode 0600) and tells the server where that file is
// via PI_CONSOLE_TOKEN_FILE. The token is not put on the server's command line or in its log.
// `/console` shows it in the login URL it prints (`http://host:port/#token=...`; a URL fragment
// never reaches the server or a Referer header). `/console open` also hands that URL to the
// system opener as an argument (`xdg-open`, `open`, `start`), so it is briefly visible in the
// process list, and a browser started by it can keep it in its own command line: prefer
// `/console` and paste the URL when other users share the machine. The token file is readable by
// your user, and so by the agent the console drives; the tool firewall classifies reading it as a
// credential read. `/console status` hides the token unless asked (`--show-token`). An operator
// can supply their own via PI_CONSOLE_TOKEN or PI_CONSOLE_TOKEN_FILE, or explicitly disable auth
// on loopback with PI_CONSOLE_AUTH=off.
//
// Self-containment rule: import only node:* builtins and pi peers.
// No sibling imports, no packages/core imports.

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8123;
const HEALTH_TIMEOUT_MS = 800;
const READY_POLLS = 24;
const READY_POLL_MS = 250;
const TOKEN_FILE_NAME = "console.token";
const LOG_TAIL_BYTES = 600;

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function readMarker(cwd: string = process.cwd()): { kitSource?: string } {
  // Match uninstall.ts: a project marker in the cwd wins, otherwise the global marker.
  const projectMarker = path.join(cwd, ".pi", ".pi-kit.json");
  const file = fs.existsSync(projectMarker) ? projectMarker : path.join(agentDir(), ".pi-kit.json");
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const kitSource = "kitSource" in parsed ? parsed.kitSource : undefined;
    return typeof kitSource === "string" ? { kitSource } : {};
  } catch {
    return {};
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
 * Locate `packages/web-ui`. Precedence:
 *   1. PI_KIT_WEBUI_ROOT override
 *   2. relative to this extension (<root>/packages/extensions/src/web-console -> <root>/packages/web-ui)
 *   3. the checkout recorded in the install marker (.pi-kit.json)
 * Returns null rather than guessing, so a generated npm surface (which does not
 * ship the web UI) degrades to a clear message.
 */
export function findWebUiRoot(): string | null {
  const hasServer = (dir: string) => webUiEntry(dir, "server") !== null;

  const override = process.env.PI_KIT_WEBUI_ROOT?.trim();
  if (override && hasServer(override)) return override;

  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const local = path.resolve(here, "..", "..", "..", "web-ui");
    if (hasServer(local)) return local;
  } catch {
    /* import.meta.url unavailable (non-ESM loader) - fall through */
  }

  const marker = readMarker();
  if (marker.kitSource) {
    const fromMarker = path.join(marker.kitSource, "packages", "web-ui");
    if (hasServer(fromMarker)) return fromMarker;
  }

  return null;
}

function consoleHost(): string {
  const host = process.env.PI_CONSOLE_HOST?.trim();
  return host || DEFAULT_HOST;
}

function consolePort(): number {
  const port = Number.parseInt(process.env.PI_CONSOLE_PORT ?? "", 10);
  return Number.isFinite(port) && port > 0 ? port : DEFAULT_PORT;
}

// Whether `host` is a loopback name/address (used only to decide which warning to print;
// the server enforces the real bind policy).
function isLoopbackName(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
  return bare === "localhost" || bare === "::1" || /^127\.\d+\.\d+\.\d+$/.test(bare);
}

// The host to show in URLs. A wildcard bind is reached through the first allowed host name
// the operator configured, otherwise over loopback.
function displayHost(): string {
  const host = consoleHost();
  const bare = host.replace(/^\[|\]$/g, "");
  if (bare === "0.0.0.0" || bare === "::") {
    const first = process.env.PI_CONSOLE_ALLOWED_HOSTS?.split(",")[0]?.trim();
    return first ? first.replace(/:[0-9]+$/, "") : DEFAULT_HOST;
  }
  return host;
}

function consoleUrl(): string {
  return `http://${displayHost()}:${consolePort()}`;
}

// Address the launcher connects to. A wildcard bind (0.0.0.0 / ::) is reached over loopback.
function probeHost(): string {
  const bare = consoleHost().replace(/^\[|\]$/g, "");
  if (bare === "0.0.0.0") return "127.0.0.1";
  if (bare === "::") return "::1";
  return bare;
}

function authDisabled(): boolean {
  return process.env.PI_CONSOLE_AUTH?.trim().toLowerCase() === "off";
}

function tokenFile(webUiRoot: string): string {
  return path.join(runtimeDir(webUiRoot), TOKEN_FILE_NAME);
}

function readTokenFile(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8").trim() || null;
  } catch {
    return null;
  }
}

// A token the operator supplied (PI_CONSOLE_TOKEN, or the file named by PI_CONSOLE_TOKEN_FILE).
function operatorToken(): string | null {
  const direct = process.env.PI_CONSOLE_TOKEN;
  if (direct) return direct;
  const file = process.env.PI_CONSOLE_TOKEN_FILE;
  return file ? readTokenFile(file) : null;
}

// The token a running console was most likely started with, as far as this process can tell.
function knownToken(webUiRoot: string): string | null {
  if (authDisabled()) return null;
  return operatorToken() ?? readTokenFile(tokenFile(webUiRoot));
}

// Create the token file owner-only. Remove first and use an exclusive create so a pre-planted
// file or symlink is never followed and the secret is never briefly group/world readable.
function writeTokenFile(webUiRoot: string, token: string): string {
  fs.mkdirSync(runtimeDir(webUiRoot), { recursive: true, mode: 0o700 });
  const file = tokenFile(webUiRoot);
  fs.rmSync(file, { force: true });
  fs.writeFileSync(file, `${token}\n`, { mode: 0o600, flag: "wx" });
  return file;
}

function removeTokenFile(webUiRoot: string): void {
  try {
    fs.rmSync(tokenFile(webUiRoot), { force: true });
  } catch {
    /* best effort */
  }
}

// `http://host:port/#token=...` — the fragment is consumed by the page and never sent anywhere.
function loginUrl(url: string, token: string | null): string {
  return token ? `${url}/#token=${token}` : url;
}

function runtimeDir(webUiRoot: string): string {
  return path.join(webUiRoot, ".runtime");
}

function pidFile(webUiRoot: string): string {
  return path.join(runtimeDir(webUiRoot), "server.pid");
}

function logFile(webUiRoot: string): string {
  return path.join(runtimeDir(webUiRoot), "server.log");
}

function readPid(webUiRoot: string): number | null {
  try {
    const pid = Number.parseInt(fs.readFileSync(pidFile(webUiRoot), "utf8").trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but is owned by another user.
    return (error as { code?: string }).code === "EPERM";
  }
}

// Whether `pid` is this web UI's server, from its command line. "unknown" where the
// platform has no /proc (macOS, Windows): callers then fall back to the health probe.
// Checking identity (not health) lets stop kill a hung console and never a pid the OS
// has reused for an unrelated process.
function consoleProcess(pid: number, webUiRoot: string): "console" | "other" | "unknown" {
  let raw: string;
  try {
    raw = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
  } catch {
    return "unknown";
  }
  const argv = raw.split("\0");
  return [".ts", ".js"].some((ext) => argv.includes(path.join(webUiRoot, "server", `server${ext}`))) ? "console" : "other";
}

// GET a console path and return the status code and (bounded) body, or null when unreachable.
function probe(
  pathname: string,
  timeoutMs: number,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string } | null> {
  return new Promise((resolve) => {
    const req = http.get(
      { host: probeHost(), port: consolePort(), path: pathname, timeout: timeoutMs, headers },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          if (body.length < 4096) body += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        res.on("error", () => resolve(null));
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    req.on("error", () => resolve(null));
  });
}

async function healthCheck(timeoutMs = HEALTH_TIMEOUT_MS): Promise<boolean> {
  return (await probe("/api/health", timeoutMs))?.status === 200;
}

// Whether the running console accepts `token`: true / false, or null when it cannot be told.
async function tokenAccepted(token: string): Promise<boolean | null> {
  const reply = await probe("/api/auth", HEALTH_TIMEOUT_MS, { Authorization: `Bearer ${token}` });
  if (!reply) return null;
  if (reply.status === 200) return true;
  return reply.status === 401 ? false : null;
}

// The auth mode a running console reports on its (unauthenticated) health endpoint.
async function serverAuthMode(): Promise<"token" | "off" | null> {
  const reply = await probe("/api/health", HEALTH_TIMEOUT_MS);
  if (reply?.status !== 200) return null;
  try {
    const parsed: unknown = JSON.parse(reply.body);
    const auth: unknown = typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "auth") : undefined;
    return auth === "off" ? "off" : auth === "token" ? "token" : null;
  } catch {
    return null;
  }
}

function tailLog(webUiRoot: string): string {
  try {
    const raw = fs.readFileSync(logFile(webUiRoot), "utf8");
    return raw.slice(-LOG_TAIL_BYTES).trim();
  } catch {
    return "";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface StartResult {
  /** A new child was spawned by this call. */
  started: boolean;
  /** A server was already answering / reachable. */
  alreadyRunning: boolean;
  pid: number | null;
  url: string;
  healthy: boolean;
  /** The access token for the login URL, or null when auth is off / not known to this process. */
  token: string | null;
  /** For an already-running console: does it accept `token`? null = could not tell. */
  tokenAccepted: boolean | null;
  /** The server process exited while starting (e.g. it refused an unsafe configuration). */
  exited: { code: number | null; log: string } | null;
}

async function startServer(webUiRoot: string): Promise<StartResult> {
  const url = consoleUrl();
  const existing = readPid(webUiRoot);
  // The health probe is authoritative: a live-but-unrelated process whose pid was
  // reused must not make /console start claim the console is already running. One
  // probe covers both the already-running path and the stale-pid path.
  if (await healthCheck()) {
    const token = knownToken(webUiRoot);
    const accepted = token ? await tokenAccepted(token) : null;
    return { started: false, alreadyRunning: true, pid: existing, url, healthy: true, token, tokenAccepted: accepted, exited: null };
  }
  // A console process that is alive but not answering holds the port; a second server
  // would fail to bind. Report it so the operator can /console stop it.
  if (existing && processAlive(existing) && consoleProcess(existing, webUiRoot) === "console") {
    return { started: false, alreadyRunning: true, pid: existing, url, healthy: false, token: null, tokenAccepted: null, exited: null };
  }

  fs.mkdirSync(runtimeDir(webUiRoot), { recursive: true, mode: 0o700 });

  // Decide the access token. An operator-supplied one (PI_CONSOLE_TOKEN / _FILE) is passed
  // through untouched. Otherwise generate 256 bits and hand it over as an owner-only file: not
  // on the command line, not in the environment, not in the log.
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  let token: string | null = null;
  let ownTokenFile = false;
  if (!authDisabled()) {
    token = operatorToken();
    // An operator-named token file that cannot be read is passed through unchanged, so the
    // server refuses with its own clear error instead of us quietly substituting another token.
    if (!token && !process.env.PI_CONSOLE_TOKEN_FILE) {
      token = crypto.randomBytes(32).toString("hex");
      childEnv.PI_CONSOLE_TOKEN_FILE = writeTokenFile(webUiRoot, token);
      delete childEnv.PI_CONSOLE_TOKEN;
      ownTokenFile = true;
    }
  }

  const out = fs.openSync(logFile(webUiRoot), "a");
  let child;
  try {
    child = spawn(process.execPath, [webUiEntry(webUiRoot, "server") ?? path.join(webUiRoot, "server", "server.ts")], {
      cwd: webUiRoot,
      detached: true,
      stdio: ["ignore", out, out],
      env: childEnv,
    });
    child.unref();
  } finally {
    fs.closeSync(out);
  }

  // The cast stops TypeScript narrowing this to `null`: it is assigned from the exit callback.
  let exitedWith = null as { code: number | null } | null;
  child.once("exit", (code) => {
    exitedWith = { code };
  });

  const pid = child.pid ?? null;
  if (pid) {
    try {
      fs.writeFileSync(pidFile(webUiRoot), `${pid}\n`);
    } catch {
      /* pid file is a convenience; health check is the source of truth */
    }
  }

  let healthy = false;
  for (let i = 0; i < READY_POLLS; i++) {
    if (await healthCheck(READY_POLL_MS)) {
      healthy = true;
      break;
    }
    if (exitedWith) break; // it refused to start; polling further only wastes the operator's time
    await sleep(READY_POLL_MS);
  }

  if (exitedWith) {
    if (ownTokenFile) removeTokenFile(webUiRoot);
    try {
      fs.rmSync(pidFile(webUiRoot), { force: true });
    } catch {
      /* ignore */
    }
    return {
      started: true,
      alreadyRunning: false,
      pid,
      url,
      healthy: false,
      token: null,
      tokenAccepted: null,
      exited: { code: exitedWith.code, log: tailLog(webUiRoot) },
    };
  }

  return { started: true, alreadyRunning: false, pid, url, healthy, token, tokenAccepted: null, exited: null };
}

export interface StopResult {
  stopped: boolean;
  pid: number | null;
}

async function stopServer(webUiRoot: string): Promise<StopResult> {
  const pid = readPid(webUiRoot);
  if (!pid || !processAlive(pid)) {
    // Nothing of ours is running, so a leftover token file belongs to a dead server.
    if (!(await healthCheck())) removeTokenFile(webUiRoot);
    return { stopped: false, pid };
  }
  // Only signal the pid when it is the console: a stale pid file could point at an
  // unrelated process that reused the pid. Where the command line cannot be read, a
  // console answering on the configured host/port is the best evidence available.
  const owner = consoleProcess(pid, webUiRoot);
  if (owner === "other" || (owner === "unknown" && !(await healthCheck()))) return { stopped: false, pid };
  try {
    process.kill(pid, "SIGTERM");
    try {
      fs.rmSync(pidFile(webUiRoot), { force: true });
    } catch {
      /* ignore */
    }
    removeTokenFile(webUiRoot);
    return { stopped: true, pid };
  } catch {
    return { stopped: false, pid };
  }
}

// Only a plain http(s) login URL is handed to the system opener. The host and port come from the environment and the
// token may be operator-supplied; on Windows the opener is `cmd /c start`, where a `&` or `^` in the argument would
// be a shell metacharacter, and elsewhere an argument that begins with `-` would be read as an option. The URL is always
// printed as well, so a URL that is not opened automatically costs one paste.
const OPENABLE_URL = /^https?:\/\/(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\])(?::\d{1,5})?\/(?:#token=[A-Za-z0-9_-]+)?$/;

export function openBrowser(url: string): boolean {
  if (!OPENABLE_URL.test(url)) return false;
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(opener, args, { detached: true, stdio: "ignore" });
    child.unref();
    return true;
  } catch {
    /* best effort; the URL is always printed too */
    return false;
  }
}

function notify(ctx: ExtensionCommandContext, message: string, level: "info" | "error"): void {
  if (ctx.hasUI) ctx.ui.notify(message, level);
}

const USAGE = [
  "Usage: /console [start|stop|status [--show-token]|open]",
  "  start   Launch the Pi Console web UI (default) and print its login URL.",
  "  stop    Stop the server this command started.",
  "  status  Report whether it is running and where. The access token is not shown",
  "          unless you pass --show-token.",
  "  open    Start it if needed, then open the login URL in a browser.",
].join("\n");

const ACTIONS = new Set(["start", "stop", "status", "open"]);

async function handleConsole(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const words = args.trim().split(/\s+/).filter(Boolean);
  const sub = (words[0] || "start").toLowerCase();
  const showToken = words.slice(1).some((word) => word.toLowerCase() === "--show-token");

  if (sub === "help" || sub === "-h" || sub === "--help") {
    notify(ctx, USAGE, "info");
    return;
  }
  if (!ACTIONS.has(sub)) {
    notify(ctx, `console: unknown action "${sub}"\n\n${USAGE}`, "error");
    return;
  }

  const webUiRoot = findWebUiRoot();
  if (!webUiRoot) {
    notify(
      ctx,
      [
        "console: could not locate packages/web-ui.",
        "Run this from the pi-system checkout, or set PI_KIT_WEBUI_ROOT=/path/to/packages/web-ui.",
        "Generated npm surfaces do not ship the web UI.",
      ].join(" "),
      "error",
    );
    return;
  }

  const url = consoleUrl();

  if (sub === "stop") {
    const result = await stopServer(webUiRoot);
    notify(
      ctx,
      result.stopped
        ? `console: stopped the web UI (pid ${result.pid}).`
        : "console: no server started by this command is running.",
      "info",
    );
    return;
  }

  if (sub === "status") {
    const pid = readPid(webUiRoot);
    const healthy = await healthCheck();
    const lines = [
      `console: ${healthy ? "running" : "not reachable"} at ${url}`,
      pid ? `pid ${pid}` : "no pid file (server may have been started outside /console)",
      `root ${webUiRoot}`,
    ];
    if (healthy) {
      // The token is a credential: status never prints it unless the operator asks for it.
      const mode = (await serverAuthMode()) ?? (authDisabled() ? "off" : "token");
      const token = mode === "token" ? knownToken(webUiRoot) : null;
      if (mode === "off") {
        lines.push("auth: OFF (PI_CONSOLE_AUTH=off) - loopback development only");
      } else if (showToken && token) {
        lines.push(`auth: access token required`, `login: ${loginUrl(url, token)}`, "Do not share this link.");
      } else if (token) {
        lines.push("auth: access token required (hidden). /console status --show-token prints the login link; /console open opens it.");
      } else {
        lines.push("auth: access token required; this session does not know it. Use the link printed when the console started, or /console stop then /console start.");
      }
    }
    notify(ctx, lines.join("\n"), "info");
    return;
  }

  // start | open
  if (ctx.hasUI) ctx.ui.setStatus("console", "starting web UI...");
  let result: StartResult;
  try {
    result = await startServer(webUiRoot);
  } catch (error) {
    if (ctx.hasUI) ctx.ui.setStatus("console", undefined);
    notify(ctx, `console: failed to start the web UI: ${error instanceof Error ? error.message : String(error)}`, "error");
    return;
  }
  if (ctx.hasUI) ctx.ui.setStatus("console", undefined);

  // What to show and open. A token this process does not know (a console started elsewhere) or
  // that the running console rejects cannot be turned into a working link.
  const usable = result.token !== null && result.tokenAccepted !== false ? result.token : null;
  const link = loginUrl(result.url, usable);
  // Open only a page that can actually be used: never pass a stale or unknown token to the browser.
  let notOpened = false;
  if (sub === "open" && result.healthy && !result.exited) notOpened = !openBrowser(link);

  const lines: string[] = [];
  if (result.exited) {
    lines.push(
      `console: the web UI server exited while starting (code ${result.exited.code ?? "?"}).`,
      result.exited.log ? `Log tail:\n${result.exited.log}` : `Check the log: ${logFile(webUiRoot)}`,
    );
    notify(ctx, lines.join("\n"), "error");
    return;
  }
  if (result.alreadyRunning && !result.healthy) {
    lines.push(
      `console: a web UI server (pid ${result.pid ?? "?"}) is running but ${result.url}/api/health does not respond.`,
    );
    lines.push(`Run /console stop, then /console start. Log: ${logFile(webUiRoot)}`);
  } else if (result.alreadyRunning) {
    lines.push(`console: web UI already running at ${link}`);
  } else if (result.healthy) {
    lines.push(`console: web UI started at ${link}`);
    if (result.pid) lines.push(`pid ${result.pid} · logs ${logFile(webUiRoot)}`);
  } else {
    lines.push(
      `console: server process launched (pid ${result.pid ?? "?"}) but ${result.url}/api/health did not respond yet.`,
    );
    lines.push(`Check the log: ${logFile(webUiRoot)}`);
  }

  if (notOpened) lines.push("The browser was not opened automatically (the URL has characters a system opener is not trusted with); paste the URL above.");
  if (authDisabled()) {
    lines.push("AUTHENTICATION IS OFF (PI_CONSOLE_AUTH=off): loopback development only; anything that can reach the port can run shell commands as you.");
  } else if (result.alreadyRunning && result.healthy && result.token && result.tokenAccepted === false) {
    lines.push("The running console rejects the token this session holds (it was started with a different one). Run /console stop, then /console start.");
  } else if (result.alreadyRunning && result.healthy && !result.token) {
    lines.push("Access token required, and this session does not know it. Use the link printed when the console started, or /console stop then /console start.");
  } else {
    lines.push("Access token required: the link above carries it. Do not share it or paste it into a shared log.");
  }
  if (!isLoopbackName(consoleHost())) {
    lines.push("Non-loopback bind: plain HTTP sends the token in clear text unless TLS is terminated in front (SSH tunnel or TLS proxy).");
  }
  notify(ctx, lines.join("\n"), "info");
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("console", {
    description: "Start/stop the bundled Pi Console web UI. Usage: /console [start|stop|status|open].",
    handler: handleConsole,
  });
  pi.registerCommand("webui", {
    description: "Alias for /console - start/stop the bundled Pi Console web UI.",
    handler: handleConsole,
  });
}