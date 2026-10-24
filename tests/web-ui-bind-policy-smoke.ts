#!/usr/bin/env node
// Offline smoke for the pi-console bind and token policy (packages/web-ui):
//   - a non-loopback bind is refused unless PI_CONSOLE_ALLOW_REMOTE=1, and remote never runs
//     without token authentication (PI_CONSOLE_AUTH=off is loopback-only);
//   - token sources (generated / PI_CONSOLE_TOKEN / PI_CONSOLE_TOKEN_FILE), strength and
//     handling of the generated token file;
//   - the token comparison is constant time (crypto.timingSafeEqual on fixed-length digests).
// The process-level checks start the real server.ts; the policy checks import security.ts.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { mock } from "node:test";
import {
  WEB_UI_DIR,
  authed,
  makeRunner,
  makeSandbox,
  newToken,
  request,
  startServer,
} from "./web-ui-test-harness.ts";

const { check, finish } = makeRunner("web-ui-bind-policy smoke");
const security = await import("../packages/web-ui/server/security.ts");
const sandbox = makeSandbox("pi-web-ui-bind-");
const posix = process.platform !== "win32";

const canConnect = (port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
  });

try {
  // ---------------------------------------------------- policy (in-process) ---------------
  await check("loopback hosts are accepted, everything else is refused by default", () => {
    for (const host of ["127.0.0.1", "localhost", "LOCALHOST", "::1", "[::1]", "127.0.0.2", "127.255.255.254", "::ffff:127.0.0.1"]) {
      assert.equal(security.resolvePolicy({ PI_CONSOLE_HOST: host }).loopback, true, host);
    }
    for (const host of ["0.0.0.0", "::", "[::]", "192.168.1.10", "10.0.0.1", "8.8.8.8", "example.com", "myhost.lan",
      "127.0.0.1.evil.example", "localhost.evil.example", "127.1", "::ffff:8.8.8.8", "0"]) {
      assert.throws(() => security.resolvePolicy({ PI_CONSOLE_HOST: host }), security.PolicyError, `${host} must be refused`);
    }
    assert.equal(security.resolvePolicy({}).host, "127.0.0.1", "default host is loopback");
    assert.equal(security.resolvePolicy({}).auth, "token", "authentication is on by default");
  });

  await check("PI_CONSOLE_ALLOW_REMOTE must be exactly 1, and never switches authentication off", () => {
    for (const value of ["true", "yes", "0", "", "2", " 1"]) {
      assert.throws(() => security.resolvePolicy({ PI_CONSOLE_HOST: "192.168.1.10", PI_CONSOLE_ALLOW_REMOTE: value }), security.PolicyError, JSON.stringify(value));
    }
    const remote = security.resolvePolicy({ PI_CONSOLE_HOST: "192.168.1.10", PI_CONSOLE_ALLOW_REMOTE: "1" });
    assert.equal(remote.auth, "token");
    assert.ok(remote.token && remote.token.length >= 32);
    assert.ok(remote.warnings.some((w) => /plain HTTP/.test(w) && /TLS/.test(w) && /not authentication/.test(w)), "remote warning names TLS and that a proxy is not authentication");
  });

  await check("auth=off is loopback-only and incompatible with remote mode", () => {
    assert.equal(security.resolvePolicy({ PI_CONSOLE_AUTH: "off" }).auth, "off");
    assert.ok(security.resolvePolicy({ PI_CONSOLE_AUTH: "off" }).warnings.some((w) => /AUTHENTICATION IS DISABLED/.test(w)));
    assert.equal(security.resolvePolicy({ PI_CONSOLE_AUTH: "off" }).token, null);
    for (const env of [
      { PI_CONSOLE_AUTH: "off", PI_CONSOLE_HOST: "0.0.0.0" },
      { PI_CONSOLE_AUTH: "off", PI_CONSOLE_HOST: "0.0.0.0", PI_CONSOLE_ALLOW_REMOTE: "1", PI_CONSOLE_ALLOWED_HOSTS: "a.test" },
      { PI_CONSOLE_AUTH: "off", PI_CONSOLE_HOST: "127.0.0.1", PI_CONSOLE_ALLOW_REMOTE: "1" },
      { PI_CONSOLE_AUTH: "OFF", PI_CONSOLE_HOST: "192.168.1.10", PI_CONSOLE_ALLOW_REMOTE: "1" },
    ]) {
      assert.throws(() => security.resolvePolicy(env), security.PolicyError, JSON.stringify(env));
    }
    for (const value of ["no", "false", "0", "disabled", "on"]) {
      assert.throws(() => security.resolvePolicy({ PI_CONSOLE_AUTH: value }), security.PolicyError, `PI_CONSOLE_AUTH=${value} must not silently mean something`);
    }
  });

  await check("a wildcard bind needs PI_CONSOLE_ALLOWED_HOSTS; entries are bare hosts only", () => {
    const base = { PI_CONSOLE_HOST: "0.0.0.0", PI_CONSOLE_ALLOW_REMOTE: "1" };
    assert.throws(() => security.resolvePolicy(base), security.PolicyError);
    assert.doesNotThrow(() => security.resolvePolicy({ ...base, PI_CONSOLE_ALLOWED_HOSTS: "pi.example.com, 10.0.0.5:8123" }));
    for (const bad of ["http://pi.example.com", "*.example.com", "pi.example.com/x", "pi example", "pi.example.com:99999", "@evil"]) {
      assert.throws(() => security.resolvePolicy({ ...base, PI_CONSOLE_ALLOWED_HOSTS: bad }), security.PolicyError, bad);
    }
  });

  await check("tokens: generated = 256 random bits and differs per start; supplied ones must be strong; errors never echo them", () => {
    const a = security.resolvePolicy({});
    const b = security.resolvePolicy({});
    assert.match(a.token ?? "", /^[0-9a-f]{64}$/, "256-bit hex");
    assert.notEqual(a.token, b.token);
    assert.equal(a.tokenSource, "generated");
    const supplied = newToken();
    assert.equal(security.resolvePolicy({ PI_CONSOLE_TOKEN: supplied }).token, supplied);
    for (const weak of ["short", "a".repeat(31), "has space in it but is quite long enough to pass length", `${"a".repeat(40)}!`, "a".repeat(257)]) {
      let message = "";
      try {
        security.resolvePolicy({ PI_CONSOLE_TOKEN: weak });
      } catch (error) {
        message = String(error instanceof Error ? error.message : undefined);
      }
      assert.ok(message, `weak token accepted: ${weak.slice(0, 20)}`);
      assert.ok(!message.includes(weak), "the error message echoed the token");
    }
  });

  await check("Host allowlist: loopback names, the bound host and configured hosts; never the wildcard", () => {
    const policy = security.resolvePolicy({ PI_CONSOLE_HOST: "0.0.0.0", PI_CONSOLE_ALLOW_REMOTE: "1", PI_CONSOLE_ALLOWED_HOSTS: "pi.example.com,10.0.0.5:9000" });
    const set = security.buildAuthorities(policy, 8123);
    for (const ok of ["127.0.0.1:8123", "localhost:8123", "[::1]:8123", "pi.example.com:8123", "pi.example.com", "10.0.0.5:9000"]) assert.ok(set.has(ok), ok);
    for (const bad of ["0.0.0.0:8123", "10.0.0.5:8123", "10.0.0.5", "evil.example:8123", "127.0.0.1", "127.0.0.1:80"]) assert.ok(!set.has(bad), bad);
    assert.equal(security.normalizeAuthority("Evil.EXAMPLE:80@x"), null);
    assert.equal(security.normalizeAuthority("a b"), null);
    assert.equal(security.normalizeAuthority("localhost:8123"), "localhost:8123");
  });

  // ---------------------------------------------------- constant-time compare ------------
  await check("token comparison uses crypto.timingSafeEqual on equal-length digests (no length leak, no throw)", () => {
    const spy = mock.method(crypto, "timingSafeEqual");
    try {
      const token = newToken();
      assert.equal(security.tokenMatches(token, token), true);
      assert.equal(security.tokenMatches(token.slice(0, -1) + (token.endsWith("0") ? "1" : "0"), token), false);
      assert.equal(security.tokenMatches("short", token), false);
      assert.equal(security.tokenMatches("x".repeat(5000), token), false);
      assert.equal(spy.mock.callCount(), 4, "every comparison of a presented credential must go through timingSafeEqual");
      for (const call of spy.mock.calls) {
        // security.ts passes Buffers (SHA-256 digests); the mock types them as any ArrayBufferView.
        assert.equal((call.arguments[0] as Buffer).length, 32);
        assert.equal((call.arguments[1] as Buffer).length, 32, "both sides are fixed-length SHA-256 digests");
      }
      assert.equal(security.tokenMatches(undefined, token), false);
      assert.equal(security.tokenMatches(null, token), false);
      // The request gate takes the same path.
      const before = spy.mock.callCount();
      const policy = { auth: "token" as const, token };
      const authorities = new Set(["127.0.0.1:1"]);
      const req = (h: Record<string, string>) => ({ method: "GET", headers: { host: "127.0.0.1:1", ...h } });
      const denied = security.evaluateRequest(req({ authorization: "Bearer nope" }), { pathname: "/api/sessions", authorities, policy });
      assert.equal("status" in denied ? denied.status : undefined, 401);
      assert.equal(security.evaluateRequest(req({ authorization: `Bearer ${token}` }), { pathname: "/api/sessions", authorities, policy }).ok, true);
      assert.equal(spy.mock.callCount(), before + 2, "evaluateRequest must compare via timingSafeEqual");
    } finally {
      spy.mock.restore();
    }
  });

  await check("no source file compares the token with ===/== (only constantTimeEqual)", () => {
    const dir = path.join(WEB_UI_DIR, "server");
    // A token-ish identifier on either side of an equality operator, other than a literal
    // (auth === "token") or null/undefined check.
    const op = "(?:===|==|!==|!=)(?!=)"; // the whole operator, never a prefix of a longer one
    const bad = new RegExp(
      `\\b(?:token|presented|expected|bearer)\\w*\\s*${op}\\s*(?!\\s|null\\b|undefined\\b|["'\`])|${op}\\s*(?:policy\\.token|expected|presented|token)\\b`,
    );
    // Negative control: the scan must actually flag the mistakes it exists to catch.
    for (const line of ["if (presented === policy.token) return true;", "return token == expected;", "if (bearer !== token) deny();", "ok = a === policy.token"]) {
      assert.match(line, bad, `scan failed to flag: ${line}`);
    }
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
      const text = fs.readFileSync(path.join(dir, file), "utf8").split("\n").filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"));
      for (const line of text) assert.doesNotMatch(line, bad, `${file}: ${line.trim()}`);
    }
    assert.match(fs.readFileSync(path.join(dir, "security.ts"), "utf8"), /crypto\.timingSafeEqual\(/);
  });

  // ---------------------------------------------------- process-level refusals ----------
  const refuse = async (label: string, env: NodeJS.ProcessEnv, pattern: RegExp) => {
    await check(label, async () => {
      const result = await startServer(sandbox, { env, expectExit: true });
      assert.equal(result.exit.code, 2, `exit code (output: ${result.output().slice(0, 300)})`);
      assert.doesNotMatch(result.stdout(), /listening on/, "must not have started listening");
      assert.match(result.stderr(), pattern);
      assert.equal(await canConnect(result.port), false, "nothing may be listening on the port");
    });
  };
  const T = newToken();
  await refuse("PI_CONSOLE_HOST=0.0.0.0 without opt-in: refused, nothing listens", { PI_CONSOLE_HOST: "0.0.0.0", PI_CONSOLE_TOKEN: T }, /PI_CONSOLE_ALLOW_REMOTE=1/);
  await refuse("PI_CONSOLE_HOST=:: without opt-in: refused", { PI_CONSOLE_HOST: "::" }, /PI_CONSOLE_ALLOW_REMOTE=1/);
  await refuse("a LAN address without opt-in: refused", { PI_CONSOLE_HOST: "192.168.1.10" }, /not a loopback address/);
  await refuse("a host name without opt-in: refused", { PI_CONSOLE_HOST: "myhost.lan" }, /not a loopback address/);
  await refuse("remote opt-in with PI_CONSOLE_AUTH=off: refused", { PI_CONSOLE_HOST: "0.0.0.0", PI_CONSOLE_ALLOW_REMOTE: "1", PI_CONSOLE_ALLOWED_HOSTS: "a.test", PI_CONSOLE_AUTH: "off" }, /loopback|token/i);
  await refuse("auth=off on a non-loopback address: refused", { PI_CONSOLE_HOST: "0.0.0.0", PI_CONSOLE_AUTH: "off" }, /PI_CONSOLE_ALLOW_REMOTE|loopback/);
  await refuse("wildcard remote bind without PI_CONSOLE_ALLOWED_HOSTS: refused", { PI_CONSOLE_HOST: "0.0.0.0", PI_CONSOLE_ALLOW_REMOTE: "1", PI_CONSOLE_TOKEN: T }, /PI_CONSOLE_ALLOWED_HOSTS/);
  await refuse("a weak PI_CONSOLE_TOKEN is refused and never echoed", { PI_CONSOLE_TOKEN: "hunter2hunter2" }, /PI_CONSOLE_TOKEN is not acceptable/);
  await refuse("an unreadable PI_CONSOLE_TOKEN_FILE is refused", { PI_CONSOLE_TOKEN_FILE: path.join(sandbox.root, "does-not-exist") }, /PI_CONSOLE_TOKEN_FILE/);
  await refuse("an unrecognised PI_CONSOLE_AUTH value is refused (fail closed)", { PI_CONSOLE_AUTH: "disabled" }, /PI_CONSOLE_AUTH/);

  await check("a weak token is not printed by the refusing server", async () => {
    const result = await startServer(sandbox, { env: { PI_CONSOLE_TOKEN: "hunter2hunter2" }, expectExit: true });
    assert.ok(!result.output().includes("hunter2hunter2"));
  });

  // ---------------------------------------------------- explicit remote opt-in ----------
  await check("remote opt-in starts only with a token; Host allowlist and TLS-proxy Origin work; warning printed", async () => {
    const token = newToken();
    const server = await startServer(sandbox, {
      env: { PI_CONSOLE_HOST: "0.0.0.0", PI_CONSOLE_ALLOW_REMOTE: "1", PI_CONSOLE_ALLOWED_HOSTS: "pi.test", PI_CONSOLE_TOKEN: token },
    });
    try {
      const { port } = server;
      assert.match(server.stderr(), /remote access enabled/);
      assert.match(server.stderr(), /plain HTTP/);
      assert.match(server.stderr(), /not authentication/);
      assert.equal((await request(port, { path: "/api/sessions", host: `pi.test:${port}` })).status, 401, "no token, no access");
      assert.equal((await authed(port, token, { path: "/api/sessions", host: `pi.test:${port}` })).status, 200);
      assert.equal((await authed(port, token, { path: "/api/sessions", host: "pi.test" })).status, 200, "proxy form: Host without the listen port");
      assert.equal((await authed(port, token, { path: "/api/sessions", host: "pi.test", headers: { Origin: "https://pi.test" } })).status, 200, "HTTPS page behind a TLS proxy");
      assert.equal((await authed(port, token, { path: "/api/sessions", host: "pi.test", headers: { Origin: "https://evil.test" } })).status, 403);
      assert.equal((await authed(port, token, { path: "/api/sessions", host: `other.test:${port}` })).status, 403, "unlisted Host");
      assert.equal((await authed(port, token, { path: "/api/sessions", host: `0.0.0.0:${port}` })).status, 403, "the wildcard is not a valid Host");
      const wrong = token.slice(0, -1) + (token.endsWith("0") ? "1" : "0");
      assert.equal((await authed(port, wrong, { path: "/api/sessions", host: `pi.test:${port}` })).status, 401);
      // Genuinely reachable on a non-loopback interface, when this machine has one.
      const external = Object.values(os.networkInterfaces()).flat().find((i) => i?.family === "IPv4" && !i.internal);
      if (external) {
        const viaLan = await new Promise((resolve) => {
          const socket = net.connect(port, external.address);
          socket.once("connect", () => { socket.destroy(); resolve(true); });
          socket.once("error", () => resolve(false));
        });
        assert.equal(viaLan, true, "a wildcard bind should be reachable on the LAN address");
      }
    } finally {
      await server.stop();
    }
  });

  // ---------------------------------------------------- token sources -------------------
  await check("PI_CONSOLE_TOKEN_FILE supplies the token; PI_CONSOLE_TOKEN wins over it; loose permissions warn", async () => {
    const fileToken = newToken();
    const file = path.join(sandbox.root, "supplied.token");
    fs.writeFileSync(file, `${fileToken}\n`, { mode: 0o600 });
    const s1 = await startServer(sandbox, { env: { PI_CONSOLE_TOKEN_FILE: file } });
    try {
      assert.equal((await authed(s1.port, fileToken, { path: "/api/sessions" })).status, 200);
      assert.equal((await request(s1.port, { path: "/api/sessions" })).status, 401);
      assert.ok(!s1.output().includes(fileToken));
      assert.doesNotMatch(s1.stderr(), /readable by other users/);
    } finally {
      await s1.stop();
    }
    const direct = newToken();
    const s2 = await startServer(sandbox, { env: { PI_CONSOLE_TOKEN_FILE: file, PI_CONSOLE_TOKEN: direct } });
    try {
      assert.equal((await authed(s2.port, direct, { path: "/api/sessions" })).status, 200);
      assert.equal((await authed(s2.port, fileToken, { path: "/api/sessions" })).status, 401);
    } finally {
      await s2.stop();
    }
    if (posix) {
      fs.chmodSync(file, 0o644);
      const s3 = await startServer(sandbox, { env: { PI_CONSOLE_TOKEN_FILE: file } });
      try {
        assert.match(s3.stderr(), /readable by other users/);
      } finally {
        await s3.stop();
      }
    }
  });

  await check("a generated token goes to an owner-only file (not stdout/stderr), is fresh per start and removed on shutdown", async () => {
    const tokenFile = path.join(sandbox.runtimeDir, "console.token");
    const s1 = await startServer(sandbox, { env: {} });
    let first;
    try {
      assert.ok(fs.existsSync(tokenFile), "server should leave the generated token in the runtime dir when stdout is not a terminal");
      first = fs.readFileSync(tokenFile, "utf8").trim();
      assert.match(first, /^[0-9a-f]{64}$/, "256-bit token");
      if (posix) assert.equal(fs.statSync(tokenFile).mode & 0o777, 0o600, "token file must be 0600");
      assert.ok(!s1.output().includes(first), "generated token was logged");
      assert.doesNotMatch(s1.output(), /[0-9a-f]{40,}/, "a long hex string was logged");
      assert.equal((await authed(s1.port, first, { path: "/api/sessions" })).status, 200);
      assert.equal((await request(s1.port, { path: "/api/sessions" })).status, 401);
    } finally {
      await s1.stop();
    }
    assert.equal(fs.existsSync(tokenFile), false, "token file must be removed on clean shutdown");
    const s2 = await startServer(sandbox, { env: {} });
    try {
      const second = fs.readFileSync(tokenFile, "utf8").trim();
      assert.notEqual(second, first, "a new token per start");
      assert.equal((await authed(s2.port, first, { path: "/api/sessions" })).status, 401, "the previous token must be dead");
    } finally {
      await s2.stop();
    }
  });

  if (posix) {
    await check("a pre-planted token-file symlink is replaced, not followed", async () => {
      const tokenFile = path.join(sandbox.runtimeDir, "console.token");
      const victim = path.join(sandbox.root, "victim.txt");
      fs.writeFileSync(victim, "precious");
      fs.rmSync(tokenFile, { force: true });
      fs.symlinkSync(victim, tokenFile);
      const server = await startServer(sandbox, { env: {} });
      try {
        assert.equal(fs.readFileSync(victim, "utf8"), "precious", "the symlink target was overwritten");
        assert.equal(fs.lstatSync(tokenFile).isSymbolicLink(), false);
        assert.equal(fs.statSync(tokenFile).mode & 0o777, 0o600);
      } finally {
        await server.stop();
      }
    });
  }
} finally {
  sandbox.cleanup();
}

finish();
