#!/usr/bin/env node
// Offline smoke for what the pi-console server will and will not do with a request:
//   - only an allowlist of pi RPC command types is ever written to a pi child, with fixed
//     shapes (request bodies cannot smuggle extra fields or another command type);
//   - spawn config, session/model/entry ids and streamingBehavior are validated BEFORE any
//     child is started;
//   - the token never reaches a pi child's environment;
//   - Pi's own session files are never written (behaviour and source scan);
//   - shutdown stops children (even one that ignores SIGTERM), removes temp files and closes
//     event streams and timers.
// A stub executable stands in for `pi --mode rpc`; nothing else is spawned and nothing
// leaves loopback.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  WEB_UI_DIR,
  alive,
  authed,
  makeRunner,
  makeSandbox,
  newToken,
  openSse,
  request,
  startServer,
  waitFor,
  writeSessionFixture,
} from "./web-ui-test-harness.mjs";

const { check, finish } = makeRunner("web-ui-rpc smoke");
const sandbox = makeSandbox("pi-web-ui-rpc-");
const TOKEN = newToken();
const JSON_HEADERS = { "Content-Type": "application/json" };
const FIXTURE_ID = "fixture-1";
const fixtureFile = writeSessionFixture(sandbox, FIXTURE_ID);
const ALLOWED = new Set(["get_state", "prompt", "abort", "set_model", "set_thinking_level", "fork", "new_session", "get_session_stats"]);
const cmds = () => sandbox.stubEvents().filter((e) => e.event === "cmd").map((e) => e.cmd);
const starts = () => sandbox.stubEvents().filter((e) => e.event === "start");
const sha = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const snapshot = (dir) => {
  const out = {};
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        const st = fs.statSync(full);
        out[path.relative(dir, full)] = `${st.size}:${st.mtimeMs}:${sha(full)}`;
      }
    }
  };
  walk(dir);
  return out;
};

fs.mkdirSync(sandbox.projectAgents, { recursive: true });
fs.writeFileSync(path.join(sandbox.projectAgents, "lifecycle-agent.md"), "---\nname: lifecycle-agent\ndescription: lifecycle\n---\n\nYou are a test agent.\n");

