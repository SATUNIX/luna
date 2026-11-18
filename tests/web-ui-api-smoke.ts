#!/usr/bin/env node
// Offline regression smoke for the web-ui API query string. The server used to call
// handleApi(req, res, { pathname }) with no `search`, so routes.ts always saw an empty
// query and `?source=project` was ignored: GET returned the user-level agent and DELETE
// removed the user-level file when a project agent of the same name existed.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { EventInput } from "../packages/autonomy/lib/events.ts";
import type { AutonomyResponse } from "../packages/web-ui/server/autonomy.ts";
import type { handleApi } from "../packages/web-ui/server/routes.ts";

const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-ui-api-home-"));
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-ui-api-proj-"));
const savedEnv = {
  HOME: process.env.HOME,
  PI_CONSOLE_PROJECT_AGENTS: process.env.PI_CONSOLE_PROJECT_AGENTS,
  PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
};
let failed = false;

function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ok - ${name}`);
  } catch (error) {
    failed = true;
    console.error(`  not ok - ${name}`);
    console.error(error instanceof Error && error.stack ? error.stack : error);
  }
}

interface FakeRes {
  statusCode: number | null;
  body: string | null;
  writeHead(s: number): void;
  end(b: string): void;
  // Only an event stream writes or listens; these routes never do.
  write(): void;
  on(): void;
}

function fakeRes(): FakeRes {
  return {
    statusCode: null,
    body: null,
    writeHead(s: number) {
      this.statusCode = s;
    },
    end(b: string) {
      this.body = b;
    },
    write() {},
    on() {},
  };
}

// The fake response only ever receives a string body; a missing one fails the check.
function responseBody(res: FakeRes): string {
  if (res.body === null) throw new Error("no response body");
  return res.body;
}

function writeAgent(filePath: string, description: string, body: string): void {
  fs.writeFileSync(
    filePath,
    `---\nname: dup\ndescription: ${description}\n---\n\n${body}\n`,
    "utf8",
  );
}

/** A request to handleApi with the given method (bodiless). */
async function call(api: typeof handleApi, method: string, pathname: string): Promise<FakeRes> {
  const res = fakeRes();
  await api({ method, url: pathname, headers: { "content-type": "application/json" }, on() {} }, res, { pathname });
  return res;
}

/**
 * GET /api/autonomy (PG-08) over fixture state written with the autonomy library itself: the
 * documented shape, one malformed run, line or status file skipped and counted, worker text made
 * one line, the newest MAX_EVENTS events, and read-only (405 on anything but GET).
 */
async function autonomyChecks(api: typeof handleApi): Promise<void> {
  const { appendEvent, EVENT_TYPES } = await import("../packages/autonomy/lib/events.ts");
  const { buildStatus } = await import("../packages/autonomy/lib/reporting.ts");
  const { STATE_SCHEMA_VERSION } = await import("../packages/autonomy/lib/lifecycle.ts");
  const { stateHome } = await import("../packages/autonomy/lib/paths.ts");
  const { autonomyHome, MAX_EVENTS } = await import("../packages/web-ui/server/autonomy.ts");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-ui-autonomy-"));
  const savedHome = process.env.PI_AUTONOMY_HOME;
  process.env.PI_AUTONOMY_HOME = home;
  const view = async (): Promise<AutonomyResponse> => {
    const res = await call(api, "GET", "/api/autonomy");
    assert.equal(res.statusCode, 200, responseBody(res));
    return JSON.parse(responseBody(res)) as AutonomyResponse;
  };
  const writeState = (run: string, state: unknown): void => {
    fs.mkdirSync(path.join(home, run), { recursive: true });
    fs.writeFileSync(path.join(home, run, "state.json"), typeof state === "string" ? state : JSON.stringify(state));
  };
  const at = (minute: number): string => new Date(Date.UTC(2026, 10, 18, 10, minute)).toISOString();
  const log = (line: string): void => { throw new Error(`event not written: ${line}`); };
  try {
    check("the state home is resolved as the autonomy library resolves it", () => {
      for (const env of [{ PI_AUTONOMY_HOME: "/x/home" }, { XDG_STATE_HOME: "/x/state" }, {}]) {
        assert.equal(autonomyHome(env), stateHome(env), JSON.stringify(env));
      }
    });

    const empty = await view();
    check("an empty state home answers the documented shape with nothing in it", () => {
      assert.equal(empty.schemaVersion, 1);
      assert.ok(Number.isFinite(Date.parse(empty.at)));
      assert.deepEqual([empty.runs, empty.runsTotal, empty.events, empty.status, empty.skipped],
        [[], 0, [], null, { runs: 0, events: 0, status: 0 }]);
    });

    // One event of every type the library writes: each must come back.
    const inputs: EventInput[] = [
      { type: "run.started", run: "r-good", template: "implement" },
      { type: "run.status", run: "r-good", from: "setup", to: "running", reason: null },
      { type: "cycle.started", run: "r-good", n: 1, resume: false },
      { type: "gate.result", run: "r-good", n: 1, sha: "a".repeat(40), green: false, failing: ["unit", "lint"] },
      { type: "cycle.ended", run: "r-good", n: 1, outcome: "merged", gate: "green", merged: true, reason: "ok" },
      { type: "push", run: "r-good", branch: "integrate/r-good", sha: "b".repeat(40), ok: true },
      { type: "failure", run: "r-good", code: "boom", detail: "it broke" },
      { type: "dispatch.claim", run: "r-good", n: 2, item: "PG-08", engineer: "e1", outcome: "winner" },
      { type: "dispatch.submit", run: "r-good", n: 2, item: "PG-08", engineer: "e1", sha: "c".repeat(40) },
      { type: "harness.degraded", run: "r-good", missing: ["orchestrate"] },
    ];
    inputs.forEach((input, i) => appendEvent(home, input, log, { at: at(i) }));
    const typed = await view();
    check("every event type the library writes is read back, fields intact", () => {
      assert.deepEqual(typed.events.map((e) => e.type), [...EVENT_TYPES]);
      assert.equal(typed.skipped.events, 0);
      const gate = typed.events.find((e) => e.type === "gate.result");
      assert.deepEqual(gate?.failing, ["unit", "lint"]);
      assert.equal(gate?.green, false);
    });

    writeState("r-good", {
      schemaVersion: STATE_SCHEMA_VERSION, run: "r-good", template: "implement", status: "blocked", step: 3,
      updatedAt: at(30), usage: { usd: 1.5 }, limits: { budget: { totalUsd: 10 } }, outcome: null,
      blocker: { kind: "question", question: "first\nsecond‮<img src=x onerror=alert(1)>", waiting: "waiting_provider" },
    });
    writeState("r-legacy", { status: "succeeded", updatedAt: at(1), outcome: { status: "succeeded", reason: "done" } });
    writeState("r-bad", "{not json");
    writeState("r-array", "[1]");
    fs.mkdirSync(path.join(home, "no-state"));
    for (let i = 0; i < MAX_EVENTS + 10; i++) {
      appendEvent(home, { type: "run.status", run: "r-good", from: "running", to: "running", reason: `tick ${i}` }, log, { at: at(10 + (i % 20)) });
    }
    fs.appendFileSync(path.join(home, "events.jsonl"), `{nope\n${JSON.stringify({ v: 1, at: at(40), run: "r-good", type: "bogus" })}\n`);
    fs.writeFileSync(path.join(home, "status.json"), JSON.stringify(buildStatus({ home, now: new Date(at(31)) })));

    const full = await view();
    const good = full.runs.find((r) => r.run === "r-good");
    const legacy = full.runs.find((r) => r.run === "r-legacy");
    check("runs are listed newest first, with listRuns' fields and the newest event's time", () => {
      assert.deepEqual(full.runs.map((r) => r.run), ["r-good", "r-legacy"]);
      assert.equal(full.runsTotal, 2);
      assert.deepEqual(
        [good?.template, good?.status, good?.step, good?.spentUsd, good?.budgetUsd, good?.blocker?.kind, good?.lastEventAt],
        ["implement", "blocked", 3, 1.5, 10, "question", at(29)],
      );
      assert.equal(legacy?.legacy, true);
      assert.deepEqual(legacy?.outcome, { status: "succeeded", reason: "done" });
      assert.equal(legacy?.lastEventAt, null);
    });
    check("worker text in a run is one visible line, still only text", () => {
      const question = good?.blocker?.question ?? "";
      assert.ok(!/[\n‮]/.test(question), JSON.stringify(question));
      assert.match(question, /^first second <img/);
    });
    check("a malformed run, event line or status file is skipped and counted, never fatal", () => {
      assert.deepEqual(full.skipped, { runs: 2, events: 2, status: 0 });
    });
    check("events are the newest MAX_EVENTS, oldest first", () => {
      assert.equal(full.events.length, MAX_EVENTS);
      assert.equal(full.events.at(-1)?.reason, `tick ${MAX_EVENTS + 9}`);
    });
    check("the status file is passed on when it is the reporting schema", () => {
      assert.equal(full.status?.schemaVersion, 1);
      assert.deepEqual(full.status?.runs.map((r) => r.run), ["r-good", "r-legacy"]);
    });

    fs.writeFileSync(path.join(home, "status.json"), JSON.stringify({ schemaVersion: 2 }));
    const badStatus = await view();
    check("a status file of another schema is null and counted", () => {
      assert.equal(badStatus.status, null);
      assert.equal(badStatus.skipped.status, 1);
      assert.equal(badStatus.runs.length, 2, "the rest of the answer is unaffected");
    });

    // Worker text quoting a secret: the route redacts it as the status file and alerts do. The
    // secrets are joined from parts (as tests/fixtures/secret-corpus.json does), and the event line
    // is appended raw, past the library's own event redaction, to pin the route's.
    const envSecret = "EXAMPLE0000" + "example0000EXAMPLE";
    const antSecret = "sk-" + "ant-" + "a".repeat(32);
    writeState("r-secret", {
      schemaVersion: STATE_SCHEMA_VERSION, run: "r-secret", status: "blocked", updatedAt: at(32),
      outcome: { status: "failed", reason: `OPENAI_API_KEY=${envSecret}` },
      blocker: { kind: "question", question: `should I use ${antSecret} from .env?` },
    });
    fs.appendFileSync(path.join(home, "events.jsonl"),
      `${JSON.stringify({ v: 1, at: at(41), run: "r-secret", type: "failure", code: "boom", detail: `OPENAI_API_KEY=${envSecret}` })}\n`);
    const status = buildStatus({ home, now: new Date(at(33)) });
    fs.writeFileSync(path.join(home, "status.json"), JSON.stringify({
      ...status,
      openPrs: [{ number: 9, title: `leak ${antSecret}`, head: "lane/a\nb\u202Ec", base: "main", draft: false, ci: "green", url: "https://example.invalid/pr/9" }],
      spend: { "prov\u202Eider": { todayUsd: 0, monthUsd: 0 } },
    }));
    const secret = await view();
    const secretBody = JSON.stringify(secret);
    check("secrets in worker text are redacted in runs, events and the status file", () => {
      assert.ok(!secretBody.includes(envSecret) && !secretBody.includes(antSecret), secretBody);
      const run = secret.runs.find((r) => r.run === "r-secret");
      assert.match(run?.blocker?.question ?? "", /^should I use \[REDACTED\]/);
      assert.match(run?.outcome?.reason ?? "", /^OPENAI_API_KEY=\[REDACTED\]/);
      assert.match(String(secret.events.at(-1)?.detail), /^OPENAI_API_KEY=\[REDACTED\]/);
    });
    check("status file strings and record keys are one visible line, as state.json fields are", () => {
      assert.equal(secret.status?.openPrs?.[0]?.head, "lane/a b c");
      assert.deepEqual(Object.keys(secret.status?.spend ?? {}), ["prov ider"]);
      assert.equal(secret.skipped.status, 0);
    });

    if (process.platform !== "win32") {
      // A FIFO at a name the route reads must be refused without waiting for a writer: the open is
      // synchronous, so a blocking one would hang this request and the whole console with it.
      const before = await view();
      fs.mkdirSync(path.join(home, "r-fifo"));
      execFileSync("mkfifo", [path.join(home, "r-fifo", "state.json"), path.join(home, "events.jsonl.1")]);
      const fifo = await view();
      check("a FIFO in the state home is skipped and counted, never waited on", () => {
        assert.equal(fifo.skipped.runs, before.skipped.runs + 1);
        assert.equal(fifo.skipped.events, before.skipped.events + 1);
        assert.equal(fifo.runs.length, before.runs.length);
      });
    }

    const refused: Array<[string, number | null]> = [];
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) refused.push([method, (await call(api, method, "/api/autonomy")).statusCode]);
    check("the autonomy route is read-only: every other method is 405", () => {
      assert.deepEqual(refused, [["POST", 405], ["PUT", 405], ["DELETE", 405], ["PATCH", 405]]);
    });
  } finally {
    if (savedHome === undefined) Reflect.deleteProperty(process.env, "PI_AUTONOMY_HOME");
    else process.env.PI_AUTONOMY_HOME = savedHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

try {
  // config.ts captures HOME and the agent dirs at import time, so set every env var
  // before the dynamic import.
  process.env.HOME = homeDir;
  process.env.PI_CONSOLE_PROJECT_AGENTS = projectDir;
  // A non-default agent dir, so a console that ignored PI_CODING_AGENT_DIR would be caught.
  const agentDir = path.join(homeDir, "custom-agent-dir");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const { handleApi } = await import("../packages/web-ui/server/routes.ts");

  const userAgentPath = path.join(agentDir, "agents", "dup.md");
  const projectAgentPath = path.join(projectDir, "dup.md");
  fs.mkdirSync(path.dirname(userAgentPath), { recursive: true });
  writeAgent(userAgentPath, "user-copy", "user body");
  writeAgent(projectAgentPath, "project-copy", "project body");

  // GET must honour ?source=project even when handleApi only receives `pathname`
  // (the old server.ts shape).
  const getRes = fakeRes();
  await handleApi(
    { method: "GET", url: "/api/agents/dup?source=project", on() {} },
    getRes,
    { pathname: "/api/agents/dup" },
  );
  check("GET ?source=project selects the project agent", () => {
    assert.equal(getRes.statusCode, 200);
    const { agent } = JSON.parse(responseBody(getRes)) as { agent: { source: string; description: string } };
    assert.equal(agent.source, "project");
    assert.equal(agent.description, "project-copy");
  });

  // DELETE must remove the project copy, not the user copy.
  const delRes = fakeRes();
  await handleApi(
    { method: "DELETE", url: "/api/agents/dup?source=project", on() {} },
    delRes,
    { pathname: "/api/agents/dup" },
  );
  check("DELETE ?source=project removes only the project agent", () => {
    assert.equal(delRes.statusCode, 200);
    assert.equal(fs.existsSync(projectAgentPath), false, "project file must be deleted");
    assert.equal(fs.existsSync(userAgentPath), true, "user file must survive");
  });

  // The version reported to the client must be the real package version, not the old hard-coded 0.1.0.
  const rootPkg = JSON.parse(
    fs.readFileSync(path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "package.json"), "utf8"),
  ) as { version: string };
  const healthRes = fakeRes();
  await handleApi({ method: "GET", url: "/api/health", on() {} }, healthRes, { pathname: "/api/health" });
  check("GET /api/health reports the real kit version, not the old hard-coded 0.1.0", () => {
    assert.equal(healthRes.statusCode, 200);
    const body = JSON.parse(responseBody(healthRes)) as { version: string };
    assert.equal(body.version, rootPkg.version);
    assert.notEqual(body.version, "0.1.0");
  });
  const { configInfo } = await import("../packages/web-ui/server/configinfo.ts");
  check("configInfo().app.version is the real kit version", () => {
    assert.equal(configInfo().app.version, rootPkg.version);
    assert.notEqual(configInfo().app.version, "0.1.0");
  });

  // An unexpected failure (an fs error, a bug) must not put its text, which can hold paths and internals, in the response:
  // the client gets a generic 500 and the detail goes to the server's log. A deliberate HttpError keeps its message.
  const secret = "EACCES: permission denied, open '/home/operator/.ssh/id_rsa'";
  const boomRes = fakeRes();
  const realStderr = process.stderr.write.bind(process.stderr);
  let logged = "";
  process.stderr.write = (chunk) => ((logged += String(chunk)), true);
  try {
    await handleApi(
      { method: "POST", url: "/api/agents", headers: { "content-type": "application/json" }, on() { throw new Error(secret); } },
      boomRes,
      { pathname: "/api/agents" },
    );
  } finally {
    process.stderr.write = realStderr;
  }
  check("an unexpected error is a generic 500 with no internals in the response, and is logged", () => {
    assert.equal(boomRes.statusCode, 500);
    assert.equal((JSON.parse(responseBody(boomRes)) as { error: string }).error, "internal error (see the console log)");
    const boomBody = responseBody(boomRes);
    assert.ok(!boomBody.includes("id_rsa") && !boomBody.includes("/home/operator"), boomBody);
    assert.ok(logged.includes(secret), "the detail is in the server's own log");
  });
  const { agentDirFor, createAgent, deleteAgent, getAgent, updateAgent } = await import("../packages/web-ui/server/agentstore.ts");
  const { HttpError } = await import("../packages/web-ui/server/validate.ts");
  // The subagent tool reads user roles from <agent dir>/agents; a role the console saves as a
  // user agent must be one the subagent tool discovers.
  const { discoverAgents } = await import("../packages/extensions/third_party/subagent/agents.ts");
  check("the console's user agents are the subagent tool's user agents (<agent dir>/agents)", () => {
    assert.equal(agentDirFor("user"), path.join(agentDir, "agents"));
    createAgent({ name: "shared-role", description: "made in the console", body: "x" });
    const found = discoverAgents(projectDir, "user").agents.find((agent) => agent.name === "shared-role");
    assert.equal(found?.source, "user", "the subagent tool discovers the console-made agent as a user agent");
    deleteAgent("shared-role", "user");
  });
  check("client-facing agent failures are HttpErrors with their status", () => {
    const attempts: Array<[string, () => unknown, number]> = [
      ["an invalid name", () => createAgent({ name: "Bad Name", body: "x" }), 400],
      ["a missing agent", () => deleteAgent("nosuch-agent", "user"), 404],
    ];
    for (const [label, attempt, status] of attempts) {
      let error: unknown = null;
      try { attempt(); } catch (e) { error = e; }
      assert.ok(error instanceof HttpError, `${label}: ${String(error)}`);
      assert.equal(error.statusCode, status, label);
    }
  });
  check("editing an agent without sending its model keeps the model", () => {
    createAgent({ name: "keeps-model", model: "provider/model-x", body: "x" });
    assert.equal(getAgent("keeps-model", "user")?.model, "provider/model-x", "the record carries the model");
    updateAgent("keeps-model", { description: "edited", body: "y", source: "user" });
    assert.equal(getAgent("keeps-model", "user")?.model, "provider/model-x");
    deleteAgent("keeps-model", "user");
  });
  // The editor sends "" when its model field is cleared (agentui.ts); that must remove the model.
  check("editing an agent with an empty model clears it", () => {
    createAgent({ name: "clears-model", model: "provider/model-x", body: "x" });
    updateAgent("clears-model", { model: "", body: "x", source: "user" });
    assert.equal(getAgent("clears-model", "user")?.model, undefined);
    deleteAgent("clears-model", "user");
  });
  check("a line break of any kind in a field cannot add a frontmatter key", () => {
    createAgent({ name: "one-line", description: "a\rmodel: injected\u2028tools: bash", body: "x" });
    const text = fs.readFileSync(path.join(agentDirFor("user"), "one-line.md"), "utf8");
    const frontmatter = text.split("---")[1] ?? "";
    assert.ok(!/[\r\u2028\u2029]/.test(frontmatter), "no raw line break survives in the frontmatter");
    assert.equal(getAgent("one-line", "user")?.model, undefined);
    deleteAgent("one-line", "user");
  });

  await autonomyChecks(handleApi);
} finally {
  fs.rmSync(homeDir, { recursive: true, force: true });
  fs.rmSync(projectDir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
}

if (failed) {
  console.error("web-ui-api smoke: FAIL");
  process.exit(1);
}
console.log("web-ui-api smoke: OK");
