#!/usr/bin/env node
// Offline security smoke for the pi-console HTTP server (packages/web-ui).
//
// Starts the real server.ts on an ephemeral loopback port inside a sandbox of temp
// directories and attacks it over real HTTP: missing/wrong credentials, DNS rebinding,
// cross-origin and cross-port requests, CORS preflight, simple-request (text/plain) CSRF,
// security headers, static-file traversal, oversized and malformed bodies, the explicit
// PI_CONSOLE_AUTH=off mode, and token leakage into logs, bodies and cookies.
//
// PI_CONSOLE_TEST_SERVER=<path to another server.ts> reruns everything against that server.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  type RequestOptions,
  type ServerHandle,
  WEB_UI_DIR,
  authed,
  makeRunner,
  makeSandbox,
  newToken,
  openSse,
  rawRequest,
  request,
  startServer,
  waitFor,
  writeSessionFixture,
} from "./web-ui-test-harness.ts";

/** GET /api/health */
interface HealthBody {
  ok: boolean;
  auth: string;
}

/** GET /api/sessions */
interface SessionsBody {
  sessions: Array<{ id: string }>;
}

/** GET /api/agents/<name> */
interface AgentBody {
  agent: { description: string };
}

const { check, finish } = makeRunner("web-ui-security smoke");
const sandbox = makeSandbox();
const FIXTURE_ID = "fixture-1";
writeSessionFixture(sandbox, FIXTURE_ID);
const TOKEN = newToken();
const JSON_HEADERS = { "Content-Type": "application/json" };
let server: ServerHandle | null = null;
let exitCode = 0;