let server = null;
try {
  server = await startServer(sandbox, { env: { PI_CONSOLE_TOKEN: TOKEN } });
  const { port } = server;
  const call = (method, p, body, o = {}) =>
    authed(port, TOKEN, { method, path: p, headers: JSON_HEADERS, body: body === undefined ? undefined : JSON.stringify(body), ...o });

  // ---------------------------------------------------- validation before spawn ---------
  await check("invalid spawn requests are refused (400) and start no pi child", async () => {
    const bodies = [
      { model: "--dangerously-skip-permissions" }, { provider: "a b" }, { provider: { a: 1 } }, { model: ["x"] }, { model: "x".repeat(300) },
      { thinking: "bogus" }, { thinking: 3 }, { cwd: "relative/path" }, { cwd: "/definitely/not/here" }, { cwd: "/etc/passwd" }, { cwd: 42 },
      { cwd: `${sandbox.cwd}\u0000x` }, { agent: "../../etc/passwd" }, { agent: "no-such-agent" }, { agentSource: "other", agent: "lifecycle-agent" },
    ];
    for (const body of bodies) {
      const res = await call("POST", "/api/sessions", body);
      assert.equal(res.status, 400, `${JSON.stringify(body).slice(0, 80)} -> ${res.status} ${res.text.slice(0, 100)}`);
    }
    for (const raw of ["[]", "null", '"x"']) {
      const res = await authed(port, TOKEN, { method: "POST", path: "/api/sessions", headers: JSON_HEADERS, body: raw });
      assert.equal(res.status, 400, raw);
    }
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(starts(), [], "a pi child was started for an invalid request");
  });

  await check("a valid spawn passes exactly the validated arguments", async () => {
    const res = await call("POST", "/api/sessions", { cwd: sandbox.cwd, thinking: "off", provider: "openrouter-custom", model: "deepseek/deepseek-v4.1-flash:free", evil: "--flag" });
    assert.equal(res.status, 201, res.text);
    assert.ok(await waitFor(() => starts().length === 1));
    assert.deepEqual(starts()[0].argv, ["--mode", "rpc", "--provider", "openrouter-custom", "--model", "deepseek/deepseek-v4.1-flash:free", "--thinking", "off"]);
  });

  const sessionId = `stub-${starts()[0]?.pid}`;

  await check("the token and token-file variables are not in the pi child's environment", () => {
    assert.equal(starts()[0].tokenEnv, null, "PI_CONSOLE_TOKEN leaked to the child");
    assert.equal(starts()[0].tokenFileEnv, null);
  });

  // ---------------------------------------------------- RPC allowlist -------------------
  await check("prompt forwards only {type:'prompt', message, streamingBehavior}; extra body fields cannot add a command", async () => {
    const res = await call("POST", `/api/sessions/${sessionId}/prompt`, {
      message: "hi", streamingBehavior: "steer", type: "bash", command: "id", sessionPath: "/etc/passwd", outputPath: "/tmp/x", id: "attacker", provider: "p",
    });
    assert.equal(res.status, 202, res.text);
    assert.ok(await waitFor(() => cmds().some((c) => c.type === "prompt")));
    const prompt = cmds().find((c) => c.type === "prompt");
    assert.deepEqual(Object.keys(prompt).sort(), ["id", "message", "streamingBehavior", "type"]);
    assert.equal(prompt.message, "hi");
    assert.notEqual(prompt.id, "attacker", "the server assigns the command id");
  });

  await check("bad prompt fields are 400 and forward nothing", async () => {
    const before = cmds().length;
    for (const body of [{ message: "x", streamingBehavior: { a: 1 } }, { message: "x", streamingBehavior: "later" }, { message: "x", streamingBehavior: ["steer"] }, { message: 5 }, { message: "   " }, {}]) {
      const res = await call("POST", `/api/sessions/${sessionId}/prompt`, body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(cmds().length, before);
  });

  await check("abort / model / thinking / fork / new / stats each send exactly one fixed-shape command", async () => {
    assert.equal((await call("POST", `/api/sessions/${sessionId}/abort`, {})).status, 202);
    assert.equal((await call("POST", `/api/sessions/${sessionId}/model`, { provider: "p", modelId: "m:1", type: "bash", command: "id" })).status, 200);
    assert.equal((await call("POST", `/api/sessions/${sessionId}/thinking`, { level: "high", type: "bash" })).status, 200);
    assert.equal((await call("POST", `/api/sessions/${sessionId}/fork`, { entryId: "abc123", parentSession: "/etc/passwd" })).status, 200);
    assert.equal((await call("POST", `/api/sessions/${sessionId}/fork`, {})).status, 200);
    assert.equal((await call("POST", `/api/sessions/${sessionId}/new`, { parentSession: "/etc/passwd" })).status, 200);
    assert.equal((await authed(port, TOKEN, { path: `/api/sessions/${sessionId}/stats` })).status, 200);
    assert.ok(await waitFor(() => cmds().some((c) => c.type === "abort")));
    const byType = (t) => cmds().filter((c) => c.type === t);
    assert.deepEqual(Object.keys(byType("abort")[0]).sort(), ["id", "type"]);
    assert.deepEqual(Object.keys(byType("set_model")[0]).sort(), ["id", "modelId", "provider", "type"]);
    assert.deepEqual(Object.keys(byType("set_thinking_level")[0]).sort(), ["id", "level", "type"]);
    assert.deepEqual(Object.keys(byType("fork")[0]).sort(), ["entryId", "id", "type"]);
    assert.deepEqual(Object.keys(byType("fork")[1]).sort(), ["id", "type"], "an absent entryId stays absent");
    assert.deepEqual(Object.keys(byType("new_session")[0]).sort(), ["id", "type"], "parentSession must not be forwarded");
    assert.deepEqual(Object.keys(byType("get_session_stats")[0]).sort(), ["id", "type"]);
  });

  await check("bad model / thinking / fork arguments are 400 and forward nothing", async () => {
    const before = cmds().length;
    const cases = [
      ["model", { provider: "p q", modelId: "m" }], ["model", { provider: "p", modelId: "--x" }], ["model", { provider: 1, modelId: 2 }], ["model", { provider: "p" }],
      ["model", { provider: { a: 1 }, modelId: "m" }], ["thinking", { level: "bogus" }], ["thinking", {}], ["fork", { entryId: "../x" }], ["fork", { entryId: { a: 1 } }],
      ["fork", { entryId: "a b" }], ["fork", { entryId: "x".repeat(200) }],
    ];
    for (const [route, body] of cases) {
      const res = await call("POST", `/api/sessions/${sessionId}/${route}`, body);
      assert.equal(res.status, 400, `${route} ${JSON.stringify(body)} -> ${res.status}`);
    }
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(cmds().length, before);
  });

  await check("every command the server ever wrote to a child is on the allowlist (no bash / switch_session / export_html ...)", () => {
    const types = new Set(cmds().map((c) => c.type));
    for (const type of types) assert.ok(ALLOWED.has(type), `unexpected RPC command ${type}`);
    for (const forbidden of ["bash", "switch_session", "export_html", "compact", "set_auto_compaction", "clone", "get_messages"]) assert.ok(!types.has(forbidden), forbidden);
  });

  // ---------------------------------------------------- read-only session files --------
  await check("the server never writes Pi session files (reads, streaming and a resume leave them byte-identical)", async () => {
    const before = snapshot(sandbox.sessionsDir);
    assert.ok(Object.keys(before).length >= 1);
    for (const route of ["/api/sessions", `/api/sessions/${FIXTURE_ID}`, `/api/sessions/${FIXTURE_ID}/stats`, `/api/sessions/${FIXTURE_ID}/todos`, `/api/sessions/${FIXTURE_ID}/lens`, "/api/cwds", "/api/config"]) {
      assert.equal((await authed(port, TOKEN, { path: route })).status, 200, route);
    }
    const sse = await openSse(port, `/api/sessions/${FIXTURE_ID}/events`, { Authorization: `Bearer ${TOKEN}` });
    assert.ok(await waitFor(() => sse.received().includes("observed_message")), "tailer replay");
    sse.close();
    // Prompting an idle session resumes it through pi (`--session <file>`); the server itself writes nothing.
    const startsBefore = starts().length;
    assert.equal((await call("POST", `/api/sessions/${FIXTURE_ID}/prompt`, { message: "resume me" })).status, 202);
    assert.ok(await waitFor(() => starts().length === startsBefore + 1));
    assert.deepEqual(starts().at(-1).argv.slice(0, 4), ["--mode", "rpc", "--session", fixtureFile]);
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(snapshot(sandbox.sessionsDir), before, "a session file was modified, created or removed");
  });

  await check("only known modules write to disk, and none of them targets the sessions directory", () => {
    const dir = path.join(WEB_UI_DIR, "server");
    const writer = /\b(writeFile(?:Sync)?|appendFile(?:Sync)?|createWriteStream|rename(?:Sync)?|unlink(?:Sync)?|rm(?:Sync)?|rmdir(?:Sync)?|mkdir(?:Sync)?|copyFile(?:Sync)?|truncate(?:Sync)?|symlink(?:Sync)?|utimes(?:Sync)?|chmod(?:Sync)?)\s*\(/g;
    const allowed = {
      "agentstore.js": ["mkdirSync", "unlinkSync", "writeFileSync"], // agent definitions, path-checked to AGENT_DIRS
      "spawn.js": ["mkdirSync", "unlinkSync", "writeFileSync"], // the temp --append-system-prompt file in RUNTIME_DIR
      "server.js": ["rmSync", "writeFileSync"], // the generated token file in RUNTIME_DIR
      "config.js": ["mkdirSync"], // RUNTIME_DIR itself
      "remote-host.js": ["rmSync"], // its own control.json, at shutdown
      // The remote host's state directory (identity, TLS key, devices, control.json, audit log),
      // written only through store.js's owner-only helpers.
      "remote/store.js": ["appendFileSync", "chmodSync", "mkdirSync", "renameSync", "rmSync", "writeFileSync"],
    };
    const files = [
      ...fs.readdirSync(dir).filter((f) => f.endsWith(".js")),
      ...fs.readdirSync(path.join(dir, "remote")).filter((f) => f.endsWith(".js")).map((f) => `remote/${f}`),
    ];
    for (const file of files) {
      const code = fs.readFileSync(path.join(dir, file), "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
      const used = new Set([...code.matchAll(writer)].map((m) => m[1]));
      const extra = [...used].filter((name) => !(allowed[file] || []).includes(name));
      assert.deepEqual(extra, [], `${file} uses unexpected write primitives: ${extra}`);
      assert.doesNotMatch(code, /(?:write|append|mkdir|unlink|rm|rename|truncate)\w*\([^)]*SESSIONS_DIR/, `${file} writes under SESSIONS_DIR`);
    }
    const spawnSrc = fs.readFileSync(path.join(dir, "spawn.js"), "utf8");
    assert.match(spawnSrc, /fs\.writeFileSync\(agentFile/, "spawn.js writes only the temp agent prompt");
    assert.doesNotMatch(spawnSrc, /writeFileSync\((?!agentFile)/);
  });

  await check("DELETE stops the session's child", async () => {
    const pid = starts()[0].pid;
    assert.equal((await call("DELETE", `/api/sessions/${sessionId}`, {})).status, 202);
    assert.ok(await waitFor(() => !alive(pid), { timeoutMs: 6000 }), "the child is still running");
  });
} catch (error) {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
} finally {
  if (server) await server.stop();
}

// ---------------------------------------------------- send() allowlist (in-process) -----
try {
  await check("PiRpcProcess.send refuses any command type not on the allowlist, and never lets a caller pick the id", async () => {
    // config.js reads the environment at import time, so set everything first.
    Object.assign(process.env, {
      HOME: sandbox.home, PI_CODING_AGENT_DIR: sandbox.agentDir, PI_CODING_AGENT_SESSION_DIR: sandbox.sessionsDir,
      PI_CONSOLE_PROJECT_AGENTS: sandbox.projectAgents, PI_CONSOLE_RUNTIME_DIR: sandbox.runtimeDir, PI_BIN: sandbox.stub,
      STUB_LOG: path.join(sandbox.root, "inproc.jsonl"), PI_CONSOLE_TOKEN: TOKEN, PI_CONSOLE_TOKEN_FILE: "/tmp/should-not-reach-child",
    });
    const spawnModule = await import("../packages/web-ui/server/spawn.js");
    const proc = await spawnModule.createSession({ cwd: sandbox.cwd });
    try {
      for (const command of [{ type: "bash", command: "id" }, { type: "switch_session", sessionPath: "/etc/passwd" }, { type: "export_html", outputPath: "/tmp/x" },
        { type: "compact" }, { type: "set_auto_compaction", enabled: false }, { type: "clone" }, { type: "get_messages" }, { type: "Prompt" }, { type: "prompt ", message: "x" },
        { type: 5 }, {}, null, undefined, "prompt"]) {
        await assert.rejects(proc.send(command), /not allowed/, JSON.stringify(command));
      }
      assert.deepEqual([...spawnModule.ALLOWED_RPC_COMMANDS].sort(), [...ALLOWED].sort(), "the allowlist changed; review it deliberately");
      assert.ok(Object.isFrozen(spawnModule.ALLOWED_RPC_COMMANDS));
      await proc.send({ type: "get_state", id: "attacker" });
      const inproc = fs.readFileSync(path.join(sandbox.root, "inproc.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
      const sent = inproc.filter((e) => e.event === "cmd").map((e) => e.cmd);
      assert.ok(sent.every((c) => ALLOWED.has(c.type)), `a disallowed command reached the child: ${JSON.stringify(sent)}`);
      assert.ok(sent.filter((c) => c.type === "get_state").every((c) => c.id !== "attacker"));
      const start = inproc.find((e) => e.event === "start");
      assert.equal(start.tokenEnv, null, "PI_CONSOLE_TOKEN reached the child");
      assert.equal(start.tokenFileEnv, null, "PI_CONSOLE_TOKEN_FILE reached the child");
    } finally {
      proc.kill({ graceMs: 200 });
    }
  });

  await check("tailers can be closed: no poll timer survives closeAllTailers()", async () => {
    const tailerModule = await import("../packages/web-ui/server/tailer.js");
    const tailer = tailerModule.acquireTailer(fixtureFile);
    assert.ok(tailer && tailer.timer, "tailer polling");
    const unsubscribe = tailer.subscribe(() => {});
    assert.ok(tailer.watching);
    tailerModule.closeAllTailers();
    assert.equal(tailer.timer, null, "poll timer still armed");
    assert.equal(tailer.closed, true);
    assert.equal(tailer.subscribers.size, 0);
    unsubscribe();
    tailerModule.closeAllTailers(); // idempotent
  });

  // ---------------------------------------------------- shutdown / lifecycle -----------
  await check("SIGTERM stops children that ignore SIGTERM, removes temp files, ends SSE streams and exits 0", async () => {
    fs.rmSync(sandbox.stubLog, { force: true });
    const s = await startServer(sandbox, { env: { PI_CONSOLE_TOKEN: TOKEN, STUB_IGNORE_SIGTERM: "1" } });
    const bearer = { Authorization: `Bearer ${TOKEN}` };
    const created = await authed(s.port, TOKEN, { method: "POST", path: "/api/sessions", headers: JSON_HEADERS, body: JSON.stringify({ cwd: sandbox.cwd, agent: "lifecycle-agent" }) });
    assert.equal(created.status, 201, created.text);
    assert.ok(await waitFor(() => starts().length === 1));
    const childPid = starts()[0].pid;
    const tempFiles = () => fs.readdirSync(sandbox.runtimeDir).filter((f) => /^agent-lifecycle-agent-.*\.md$/.test(f));
    assert.equal(tempFiles().length, 1, "the agent prompt temp file should exist while the session runs");
    const liveId = created.json().session.id;
    const liveStream = await openSse(s.port, `/api/sessions/${liveId}/events`, bearer);
    const tailStream = await openSse(s.port, `/api/sessions/${FIXTURE_ID}/events`, bearer);
    assert.equal(liveStream.status, 200);
    assert.ok(await waitFor(() => tailStream.received().includes('"state":"watching"')));
    assert.ok(alive(childPid));

    const t0 = Date.now();
    s.child.kill("SIGTERM");
    const result = await Promise.race([s.exited, new Promise((r) => setTimeout(() => r("timeout"), 9000))]);
    assert.notEqual(result, "timeout", `the server did not exit: ${s.output()}`);
    assert.equal(result.code, 0, `exit code ${JSON.stringify(result)}`);
    assert.ok(Date.now() - t0 < 6000, `shutdown took ${Date.now() - t0}ms`);
    assert.equal(alive(childPid), false, "the pi child that ignored SIGTERM survived the server");
    assert.deepEqual(tempFiles(), [], "temp agent prompt file left behind");
    assert.ok(await waitFor(() => liveStream.ended() && tailStream.ended()), "event streams were not closed");
    await assert.rejects(request(s.port, { path: "/api/health", timeout: 500 }), "the port must be closed after shutdown");
    liveStream.close();
    tailStream.close();
  });

  await check("a normal SIGTERM shutdown with a well-behaved child is quick and leaves nothing behind", async () => {
    fs.rmSync(sandbox.stubLog, { force: true });
    const s = await startServer(sandbox, { env: { PI_CONSOLE_TOKEN: TOKEN } });
    const created = await authed(s.port, TOKEN, { method: "POST", path: "/api/sessions", headers: JSON_HEADERS, body: JSON.stringify({ cwd: sandbox.cwd }) });
    assert.equal(created.status, 201);
    assert.ok(await waitFor(() => starts().length === 1));
    const childPid = starts()[0].pid;
    const t0 = Date.now();
    s.child.kill("SIGINT");
    const result = await s.exited;
    assert.equal(result.code, 0);
    assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0}ms`);
    assert.ok(await waitFor(() => !alive(childPid), { timeoutMs: 2000 }));
  });
} finally {
  sandbox.cleanup();
}

finish();
