#!/usr/bin/env node
// Offline web-console extension smoke: resolves packages/web-ui, starts the
// zero-dependency server on an isolated loopback port, and exercises
// /console start|status|stop. No model, no network beyond loopback.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { loadExtension, fakePi, setEnv, tmpWorkspace, rmWorkspace } from "../packages/core/eval/harness.ts";

interface Notification {
  message: string;
  level: string;
}

interface ApiStatus {
  status: number | undefined;
}

const wait = (ms = 50): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms));

function alive(pid: number | undefined): boolean {
  if (pid === undefined) return false; // process.kill(undefined) throws, i.e. not alive
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// A long-lived process whose only purpose is to occupy a pid. It never binds the
// console port, so a stale pid file pointing at it must not be mistaken for the server.
function spawnInert(): ChildProcess {
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
}

function health(port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/api/health", timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
  });
}

// Status code of a console API request, optionally with a bearer token.
function apiStatus(port: number, pathname: string, token?: string): Promise<ApiStatus> {
  return new Promise<ApiStatus>((resolve, reject) => {
    const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
    http
      .get({ host: "127.0.0.1", port, path: pathname, headers, timeout: 2000 }, (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode }));
      })
      .on("error", reject);
  });
}

async function waitHealthy(port: number): Promise<boolean> {
  for (let i = 0; i < 60; i++) {
    if (await health(port)) return true;
    await wait(100);
  }
  return false;
}