try {
  server = await startServer(sandbox, { env: { PI_CONSOLE_TOKEN: TOKEN, PI_CONSOLE_ACCESS_LOG: "1" } });
  const running = server; // the started server, non-null inside the check closures below
  const { port } = server;
  const get = (p: string, o: RequestOptions = {}) => request(port, { path: p, ...o });
  const auth = (p: string, o: RequestOptions = {}) => authed(port, TOKEN, { path: p, ...o });

  // ------------------------------------------------ 1. authentication ------------------
  const PROTECTED = [
    ["GET", "/api/config"],
    ["GET", "/api/prompts"],
    ["GET", "/api/skills"],
    ["GET", "/api/models"],
    ["GET", "/api/cwds"],
    ["GET", "/api/agents"],
    ["GET", "/api/agents/x"],
    ["POST", "/api/agents"],
    ["PUT", "/api/agents/x"],
    ["DELETE", "/api/agents/x"],
    ["GET", "/api/sessions"],
    ["POST", "/api/sessions"],
    ["GET", `/api/sessions/${FIXTURE_ID}`],
    ["DELETE", `/api/sessions/${FIXTURE_ID}`],
    ["GET", `/api/sessions/${FIXTURE_ID}/stats`],
    ["GET", `/api/sessions/${FIXTURE_ID}/todos`],
    ["GET", `/api/sessions/${FIXTURE_ID}/lens`],
    ["GET", `/api/sessions/${FIXTURE_ID}/events`],
    ["POST", `/api/sessions/${FIXTURE_ID}/prompt`],
    ["POST", `/api/sessions/${FIXTURE_ID}/abort`],
    ["POST", `/api/sessions/${FIXTURE_ID}/model`],
    ["POST", `/api/sessions/${FIXTURE_ID}/thinking`],
    ["POST", `/api/sessions/${FIXTURE_ID}/fork`],
    ["POST", `/api/sessions/${FIXTURE_ID}/new`],
    ["GET", "/api/auth"],
  ] satisfies Array<[string, string]>;

  await check("missing token -> 401 on every session-revealing or controlling route", async () => {
    for (const [method, route] of PROTECTED) {
      const res = await get(route, {
        method,
        headers: method === "GET" ? {} : JSON_HEADERS,
        ...(method === "GET" ? {} : { body: "{}" }),
      });
      assert.equal(res.status, 401, `${method} ${route} should be 401, got ${res.status}`);
      assert.match(res.headers["www-authenticate"] || "", /^Bearer/, `${method} ${route} lacks WWW-Authenticate`);
    }
  });

  await check("the SSE event stream refuses an unauthenticated client (401, no stream)", async () => {
    const sse = await openSse(port, `/api/sessions/${FIXTURE_ID}/events`);
    assert.equal(sse.status, 401);
    assert.doesNotMatch(String(sse.headers["content-type"]), /event-stream/);
    sse.close();
  });

  await check("wrong or malformed credentials -> 401", async () => {
    const wrongSameLength = `${TOKEN.slice(0, -1)}${TOKEN.endsWith("0") ? "1" : "0"}`;
    const variants = [
      { Authorization: `Bearer ${wrongSameLength}` },
      { Authorization: `Bearer ${TOKEN.slice(1)}` },
      { Authorization: `Bearer ${TOKEN}x` },
      { Authorization: "Bearer " },
      { Authorization: "Bearer" },
      { Authorization: "" },
      { Authorization: `Bearer  ${TOKEN}` },
      { Authorization: `Basic ${Buffer.from(`u:${TOKEN}`).toString("base64")}` },
      { Authorization: TOKEN },
      { "X-Api-Key": TOKEN },
      { Cookie: `token=${TOKEN}; pi-console.token=${TOKEN}` },
    ];
    for (const headers of variants) {
      const res = await get("/api/sessions", { headers });
      assert.equal(res.status, 401, `should reject ${JSON.stringify(Object.keys(headers))}: ${res.status}`);
    }
  });

  await check("a token in the query string is never accepted", async () => {
    for (const q of [`token=${TOKEN}`, `access_token=${TOKEN}`, `key=${TOKEN}`]) {
      const res = await get(`/api/sessions?${q}`);
      assert.equal(res.status, 401, q.slice(0, q.indexOf("=")));
    }
  });

  await check("the correct token is accepted on the read routes", async () => {
    const config = await auth("/api/config");
    assert.equal(config.status, 200);
    const sessions = await auth("/api/sessions");
    assert.equal(sessions.status, 200);
    assert.ok((sessions.json() as SessionsBody).sessions.some((s) => s.id === FIXTURE_ID), "fixture session listed");
    for (const route of ["/api/prompts", "/api/skills", "/api/models", "/api/cwds", "/api/agents", "/api/auth",
      `/api/sessions/${FIXTURE_ID}`, `/api/sessions/${FIXTURE_ID}/stats`, `/api/sessions/${FIXTURE_ID}/todos`, `/api/sessions/${FIXTURE_ID}/lens`]) {
      const res = await auth(route);
      assert.equal(res.status, 200, `${route} -> ${res.status} ${res.text.slice(0, 120)}`);
    }
  });

  await check("the SSE stream works with the token (Authorization header)", async () => {
    const sse = await openSse(port, `/api/sessions/${FIXTURE_ID}/events`, { Authorization: `Bearer ${TOKEN}` });
    assert.equal(sse.status, 200);
    assert.match(String(sse.headers["content-type"]), /text\/event-stream/);
    assert.ok(await waitFor(() => sse.received().includes('"state":"watching"')), `no lifecycle frame: ${sse.received()}`);
    sse.close();
  });

  await check("/api/health stays open, reports the auth mode and reveals no token", async () => {
    const res = await get("/api/health");
    assert.equal(res.status, 200);
    const body = res.json() as HealthBody;
    assert.equal(body.ok, true);
    assert.equal(body.auth, "token");
    assert.ok(!res.text.includes(TOKEN));
  });

  await check("the static UI shell is open and contains no secret", async () => {
    const res = await get("/");
    assert.equal(res.status, 200);
    assert.match(res.headers["content-type"] || "", /text\/html/);
    assert.ok(!res.text.includes(TOKEN));
    assert.equal((await get("/js/app.js")).status, 200);
  });

  // ------------------------------------------------ 2. DNS rebinding -------------------
  await check("a foreign Host header is refused on the API and on static files (DNS rebinding)", async () => {
    for (const host of ["evil.example", `evil.example:${port}`, `127.0.0.1.evil.example:${port}`, `localhost.evil.example:${port}`,
      `127.0.0.1:${port + 1}`, `0.0.0.0:${port}`, `127.0.0.1:${port}@evil.example`, `evil.example:${port}, 127.0.0.1:${port}`, `127.0.0.1:${port}/x`]) {
      const api = await authed(port, TOKEN, { path: "/api/sessions", host });
      assert.equal(api.status, 403, `API with Host ${host} -> ${api.status}`);
      const page = await get("/", { host });
      assert.equal(page.status, 403, `static with Host ${host} -> ${page.status}`);
      assert.ok(!page.text.includes("<title>"), "the UI shell must not load for a foreign Host");
    }
  });

  await check("a missing Host header is refused", async () => {
    // Node's own parser answers 400 to an HTTP/1.1 request without Host; either way it is refused.
    const res = await request(port, { path: "/api/health", noHost: true, headers: {} });
    assert.ok([400, 403].includes(res.status), `status ${res.status}`);
  });

  await check("loopback names (any case) with the real port are accepted", async () => {
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `LocalHost:${port}`, `[::1]:${port}`]) {
      const res = await authed(port, TOKEN, { path: "/api/sessions", host });
      assert.equal(res.status, 200, `Host ${host} -> ${res.status}`);
    }
  });

  // ------------------------------------------------ 3. CSRF / cross-origin ---------------
  const EVIL = "http://evil.example";
  const OTHER_LOCAL_PORT = `http://127.0.0.1:${port + 1}`;

  await check("a cross-origin request is refused on GET routes and the SSE stream, even with a valid token", async () => {
    for (const origin of [EVIL, "https://evil.example", "null", OTHER_LOCAL_PORT, `http://localhost:${port + 1}`,
      `http://127.0.0.1.evil.example:${port}`, "file://", `ftp://127.0.0.1:${port}`]) {
      const res = await auth("/api/sessions", { headers: { Origin: origin } });
      assert.equal(res.status, 403, `Origin ${origin} -> ${res.status}`);
      const sse = await openSse(port, `/api/sessions/${FIXTURE_ID}/events`, { Authorization: `Bearer ${TOKEN}`, Origin: origin });
      assert.equal(sse.status, 403, `SSE with Origin ${origin} -> ${sse.status}`);
      sse.close();
    }
  });

  await check("Sec-Fetch-Site cross-site / same-site is refused; same-origin and none pass", async () => {
    for (const site of ["cross-site", "same-site"]) {
      const res = await auth("/api/sessions", { headers: { "Sec-Fetch-Site": site } });
      assert.equal(res.status, 403, site);
    }
    for (const site of ["same-origin", "none"]) {
      const res = await auth("/api/sessions", { headers: { "Sec-Fetch-Site": site } });
      assert.equal(res.status, 200, site);
    }
  });

  await check("same-origin Origin values pass", async () => {
    for (const origin of [`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`]) {
      const res = await auth("/api/sessions", { headers: { Origin: origin } });
      assert.equal(res.status, 200, origin);
    }
  });

  await check("cross-origin state-changing requests are refused and have no effect (spawn/send/abort/config routes)", async () => {
    const victim = path.join(sandbox.userAgents, "csrf-agent.md");
    const bodies = { "/api/agents": '{"name":"csrf-agent","body":"pwn"}', "/api/sessions": `{"cwd":${JSON.stringify(sandbox.cwd)}}` };
    for (const origin of [EVIL, "null", OTHER_LOCAL_PORT]) {
      for (const [route, body] of [...Object.entries(bodies),
        [`/api/sessions/${FIXTURE_ID}/prompt`, '{"message":"rm -rf /"}'], [`/api/sessions/${FIXTURE_ID}/abort`, "{}"],
        [`/api/sessions/${FIXTURE_ID}/model`, '{"provider":"a","modelId":"b"}'], [`/api/sessions/${FIXTURE_ID}/fork`, "{}"]] satisfies Array<[string, string]>) {
        // With a valid token: the Origin gate alone must stop it.
        const withToken = await auth(route, { method: "POST", headers: { ...JSON_HEADERS, Origin: origin }, body });
        assert.equal(withToken.status, 403, `POST ${route} Origin ${origin} (token) -> ${withToken.status}`);
        // Without a token, as the real attacker would send it.
        const bare = await get(route, { method: "POST", headers: { ...JSON_HEADERS, Origin: origin }, body });
        assert.equal(bare.status, 403, `POST ${route} Origin ${origin} (no token) -> ${bare.status}`);
      }
      const del = await auth(`/api/sessions/${FIXTURE_ID}`, { method: "DELETE", headers: { ...JSON_HEADERS, Origin: origin } });
      assert.equal(del.status, 403, "DELETE session");
      const put = await auth("/api/agents/x", { method: "PUT", headers: { ...JSON_HEADERS, Origin: origin }, body: "{}" });
      assert.equal(put.status, 403, "PUT agent");
    }
    assert.equal(fs.existsSync(victim), false, "a cross-origin request created an agent file");
    assert.deepEqual(sandbox.stubEvents(), [], "a cross-origin request spawned a pi child");
  });

  await check("a simple cross-site request (text/plain body, no token) cannot create an agent", async () => {
    const victim = path.join(sandbox.userAgents, "csrf-agent.md");
    const res = await get("/api/agents", {
      method: "POST",
      headers: { Origin: EVIL, "Content-Type": "text/plain", "Sec-Fetch-Site": "cross-site" },
      body: '{"name":"csrf-agent","body":"pwn"}',
    });
    assert.ok([401, 403].includes(res.status), `status ${res.status}`);
    assert.equal(fs.existsSync(victim), false);
  });

  await check("CORS is not offered: preflight is refused and no Access-Control header is ever sent", async () => {
    const preflight = await get("/api/sessions", {
      method: "OPTIONS",
      headers: { Origin: EVIL, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type,authorization" },
    });
    assert.equal(preflight.status, 403);
    for (const res of [preflight, await auth("/api/sessions", { headers: { Origin: `http://127.0.0.1:${port}` } }),
      await get("/api/health", { headers: { Origin: EVIL } }), await get("/")]) {
      const acl = Object.keys(res.headers).filter((k) => k.startsWith("access-control-"));
      assert.deepEqual(acl, [], `unexpected CORS headers ${acl.join(",")}`);
    }
    const sameOriginOptions = await auth("/api/sessions", { method: "OPTIONS" });
    assert.ok(sameOriginOptions.status >= 400 && !sameOriginOptions.headers["access-control-allow-origin"]);
  });

  await check("state-changing requests must be application/json (text/plain, form, none are refused)", async () => {
    for (const contentType of ["text/plain", "text/plain;charset=UTF-8", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", "application/jsonx", "text/json", undefined]) {
      const headers = contentType === undefined ? {} : { "Content-Type": contentType };
      // request() (not authed()) so that no Content-Type is added on our behalf.
      const res = await request(port, { path: "/api/agents", method: "POST", headers: { ...headers, Authorization: `Bearer ${TOKEN}` }, body: '{"name":"plain-agent","body":"x"}' });
      assert.equal(res.status, 415, `${contentType} -> ${res.status}`);
    }
    assert.equal(fs.existsSync(path.join(sandbox.userAgents, "plain-agent.md")), false);
    // Bodiless POST/DELETE need the header too: a no-cors fetch() sends none.
    for (const [method, route] of [["POST", `/api/sessions/${FIXTURE_ID}/abort`], ["DELETE", `/api/sessions/${FIXTURE_ID}`]] satisfies Array<[string, string]>) {
      const res = await request(port, { method, path: route, headers: { Authorization: `Bearer ${TOKEN}` } });
      assert.equal(res.status, 415, `${method} ${route} without Content-Type -> ${res.status}`);
    }
    const ok = await authed(port, TOKEN, { path: "/api/agents", method: "POST", headers: { "Content-Type": "application/json; charset=utf-8" }, body: '{"name":"json-agent","body":"x"}' });
    assert.equal(ok.status, 201);
    const del = await authed(port, TOKEN, { path: "/api/agents/json-agent?source=user", method: "DELETE" });
    assert.equal(del.status, 200);
  });

  // ------------------------------------------------ 4. headers ----------------------------
  await check("every response carries the security headers (CSP, nosniff, no-referrer, frame denial)", async () => {
    const responses = [await get("/"), await get("/index.html"), await get("/js/app.js"), await get("/css/style.css"), await get("/nope.txt"),
      await get("/api/health"), await get("/api/sessions"), await auth("/api/sessions"), await get("/", { host: "evil.example" }),
      await get("/x", { method: "POST" })];
    for (const res of responses) {
      const csp = String(res.headers["content-security-policy"] || "");
      assert.ok(csp, `no CSP (status ${res.status})`);
      const directives = Object.fromEntries(csp.split(";").map((d) => d.trim()).filter(Boolean).map((d): [string, string[]] => { const [name = "", ...values] = d.split(/\s+/); return [name, values]; }));
      assert.deepEqual(directives["script-src"], ["'self'"]);
      assert.deepEqual(directives["default-src"], ["'none'"]);
      assert.deepEqual(directives["frame-ancestors"], ["'none'"]);
      assert.deepEqual(directives["object-src"], ["'none'"]);
      assert.deepEqual(directives["base-uri"], ["'none'"]);
      assert.deepEqual(directives["form-action"], ["'none'"]);
      assert.deepEqual(directives["style-src"], ["'self'"]);
      assert.deepEqual(directives["connect-src"], ["'self'"]);
      assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|\*|data:|http:/);
      assert.equal(res.headers["x-content-type-options"], "nosniff");
      assert.equal(res.headers["referrer-policy"], "no-referrer");
      assert.equal(res.headers["x-frame-options"], "DENY");
    }
  });

  await check("API responses (success and error) are Cache-Control: no-store", async () => {
    for (const res of [await get("/api/health"), await get("/api/sessions"), await auth("/api/sessions"), await auth("/api/nope"),
      await auth("/api/config"), await get("/api/agents", { method: "POST", headers: { Origin: EVIL } })]) {
      assert.equal(res.headers["cache-control"], "no-store", `status ${res.status}`);
    }
    const sse = await openSse(port, `/api/sessions/${FIXTURE_ID}/events`, { Authorization: `Bearer ${TOKEN}` });
    assert.match(String(sse.headers["cache-control"]), /no-store/);
    sse.close();
  });

  await check("the page needs no inline script, inline style, or dynamic code (so the CSP holds)", async () => {
    const html = fs.readFileSync(path.join(WEB_UI_DIR, "public", "index.html"), "utf8");
    assert.doesNotMatch(html, /<script(?![^>]*\ssrc=)[^>]*>/i, "inline <script>");
    assert.doesNotMatch(html, /<style[\s>]/i, "<style> element");
    assert.doesNotMatch(html, /\son[a-z]+\s*=/i, "inline event handler");
    assert.doesNotMatch(html, /\sstyle\s*=/i, "style attribute");
    assert.doesNotMatch(html, /javascript:/i, "javascript: URL");
    assert.match(html, /<meta name="referrer" content="no-referrer"/);
    const sinks = /\.(?:inner|outer)HTML\s*=|insertAdjacentHTML\s*\(|document\.write(?:ln)?\s*\(|\beval\s*\(|new\s+Function\s*\(|setAttribute\(\s*["'](?:style|on[a-z]+)["']/;
    for (const file of fs.readdirSync(path.join(WEB_UI_DIR, "public", "js"))) {
      const text = fs.readFileSync(path.join(WEB_UI_DIR, "public", "js", file), "utf8");
      assert.doesNotMatch(text, sinks, `${file} uses an HTML/code injection sink`);
    }
    assert.doesNotMatch(fs.readFileSync(path.join(WEB_UI_DIR, "public", "css", "style.css"), "utf8"), /@import|url\(\s*["']?(?:https?:)?\/\//i, "external CSS reference");
  });

  // ------------------------------------------------ 5. static files ----------------------
  await check("static serving refuses traversal, dotfiles, NUL bytes and non-GET methods", async () => {
    for (const p of ["/..%2f..%2fpackage.json", "/%2e%2e/server/config.js", "/../server/config.js", "/js/../../server/config.js", "/..%5c..%5cserver%5cconfig.js"]) {
      const res = await get(p);
      assert.ok([400, 403, 404].includes(res.status), `${p} -> ${res.status}`);
      assert.doesNotMatch(res.text, /PI_CONSOLE_HOST|APP_ROOT/);
    }
    assert.equal((await get("/.gitignore")).status, 404);
    assert.equal((await get("/js/.hidden")).status, 404);
    assert.equal((await get("/js/app.js%00.png")).status, 400);
    assert.equal((await get("/%zz")).status, 400);
    assert.equal((await get("/", { method: "POST", headers: JSON_HEADERS, body: "{}" })).status, 405);
  });

  await check("an absolute-form request target is refused", async () => {
    const raw = await rawRequest(port, `GET http://evil.example/api/health HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
    assert.match(raw, /^HTTP\/1\.1 400/);
  });

  // ------------------------------------------------ 6. bodies -----------------------------
  await check("request bodies are size-bounded (declared and chunked) and parsed as one JSON object", async () => {
    // The declared-length path refuses before consuming a body. Sending a megabyte
    // after that refusal races the server's connection close (EPIPE), so test the
    // header preflight directly. The separate chunked request proves actual-byte limits.
    const declared = await auth("/api/agents", { method: "POST", headers: { ...JSON_HEADERS, "Content-Length": "1000001" } });
    assert.equal(declared.status, 413);
    const big = Buffer.from(JSON.stringify({ name: "big2", body: "y".repeat(1_000_001) }));
    const chunked = await auth("/api/agents", { method: "POST", headers: JSON_HEADERS, chunks: [big.subarray(0, 500_000), big.subarray(500_000)] });
    assert.equal(chunked.status, 413);
    assert.equal(fs.existsSync(path.join(sandbox.userAgents, "big.md")), false);
    assert.equal(fs.existsSync(path.join(sandbox.userAgents, "big2.md")), false);
    for (const [label, body] of [["array", "[]"], ["null", "null"], ["string", '"x"'], ["number", "1"]] satisfies Array<[string, string]>) {
      const res = await auth("/api/agents", { method: "POST", headers: JSON_HEADERS, body });
      assert.equal(res.status, 400, label);
    }
    const bad = await auth("/api/agents", { method: "POST", headers: JSON_HEADERS, body: "{not json" });
    assert.equal(bad.status, 400);
  });

  await check("multi-byte characters split across body chunks survive intact", async () => {
    const payload = Buffer.from(JSON.stringify({ name: "utf8-agent", description: "héllo \u{1F600} wörld", body: "x" }));
    const cut = payload.indexOf(Buffer.from("\u{1F600}")) + 2; // inside the 4-byte emoji
    const res = await auth("/api/agents", { method: "POST", headers: JSON_HEADERS, chunks: [payload.subarray(0, cut), payload.subarray(cut)] });
    assert.equal(res.status, 201, res.text);
    const back = await auth("/api/agents/utf8-agent?source=user");
    assert.equal((back.json() as AgentBody).agent.description, "héllo \u{1F600} wörld");
    await auth("/api/agents/utf8-agent?source=user", { method: "DELETE", headers: JSON_HEADERS });
  });

  await check("session ids are validated: path-like ids are 400 and never reach the filesystem", async () => {
    for (const id of ["..%2f..%2fetc%2fpasswd", "%2e%2e", "..", ".hidden", "a%2fb", "a%5cb", "a%00b", "a%20b", "x".repeat(201), "%E9", "%zz"]) {
      for (const suffix of ["", "/lens", "/stats", "/todos", "/events"]) {
        const res = await auth(`/api/sessions/${id}${suffix}`);
        assert.ok([400, 404].includes(res.status), `/api/sessions/${id}${suffix} -> ${res.status}`);
        assert.notEqual(res.status, 200);
      }
    }
    const res = await auth("/api/sessions/..%2f..%2fetc%2fpasswd/lens");
    assert.equal(res.status, 400);
  });

  // ------------------------------------------------ 7. token hygiene ---------------------
  await check("the token never reaches logs, response bodies, cookies or headers", async () => {
    // Drive every kind of request, including ones that put the token where it must not be.
    await get(`/api/sessions?token=${TOKEN}`);
    await get(`/api/config?access_token=${TOKEN}`, { headers: { Origin: EVIL } });
    await authed(port, TOKEN, { path: `/${TOKEN}` });
    await auth("/api/sessions", { host: `${TOKEN}.evil.example` });
    await get("/api/sessions", { headers: { Authorization: `Bearer ${TOKEN.slice(0, -1)}z` } });
    const responses = [await get("/"), await get("/api/health"), await auth("/api/config"), await auth("/api/sessions"),
      await auth(`/api/sessions/${FIXTURE_ID}/stats`), await auth("/api/agents"), await get("/api/config")];
    for (const res of responses) {
      assert.ok(!res.text.includes(TOKEN), "token echoed in a response body");
      assert.ok(!JSON.stringify(res.headers).includes(TOKEN), "token echoed in a response header");
      assert.equal(res.headers["set-cookie"], undefined, "the server must not set cookies");
    }
    const logs = running.output();
    assert.ok(logs.includes("/api/sessions"), "access log should record denied requests (path only)");
    assert.ok(!logs.includes(TOKEN), "token found in the server log");
    assert.ok(!logs.includes(TOKEN.slice(0, 12)), "part of the token found in the server log");
    assert.doesNotMatch(logs, /Bearer/i, "credential header echoed into the log");
    assert.doesNotMatch(logs, /[?&](?:token|access_token)=/, "query string logged");
  });

  await check("denied-request logging is path-only and bounded", async () => {
    const denied = () => running.stderr().split("\n").filter((l) => l.includes("-> 401"));
    const before = denied().length;
    for (let i = 0; i < 80; i++) await get(`/api/sessions?n=${i}`);
    // At most 30 lines per 10 s window, so an 80-request burst (one window boundary at worst) logs <= 60.
    assert.ok(denied().length - before <= 60, `denied-request log not rate limited (${denied().length - before} of 80 logged)`);
    assert.ok(denied().every((l) => !l.includes("?")), "query string in a log line");
  });
} catch (error) {
  console.error(error instanceof Error && error.stack ? error.stack : error);
  exitCode = 1;
} finally {
  if (server) await server.stop();
}

// ------------------------------------------------ 8. explicit auth-off mode ----------------
try {
  const off = await startServer(sandbox, { env: { PI_CONSOLE_AUTH: "off" } });
  try {
    const { port } = off;
    await check("PI_CONSOLE_AUTH=off warns loudly at startup and is reported on /api/health", async () => {
      assert.match(off.stderr(), /AUTHENTICATION IS (?:OFF|DISABLED)/);
      assert.equal(((await request(port, { path: "/api/health" })).json() as HealthBody).auth, "off");
    });
    await check("auth off: no token needed, but Host / Origin / content-type checks still apply", async () => {
      assert.equal((await request(port, { path: "/api/sessions" })).status, 200);
      assert.equal((await request(port, { path: "/api/sessions", host: "evil.example" })).status, 403);
      assert.equal((await request(port, { path: "/api/sessions", headers: { Origin: "http://evil.example" } })).status, 403);
      const victim = path.join(sandbox.userAgents, "off-agent.md");
      const cross = await request(port, { method: "POST", path: "/api/agents", headers: { Origin: "http://evil.example", "Content-Type": "text/plain" }, body: '{"name":"off-agent","body":"x"}' });
      assert.equal(cross.status, 403);
      const plain = await request(port, { method: "POST", path: "/api/agents", headers: { "Content-Type": "text/plain" }, body: '{"name":"off-agent","body":"x"}' });
      assert.equal(plain.status, 415);
      const bodiless = await request(port, { method: "POST", path: `/api/sessions/${FIXTURE_ID}/abort` });
      assert.equal(bodiless.status, 415);
      assert.equal(fs.existsSync(victim), false);
    });
  } finally {
    await off.stop();
  }
} catch (error) {
  console.error(error instanceof Error && error.stack ? error.stack : error);
  exitCode = 1;
} finally {
  sandbox.cleanup();
}

if (exitCode) process.exit(exitCode);
finish();