async function run(): Promise<void> {
  const ws = tmpWorkspace("pi-kit-web-console-");
  const webUiRoot = path.resolve("packages", "web-ui");
  const port = 18000 + Math.floor(Math.random() * 2000);
  const restore = [
    setEnv("PI_KIT_WEBUI_ROOT", webUiRoot),
    setEnv("PI_CONSOLE_PORT", String(port)),
    setEnv("PI_CONSOLE_HOST", "127.0.0.1"),
    // No install marker, so findWebUiRoot cannot fall back to a real checkout.
    setEnv("PI_CODING_AGENT_DIR", ws),
  ];

  const notifications: Notification[] = [];
  const lastNotification = (): Notification => {
    const last = notifications.at(-1);
    assert.ok(last, "expected a notification");
    return last;
  };
  const ctx = { hasUI: true, ui: { notify: (message: string, level: string) => notifications.push({ message, level }), setStatus: () => {} } };
  const inert: ChildProcess[] = [];
  let stopped = false;
  const pidPath = path.join(webUiRoot, ".runtime", "server.pid");
  const writePid = (pid: number | undefined): void => {
    fs.mkdirSync(path.dirname(pidPath), { recursive: true });
    fs.writeFileSync(pidPath, `${pid}\n`);
  };

  try {
    const register = await loadExtension("extensions/web-console/index.ts");
    const pi = fakePi();
    register(pi.api);

    const consoleCmd = pi.commands.get("console");
    const webuiCmd = pi.commands.get("webui");
    assert.ok(consoleCmd, "/console must be registered");
    assert.ok(webuiCmd, "/webui alias must be registered");

    // Not running yet.
    await consoleCmd.handler("status", ctx);
    assert.match(lastNotification().message, /not reachable/);

    // Unknown action fails closed with usage.
    await consoleCmd.handler("bogus", ctx);
    assert.equal(lastNotification().level, "error");
    assert.match(lastNotification().message, /unknown action/);

    // start-trust (B-090): a live but unrelated pid in the pid file must not make
    // /console start report alreadyRunning/healthy without probing /api/health.
    const stalePid = spawnInert();
    inert.push(stalePid);
    assert.ok(stalePid.pid, "inert child must have a pid");
    writePid(stalePid.pid);
    await consoleCmd.handler("start", ctx);
    const startMessage = lastNotification().message;
    assert.doesNotMatch(startMessage, /already running/, "a live stale pid must not short-circuit the health probe");
    assert.match(startMessage, /web UI started/);
    assert.ok(await waitHealthy(port), "a fresh server must start despite the stale pid file");

    // Access token: /console start prints the tokenised login URL, the server enforces it,
    // and the token is never in the server log (it travels by an owner-only file).
    const tokenMatch = /http:\/\/127\.0\.0\.1:\d+\/#token=([0-9a-f]{64})\b/.exec(startMessage);
    assert.ok(tokenMatch, `start must print the login URL with a 256-bit token: ${startMessage}`);
    assert.ok(startMessage.includes(`http://127.0.0.1:${port}/#token=`));
    const [, token] = tokenMatch;
    assert.ok(token !== undefined, "the login URL carries the token");
    const tokenPath = path.join(webUiRoot, ".runtime", "console.token");
    const logPath = path.join(webUiRoot, ".runtime", "server.log");
    assert.equal((await apiStatus(port, "/api/sessions")).status, 401, "the console must refuse requests without the token");
    assert.equal((await apiStatus(port, "/api/sessions", token)).status, 200, "the printed token must work");
    assert.equal(fs.readFileSync(tokenPath, "utf8").trim(), token, "the token file holds the printed token");
    if (process.platform !== "win32") assert.equal(fs.statSync(tokenPath).mode & 0o777, 0o600, "token file must be owner-only");
    assert.ok(!fs.readFileSync(logPath, "utf8").includes(token), "the token must not be written to the server log");

    // Status reports running, and does not print the token unless asked.
    await consoleCmd.handler("status", ctx);
    assert.match(lastNotification().message, /running/);
    assert.ok(!lastNotification().message.includes(token), "/console status must not print the token");
    assert.match(lastNotification().message, /hidden/);
    await consoleCmd.handler("status --show-token", ctx);
    assert.ok(lastNotification().message.includes(`#token=${token}`), "--show-token prints the login URL");

    // Start again is idempotent and offers the same working link.
    await consoleCmd.handler("start", ctx);
    assert.match(lastNotification().message, /already running/);
    assert.ok(lastNotification().message.includes(`#token=${token}`));

    // Stop and confirm the port is dead and the token file is gone.
    await consoleCmd.handler("stop", ctx);
    stopped = true;
    assert.match(lastNotification().message, /stopped the web UI/);
    for (let i = 0; i < 40 && (await health(port)); i++) await wait(50);
    assert.equal(await health(port), false, "server must be stopped after /console stop");
    assert.equal(fs.existsSync(tokenPath), false, "stop must remove the token file");

    // An operator-supplied token is used as given and no token file is written.
    {
      const supplied = "a1b2c3d4".repeat(8);
      const undo = setEnv("PI_CONSOLE_TOKEN", supplied);
      try {
        await consoleCmd.handler("start", ctx);
        assert.ok(lastNotification().message.includes(`#token=${supplied}`), "supplied token is used in the login URL");
        assert.ok(await waitHealthy(port));
        assert.equal((await apiStatus(port, "/api/sessions", supplied)).status, 200);
        assert.equal(fs.existsSync(tokenPath), false, "no token file for an operator-supplied token");
      } finally {
        await consoleCmd.handler("stop", ctx);
        undo();
      }
      for (let i = 0; i < 40 && (await health(port)); i++) await wait(50);
      assert.equal(await health(port), false);
    }

    // Explicit PI_CONSOLE_AUTH=off: loud warning, no token in the URL, no token file.
    {
      const undo = setEnv("PI_CONSOLE_AUTH", "off");
      try {
        await consoleCmd.handler("start", ctx);
        const message = lastNotification().message;
        assert.match(message, /AUTHENTICATION IS OFF/);
        assert.doesNotMatch(message, /#token=/);
        assert.ok(await waitHealthy(port));
        assert.equal((await apiStatus(port, "/api/sessions")).status, 200);
        assert.equal(fs.existsSync(tokenPath), false);
        await consoleCmd.handler("status", ctx);
        assert.match(lastNotification().message, /auth: OFF/);
      } finally {
        await consoleCmd.handler("stop", ctx);
        undo();
      }
      for (let i = 0; i < 40 && (await health(port)); i++) await wait(50);
      assert.equal(await health(port), false);
    }

    // An unreadable operator token file is refused by the server, not silently replaced.
    {
      const undo = setEnv("PI_CONSOLE_TOKEN_FILE", path.join(ws, "no-such-token-file"));
      try {
        await consoleCmd.handler("start", ctx);
        const { message, level } = lastNotification();
        assert.equal(level, "error");
        assert.match(message, /PI_CONSOLE_TOKEN_FILE/);
        assert.equal(fs.existsSync(tokenPath), false, "no substitute token file may be written");
      } finally {
        undo();
      }
    }

    // A refused configuration is reported promptly with the reason, and leaves no token behind.
    {
      const undo = setEnv("PI_CONSOLE_HOST", "0.0.0.0");
      try {
        const started = Date.now();
        await consoleCmd.handler("start", ctx);
        const { message, level } = lastNotification();
        assert.equal(level, "error");
        assert.match(message, /exited while starting/);
        assert.match(message, /PI_CONSOLE_ALLOW_REMOTE/, "the refusal reason is shown");
        assert.ok(Date.now() - started < 5000, "must not wait out the readiness timeout for a server that already exited");
        assert.equal(fs.existsSync(tokenPath), false, "a refused start must not leave a token file");
        assert.doesNotMatch(message, /#token=/);
      } finally {
        undo();
      }
    }

    // stop-safety (B-090): a stale pid file pointing at an unrelated live process must
    // not be SIGTERMed while no console is answering the health endpoint.
    const bystander = spawnInert();
    inert.push(bystander);
    assert.ok(bystander.pid, "bystander must have a pid");
    writePid(bystander.pid);
    await consoleCmd.handler("stop", ctx);
    assert.match(lastNotification().message, /no server started/);
    assert.ok(alive(bystander.pid), "stop must not SIGTERM a pid that is not the console");
    assert.ok(fs.existsSync(pidPath), "a failed stop must keep the pidfile");

    // hung console (Linux, where the pid's command line is readable): a console process
    // that holds the pid file but does not answer /api/health must be reported by start
    // (not duplicated) and killed by stop.
    if (fs.existsSync(`/proc/${process.pid}/cmdline`)) {
      const hung = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", path.join(webUiRoot, "server", "server.ts")], { stdio: "ignore" });
      inert.push(hung);
      writePid(hung.pid);
      await consoleCmd.handler("start", ctx);
      assert.match(lastNotification().message, /is running but .* does not respond/, "start must report a hung console");
      assert.equal(await health(port), false, "start must not launch a second server over a hung one");
      await consoleCmd.handler("stop", ctx);
      assert.match(lastNotification().message, /stopped the web UI/, "stop must kill a hung console");
      for (let i = 0; i < 40 && alive(hung.pid); i++) await wait(50);
      assert.equal(alive(hung.pid), false, "the hung console must be gone after stop");
    }

    console.log("web-console smoke: OK");
  } finally {
    for (const child of inert) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }
    if (!stopped) {
      // Best-effort cleanup if the test failed mid-run.
      try {
        const register = await loadExtension("extensions/web-console/index.ts");
        const pi = fakePi();
        register(pi.api);
        await pi.commands.get("console").handler("stop", ctx);
      } catch {
        /* ignore */
      }
    }
    for (const r of restore.reverse()) r();
    rmWorkspace(ws);
  }
}

run().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});